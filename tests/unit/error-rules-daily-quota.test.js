import { describe, it, expect } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { dailyQuotaCooldownMs, MAX_DAILY_QUOTA_COOLDOWN_MS } from "../../open-sse/config/errorConfig.js";
import { quotaWindowFor, QUOTA_SCOPES, calendarResetMs } from "../../open-sse/config/quotaWindows.js";

// Real Cline body that motivated this: the router used to treat it as a burst
// rate limit (429 backoff: 2s, 4s, 8s…) and re-selected the same dead account
// every couple of minutes.
const CLINE_DAILY = '[429]: {"error":{"code":"INFERENCE_CAP_ERROR","message":"Error 429: Daily free limit reached on model z-ai/glm-5.3-flash"}}';

describe("daily free-tier quota classification", () => {
  it("parks the model until the daily reset instead of backing off", () => {
    const res = checkFallbackError(429, CLINE_DAILY, 0, "cline");
    expect(res.shouldFallback).toBe(true);
    expect(res.dailyQuota).toBe(true);
    expect(res.newBackoffLevel).toBe(0); // no backoff ladder
    // The cooldown is "until the next 00:00 UTC", so its MAGNITUDE depends on the
    // wall clock when the suite runs (49 minutes if it is almost midnight UTC,
    // ~24h just after). Assert the boundary it lands on instead of a fixed size.
    const expected = calendarResetMs(QUOTA_SCOPES.DAILY, { resetUtcHour: 0 }, Date.now());
    expect(Math.abs((Date.now() + res.cooldownMs) - expected)).toBeLessThan(5000);
    expect(res.cooldownMs).toBeGreaterThan(0);
    expect(res.cooldownMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it("the cooldown lands on the provider's reset hour", () => {
    const before = Date.now();
    const res = checkFallbackError(429, CLINE_DAILY, 0, "cline");
    const resetAt = new Date(before + res.cooldownMs);
    expect(resetAt.getUTCHours()).toBe(0); // default = 00:00 UTC
    expect(resetAt.getUTCMinutes()).toBe(0);
  });

  it("freebuff resets on the Pacific quota day (07:00 UTC)", () => {
    const cooldown = dailyQuotaCooldownMs("freebuff");
    const resetAt = new Date(Date.now() + cooldown);
    expect(resetAt.getUTCHours()).toBe(7);
  });

  it("never parks for longer than the safety ceiling", () => {
    expect(dailyQuotaCooldownMs("cline")).toBeLessThanOrEqual(MAX_DAILY_QUOTA_COOLDOWN_MS);
    expect(dailyQuotaCooldownMs("cline")).toBeLessThanOrEqual(quotaWindowFor("cline").maxCooldownMs);
  });

  it("generic rate limits still use backoff", () => {
    const res = checkFallbackError(429, "too many requests", 0, "cline");
    expect(res.dailyQuota).toBeUndefined();
    expect(res.newBackoffLevel).toBe(1);
    expect(res.cooldownMs).toBeLessThan(60 * 1000);
  });

  it("unrelated 429s keep the old behaviour", () => {
    const res = checkFallbackError(429, "upstream exploded", 0, "cline");
    expect(res.dailyQuota).toBeUndefined();
    expect(res.newBackoffLevel).toBe(1);
  });
});
