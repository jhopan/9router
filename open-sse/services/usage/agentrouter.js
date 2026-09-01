/**
 * AgentRouter (New-API) balance quota fetcher.
 *
 * AgentRouter is built on the New-API gateway, which exposes an admin balance API
 * distinct from the routing `sk-...` API key:
 *
 *   GET https://agentrouter.org/api/user/self
 *     Authorization: Bearer {systemAccessToken}
 *     New-Api-User: {userId}
 *   -> { "data": { "quota": <int> } }   (raw New-API credit units)
 *
 * `quota_per_unit` (units per $1) is a New-API-wide constant — hardcoded to 500000
 * to avoid a second upstream round-trip per fetch.
 *
 * Credentials come from `providerSpecificData.consoleApiKey` (System Access Token)
 * and `providerSpecificData.newApiUserId` (New-Api-User header) — NOT the routing apiKey.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { toFiniteNumber } from "./shared.js";

const BASE_URL = "https://agentrouter.org";
const SELF_PATH = "/api/user/self";
const QUOTA_PER_UNIT = 500_000;

/**
 * @param {string|null|undefined} consoleApiKey  New-API System Access Token
 * @param {string|null|undefined} newApiUserId   New-Api-User header value
 * @param {object|null} proxyOptions
 */
export async function getAgentrouterUsage(
  consoleApiKey = null,
  newApiUserId = null,
  proxyOptions = null,
) {
  if (!consoleApiKey || newApiUserId == null) {
    return {
      plan: "AgentRouter",
      message:
        "AgentRouter quota needs a System Access Token + New-Api-User ID. Add them in the provider connection (Quota Console).",
    };
  }

  try {
    const response = await proxyAwareFetch(
      `${BASE_URL}${SELF_PATH}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${consoleApiKey.trim()}`,
          "New-Api-User": String(newApiUserId).trim(),
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      },
      proxyOptions,
    );

    if (response.status === 401 || response.status === 403) {
      return {
        plan: "AgentRouter",
        message: "AgentRouter quota authentication failed. Check the System Access Token / New-Api-User ID.",
      };
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      return {
        plan: "AgentRouter",
        message: `AgentRouter quota API error (${response.status})${errText ? `: ${errText.slice(0, 120)}` : ""}`,
      };
    }

    const data = await response.json().catch(() => null);
    const dataObj = data?.data || data || null;
    const rawQuota = toFiniteNumber(dataObj?.quota ?? data?.quota, -1);
    if (rawQuota < 0) {
      return {
        plan: "AgentRouter",
        message: "AgentRouter connected. No balance data returned.",
      };
    }

    const dollarBalance = rawQuota / QUOTA_PER_UNIT;
    const limitReached = rawQuota <= 0;
    const percentUsed = limitReached ? 1 : 0;

    return {
      plan: limitReached ? "AgentRouter (Insufficient Balance)" : "AgentRouter",
      quotas: {
        "Balance": {
          used: percentUsed * 100,
          total: 100,
          remainingPercentage: limitReached ? 0 : 100,
          resetAt: null,
          unlimited: !limitReached,
          rawQuota,
          dollarBalance,
          limitReached,
        },
      },
    };
  } catch (error) {
    return { message: `AgentRouter error: ${error.message}` };
  }
}
