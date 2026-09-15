// Per-key prepaid pool ("API key jualan"). Limits live in the apiKeys.limits JSON
// column: { models: string[]|null, totalTokens: number, usedTokens: number, expiresAt: string|null }
// Enforcement is fail-closed at the request boundary: model allowlist, token pool,
// expiry. Cached tokens are FREE — only (prompt − cached) + completion is billed.
import { getApiKeyByKey, setApiKeyLimits, addApiKeyUsage } from "@/lib/db/index.js";

export const API_KEY_LIMIT_ERRORS = {
  MODEL_NOT_ALLOWED: "model_not_allowed",
  EXPIRED: "key_expired",
  EXHAUSTED: "quota_exhausted",
};

/**
 * Model allowlists may be written with or without the provider prefix. Derive the
 * prefix-less form only when the remainder is still `vendor/model` — for a bare
 * two-segment id ("deepseek/deepseek-v4-flash") stripping would alias it to a
 * different model, so the input is returned untouched.
 */
export function normalizeLimitModel(model) {
  const m = String(model || "").trim();
  const slash = m.indexOf("/");
  if (slash === -1) return m;
  const rest = m.slice(slash + 1);
  return rest.includes("/") ? rest : m;
}

function isAllowed(allow, model) {
  if (!Array.isArray(allow) || allow.length === 0) return true;
  const full = String(model || "").trim();
  const bare = normalizeLimitModel(full);
  return allow.some((a) => {
    const entry = String(a || "").trim();
    return entry === full || entry === bare;
  });
}

/**
 * Check a key against its limits. Returns
 *   { ok: true, record, limits } | { ok: false, status, code, message }
 * A key with no limits blob is unlimited (legacy keys keep working).
 */
export async function checkApiKeyLimits(key, model) {
  const record = await getApiKeyByKey(key);
  if (!record) return { ok: false, status: 401, code: "invalid_api_key", message: "Invalid API key" };
  const limits = record.limits;
  if (!limits) return { ok: true, record, limits: null };

  if (limits.expiresAt && new Date(limits.expiresAt).getTime() <= Date.now()) {
    return {
      ok: false,
      status: 401,
      code: API_KEY_LIMIT_ERRORS.EXPIRED,
      message: `API key expired at ${limits.expiresAt}`,
    };
  }

  if (!isAllowed(limits.models, model)) {
    return {
      ok: false,
      status: 403,
      code: API_KEY_LIMIT_ERRORS.MODEL_NOT_ALLOWED,
      message: `Model "${model}" is not allowed on this API key`,
    };
  }

  const total = Number(limits.totalTokens || 0);
  const used = Number(limits.usedTokens || 0);
  if (total > 0 && used >= total) {
    return {
      ok: false,
      status: 429,
      code: API_KEY_LIMIT_ERRORS.EXHAUSTED,
      message: `Token pool exhausted (${used}/${total}) — contact admin to top up`,
    };
  }

  return { ok: true, record, limits };
}

/**
 * Bill a finished request. Cached tokens are free, so the billed amount is
 * (prompt_tokens − cached_tokens) + completion_tokens.
 */
export async function billApiKey(id, usage) {
  if (!id || !usage) return null;
  const prompt = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const cached = Number(
    usage.prompt_tokens_details?.cached_tokens ??
      usage.cached_tokens ??
      usage.cache_read_input_tokens ??
      0
  );
  const completion = Number(usage.completion_tokens || usage.output_tokens || 0);
  const delta = Math.max(0, prompt - cached) + completion;
  if (delta <= 0) return null;
  return addApiKeyUsage(id, delta);
}

/** Merge partial limit edits onto the stored blob (undefined = keep as-is). */
export function mergeLimits(prev, patch) {
  const base = prev && typeof prev === "object" ? prev : {};
  const next = { ...base };
  if ("models" in patch) next.models = patch.models == null ? null : patch.models;
  if ("totalTokens" in patch) next.totalTokens = patch.totalTokens == null ? null : Number(patch.totalTokens);
  if ("expiresAt" in patch) next.expiresAt = patch.expiresAt || null;
  if ("usedTokens" in patch) next.usedTokens = Math.max(0, Number(patch.usedTokens) || 0);
  if (next.usedTokens == null) next.usedTokens = base.usedTokens || 0;
  return next;
}

export { setApiKeyLimits };
