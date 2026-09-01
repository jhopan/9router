/**
 * agentrouterResponseTranslate.js
 *
 * Reverse of agentrouterTranslate.js: AgentRouter replies in English, but the
 * user wants Indonesian. This wraps the upstream Anthropic SSE stream, buffers
 * ALL text deltas, translates the final text to Indonesian, then re-emits the
 * stream as if the model had spoken Indonesian.
 *
 * It self-invokes the local 9Router "translate" combo (cheap non-thinking model)
 * with a "translate to Indonesian" directive folded into the user message.
 *
 * Trade-off (accepted by the user): the client waits for the whole response to
 * finish before text starts flowing (buffer-then-translate). Clean output, one
 * translate call — the user explicitly said "asal bisa nunggu, gak langsung
 * nutup", i.e. it's OK to delay the stream until translation is ready.
 *
 * Fail-open: any error passes the original stream through unchanged — a
 * translation failure must never break or lose a response.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { getTranslateConfig, resolveTranslateApiKey, localBaseUrl } from "./translateConfig.js";

const TRANSLATE_SYSTEM =
  "You are a translation engine. Translate the text to natural, clear Indonesian (Bahasa Indonesia). " +
  "Return ONLY the translation. Do not add explanations, commentary, or quotes. " +
  "Keep code blocks, file paths, and technical identifiers exactly as-is.";

// Translate a response to Indonesian via the translate COMBO. The combo holds
// the models[] + fallback/round-robin + multi-account logic — the adapter just
// asks the combo ("penjual") to translate. Throws on failure so callers fail-open.
async function translateToIndonesian(text, combo, apiKey, log) {
  if (typeof text !== "string" || text.trim() === "") return text;

  const body = {
    model: combo,
    stream: true,
    max_tokens: 1600,
    messages: [
      // Instruction folded into the user message (combo may drop `system` role).
      { role: "user", content: `${TRANSLATE_SYSTEM}\n\nTranslate this text to Indonesian:\n\n${text}` },
    ],
  };

  const baseUrl = localBaseUrl();
  let response;
  try {
    response = await proxyAwareFetch(
      `${baseUrl}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      },
      null,
    );
  } catch (err) {
    throw new Error(`translate fetch failed: ${err.message}`);
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 150);
    } catch {
      /* ignore */
    }
    throw new Error(`translate returned ${response.status}: ${detail}`);
  }

  let full = "";
  try {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      full += decoder.decode(value, { stream: true });
    }
  } catch (err) {
    throw new Error(`translate stream parse failed: ${err.message}`);
  }

  const translated = extractChoicesContent(full);
  if (translated && translated.trim()) return translated.trim();
  throw new Error("translate returned empty output");
}

/**
 * Strip the model's meta-frame preamble from a translated response. Some
 * agentic models echo the task structure / instructions ("Pengguna bertanya:",
 * "Per AGENTS.md:", "Bentuk:", "Sejarah:", "Jawaban:", "Saya perlu...") before
 * giving the actual answer. The user wants only the response — drop this frame.
 */
function stripResponsePreamble(text) {
  if (typeof text !== "string") return text;
  const PREAMBLE_MARKERS = [
    /^pengguna bertanya[:\s]/i,
    /^per agents\.md[:\s]/i,
    /^per .*instructions[:\s]/i,
    /^bentuk[:\s]/i,
    /^sejarah[:\s]/i,
    /^jawaban[:\s]/i,
    /^menurut agents\.md[:\s]/i,
    /^saya perlu[.\s]/i,
    /^saya harus[.\s]/i,
    /^biarkan saya[.\s]/i,
    /^cara[.\s]/i,
  ];

  let lines = text.split("\n");
  // Drop leading lines that are pure scaffolding.
  while (lines.length > 0 && PREAMBLE_MARKERS.some((re) => re.test(lines[0].trim()))) {
    lines.shift();
  }
  return lines.join("\n").trim();
}

function extractChoicesContent(raw) {
  const lines = raw.split("\n");
  let text = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const json = JSON.parse(payload);
      const delta = json.choices?.[0]?.delta?.content;
      const plain = json.choices?.[0]?.message?.content;
      const piece = delta ?? plain;
      if (typeof piece === "string") text += piece;
    } catch {
      /* ignore malformed chunk */
    }
  }
  return text;
}

