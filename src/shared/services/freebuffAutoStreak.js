// FreeBuff Auto-Streak (maturity-style, freebuff-proxy maturity.go parity):
// keeps each account's daily activity alive so the upstream streak/entitlement
// keeps growing. Once per Pacific day per connection, if the account hasn't
// been used naturally, claim a session on the CHEAPEST model (from live
// prices) and send one tiny chat.
//
// Safety posture (mirrors freebuff-proxy maturity.go §4):
// - one tiny request per connection per day, never more
// - DAILY RE-ROLLED SLOT in the account's own timezone (Pacific, where the
//   upstream rolls its windows) — the firing time changes every day and on
//   every restart, so no fixed-hour pattern exists to detect
// - restart-safe 6h throttle bounds the worst case to one extra cheap touch
// - skip when upstream reports activity today (todayUsed) or when the account
//   was used naturally — real usage makes the day indistinguishable
// - TARGET + auto-release: when the streak reaches the target (default 7),
//   automation disables itself for that connection until the streak lapses
// - ANTI-BLIND loop: 3 consecutive days where a touch didn't advance the
//   streak stops the automation with a warning flag
// - health gates: never touch an account upstream already flagged (banned,
//   country-blocked) or cooling down from a recent failure
// - model chosen from upstream's live `prices` map against current remaining
//   balance — never fires when no affordable model exists

import { getProviderConnections, updateProviderConnection, getSettings } from "@/lib/localDb";
import { getFreebuffUsage } from "open-sse/services/usage/freebuff.js";
import { FREEBUFF_AUTOSTREAK_CONFIG as C } from "@/shared/constants/config";
import { getExecutor } from "open-sse/executors/index.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

