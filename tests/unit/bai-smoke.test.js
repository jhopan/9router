import { describe, it, expect } from "vitest";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";

describe("bai provider registry", () => {
  it("registers with OpenAI-compatible transport", () => {
    expect(PROVIDERS.bai.baseUrl).toBe("https://api.b.ai/v1/chat/completions");
    expect(PROVIDERS.bai.format).toBe("openai");
    expect(PROVIDERS.bai.auth?.header).toBe("Authorization");
  });

  it("lists models and passes through the rest", () => {
    const ids = (PROVIDER_MODELS.bai || []).map((m) => m.id);
    expect(ids).toContain("deepseek-v4-flash-vision-exp");
    expect(ids).toContain("minimax-m3");
  });

  it("resolves the BAI short alias", async () => {
    const model = await import("../../open-sse/services/model.js");
    expect(model.resolveProviderAlias("BAI")).toBe("bai");
    expect(model.resolveProviderAlias("bai")).toBe("bai");
  });
});
