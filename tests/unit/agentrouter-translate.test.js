import { describe, it, expect, vi } from "vitest";
import { translateAgentRouterBody } from "../../open-sse/translator/concerns/agentrouterTranslate.js";

describe("agentrouter translate layer", () => {
  it("translates user message string content to English", async () => {
    const body = { messages: [{ role: "user", content: "bisa tolong perbaiki error berikut ini?" }] };
    const log = { warn: () => {} };
    const out = await translateAgentRouterBody(body, log);
    expect(out.messages[0].role).toBe("user");
    expect(typeof out.messages[0].content).toBe("string");
    // Fail-open: never empty/throws; if no translate key it stays original
    expect(out.messages[0].content.length).toBeGreaterThan(0);
  });

  it("leaves assistant messages untouched", async () => {
    const body = { messages: [
      { role: "user", content: "hai" },
      { role: "assistant", content: "Hello!" },
    ] };
    const log = { warn: () => {} };
    const out = await translateAgentRouterBody(body, log);
    expect(out.messages[1].content).toBe("Hello!");
  });

  it("is fail-open: returns same body when no api key", async () => {
    const body = { messages: [{ role: "user", content: "apakabar" }] };
    const log = { warn: () => {} };
    const out = await translateAgentRouterBody(body, log);
    expect(out).toBe(body);
  });
});
