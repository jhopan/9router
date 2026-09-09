// FreeBuff Auto-Streak: keeps each account's daily activity alive so the
// upstream streak/entitlement keeps growing. Once per Pacific day per
// connection, if the account hasn't been used naturally, claim a session on
// the CHEAPEST model (from live prices) and send one tiny chat.
//
// Safety posture (farm-pattern avoidance):
// - one tiny request per connection per day, never more
// - per-connection jittered slot inside a user-configured window (07:00-10:00
//   WIB default) — accounts never fire simultaneously
// - skip when the account already has usage today (user used it naturally)
// - skip (never retry-storm) on 409 model_locked — the account's live session
//   belongs to another model, which already proves activity today
// - model chosen from upstream's live `prices` map against current remaining
//   balance — nothing hardcoded; upstream repricing is picked up automatically

import { getProviderConnections, updateProviderConnection, getSettings } from "@/lib/localDb";
import { getFreebuffUsage } from "open-sse/services/usage/freebuff.js";
import { FREEBUFF_AUTOSTREAK_CONFIG as C } from "@/shared/constants/config";
import { getExecutor } from "open-sse/executors/index.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

// Survive Next.js hot reload; one scheduler per server process.
const g = (global.__freebuffAutoStreak ??= {
  interval: null,
  running: false,
  failureCache: {},
});

/** Pacific-day key (the upstream quota day) for a timestamp. */
export function pacificDayKey(nowMs = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
}

/** Deterministic per-connection minute offset inside the window (stable across restarts). */
export function slotOffsetMinutes(connectionId, windowMinutes = C.windowMinutes) {
  let h = 0;
  const s = String(connectionId || "x");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % windowMinutes;
}

/** Pick cheapest model the current balance can afford. Returns [model, price] or [null, 0]. */
export function pickCheapestModel(prices = {}, remaining = 0) {
  let best = null;
  let bestPrice = Infinity;
  for (const [model, price] of Object.entries(prices)) {
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0) continue;
    // skip models 9router can't drive (no agent mapping) — muse-spark variant naming etc.
    if (!/^(z-ai|mimo|upstage|crof|deepseek|openai|minimax)\//.test(model)) continue;
    if (p < bestPrice && p <= remaining) {
      best = model;
      bestPrice = p;
    }
  }
  return [best, bestPrice === Infinity ? 0 : bestPrice];
}

function shouldSkipAfterFailure(connectionId, nowMs = Date.now()) {
  const at = g.failureCache[connectionId];
  return at && nowMs - at < C.failureCooldownMs;
}

/** Has this connection been used naturally today (pacific day)? */
async function usedNaturallyToday(connection, dayKey) {
  if (connection.lastStreakDayKey === dayKey) return true; // streak already sent today
  if (connection.lastStreakAt && pacificDayKey(new Date(connection.lastStreakAt).getTime()) === dayKey) return true;
  try {
    const { getUsageHistory } = await import("@/lib/db/index.js");
    const since = new Date(); since.setHours(0, 0, 0, 0); since.setDate(since.getDate() - 2);
    const hist = await getUsageHistory({ provider: "freebuff", startDate: since.toISOString() });
    return (hist || []).some((h) => {
      if (h.connectionId && connection.id && h.connectionId !== connection.id) return false;
      return pacificDayKey(new Date(h.timestamp).getTime()) === dayKey;
    });
  } catch {
    return false;
  }
}

