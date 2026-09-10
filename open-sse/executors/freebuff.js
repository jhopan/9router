import { randomInt, randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { BaseExecutor } from "./base.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { renameRequestTools, restoreResponseToolNames, restoreStreamToolNames } from "./freebuffToolMap.js";

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

const sessionPool = new Map(); // `${token}::${model}` -> { instanceId, runId, agentId, createdAt }
const tokenCooldown = new Map(); // token -> { until, reason }
const inflight = new Map(); // `${token}::${model}` -> Promise<session> (single-flight handshake)
const actingUserIds = new Map(); // token -> user id (x-freebuff-acting-user-id; CLI: GET /api/v1/me once)

// The official CLI sends x-freebuff-acting-user-id (the account's OWN id from
// GET /api/v1/me) on every chat and agent-runs call. Fetch once per token,
// cache forever — the id never changes for a token.
async function getActingUserId(token, signal) {
  if (actingUserIds.has(token)) return actingUserIds.get(token);
  try {
    const r = await proxyAwareFetch(`${UPSTREAM}/me`, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "Bun/1.3.14", Accept: "application/json" },
      signal,
    });
    if (r.ok) {
      const j = await r.json().catch(() => ({}));
      const id = j?.user?.id || j?.id || "";
      if (id) {
        actingUserIds.set(token, id);
        return id;
      }
    }
  } catch { /* best-effort — absent header is the CLI's own fallback */ }
  actingUserIds.set(token, "");
  return "";
}

const jitter = () => new Promise((r) => setTimeout(r, randomInt(0, JITTER_MAX_MS)));

function jsonError(status, message, type = "upstream_error", extra = {}) {
  return { response: new Response(JSON.stringify({ error: { message, type, ...extra } }), { status, headers: { "Content-Type": "application/json" } }) };
}

// 428 waiting_room_required — the upstream gate demands the CLI's pre-session
// "ad chain" before the next session create (issue #94 parity): POST
// /api/v1/ads for gravity + zeroclick (Freebuff-CLI UA on the wire, Chrome UA
// in the body, surface "waiting_room"), then GET /freebuff/streak. Strictly
// best-effort — the session row stays valid, nothing is invalidated.
async function fireWaitingRoomChain(token, signal) {
  const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  const headers = {
    Authorization: `Bearer ${token}`,
    "User-Agent": "Freebuff-CLI/1.0.0",
    "Content-Type": "application/json",
  };
  // gravity only — upstream rejected "zeroclick" with 400 invalid option
  // (verified live 2026-09-11); the reference list predates that change.
  for (const provider of ["gravity"]) {
    try {
      await proxyAwareFetch(`${UPSTREAM}/ads`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          provider,
          messages: [],
          device: { os: "windows", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Jakarta", locale: "id-ID" },
          userAgent: CHROME_UA,
          surface: "waiting_room",
        }),
        signal,
      });
    } catch { /* best-effort — swallow like the proxy does */ }
  }
  try {
    await proxyAwareFetch(`${UPSTREAM}/freebuff/streak`, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "Bun/1.3.14", Accept: "application/json" },
      signal,
    });
  } catch { /* best-effort */ }
}

export class FreebuffExecutor extends BaseExecutor {
  constructor() {
    super();
    this.provider = "freebuff";
  }

