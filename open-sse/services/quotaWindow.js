// Quota-window resolver: how long to park a connection after its free tier
// refuses a request.
//
// Order of truth:
//   1. The provider's own reset timestamp (usage API — already implemented per
//      provider). Exact: Kiro reports a date, Antigravity a weekly bucket
//      resetTime, Codex a window reset_at.
//   2. A calendar computation for the provider's cadence (session/daily/
//      weekly/monthly) when the usage API is unavailable or silent.
//
// Everything here is best-effort and must never throw into the request path:
// callers get a usable cooldown even when upstream is unreachable.

import { quotaWindowFor, QUOTA_SCOPES, isQuotaExhaustedError, calendarResetMs } from "../config/quotaWindows.js";
import { getUsageForProvider } from "./usage.js";

export { quotaWindowFor, QUOTA_SCOPES, isQuotaExhaustedError, calendarResetMs };

// Usage probes are cached per connection so a burst of failures on one account
// costs one upstream call, and a failing usage API doesn't get hammered.
const USAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const USAGE_FAIL_TTL_MS = 60 * 1000;
const USAGE_TIMEOUT_MS = 8000;

const usageCache = new Map(); // connectionId -> { resetAt, expiresAt }

/** Exported for tests. */
export function _clearQuotaWindowCache() {
  usageCache.clear();
}

/**
 * Pick a reset timestamp out of a provider usage response.
 * @param {object} usage - getUsageForProvider() result ({ quotas: {...} })
 * @param {string|null} usageKey - preferred quota key; null = earliest future reset
 * @param {number} now
 * @returns {number|null}
 */
export function pickResetFromUsage(usage, usageKey, now = Date.now()) {
  const quotas = usage?.quotas;
  if (!quotas || typeof quotas !== "object") return null;

  const readOne = (q) => {
    if (!q || q.unlimited === true) return null;
    const ms = q.resetAt ? new Date(q.resetAt).getTime() : NaN;
    return Number.isFinite(ms) && ms > now ? ms : null;
  };

  if (usageKey) {
    const exact = readOne(quotas[usageKey]);
    if (exact) return exact;
    // Windows are sometimes namespaced (e.g. `gpt_session`) — accept a suffix match.
    for (const [name, q] of Object.entries(quotas)) {
      if (name === usageKey || name.endsWith(`_${usageKey}`)) {
        const hit = readOne(q);
        if (hit) return hit;
      }
    }
  }

  const candidates = Object.values(quotas).map(readOne).filter(Boolean).sort((a, b) => a - b);
  return candidates[0] ?? null;
}

async function probeUsage(connection, now) {
  const id = connection?.id;
  if (!id) return null;
  const cached = usageCache.get(id);
  if (cached && cached.expiresAt > now) return cached.resetAt;

  try {
    const usage = await Promise.race([
      getUsageForProvider(connection),
      new Promise((_, rej) => setTimeout(() => rej(new Error("usage timeout")), USAGE_TIMEOUT_MS)),
    ]);
    const cfg = quotaWindowFor(connection.provider);
    const resetAt = pickResetFromUsage(usage, cfg.usageKey, now);
    usageCache.set(id, { resetAt, expiresAt: now + USAGE_CACHE_TTL_MS });
    return resetAt;
  } catch {
    usageCache.set(id, { resetAt: null, expiresAt: now + USAGE_FAIL_TTL_MS });
    return null;
  }
}

/**
 * Decide how long a connection stays parked for a quota error.
 * @param {object} opts
 * @param {string} opts.provider
 * @param {object|null} [opts.connection] - full connection row (for the usage probe)
 * @param {number} [opts.now]
 * @param {boolean} [opts.probe] - set false to skip the usage API (tests/offline)
 * @returns {Promise<{ resetAtMs: number, cooldownMs: number, source: "usage"|"calendar" }>}
 */
export async function resolveQuotaResetAt({ provider, connection = null, now = Date.now(), probe = true }) {
  const cfg = quotaWindowFor(provider);

  let resetAtMs = null;
  let source = "calendar";

  if (probe && connection) {
    const probed = await probeUsage({ ...connection, provider }, now);
    if (probed) {
      resetAtMs = probed;
      source = "usage";
    }
  }

  if (!resetAtMs) resetAtMs = calendarResetMs(cfg.scope, cfg, now);

  // Always leave a floor so the lock is meaningful even if a stale resetAt
  // lands in the past, and honour the provider ceiling.
  const cooldownMs = Math.min(Math.max(resetAtMs - now, 60 * 1000), cfg.maxCooldownMs);
  return { resetAtMs: now + cooldownMs, cooldownMs, source };
}
