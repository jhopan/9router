/**
 * translateConfig.js
 *
 * Single source of truth for the "Translate Adapter". The translate COMBO is
 * the "penjual" (provider): it holds the models[], multi-account failover, and
 * its own fallback/round-robin strategy (configured in the Combo UI). Agents
 * ("pelanggan"/customers, e.g. agentrouter) just ask the adapter to translate;
 * whatever the combo provides is what the customer gets.
 *
 * Config lives in `settings.translateConfig` and is OFF by default:
 *   enabled  (bool)     — master switch. Default false.
 *   combo    (string)   — the translate composer name. Default "translate".
 *   providers(string[]) — "customer" providers that get translated. Default ["agentrouter"].
 */

import { getApiKeys } from "@/lib/db/repos/apiKeysRepo.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";

const DEFAULTS = {
  enabled: false,
  combo: "translate",
  providers: ["agentrouter"],
};

// Read translateConfig from settings, merged with defaults.
export async function getTranslateConfig() {
  try {
    const settings = await getSettings();
    const raw = settings?.translateConfig || {};
    return {
      enabled: raw.enabled === true,
      combo: typeof raw.combo === "string" && raw.combo.trim() ? raw.combo : DEFAULTS.combo,
      providers: Array.isArray(raw.providers) && raw.providers.length
        ? raw.providers.map(String)
        : [...DEFAULTS.providers],
    };
  } catch {
    return { ...DEFAULTS, providers: [...DEFAULTS.providers] };
  }
}

// True if translation should run for the given provider ("customer").
export async function shouldTranslateProvider(provider) {
  const config = await getTranslateConfig();
  return config.enabled && config.providers.includes(provider);
}

// Resolve the API key for the self-invoke translate call.
export async function resolveTranslateApiKey(config, log) {
  try {
    const keys = await getApiKeys();
    const active = keys.filter((k) => k.isActive);
    return (active[0]?.key || keys[0]?.key || "").trim();
  } catch (err) {
    log?.warn?.("TRANSLATE", `no api key: ${err.message}`);
    return "";
  }
}

// Local base URL for self-invoke.
export function localBaseUrl() {
  const port = process.env.PORT || "20127";
  return `http://localhost:${port}`;
}

export { DEFAULTS as TRANSLATE_DEFAULTS };
