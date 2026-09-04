import { NextResponse } from "next/server";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { getApiKeys } from "@/lib/localDb";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { getConsistentMachineId } from "@/shared/utils/machineId";

const CLI_TOKEN_SALT = "9r-cli-auth";

// 8x8 red PNG — smallest real image most vision APIs accept (some reject 1x1).
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z8Dwn4GBgYGJgQoAAF9rAgOQ0tG7AAAAAElFTkSuQmCC";

async function getInternalHeaders() {
  let apiKey = null;
  try {
    const keys = await getApiKeys();
    apiKey = keys.find((k) => k.isActive !== false)?.key || null;
  } catch {}
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  headers["x-9r-cli-token"] = await getConsistentMachineId(CLI_TOKEN_SALT);
  return headers;
}

function detectReasoningFromResponse(parsed) {
  const msg = parsed?.choices?.[0]?.message || {};
  const reasoning =
    msg.reasoning || msg.reasoning_content || msg.thinking || msg.thinking_content;
  return typeof reasoning === "string" ? reasoning.trim().length > 0 : !!reasoning;
}

// POST /api/models/detect-caps — probe a model for vision/reasoning support.
// Body: { model: "alias/model-id" }
// Returns { ok, caps: { vision, reasoning }, detail: { vision, reasoning } }
export async function POST(request) {
  try {
    const { model } = await request.json();
    if (!model || !model.includes("/")) {
      return NextResponse.json({ error: "Model required (alias/model-id)" }, { status: 400 });
    }
    const headers = await getInternalHeaders();
    const base = `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`;

    // Split alias/model for the heuristic lookup (no request needed).
    const slash = model.indexOf("/");
    const providerAlias = model.slice(0, slash);
    const modelId = model.slice(slash + 1);

    // Heuristic pass (tabel + pattern + nama) — instan, tanpa request.
    const heur = getCapabilitiesForModel(providerAlias, modelId);
    const caps = {
      vision: !!heur.vision,
      reasoning: !!heur.reasoning,
    };
    const detail = {
      vision: "heuristic",
      reasoning: "heuristic",
      contextWindow: heur.contextWindow,
      thinkingFormat: heur.thinkingFormat,
    };

    // Probe 1: text-only — hidup? + reasoning field?
    let textOk = false;
    try {
      const res = await fetch(`${base}/api/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          max_tokens: 1024, // reasoning models burn budget on chain-of-thought first
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) {
        const parsed = await res.json().catch(() => null);
        const hasChoices = Array.isArray(parsed?.choices) && parsed.choices.length > 0;
        if (hasChoices) {
          textOk = true;
          const hasReasoning = detectReasoningFromResponse(parsed);
          if (hasReasoning) {
            caps.reasoning = true;
            detail.reasoning = "probe (thinking field in response)";
          } else {
            // Negative probe overrides heuristic OFF? No — heuristic table entries
            // (e.g. deepseek tables) are trusted upstream data; absence in one
            // short "hi" response is not proof of no-reasoning. Keep heuristic.
            detail.reasoning = caps.reasoning ? "heuristic (no thinking field in short response)" : "none detected";
          }
        }
      }
    } catch {}

    // Probe 2: image — vision? (only if heuristic didn't already say yes)
    let visionOk = false;
    if (!caps.vision) {
      try {
        const res = await fetch(`${base}/api/v1/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model,
            max_tokens: 64,
            stream: false,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "What color is this image? One word." },
                  { type: "image_url", image_url: { url: `data:image/png;base64,${TINY_PNG_B64}` } },
                ],
              },
            ],
          }),
          signal: AbortSignal.timeout(20000),
        });
        if (res.ok) {
          const parsed = await res.json().catch(() => null);
          const msg = parsed?.choices?.[0]?.message;
          const content = typeof msg?.content === "string" ? msg.content.trim() : "";
          // Who actually answered? The Vision Adapter (combo image) may intercept
          // a vision-less target and switch the request — the response then comes
          // from a DIFFERENT model. That switch is itself proof the target cannot
          // see images, so credit vision only when the TARGET answered.
          const respondedModel = String(parsed?.model || "");
          const targetId = model.split("/").pop() || model;
          const switched = respondedModel !== "" && !respondedModel.includes(targetId);
          if (switched) {
            caps.vision = false;
            detail.vision = `combo-switched (answered by ${respondedModel}, not the target)`;
          } else if (content.length > 0) {
            // 200 + non-error content after an image from the TARGET itself = it
            // accepted image input. A vision-less model typically 400s on image
            // blocks; empty-but-200 is weak evidence and keeps heuristic (off).
            visionOk = true;
            caps.vision = true;
            detail.vision = "probe (answered about the image)";
          }
        }
      } catch {}
    } else {
      visionOk = true;
      detail.vision = "heuristic (known vision model)";
    }

    return NextResponse.json({
      ok: textOk || visionOk,
      caps,
      detail,
      note: "heuristic = nama/tabel dikenal; probe = terverifikasi lewat request nyata",
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
