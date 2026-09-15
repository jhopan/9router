// Quota-window config: how long a connection must stay parked after its free
// tier refuses a request, per provider.
//
// Reality: providers reset on wildly different cadences — Cline daily, FreeBuff
// daily (Pacific), Antigravity weekly, Claude/Codex 5-hour session windows, Kiro
// on a date it reports itself. Hardcoding one cadence either parks accounts for
// days too long (quota already reset) or retries them hundreds of times (quota
// still empty).
//
// So each entry prefers the provider's own reset timestamp (read from its usage
// API, which the repo already implements per provider) and only falls back to a
// calendar computation when the usage API is unavailable.

/** Calendar fallback scopes. */
export const QUOTA_SCOPES = {
  SESSION: "session",
  DAILY: "daily",
  WEEKLY: "weekly",
  MONTHLY: "monthly",
};

export const QUOTA_WINDOWS = {
  /**
   * Per-provider window. Fields:
   *   scope        — calendar fallback cadence (QUOTA_SCOPES).
   *   usageKey     — quota key inside the usage response to read resetAt from.
   *                  null = any quota with a future resetAt (earliest wins).
   *   resetUtcHour — daily scope only: hour (UTC) the quota day rolls over.
   *   maxCooldownMs— per-provider ceiling (defaults to defaultMaxCooldownMs).
   */
  providers: {
    // Reports an exact date via `nextDateReset` in its usage API.
    kiro: { scope: QUOTA_SCOPES.MONTHLY, usageKey: null },
    // Weekly buckets from retrieveUserQuotaSummary (resetTime per bucket).
    antigravity: { scope: QUOTA_SCOPES.WEEKLY, usageKey: "gemini_weekly" },
    // 5h primary window + weekly secondary; `session` is the short one.
    codex: { scope: QUOTA_SCOPES.SESSION, usageKey: "session" },
    claude: { scope: QUOTA_SCOPES.SESSION, usageKey: "session (5h)" },
    // No usage API for the free tier — calendar only.
    cline: { scope: QUOTA_SCOPES.DAILY, resetUtcHour: 0 },
    freebuff: { scope: QUOTA_SCOPES.DAILY, resetUtcHour: 7 }, // Pacific midnight
    default: { scope: QUOTA_SCOPES.DAILY, resetUtcHour: 0 },
  },

  sessionWindowMs: 5 * 60 * 60 * 1000, // rolling 5h window when no resetAt is known
  weeklyResetWeekday: 1,               // 1 = Monday (UTC)
  monthlyResetDay: 1,                  // 1st of next month (UTC)
  // Safety ceiling: a clock/misclassification bug must never park an account
  // for longer than this.
  defaultMaxCooldownMs: 40 * 24 * 60 * 60 * 1000,
};

/**
 * Calendar fallback for a quota scope, computed from `now`.
 * Pure — no I/O, no imports. Used by the error path (placeholder cooldown) and
 * by the quota-window resolver (when the usage API has no resetAt).
 * @param {string} scope - QUOTA_SCOPES value
 * @param {{resetUtcHour?:number, sessionWindowMs?:number, weeklyResetWeekday?:number, monthlyResetDay?:number}} cfg
 * @param {number} now
 * @returns {number} epoch ms of the next reset
 */
export function calendarResetMs(scope, cfg = {}, now = Date.now()) {
  switch (scope) {
    case QUOTA_SCOPES.SESSION: {
      // Rolling window with no boundary reported upstream — assume a full
      // window from now (slightly optimistic, never retries too early).
      return now + (cfg.sessionWindowMs || 5 * 60 * 60 * 1000);
    }
    case QUOTA_SCOPES.WEEKLY: {
      // Next occurrence of the configured weekday (default Monday) at 00:00 UTC.
      const d = new Date(now);
      const target = cfg.weeklyResetWeekday ?? 1;
      const delta = (target - d.getUTCDay() + 7) % 7;
      d.setUTCDate(d.getUTCDate() + (delta === 0 ? 7 : delta));
      d.setUTCHours(0, 0, 0, 0);
      return d.getTime();
    }
    case QUOTA_SCOPES.MONTHLY: {
      const d = new Date(now);
      d.setUTCMonth(d.getUTCMonth() + 1, cfg.monthlyResetDay ?? 1);
      d.setUTCHours(0, 0, 0, 0);
      return d.getTime();
    }
    case QUOTA_SCOPES.DAILY:
    default: {
      const d = new Date(now);
      d.setUTCHours(cfg.resetUtcHour ?? 0, 0, 0, 0);
      if (d.getTime() <= now) d.setUTCDate(d.getUTCDate() + 1);
      return d.getTime();
    }
  }
}

/** Resolve the effective config for a provider (falls back to `default`). */
export function quotaWindowFor(provider) {
  const key = String(provider || "").toLowerCase();
  const { providers, ...shared } = QUOTA_WINDOWS;
  const merged = { ...providers.default, ...(providers[key] || {}) };
  return {
    ...shared,
    ...merged,
    maxCooldownMs: merged.maxCooldownMs ?? shared.defaultMaxCooldownMs,
  };
}

// ── Quota-refusal signatures ───────────────────────────────────────────────
// Single source of truth: errorConfig builds its ERROR_RULES from this list and
// the quota-window resolver uses it to decide "this is a quota refusal, not a
// burst rate limit". Keep additions lowercase (matching lowercases the text).
export const QUOTA_EXHAUSTED_SIGNALS = [
  "daily free limit reached",   // Cline INFERENCE_CAP_ERROR
  "inference_cap_error",        // Cline error code
  "daily limit",
  "daily quota",
  "weekly limit",
  "weekly quota",
  "monthly limit",
  "monthly quota",
  "quota will reset",
  "quota exhausted",
  "free limit reached",
];

/**
 * True when an upstream error means "your quota for this window is gone"
 * as opposed to "you are going too fast".
 * @param {unknown} errorText
 * @returns {boolean}
 */
export function isQuotaExhaustedError(errorText) {
  const lower = String(errorText || "").toLowerCase();
  return QUOTA_EXHAUSTED_SIGNALS.some((sig) => lower.includes(sig));
}
