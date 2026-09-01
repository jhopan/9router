import { describe, it, expect } from "vitest";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { getAgentrouterUsage } from "../../open-sse/services/usage/agentrouter.js";

describe("agentrouter provider", () => {
  it("registers with claude format + fingerprint headers", () => {
    const t = PROVIDERS.agentrouter;
    expect(t).toBeTruthy();
    expect(t.format).toBe("claude");
    expect(t.baseUrl).toBe("https://agentrouter.org/v1/messages");
    expect(t.auth.header).toBe("x-api-key");
    // Claude Code fingerprint required to pass the AgentRouter WAF
    expect(t.headers["User-Agent"]).toContain("claude-cli");
    expect(t.headers["X-Stainless-Package-Version"]).toBeTruthy();
    expect(t.headers["Anthropic-Version"]).toBeTruthy();
    expect(t.headers["anthropic-version"] || t.headers["Anthropic-Version"]).toBeTruthy();
  });

  it("exposes models", () => {
    const ids = (PROVIDER_MODELS.agentrouter || []).map((m) => m.id);
    expect(ids).toContain("claude-opus-4-6");
    expect(ids).toContain("glm-5.1");
  });

  it("usage handler returns message when console creds missing", async () => {
    const res = await getAgentrouterUsage(null, null, null);
    expect(res.message).toContain("System Access Token");
  });

  it("getUsageForProvider routes agentrouter without throwing", async () => {
    const res = await getUsageForProvider({ provider: "agentrouter", providerSpecificData: {} }, null);
    expect(res.message).toBeTruthy();
  });
});
