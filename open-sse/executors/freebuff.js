import { randomInt } from "node:crypto";
import { createHash } from "node:crypto";
import { BaseExecutor } from "./base.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

/**
 * FreebuffExecutor — native Codebuff/FreeBuff free-tier provider.
 *
 * Wire lifecycle (ported from OmniRoute's open-sse/executors/freebuff.ts) and
 * upgraded with freebuff-proxy's stealth-soft techniques:
 *
 *  1. SESSION POOLING — one upstream session per token, reused across requests
 *     (hot session). Handshake (POST /freebuff/session) only on first use or
 *     after TTL/invalidation. Single-flight: concurrent requests share one
 *     handshake. This is what a real CLI looks like upstream.
 *  2. HONEST RUN LIFECYCLE — START once per session; FINISH only when the
 *     session is rotated/invalidated (NOT "completed totalSteps:1" per chat —
 *     that false report is a third-party-client signature).
 *  3. STABLE client_id — 13-char base36 derived from the machine hash, like the
 *     real CLI (one device = one id), NOT random per request.
 *  4. PER-ENDPOINT UA — Bun/1.3.14 on session/auth, ai-sdk/openai-compatible on
 *     chat (matches the official CLI's split).
 *  5. JITTER — 0-200ms random delay on handshakes only (chat latency matters).
 *  6. 429 QUOTA LOCK — parse upstream reset, cooldown the token in-memory,
 *     surface a structured error so 9router's account-fallback moves on without
 *     touching upstream again.
 *
 * Known limitation (accepted): TLS fingerprint stays Node's (no uTLS in Node);
 * everything above minimizes the remaining detection surface.
 */

const UPSTREAM = "https://www.codebuff.com/api/v1";
const SESSION_TTL_MS = 5 * 60 * 60 * 1000; // < the 6h run rotation window
const JITTER_MAX_MS = 200;

// model id (without the freebuff/ prefix) → upstream free agent id
const MODEL_TO_AGENT = {
  "deepseek/deepseek-v4-flash": "base2-free-deepseek-flash",
  "deepseek/deepseek-v4-pro": "base2-free-deepseek",
  "openai/gpt-5.6-luna": "base2-free-luna",
  "minimax/minimax-m3": "base2-free-minimax-m3",
  "mimo/mimo-v2.5": "base2-free-mimo",
  "z-ai/glm-5.2": "base2-free-glm",
  "z-ai/glm-5.3-flash": "base2-free-glm-5-3-flash",
  "crof/kimi-k3-eco": "base2-free-kimi-k3-eco",
  "anthropic/claude-fable-5": "base2-free-fable",
  "meta/muse-spark-1.2-contributor": "base2-free-muse-spark",
};

const BUFFY_PROMPT = "You are Buffy, the strategic coding assistant.";

// ── stable per-machine client id (13-char base36, like the CLI) ──
function machineClientId() {
  const hash = createHash("sha256")
    .update(`${process.env.COMPUTERNAME || process.env.HOSTNAME || "9router"}:freebuff-executor`)
    .digest("hex");
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  let out = "";
  let i = 0;
  // fill 13 chars deterministically from the hash
  while (out.length < 13) {
    out += alphabet[parseInt(hash.slice(i % hash.length, (i % hash.length) + 2), 16) % alphabet.length];
    i += 2;
  }
  return out;
}
const CLIENT_ID = machineClientId();

const sessionPool = new Map(); // token -> { instanceId, runId, agentId, createdAt }
const tokenCooldown = new Map(); // token -> { until, reason }
const inflight = new Map(); // token -> Promise<session> (single-flight handshake)

const jitter = () => new Promise((r) => setTimeout(r, randomInt(0, JITTER_MAX_MS)));

function jsonError(status, message, type = "upstream_error", extra = {}) {
  return { response: new Response(JSON.stringify({ error: { message, type, ...extra } }), { status, headers: { "Content-Type": "application/json" } }) };
}

export class FreebuffExecutor {
  constructor() {
    this.provider = "freebuff";
  }

