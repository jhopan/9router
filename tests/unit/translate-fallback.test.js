import { describe, it, expect } from "vitest";
import { translateWithFallback } from "../../open-sse/translator/concerns/translateConfig.js";

describe("translateWithFallback", () => {
  it("uses first model when it succeeds", async () => {
    const config = { models: ["m1", "m2"], roundRobin: false };
    const call = async (modelId) => { if (modelId === "m1") return "translated"; throw new Error("x"); };
    const res = await translateWithFallback("text", config, "k", {}, call);
    expect(res).toBe("translated");
  });

  it("falls back to next model when first returns empty", async () => {
    const config = { models: ["m1", "m2"], roundRobin: false };
    const calls = [];
    const call = async (modelId) => {
      calls.push(modelId);
      if (modelId === "m1") throw new Error("429 quota exhausted");
      return "from-m2";
    };
    const res = await translateWithFallback("text", config, "k", {}, call);
    expect(res).toBe("from-m2");
    expect(calls).toEqual(["m1", "m2"]);
  });

  it("returns original text when all models fail (fail-open)", async () => {
    const config = { models: ["m1", "m2"], roundRobin: false };
    const call = async () => { throw new Error("all down"); };
    const res = await translateWithFallback("text", config, "k", {}, call);
    expect(res).toBe("text");
  });

  it("no models returns original (fail-open)", async () => {
    const res = await translateWithFallback("x", { models: [] }, "k", {}, async () => "y");
    expect(res).toBe("x");
  });
});
