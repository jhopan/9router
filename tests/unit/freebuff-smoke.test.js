import { describe, it, expect } from "vitest";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";

describe("freebuff provider registry", () => {
  it("registers with OpenAI-compatible transport (flat keys)", () => {
    expect(PROVIDERS.freebuff.baseUrl).toBe("https://www.codebuff.com/api/v1/chat/completions");
    expect(PROVIDERS.freebuff.format).toBe("openai");
    expect(PROVIDERS.freebuff.auth?.header).toBe("Authorization");
  });

  it("lists the free catalog models", () => {
    const ids = (PROVIDER_MODELS.freebuff || []).map((m) => m.id);
    expect(ids).toContain("deepseek/deepseek-v4-flash");
    expect(ids).toContain("mimo/mimo-v2.5");
    expect(ids).toContain("z-ai/glm-5.3-flash");
  });

  it("resolves the fb short alias", async () => {
    const model = await import("../../open-sse/services/model.js");
    expect(model.resolveProviderAlias("fb")).toBe("freebuff");
    expect(model.resolveProviderAlias("FB")).toBe("freebuff");
  });
});