  // ── session pool (per token+model — upstream binds a session to one model;
  //    switching models on a live session returns 409 "restart to switch") ──
  async acquireSession(token, requestedModel, agentId, proxyOptions) {
    const now = Date.now();
    const poolKey = `${token}::${requestedModel}`;
    const existing = sessionPool.get(poolKey);
    if (existing && existing.runId && now < existing.expiresAt) return existing;

    // single-flight: concurrent requests share one handshake
    if (inflight.has(poolKey)) return inflight.get(poolKey);

    const p = (async () => {
      await jitter();
      const sessionRes = await proxyAwareFetch(`${UPSTREAM}/freebuff/session`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "Bun/1.3.14",
          // Upstream selects the model via this header (CLI parity: the
          // session POST is a bare fetch with Authorization + optional
          // x-freebuff-model). Without it upstream defaults to
          // deepseek-v4-flash (30 freebucks) → 429 even for cheaper models.
          "x-freebuff-model": requestedModel,
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
        const actingUserStart = await getActingUserId(token, null);
        const runRes = await proxyAwareFetch(`${UPSTREAM}/agent-runs`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": "Bun/1.3.14",
            ...(actingUserStart ? { "x-freebuff-acting-user-id": actingUserStart } : {}),
          },
          body: JSON.stringify({ action: "START", agentId, ancestorRunIds: [] }),
        });
        if (runRes.ok) runId = (await runRes.json().catch(() => ({}))).runId || "";
      } catch {}

      // trace_session_id mirrors the CLI: one random UUID per run, repeated
      // on every chat call of that run (freebuff-proxy ChatOptions.TraceSessionID).
      const traceSessionId = randomUUID();
      const session = { instanceId, runId, agentId, model: requestedModel, traceSessionId, createdAt: now, expiresAt: now + SESSION_TTL_MS };
      sessionPool.set(poolKey, session);
      return session;
    })();

    inflight.set(poolKey, p);
    try {
      return await p;
    } finally {
      inflight.delete(poolKey);
    }
  }

  invalidateSession(token, status = "completed", requestedModel = null) {
    // drop this token's session(s) — just the one model's unless unspecified
    const keys = requestedModel
      ? [`${token}::${requestedModel}`]
      : [...sessionPool.keys()].filter((k) => k.startsWith(`${token}::`));
    const s = sessionPool.get(keys[0]);
    for (const k of keys) sessionPool.delete(k);
    if (s?.runId) {
      // honest FINISH — the run actually lived this long
      void (async () => {
        const actingUserEnd = actingUserIds.get(token) || "";
        await proxyAwareFetch(`${UPSTREAM}/agent-runs`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": "Bun/1.3.14",
            ...(actingUserEnd ? { "x-freebuff-acting-user-id": actingUserEnd } : {}),
          },
          body: JSON.stringify({ action: "FINISH", runId: s.runId, status, totalSteps: 1, directCredits: 0, totalCredits: 0 }),
        }).catch(() => {});
      })();
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

    // 1. session (pooled, per token+model)
    let session;
    try {
      session = await this.acquireSession(token, requestedModel, agentId, proxyOptions);
    } catch (err) {
      if (err?.status === 429) {
        tokenCooldown.set(token, { until: Date.now() + 6 * 60 * 60 * 1000, reason: "upstream 429" });
        return jsonError(429, `FreeBuff quota: ${err.message}`, "rate_limit_error", { retryAfter: 6 * 3600 });
      }
      if (err?.status === 401 || err?.status === 403) {
        this.invalidateSession(token, "aborted", requestedModel);
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
    // CLI envelope parity (freebuff-proxy injectEnvelope):
    //  - codebuff_metadata: run_id/client_id/instance per session; reserved keys win
    //  - provider.data_collection = "deny" (the CLI always denies data collection)
    //  - stream forced true in the BODY (client-side stream choice handled by 9router)
    //  - stop sentinel: JSON-QUOTED "cb_easp" when the request has no stop of its own
    let upstreamBody = {
      ...payload,
      model: requestedModel,
      messages: incomingMessages,
      codebuff_metadata: {
        ...existingMetadata,
        run_id: session.runId,
        cost_mode: "free",
        client_id: CLIENT_ID,
        freebuff_instance_id: session.instanceId,
        ...(session.traceSessionId ? { trace_session_id: session.traceSessionId } : {}),
      },
      provider: { data_collection: "deny" },
      stream: true,
    };
    if (!Array.isArray(upstreamBody.stop) || upstreamBody.stop.length === 0) {
      upstreamBody.stop = ['"cb_easp"'];
    }
    if (typeof payload.reasoning_effort === "string" && payload.reasoning_effort) {
      upstreamBody.codebuff_metadata.freebuff_reasoning_effort = payload.reasoning_effort;
    }

    // Tool-name tolerance (freebuff-proxy parity #140): harnesses (Hermes,
    // Cline, ...) send their own tool names → zero signature tools → upstream
    // foreign_toolset gate downgrades the request ("No endpoints found").
    // Rename known names to signature equivalents on the wire; schemas stay
    // untouched; names are restored on every response path below.
    const { renamed: renamedTools, mapping: toolNameMapping } = renameRequestTools(upstreamBody.tools);
    if (renamedTools) upstreamBody.tools = renamedTools;

    // 4. chat completion — with ONE bounded retry: upstream binds a session to
    //    one model ("session is bound to X; restart freebuff to switch models").
    //    On 409, drop the pooled session, re-handshake (fresh instance binds to
    //    the new model), and retry the chat exactly once.
    const doChat = async (sess) => {
      // CLI parity (freebuff-proxy chat.go): the official CLI sends exactly
      // Authorization + the ai-sdk UA (+ x-freebuff-acting-user-id) on chat —
      // model and instance id ride ONLY in body codebuff_metadata. Other
      // x-freebuff-*/x-codebuff-* headers on chat are a third-party signal.
      const actingUser = await getActingUserId(token, signal);
      const completionHeaders = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "ai-sdk/openai-compatible/1.0.25/codebuff",
        Accept: "application/json, text/event-stream",
        ...(actingUser ? { "x-freebuff-acting-user-id": actingUser } : {}),
      };
      return proxyAwareFetch(`${UPSTREAM}/chat/completions`, {
        method: "POST",
        headers: completionHeaders,
        body: JSON.stringify(upstreamBody),
        signal,
      });
    };

    let response = await doChat(session);

    // 404 "No endpoints found" = the upstream routing node behind THIS instance
    // is gone (handshake reuses the same instance; only a fresh one lands on a
    // healthy node). Treat like 409: rotate honestly and re-handshake once.
    // 428 waiting_room_required (issue #94 parity): the session row is FINE —
    // the account just needs the CLI's pre-session ad-chain before the next
    // create. Fire the chain, honor Retry-After briefly, retry in place ONCE.
    // No cooldown, no session invalidation (freebuff-proxy classify.go).
    if (response.status === 428) {
      const errText428 = await response.text().catch(() => "");
      if (errText428.includes("waiting_room_required")) {
        await fireWaitingRoomChain(token, signal);
        response = null;
        try {
          session = await this.acquireSession(token, requestedModel, agentId, proxyOptions);
          response = await doChat(session);
        } catch (err) {
          if (err?.status === 429) {
            tokenCooldown.set(token, { until: Date.now() + 6 * 60 * 60 * 1000, reason: "upstream 429" });
            return jsonError(429, `FreeBuff quota: ${err.message}`, "rate_limit_error", { retryAfter: 6 * 3600 });
          }
          return jsonError(502, err.message || "FreeBuff upstream error");
        }
      }
    }

    if (response.status === 404) {
      const errText404 = await response.text().catch(() => "");
      if (errText404.includes("No endpoints found")) {
        response = null;
        // Release the poisoned slot FIRST (CLI parity: DELETE keyed on the
        // instance header). Upstream ends it with freebucksRefundPending:true,
        // so the next handshake lands on a FRESH instance/node instead of
        // returning the same dead one for the rest of its 1h lifetime.
        try {
          await proxyAwareFetch(`${UPSTREAM}/freebuff/session`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}`, "User-Agent": "Bun/1.3.14", "x-freebuff-instance-id": session.instanceId },
            signal,
          });
        } catch { /* best-effort — handshake still proceeds */ }
        this.invalidateSession(token, "aborted", requestedModel);
        try {
          session = await this.acquireSession(token, requestedModel, agentId, proxyOptions);
          response = await doChat(session);
        } catch (err) {
          if (err?.status === 429) {
            tokenCooldown.set(token, { until: Date.now() + 6 * 60 * 60 * 1000, reason: "upstream 429" });
            return jsonError(429, `FreeBuff quota: ${err.message}`, "rate_limit_error", { retryAfter: 6 * 3600 });
          }
          return jsonError(502, err.message || "FreeBuff upstream error");
        }
      }
    }

    if (response.status === 409) {
      const errText = await response.text().catch(() => "");
      response = null;
      // stale/bound session — rotate honestly and re-handshake once
      this.invalidateSession(token, "aborted", requestedModel);
      try {
        session = await this.acquireSession(token, requestedModel, agentId, proxyOptions);
        response = await doChat(session);
      } catch (err) {
        if (err?.status === 429) {
          tokenCooldown.set(token, { until: Date.now() + 6 * 60 * 60 * 1000, reason: "upstream 429" });
          return jsonError(429, `FreeBuff quota: ${err.message}`, "rate_limit_error", { retryAfter: 6 * 3600 });
        }
        return jsonError(502, err.message || "FreeBuff upstream error");
      }
      if (response.status === 409) {
        // second 409 — account-level lock (e.g. "another instance taken over"); surface it
        const errText2 = await response.text().catch(() => "");
        return jsonError(409, `FreeBuff session conflict: ${errText2.slice(0, 240)}`, "invalid_request_error");
      }
    }

    if (!response.ok && (response.status === 429 || response.status === 401 || response.status === 403)) {
      // session is burned — rotate honestly, lock on 429
      this.invalidateSession(token, response.status === 429 ? "completed" : "aborted", requestedModel);
      if (response.status === 429) {
        tokenCooldown.set(token, { until: Date.now() + 6 * 60 * 60 * 1000, reason: "upstream 429" });
        return jsonError(429, "FreeBuff daily quota exhausted for this token (resets Pacific midnight)", "rate_limit_error", { retryAfter: 6 * 3600 });
      }
      const errText = await response.text().catch(() => "");
      return jsonError(response.status, `FreeBuff rejected (${response.status}): ${errText.slice(0, 240)}`, "authentication_error");
    }

    // Restore client tool names on the response path (freebuff-proxy parity):
    //  - non-stream: parse+patch JSON tool_calls names
    //  - stream: rewrite SSE lines so delta.tool_calls names match the client's
    if (Object.keys(toolNameMapping).length > 0) {
      if (stream === false) {
        const text = await response.text().catch(() => "");
        try {
          const data = JSON.parse(text);
          restoreResponseToolNames(data, toolNameMapping);
          response = new Response(JSON.stringify(data), { status: response.status, headers: response.headers });
        } catch { /* non-JSON body — pass through */ }
      } else {
        const origBody = response.body;
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        const stream_ = new ReadableStream({
          async start(controller) {
            const reader = origBody.getReader();
            let buf = "";
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split("\n");
                buf = lines.pop() || "";
                for (const line of lines) {
                  controller.enqueue(encoder.encode(restoreStreamToolNames(line + "\n", toolNameMapping)));
                }
              }
              if (buf) controller.enqueue(encoder.encode(restoreStreamToolNames(buf, toolNameMapping)));
            } catch (e) {
              try { controller.error(e); } catch { /* client gone */ }
              return;
            }
            controller.close();
          },
        });
        response = new Response(stream_, { status: response.status, headers: response.headers });
      }
    }

    return { response };
  }
}
