import { describe, it, expect } from "vitest";
import {
  normalizeLimitModel,
  mergeLimits,
  API_KEY_LIMIT_ERRORS,
} from "../../src/lib/apiKeyLimits.js";

// Pure helpers only — the DB-backed checkApiKeyLimits/billApiKey are exercised
// through the live server (tests/ has no DB harness for apiKeys).

describe("normalizeLimitModel", () => {
  it("strips the provider prefix", () => {
    expect(normalizeLimitModel("frp/deepseek/deepseek-v4-flash")).toBe("deepseek/deepseek-v4-flash");
  });
  it("keeps a bare model untouched", () => {
    expect(normalizeLimitModel("deepseek/deepseek-v4-flash")).toBe("deepseek/deepseek-v4-flash");
  });
  it("handles empty input", () => {
    expect(normalizeLimitModel(null)).toBe("");
  });
});

describe("mergeLimits", () => {
  it("creates a blob from scratch", () => {
    const out = mergeLimits(null, {
      models: ["frp/z-ai/glm-5.3-flash"],
      totalTokens: 1000000,
      expiresAt: "2026-12-31",
    });
    expect(out.models).toEqual(["frp/z-ai/glm-5.3-flash"]);
    expect(out.totalTokens).toBe(1000000);
    expect(out.usedTokens).toBe(0);
    expect(out.expiresAt).toBe("2026-12-31");
  });

  it("merges partial patches without dropping other fields", () => {
    const prev = { models: ["a"], totalTokens: 1000, usedTokens: 250, expiresAt: "2026-01-01" };
    const out = mergeLimits(prev, { totalTokens: 2000 });
    expect(out.models).toEqual(["a"]);
    expect(out.usedTokens).toBe(250); // preserved
    expect(out.expiresAt).toBe("2026-01-01");
    expect(out.totalTokens).toBe(2000);
  });

  it("top-up keeps usedTokens so remaining grows", () => {
    const prev = { totalTokens: 1000, usedTokens: 900 };
    const out = mergeLimits(prev, { totalTokens: 2000 });
    expect(out.totalTokens - out.usedTokens).toBe(1100);
  });

  it("null models means unrestricted", () => {
    const out = mergeLimits({ models: ["a"] }, { models: null });
    expect(out.models).toBeNull();
  });

  it("usedTokens can be reset explicitly", () => {
    const out = mergeLimits({ usedTokens: 500 }, { usedTokens: 0 });
    expect(out.usedTokens).toBe(0);
  });
});

describe("error codes", () => {
  it("are stable strings (clients match on them)", () => {
    expect(API_KEY_LIMIT_ERRORS.MODEL_NOT_ALLOWED).toBe("model_not_allowed");
    expect(API_KEY_LIMIT_ERRORS.EXPIRED).toBe("key_expired");
    expect(API_KEY_LIMIT_ERRORS.EXHAUSTED).toBe("quota_exhausted");
  });
});