// Survive Next.js hot reload; one scheduler per server process.
const g = (global.__freebuffAutoStreak ??= {
  interval: null,
  running: false,
  failureCache: {},
  // per-connection in-memory state (restart-safe values live on the connection row)
  slots: {},        // connId -> { day, slotMs }   — re-rolled daily
  lastTouch: {},    // connId -> ms
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

/**
 * Deterministic-but-daily slot: the minute-of-day this connection fires.
 * Hash(connId + dayKey) — stable within one Pacific day, re-rolled when the
 * day changes (and therefore after every reset). Restart-safe: same day =
 * same slot, and the 6h throttle plus todayUsed bound any double-fire.
 * Window [windowStartHour, windowEndHour) keeps touches in daylight-ish
 * hours; the dayKey in the hash is what makes the hour change daily.
 */
export function slotMinuteOfDay(connectionId, dayKey, startHour = C.windowStartHour, endHour = C.windowEndHour) {
  const s = `${connectionId}::${dayKey}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h * 131) + s.charCodeAt(i)) >>> 0;
  const windowMinutes = Math.max(60, (endHour - startHour) * 60);
  return startHour * 60 + (h % windowMinutes);
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

// ── maturity state helpers (persisted on the connection row) ──────────────

function maturityState(connection) {
  return connection.providerSpecificData?.maturity || {};
}

/** Anti-blind loop: 3 consecutive touch-days without streak advance → warn + stop. */
function isBlindBlocked(m) {
  return m.warn === true || (m.noAdvanceDays || 0) >= C.noAdvanceLimit;
}

async function saveMaturity(conn, patch) {
  await updateProviderConnection(conn.id, {
    providerSpecificData: {
      ...(conn.providerSpecificData || {}),
      maturity: { ...(conn.providerSpecificData?.maturity || {}), ...patch },
    },
    updatedAt: new Date().toISOString(),
  });
}

async function runStreakForConnection(connection, proxyOptions) {
  const dayKey = pacificDayKey();
  const connId = connection.id;
  const m = maturityState(connection);

  // Anti-blind loop: automation stopped itself after repeated no-advance days.
  if (isBlindBlocked(m)) {
    return { skipped: true, reason: "maturity warned (3 days no streak advance) — manual re-enable required" };
  }

  // Target reached earlier → released; only re-engage if the streak lapsed
  // below the target again (mirrors maturityRelockWatch: 2 consecutive
  // below-target days re-arm; one bad day is noise).
  if (m.released && m.releasedTarget > 0 && m.lastStreak >= m.releasedTarget - 1) {
    return { skipped: true, reason: "target reached — released" };
  }

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
  // Health gate: never poke an account upstream already flagged.
  if (usage?.activeInstance === null && usage?.message?.includes("banned")) {
    await saveMaturity(connection, { warn: true, lastResult: "skip:banned" });
    return { skipped: true, reason: "account flagged upstream (banned) — automation stopped" };
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

  const streakNow = Number(usage?.streak?.streak);
  const prevStreak = Number.isFinite(m.lastStreak) ? m.lastStreak : null;
  const advanced = prevStreak === null ? true : streakNow > prevStreak || usage?.streak?.todayUsed === true;
  const noAdvanceDays = advanced ? 0 : (m.noAdvanceDays || 0) + 1;
  const reachedTarget = streakNow >= (m.target || C.targetDays);
  const warn = noAdvanceDays >= C.noAdvanceLimit;

  await updateProviderConnection(connId, {
    lastStreakDayKey: dayKey,
    lastStreakAt: new Date().toISOString(),
    lastStreakModel: model,
    lastStreakCost: price,
    providerSpecificData: {
      ...(connection.providerSpecificData || {}),
      maturity: {
        ...m,
        lastStreak: Number.isFinite(streakNow) ? streakNow : m.lastStreak,
        lastTouchDay: dayKey,
        lastResult: "ok",
        lastAdvanced: advanced ? "yes" : "no",
        noAdvanceDays: warn ? C.noAdvanceLimit : noAdvanceDays,
        warn: warn || m.warn === true,
        released: reachedTarget ? true : m.released === true,
        releasedTarget: reachedTarget ? (m.target || C.targetDays) : m.releasedTarget,
      },
    },
    updatedAt: new Date().toISOString(),
  });
  return { skipped: false, model, price, advanced, noAdvanceDays, reachedTarget, streakNow };
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

  const dayKey = pacificDayKey(now.getTime());
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  const startMin = (Number(cfg.windowStartHour) || C.windowStartHour) * 60;
  const endMin = (Number(cfg.windowEndHour) || C.windowEndHour) * 60;

  for (const conn of conns) {
    if (!enabledIds.includes(conn.id)) continue;
    if (shouldSkipAfterFailure(conn.id)) continue;

    // 6h restart-safe throttle: even if a slot re-rolls after a restart, the
    // same connection cannot fire twice within 6 hours (worst case one extra
    // cheap touch, bounded — freebuff-proxy maturityThrottle parity).
    const lastMs = g.lastTouch[conn.id] || (conn.lastStreakAt ? new Date(conn.lastStreakAt).getTime() : 0);
    if (lastMs && now.getTime() - lastMs < C.touchThrottleMs) continue;

    // DAILY RE-ROLLED SLOT (maturity parity): minute-of-day derived from
    // hash(connId + pacificDay) — changes every day AND per account, so no
    // fixed-hour pattern exists. Accounts still never fire simultaneously.
    const slot = slotMinuteOfDay(conn.id, dayKey, startMin / 60, endMin / 60);
    if (minutesNow < slot) continue; // slot not reached yet today

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
        const warnLine = r.warn ? " | WARN: no-advance limit reached, automation paused" : "";
        const releaseLine = r.reachedTarget ? ` | TARGET REACHED (${r.streakNow} days) — auto-released` : "";
        console.log(`[FB_STREAK] ${conn.name}: streak ok — ${r.model} (${r.price} fb)${releaseLine}${warnLine}`);
        g.lastTouch[conn.id] = now.getTime();
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