// Buffer the upstream Anthropic SSE body, extract the text stream + tool signals.
async function readClaudeStreamToText(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
  }

  // Parse Anthropic SSE: pull text_delta blocks; keep everything else shape-relevant.
  const textParts = [];
  let hasToolUse = false;
  let hasToolResult = false;
  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const json = JSON.parse(payload);
      if (json.type === "content_block_delta" && json.delta?.type === "text_delta" && json.delta.text) {
        textParts.push(json.delta.text);
      }
      if (json.type === "content_block_start" && json.content_block?.type === "tool_use") {
        hasToolUse = true;
      }
      if (json.type === "content_block_start" && json.content_block?.type === "tool_result") {
        hasToolResult = true;
      }
      // Deliberately skip thinking_delta: the model's reasoning preamble
      // ("Pengguna bertanya: ...", "Per AGENTS.md: ...") is NOT user-facing
      // output and would pollute the translated response.
    } catch {
      /* ignore */
    }
  }
  return { text: textParts.join(""), raw, hasToolUse, hasToolResult };
}

// Re-emit a translated Anthropic SSE stream (content_block_delta rows + terminal events).
function buildClaudeSSEStream(text) {
  const encoder = new TextEncoder();
  const eventRows = [];

  eventRows.push(encodeEvent(encoder, {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  }));
  // Chunk the translated text so the client gets a sense of streaming.
  const CHUNK = 64;
  for (let i = 0; i < text.length; i += CHUNK) {
    eventRows.push(
      encodeEvent(encoder, {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: text.slice(i, i + CHUNK) },
      }),
    );
  }
  eventRows.push(encodeEvent(encoder, { type: "content_block_stop", index: 0 }));
  eventRows.push(encodeEvent(encoder, { type: "message_stop" }));

  return new ReadableStream({
    start(controller) {
      for (const bytes of eventRows) controller.enqueue(bytes);
      controller.close();
    },
  });
}

function encodeEvent(encoder, obj) {
  return encoder.encode(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`);
}

// Rebuild a ReadableStream from raw SSE text (used when passing through a body
// whose original stream has already been consumed/locked by buffering).
function rawToStream(raw) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(raw));
      controller.close();
    },
  });
}

/**
 * Wrap an upstream Claude SSE response body: buffer all text, translate to
 * Indonesian, re-emit as a fresh Claude SSE stream. Fail-open.
 */
export async function wrapAgentRouterResponseStream(response, log) {
  try {
    const { text: originalText, raw, hasToolUse, hasToolResult } = await readClaudeStreamToText(response);
    // Tool-call / tool-result responses are the agentic tool loop (tool_use +
    // tool_result), not user-facing prose. Translating or re-emitting them as
    // text would corrupt the tool flow, so pass the original stream through
    // untouched. The (empty) text is likely just scaffolding.
    if (hasToolUse || hasToolResult || !originalText.trim()) {
      log?.info?.("TRANSLATE_OUT", `pass-through (text=${originalText.length}, toolUse=${hasToolUse}, toolResult=${hasToolResult})`);
      return rawToStream(raw);
    }

    const config = await getTranslateConfig();
    if (!config.enabled) {
      log?.debug?.("TRANSLATE_OUT", "disabled; passing original stream");
      return rawToStream(raw);
    }

    const apiKey = await resolveTranslateApiKey(config, log);
    if (!apiKey) {
      log?.warn?.("TRANSLATE_OUT", "no key; passing original stream");
      return rawToStream(raw);
    }

    if (!config.combo || !config.combo.trim()) {
      log?.warn?.("TRANSLATE_OUT", "no translate combo configured; passing original stream");
      return rawToStream(raw);
    }
    const translated = await translateToIndonesian(originalText, config.combo, apiKey, log);
    if (!translated || translated === originalText) {
      log?.warn?.("TRANSLATE_OUT", "no change; passing original stream");
      return rawToStream(raw);
    }

    // Strip the model's meta-frame preamble (if the model echoed the task
    // structure / instructions rather than answering directly). Lines like
    // "Pengguna bertanya:", "Per AGENTS.md:", "Bentuk:", "Sejarah:" are task
    // scaffolding, not the actual answer — the user wants only the response.
    const cleaned = stripResponsePreamble(translated);
    log?.info?.("TRANSLATE_OUT", `translated response ${originalText.length} -> ${translated.length} chars`);
    return buildClaudeSSEStream(cleaned);
  } catch (err) {
    log?.warn?.("TRANSLATE_OUT", `failed: ${err.message} (fallback to original stream)`);
    return rawToStream(raw ?? "");
  }
}