async function runStreakForConnection(connection, proxyOptions) {
  const dayKey = pacificDayKey();
  const connId = connection.id;

  if (await usedNaturallyToday(connection, dayKey)) {
    return { skipped: true, reason: "already active today" };
  }

  // 1) zero-cost probe: balance + prices + active instance + STREAK
  const usage = await getFreebuffUsage(connection.accessToken, proxyOptions);
  // Upstream truth beats inference: todayUsed=true means activity is already
  // recorded today — skip without spending anything.
  if (usage?.streak?.todayUsed === true) {
    return { skipped: true, reason: "upstream says active today (streak)" };
  }
  const remaining = Number(usage?.freebucks?.daily?.remaining);
  const prices = usage?.freebucks?.prices || {};
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return { skipped: true, reason: "no balance data or empty balance" };
  }

  const [model, price] = pickCheapestModel(prices, remaining);
  if (!model) {
    return { skipped: true, reason: "no affordable model in price map" };
  }

  // 2) one tiny chat on the cheapest model (claims the session → counts as activity)
  const executor = getExecutor("freebuff");
  const { response } = await executor.execute({
    model,
    stream: true,
    credentials: {
      accessToken: connection.accessToken,
      connectionId: connId,
      providerSpecificData: connection.providerSpecificData,
    },
    proxyOptions,
    log: console,
    body: {
      model,
      stream: true,
      max_tokens: C.pingMaxTokens,
      messages: [{ role: "user", content: C.pingText }],
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    // 409 model_locked / 429 quota → the account is either active today or
    // cannot claim; both mean "do not retry today". Never hammer.
    if (response.status === 409 || response.status === 429) {
      return { skipped: true, reason: `upstream ${response.status} — treating as active/blocked today` };
    }
    throw new Error(`streak chat failed (${response.status}): ${text.slice(0, 160)}`);
  }
  // drain the stream so the run completes honestly
  await response.text().catch(() => {});

  await updateProviderConnection(connId, {
    lastStreakDayKey: dayKey,
    lastStreakAt: new Date().toISOString(),
    lastStreakModel: model,
    lastStreakCost: price,
    updatedAt: new Date().toISOString(),
  });
  return { skipped: false, model, price };
}

async function processConnections(now = new Date()) {
  const settings = await getSettings();
  const cfg = settings?.freebuffAutoStreak || {};
  if (cfg.enabled !== true) return;

  const conns = await getProviderConnections({ provider: "freebuff", isActive: true });
  const enabledIds = Object.entries(cfg.connections || {})
    .filter(([, on]) => on === true)
    .map(([id]) => id);
  if (enabledIds.length === 0) return;

  const minutesNow = now.getHours() * 60 + now.getMinutes();
  const startMin = (Number(cfg.windowStartHour) || C.windowStartHour) * 60;
  const endMin = (Number(cfg.windowEndHour) || C.windowEndHour) * 60;

  for (const conn of conns) {
    if (!enabledIds.includes(conn.id)) continue;
    if (shouldSkipAfterFailure(conn.id)) continue;

    // per-connection slot inside the window — accounts fire one by one,
    // never simultaneously (anti-farm), even if all are enabled
    const slot = startMin + slotOffsetMinutes(conn.id, Math.max(1, endMin - startMin));
    if (minutesNow < slot) continue; // window not reached for this account yet

    const proxyCfg = await resolveConnectionProxyConfig(conn.providerSpecificData).catch(() => ({}));
    const proxyOptions = {
      connectionProxyEnabled: proxyCfg.connectionProxyEnabled === true,
      connectionProxyUrl: proxyCfg.connectionProxyUrl || "",
      connectionNoProxy: proxyCfg.connectionNoProxy || "",
      vercelRelayUrl: proxyCfg.vercelRelayUrl || "",
      strictProxy: false,
    };

    try {
      const r = await runStreakForConnection(conn, proxyOptions);
      if (r.skipped) {
        console.log(`[FB_STREAK] ${conn.name}: skip — ${r.reason}`);
      } else {
        console.log(`[FB_STREAK] ${conn.name}: streak ok — ${r.model} (${r.price} fb)`);
      }
    } catch (e) {
      g.failureCache[conn.id] = Date.now();
      console.warn(`[FB_STREAK] ${conn.name}: failed — ${e.message}`);
    }
  }
}

export async function runFreebuffAutoStreakTick() {
  if (g.running) return;
  g.running = true;
  try {
    await processConnections();
  } catch (e) {
    console.warn("[FB_STREAK] tick error:", e.message);
  } finally {
    g.running = false;
  }
}

export function startFreebuffAutoStreak() {
  if (g.interval) return;
  console.log("[FB_STREAK] scheduler started");
  runFreebuffAutoStreakTick().catch(() => {});
  g.interval = setInterval(() => runFreebuffAutoStreakTick().catch(() => {}), C.tickIntervalMs);
  if (g.interval.unref) g.interval.unref();
}

export function stopFreebuffAutoStreak() {
  if (!g.interval) return;
  clearInterval(g.interval);
  g.interval = null;
  console.log("[FB_STREAK] scheduler stopped");
}

export async function configureFreebuffAutoStreak(settings) {
  const enabled = settings?.freebuffAutoStreak?.enabled === true;
  if (enabled) startFreebuffAutoStreak();
  else stopFreebuffAutoStreak();
}
