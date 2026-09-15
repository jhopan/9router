// Guard: every provider that ships a usage handler must be classified in
// QUOTA_WINDOWS. A missing entry silently falls back to the DAILY default, which
// is wrong for weekly/monthly providers (Grok, CodeBuddy, Kiro…): the account
// gets retried for days after its real reset, or parked far too long.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { quotaWindowFor, QUOTA_SCOPES, QUOTA_WINDOWS } from "../../open-sse/config/quotaWindows.js";

const usageSrc = readFileSync(resolve(__dirname, "../../open-sse/services/usage.js"), "utf8");
const usageProviders = (() => {
  const start = usageSrc.indexOf("const USAGE_HANDLERS = {");
  const block = usageSrc.slice(start, usageSrc.indexOf("};", start));
  return [...block.matchAll(/^\s*"?([\w.-]+)"?:\s*\(c\)/gm)].map((m) => m[1]);
})();

// Providers intentionally left on the daily default, with the reason.
const DAILY_BY_DESIGN = new Set([
  "deepseek",      // balance only — needs a top-up, no window to wait for
  "minimax",       // no resetAt in its usage payload
  "minimax-cn",
  "agentrouter",   // relay; per-request credit, no quota window
  "ollama",        // local / no quota
  "iflow",
  "vercel-ai-gateway",
  "gemini-cli",    // per-model daily quota lives in the Antigravity path
]);

describe("QUOTA_WINDOWS coverage", () => {
  it("found the usage handlers (sanity)", () => {
    expect(usageProviders.length).toBeGreaterThan(15);
    expect(usageProviders).toContain("grok-cli");
    expect(usageProviders).toContain("codebuddy-cn");
  });

  it("classifies every usage provider that isn't an explicit daily exception", () => {
    const missing = usageProviders.filter(
      (p) => !(p in QUOTA_WINDOWS.providers) && !DAILY_BY_DESIGN.has(p)
    );
    expect(missing).toEqual([]);
  });

  it("grok is not treated as a daily quota", () => {
    expect(quotaWindowFor("grok-cli").scope).toBe(QUOTA_SCOPES.MONTHLY);
    expect(quotaWindowFor("grok-cli").usageKey).toBe("On-demand");
  });

  it("codebuddy uses its subscription cycle, not a day", () => {
    expect(quotaWindowFor("codebuddy-cn").scope).toBe(QUOTA_SCOPES.MONTHLY);
    expect(quotaWindowFor("codebuddy-intl").scope).toBe(QUOTA_SCOPES.MONTHLY);
  });

  it("session-window providers (glm) stay on the 5h cadence", () => {
    expect(quotaWindowFor("glm").scope).toBe(QUOTA_SCOPES.SESSION);
    expect(quotaWindowFor("glm-cn").scope).toBe(QUOTA_SCOPES.SESSION);
  });

  it("weekly providers (kimi, opencode-go, xiaomi-mimo)", () => {
    expect(quotaWindowFor("kimi").scope).toBe(QUOTA_SCOPES.WEEKLY);
    expect(quotaWindowFor("opencode-go").scope).toBe(QUOTA_SCOPES.WEEKLY);
    expect(quotaWindowFor("xiaomi-mimo").scope).toBe(QUOTA_SCOPES.WEEKLY);
  });

  it("monthly providers (github, zed)", () => {
    expect(quotaWindowFor("github").scope).toBe(QUOTA_SCOPES.MONTHLY);
    expect(quotaWindowFor("zed").scope).toBe(QUOTA_SCOPES.MONTHLY);
  });

  it("provider ids that no longer exist are not silently kept", () => {
    // Cheap drift alarm: every key we ship must look like a provider id we can
    // still resolve. (Unknown ids fall through to `default` at runtime, which is
    // safe but hides the mistake.)
    for (const id of Object.keys(QUOTA_WINDOWS.providers)) {
      if (id === "default") continue;
      expect(id).toMatch(/^[a-z0-9][a-z0-9.-]*$/);
    }
  });
});
