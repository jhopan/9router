// Router-side quota state for providers with no usage API.
//
// Cline, ClinePass, OpenAI-compatible nodes and friends expose no quota
// endpoint, so /dashboard/quota showed an empty card for them even while the
// router had parked the account on a quota reset. The router already knows the
// answer (it wrote `quotaExhaustedUntil` / `modelLock_*` when the refusal
// happened) — this module turns that into the same quota-row shape the UI
// already renders, so no frontend changes are needed.
//
// Fail-open by contract: returns null instead of throwing into the usage route.

import { quotaWindowFor, QUOTA_SCOPES } from "../config/quotaWindows.js";

const SCOPE_LABELS = {
  [QUOTA_SCOPES.DAILY]: "Quota (daily)",
  [QUOTA_SCOPES.WEEKLY]: "Quota (weekly)",
  [QUOTA_SCOPES.MONTHLY]: "Quota (monthly)",
  [QUOTA_SCOPES.SESSION]: "Quota (session)",
};

const MAX_MODEL_ROWS = 5;

/** Epoch ms for a stored timestamp (ISO string or number); 0 when unusable. */
function timeOf(value) {
  if (!value) return 0;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

/** Quota row the dashboard understands: depleted, with a reset to wait for. */
function depletedRow(resetAtMs) {
  return {
    used: 1,
    total: 1,
    remainingPercentage: 0,
    unlimited: false,
    resetAt: new Date(resetAtMs).toISOString(),
  };
}

/**
 * Build synthetic quota rows from the connection's own parked state.
 *
 * @param {object} connection - provider connection row (must include provider)
 * @param {number} [now]
 * @returns {{ quotas: Record<string, object>, synthetic: true } | null}
 *          null when the connection isn't parked — caller keeps provider data.
 */
export function buildRouterQuotaState(connection, now = Date.now()) {
  try {
    if (!connection?.provider) return null;

    const quotas = {};

    // 1. Whole-account quota park written by the quota-window resolver.
    const quotaUntil = timeOf(connection.quotaExhaustedUntil);
    if (quotaUntil > now) {
      const cfg = quotaWindowFor(connection.provider);
      quotas[SCOPE_LABELS[cfg.scope] || "Quota"] = depletedRow(quotaUntil);
      return { quotas, synthetic: true };
    }

    // 2. Per-model cooldowns. `modelLock___all` means the whole account.
    const locks = Object.entries(connection)
      .filter(([key]) => key.startsWith("modelLock_"))
      .map(([key, value]) => ({ model: key.slice("modelLock_".length), until: timeOf(value) }))
      .filter((l) => l.until > now)
      .sort((a, b) => a.until - b.until);

    if (locks.length > 0) {
      const across = locks.find((l) => l.model === "__all");
      if (across) {
        quotas["Quota (account)"] = depletedRow(across.until);
      } else {
        for (const lock of locks.slice(0, MAX_MODEL_ROWS)) {
          quotas[lock.model] = depletedRow(lock.until);
        }
      }
      return { quotas, synthetic: true };
    }

    // 3. Short rate-limit cooldown — worth showing, resets in minutes.
    const rateUntil = timeOf(connection.rateLimitedUntil);
    if (rateUntil > now) {
      quotas["Rate limited"] = depletedRow(rateUntil);
      return { quotas, synthetic: true };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * True when a usage payload already carries quota rows (provider's own data is
 * authoritative — never mix synthetic rows into it).
 */
export function hasQuotaRows(usage) {
  return Boolean(usage?.quotas) && Object.keys(usage.quotas).length > 0;
}
