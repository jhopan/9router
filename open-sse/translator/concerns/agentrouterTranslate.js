/**
 * agentrouterTranslate.js
 *
 * AgentRouter only accepts requests in a fixed set of languages
 * (Mandarin, English, French, German, Russian). To avoid 400 "content-blocked"
 * false-positives caused by Indonesian (or mixed-language) prompts, this module
 * rewrites user-facing message text to English BEFORE the request is forwarded
 * to agentrouter.org.
 *
 * It self-invokes the local 9Router "translate" combo (which is a small,
 * fast, non-thinking model) via HTTP, then swaps the translated text back in.
 *
 * Fail-open: any error (translate model down, no API key, timeout, bad combo)
 * leaves the body untouched and returns it unchanged — translation must never
 * break a request.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { getApiKeys } from "@/lib/db/repos/apiKeysRepo.js";

const TRANSLATE_MODEL = "translate";

// System prompt forcing a clean, literal English translation (no explanation).
// The translate combo is a fast instruction-following model; keep it terse.
const TRANSLATE_SYSTEM =
  "You are a translation engine. Translate the user's message to clear, natural English. " +
  "Return ONLY the translated text. Do not add explanations, commentary, or quotes.";

function localBaseUrl() {
  const port = process.env.PORT || "20127";
  return `http://localhost:${port}`;
}

async function resolveApiKey() {
  const keys = await getApiKeys();
  const activeKeys = keys.filter((k) => k.isActive);
  return (activeKeys[0]?.key || keys[0]?.key || "").trim();
}

// Translate a single string to English via the local "translate" combo.
async function translateText(text, apiKey, baseUrl, log) {
  if (typeof text !== "string" || text.trim() === "") return text;

  const body = {
    model: TRANSLATE_MODEL,
    stream: true,
    max_tokens: 400,
    messages: [
      // Instruction folded into the user message: some combo models drop the
      // `system` role, so keeping the translate directive in the user turn
      // guarantees the model actually translates (short terse English).
      { role: "user", content: `${TRANSLATE_SYSTEM}\n\nTranslate this text to English: ${text}` },
    ],
  };

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
    log?.warn?.("TRANSLATE", `fetch failed: ${err.message}`);
    return text;
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 150);
    } catch {
      /* ignore */
    }
    log?.warn?.("TRANSLATE", `combo returned ${response.status}: ${detail}`);
    return text;
  }

  try {
    // Streaming response: reader accumulates text deltas.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let full = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      full += decoder.decode(value, { stream: true });
    }

    const translated = extractChoicesContent(full);
    if (translated && translated.trim()) {
      return translated.trim();
    }
  } catch (err) {
    log?.warn?.("TRANSLATE", `stream parse failed: ${err.message}`);
  }

  return text;
}

// Parse SSE/chunked chat.completions output and pull the first assistant content.
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

/**
 * Translate every user-role message's text content to English, in place.
 * Only touches `content` that is a string or an array of text/string blocks.
 * Mutates `body.messages`. Returns the same object (fail-open).
 */
export async function translateAgentRouterBody(body, log) {
  if (!body || !Array.isArray(body.messages)) return body;

  // Only run when the target is agentrouter — guarded by the caller.
  const apiKey = await resolveApiKey();
  if (!apiKey) {
    log?.warn?.("TRANSLATE", "no active API key; skipping translation");
    return body;
  }
  const baseUrl = localBaseUrl();

  const messages = body.messages;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    // Only user turns carry user-authored text to translate.
    if (msg.role !== "user") continue;

    const content = msg.content;
    if (typeof content === "string") {
      messages[i] = { ...msg, content: await translateText(content, apiKey, baseUrl, log) };
    } else if (Array.isArray(content)) {
      const newBlocks = [];
      let changed = false;
      for (const block of content) {
        if (block && block.type === "text" && typeof block.text === "string") {
          const translated = await translateText(block.text, apiKey, baseUrl, log);
          newBlocks.push({ ...block, text: translated });
          if (translated !== block.text) changed = true;
        } else {
          newBlocks.push(block);
        }
      }
      if (changed) messages[i] = { ...msg, content: newBlocks };
    }
    // tool_result blocks inside user messages: leave as-is (they are upstream data).
  }

  return body;
}