  // ── session pool ──────────────────────────────────────────────────────────
  async acquireSession(token, agentId, proxyOptions) {
    const now = Date.now();
    const existing = sessionPool.get(token);
    if (existing && existing.runId && now < existing.expiresAt) return existing;

    // single-flight: concurrent requests share one handshake
    if (inflight.has(token)) return inflight.get(token);

    const p = (async () => {
      await jitter();
      const sessionRes = await proxyAwareFetch(`${UPSTREAM}/freebuff/session`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "Bun/1.3.14",
        },
        body: JSON.stringify({}),
      }).catch((e) => { throw new Error(`FreeBuff session network error: ${e.message}`); });

      if (!sessionRes.ok) {
        const errText = await sessionRes.text().catch(() => "");
        throw Object.assign(new Error(`FreeBuff session failed (${sessionRes.status}): ${errText.slice(0, 240)}`), { status: sessionRes.status });
      }
      const data = await sessionRes.json().catch(() => ({}));
      const instanceId = data.instanceId || "";

      // one agent-run per session (START) — honest lifecycle
      let runId = "";
      try {
        const runRes = await proxyAwareFetch(`${UPSTREAM}/agent-runs`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "Bun/1.3.14" },
          body: JSON.stringify({ action: "START", agentId }),
        });
        if (runRes.ok) runId = (await runRes.json().catch(() => ({}))).runId || "";
      } catch {}

      const session = { instanceId, runId, agentId, createdAt: now, expiresAt: now + SESSION_TTL_MS };
      sessionPool.set(token, session);
      return session;
    })();

    inflight.set(token, p);
    try {
      return await p;
    } finally {
      inflight.delete(token);
    }
  }

  invalidateSession(token, status = "completed") {
    const s = sessionPool.get(token);
    sessionPool.delete(token);
    if (s?.runId) {
      // honest FINISH — the run actually lived this long
      void proxyAwareFetch(`${UPSTREAM}/agent-runs`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "Bun/1.3.14" },
        body: JSON.stringify({ action: "FINISH", runId: s.runId, status, totalSteps: 1, directCredits: 0, totalCredits: 0 }),
      }).catch(() => {});
    }
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const token = credentials?.apiKey || credentials?.accessToken || "";
    if (!token) {
      return jsonError(401, "FreeBuff auth token required (set the connection API key to your cb_... / CLI authToken)", "authentication_error");
    }

    // 429 quota lock — answer locally, don't touch upstream
    const cooldown = tokenCooldown.get(token);
    if (cooldown && Date.now() < cooldown.until) {
      const waitMin = Math.ceil((cooldown.until - Date.now()) / 60000);
      return jsonError(429, `FreeBuff daily quota exhausted for this token (resets ${cooldown.reason || "at Pacific midnight"}); retry in ~${waitMin}m`, "rate_limit_error", { retryAfter: Math.ceil((cooldown.until - Date.now()) / 1000) });
    }
    if (cooldown && Date.now() >= cooldown.until) tokenCooldown.delete(token);

    const payload = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    const requestedModel =
      typeof model === "string" ? model.replace(/^freebuff\//, "") : model || "deepseek/deepseek-v4-flash";
    const agentId = MODEL_TO_AGENT[requestedModel] || "base2-free";

    // 1. session (pooled)
    let session;
    try {
      session = await this.acquireSession(token, agentId, proxyOptions);
    } catch (err) {
      if (err?.status === 429) {
        tokenCooldown.set(token, { until: Date.now() + 6 * 60 * 60 * 1000, reason: "upstream 429" });
        return jsonError(429, `FreeBuff quota: ${err.message}`, "rate_limit_error", { retryAfter: 6 * 3600 });
      }
      if (err?.status === 401 || err?.status === 403) {
        this.invalidateSession(token, "aborted");
        return jsonError(err.status, `FreeBuff auth rejected: ${err.message.slice(0, 240)}`, "authentication_error");
      }
      return jsonError(502, err.message || "FreeBuff upstream error");
    }

    // 2. messages + Buffy system prompt (skip when the caller already provides it)
    const incomingMessages = Array.isArray(payload.messages)
      ? payload.messages.filter((m) => !!m && typeof m === "object" && !Array.isArray(m))
      : [];
    const first = incomingMessages[0];
    const hasBuffy =
      incomingMessages.length > 0 && first?.role === "system" &&
      typeof first.content === "string" && first.content.trim().startsWith("You are Buffy");
    if (!hasBuffy) incomingMessages.unshift({ role: "system", content: BUFFY_PROMPT });

    // 3. upstream body — OpenAI shape + codebuff_metadata
    const existingMetadata = payload.codebuff_metadata && typeof payload.codebuff_metadata === "object" ? payload.codebuff_metadata : {};
    const upstreamBody = {
      ...payload,
      model: requestedModel,
      messages: incomingMessages,
      stream: stream !== false,
      codebuff_metadata: {
        run_id: session.runId,
        cost_mode: "free",
        client_id: CLIENT_ID,
        freebuff_instance_id: session.instanceId,
        ...existingMetadata,
      },
    };

    const completionHeaders = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "ai-sdk/openai-compatible/1.0.25/codebuff",
      Accept: stream !== false ? "text/event-stream" : "application/json, text/event-stream",
      "x-freebuff-instance-id": session.instanceId,
      ...(session.runId ? { "x-codebuff-run-id": session.runId } : {}),
      "x-codebuff-agent-id": agentId,
    };

    // 4. chat completion
    const response = await proxyAwareFetch(`${UPSTREAM}/chat/completions`, {
      method: "POST",
      headers: completionHeaders,
      body: JSON.stringify(upstreamBody),
      signal,
    });

    if (!response.ok && (response.status === 429 || response.status === 401 || response.status === 403)) {
      // session is burned — rotate honestly, lock on 429
      this.invalidateSession(token, response.status === 429 ? "completed" : "aborted");
      if (response.status === 429) {
        tokenCooldown.set(token, { until: Date.now() + 6 * 60 * 60 * 1000, reason: "upstream 429" });
        return jsonError(429, "FreeBuff daily quota exhausted for this token (resets Pacific midnight)", "rate_limit_error", { retryAfter: 6 * 3600 });
      }
      const errText = await response.text().catch(() => "");
      return jsonError(response.status, `FreeBuff rejected (${response.status}): ${errText.slice(0, 240)}`, "authentication_error");
    }

    return { response };
  }
}
