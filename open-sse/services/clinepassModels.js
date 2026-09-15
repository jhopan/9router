import { buildClineHeaders } from "../shared/clineAuth.js";

// Cline exposes two catalogs on api.cline.bot:
//   GET /api/v1/models                          → ~446 rows: the ENTIRE Cline
//     proxy catalog (OpenRouter-style, paid pricing, `~`-prefixed aliases). This
//     is not what a Cline account can serve — surfacing it made the provider page
//     list 466 models, most of them unusable and needing Cline credits.
//   GET /api/v1/ai/cline/recommended-models     → the tiered list this account
//     actually has: { recommended[], free[], clinePass[], clineCloud[] }.
// Only the second one is a correct source for model pickers.
const CLINE_RECOMMENDED_MODELS_ENDPOINT = "https://api.cline.bot/api/v1/ai/cline/recommended-models";
// Cold-start cost (DNS + TLS + Cline's own auth round-trip) measured at ~5.7s on
// the first call, so a 5s budget aborted the first request and silently returned
// null — the free tier then vanished from the picker. Warm calls are <500ms.
const FETCH_TIMEOUT_MS = 15000;

/**
 * Build request headers for Cline's model-list endpoints.
 * Auth shape lives in shared/clineAuth: API keys ride plain Bearer, OAuth
 * access tokens carry the WorkOS `workos:` prefix.
 */
function buildModelListHeaders(token, isApiKey) {
  return buildClineHeaders(token, { Accept: "application/json" }, { isApiKey });
}

/**
 * Internal: fetch the tiered model catalog. Returns the parsed object
 * (`{ recommended, free, clinePass, clineCloud }`) or null on any failure.
 * @returns {Promise<{recommended?: object[], free?: object[], clinePass?: object[], clineCloud?: object[]} | null>}
 */
async function fetchClineCatalog(credentials) {
  const isApiKey = Boolean(credentials?.apiKey);
  const token = isApiKey ? credentials.apiKey : credentials?.accessToken;
  if (!token) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const headers = buildModelListHeaders(token, isApiKey);

    const response = await fetch(CLINE_RECOMMENDED_MODELS_ENDPOINT, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const json = await response.json();
    return json && typeof json === "object" ? json : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Normalize one catalog group into `{ models: [{ id, name }] }`, or null when
 * the group is missing/empty (caller then falls back to the static registry).
 */
function toModels(group) {
  if (!Array.isArray(group)) return null;
  const models = group
    .filter((m) => typeof m?.id === "string" && m.id.trim() !== "")
    .map((m) => ({ id: m.id, name: m.name || m.id }));
  return models.length ? { models } : null;
}

/**
 * Cline free-tier catalog (`free[]` group) — the models a Cline account can
 * actually serve at $0. Falls back to null → static registry list.
 *
 * @param {object} credentials - Connection credentials ({ accessToken, apiKey })
 * @returns {Promise<{ models: { id: string, name: string }[] } | null>}
 */
export async function resolveClineModels(credentials) {
  const catalog = await fetchClineCatalog(credentials);
  if (!catalog) return null;
  return toModels(catalog.free);
}

/**
 * ClinePass catalog (`clinePass[]` group).
 *
 * Previously this filtered `/models` for a `cline-pass/` prefix, which the full
 * proxy catalog never contains — it always came back empty. The tiered endpoint
 * lists them explicitly.
 *
 * @param {object} credentials - Connection credentials ({ accessToken, apiKey })
 * @returns {Promise<{ models: { id: string, name: string }[] } | null>}
 */
export async function resolveClinepassModels(credentials) {
  const catalog = await fetchClineCatalog(credentials);
  if (!catalog) return null;
  return toModels(catalog.clinePass);
}
