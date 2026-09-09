/**
 * FreeBuff usage/quota — GET /api/v1/freebuff/session probe.
 * Zero-cost: a bare GET claims nothing and spends no freebucks, but returns
 * balance, daily freebucks window, per-model prices, and any active instance.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";

const FREEBUFF_SESSION_URL = "https://www.codebuff.com/api/v1/freebuff/session";

/**
 * @param {string} accessToken - FreeBuff oauth token (UUID)
 * @param {object|null} proxyOptions
 * @returns {Promise<object>} usage payload consumed by the dashboard Usage tab
 */
export async function getFreebuffUsage(accessToken, proxyOptions = null) {
  if (!accessToken) return { message: "FreeBuff access token not available." };

  try {
    const response = await proxyAwareFetch(
      FREEBUFF_SESSION_URL,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": "Bun/1.3.14",
          Accept: "application/json",
        },
      },
      proxyOptions,
    );

    if (!response.ok) {
      if (response.status === 401) return { message: "FreeBuff token invalid or expired." };
      const text = await response.text().catch(() => "");
      return { message: `FreeBuff usage probe failed (${response.status}): ${text.slice(0, 160)}` };
    }

    const data = await response.json().catch(() => ({}));
    const fb = data.freebucks || {};
    const daily = fb.daily || {};

    const quotas = {};
    if (Number.isFinite(fb.balance) || Number.isFinite(daily.remaining)) {
      quotas["freebucks (daily)"] = {
        remaining: Number.isFinite(daily.remaining) ? daily.remaining : fb.balance,
        used: Number.isFinite(daily.spent) ? daily.spent : null,
        total: Number.isFinite(daily.limit) ? daily.limit : null,
        unlimited: false,
        resetAt: daily.resetAt || null,
        // Prices let the UI show which models fit today's balance.
        prices: fb.prices || {},
      };
    }

    return {
      quotas,
      freebucks: fb,
      activeInstance: data.instanceId
        ? { instanceId: data.instanceId, model: data.model, status: data.status, accessTier: data.accessTier }
        : null,
      message: data.instanceId
        ? `Instance active — bound to ${data.model || "unknown model"}`
        : "No active FreeBuff instance.",
    };
  } catch (e) {
    return { message: `FreeBuff usage probe error: ${e.message}` };
  }
}
