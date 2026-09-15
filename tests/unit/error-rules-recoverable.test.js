import { describe, expect, it } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

// Ported from OmniRoute release/v3.8.51:
// - kiro #11809: 403 "User is not authorized to make this call" = recoverable
//   config issue (missing profileArn / wrong Q region), NOT a terminal ban.
// - cline #12594: 401 "re-authenticate your Cline account" = refreshable OAuth
//   token; the retry after the refresh attempt should come fast.

describe("error rules — recoverable upstream misconfigurations", () => {
  it("kiro profile/region 403 uses a short cooldown (not the long 403 one)", () => {
    const res = checkFallbackError(403, "User is not authorized to make this call");
    // short cooldown (< 10s) — the connection stays active for a quick retry
    expect(res.shouldFallback).toBe(true);
    expect(res.cooldownMs).toBeLessThan(10_000);
  });

  it("cline re-authenticate 401 uses a short cooldown (refreshable token)", () => {
    const res = checkFallbackError(401, "Please make sure you are using the latest version of Cline and re-authenticate your Cline account.");
    expect(res.shouldFallback).toBe(true);
    expect(res.cooldownMs).toBeLessThan(10_000);
  });

  it("generic 403 keeps the long cooldown (real bans stay expensive)", () => {
    const res = checkFallbackError(403, "banned");
    expect(res.cooldownMs).toBeGreaterThanOrEqual(60_000);
  });

  it("generic 401 keeps the long cooldown", () => {
    const res = checkFallbackError(401, "unauthorized");
    expect(res.cooldownMs).toBeGreaterThanOrEqual(60_000);
  });
});
