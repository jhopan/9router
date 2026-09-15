// The Cline provider page listed 466 models because the live catalog reader hit
// GET /api/v1/models — Cline's entire OpenRouter-style proxy catalog (~446 rows,
// paid, `~`-prefixed aliases) — instead of the account's actual tiered list.
// resolveClinepassModels was broken the same way: it filtered that catalog for a
// `cline-pass/` prefix that never appears there, so it always returned empty.
//
// These tests pin the source and the group mapping without network access.
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(__dirname, "../../open-sse/services/clinepassModels.js"), "utf8");

// Import after stubbing global fetch per-test.
async function loadModule() {
  return import("../../open-sse/services/clinepassModels.js");
}

const CREDS = { accessToken: "workos-token" };

// Shape verified live against api.cline.bot (2026-09-15).
const LIVE_SHAPE = {
  recommended: [{ id: "openai/gpt-6-astra", name: "gpt-6-astra" }],
  free: [
    { id: "cline-free/deepseek-v4.1-flash", name: "Deepseek-v4.1-Flash" },
    { id: "cline-free/muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor" },
    { id: "z-ai/glm-5.3-flash", name: "glm-5.3-flash" },
    { id: "cline-free/solar-pro4", name: "Solar Pro 4" },
    { id: "poolside/laguna-s-2.1:free", name: "laguna-s-2.1:free" },
  ],
  clinePass: [
    { id: "cline-pass/deepseek-v4-flash", name: "deepseek-v4-flash" },
    { id: "cline-pass/kimi-k3", name: "kimi-k3" },
  ],
  clineCloud: [{ id: "cline-cloud/kimi-k3", name: "kimi-k3" }],
};

function mockFetch(payload, ok = true) {
  const calls = [];
  globalThis.fetch = vi.fn(async (url, init) => {
    calls.push({ url, init });
    return { ok, json: async () => payload };
  });
  return calls;
}

afterEach(() => {
  delete globalThis.fetch;
  vi.restoreAllMocks();
});

describe("cline model catalog source", () => {
  it("targets the tiered recommended-models endpoint, never /api/v1/models", () => {
    expect(src).toContain("/api/v1/ai/cline/recommended-models");
    // A bare `/api/v1/models` (the 446-row proxy catalog) must not be fetched.
    expect(src).not.toMatch(/["'`]https:\/\/api\.cline\.bot\/api\/v1\/models["'`]/);
  });

  it("resolveClineModels returns the free[] group only", async () => {
    const calls = mockFetch(LIVE_SHAPE);
    const { resolveClineModels } = await loadModule();
    const res = await resolveClineModels(CREDS);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.cline.bot/api/v1/ai/cline/recommended-models");
    expect(res.models.map((m) => m.id)).toEqual([
      "cline-free/deepseek-v4.1-flash",
      "cline-free/muse-spark-1.3-contributor",
      "z-ai/glm-5.3-flash",
      "cline-free/solar-pro4",
      "poolside/laguna-s-2.1:free",
    ]);
    // The 446-row catalog is gone; paid `recommended` rows are not mixed in.
    expect(res.models.map((m) => m.id)).not.toContain("openai/gpt-6-astra");
  });

  it("resolveClinepassModels returns the clinePass[] group (was always empty)", async () => {
    mockFetch(LIVE_SHAPE);
    const { resolveClinepassModels } = await loadModule();
    const res = await resolveClinepassModels(CREDS);
    expect(res.models.map((m) => m.id)).toEqual([
      "cline-pass/deepseek-v4-flash",
      "cline-pass/kimi-k3",
    ]);
  });

  it("returns null when a group is absent, so the registry list wins", async () => {
    mockFetch({ recommended: LIVE_SHAPE.recommended });
    const { resolveClineModels, resolveClinepassModels } = await loadModule();
    expect(await resolveClineModels(CREDS)).toBeNull();
    expect(await resolveClinepassModels(CREDS)).toBeNull();
  });

  it("returns null on a non-OK response and never throws", async () => {
    mockFetch({}, false);
    const { resolveClineModels } = await loadModule();
    expect(await resolveClineModels(CREDS)).toBeNull();
  });

  it("returns null without credentials (no request fired)", async () => {
    const calls = mockFetch(LIVE_SHAPE);
    const { resolveClineModels } = await loadModule();
    expect(await resolveClineModels({})).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("survives a fetch rejection", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    });
    const { resolveClineModels } = await loadModule();
    expect(await resolveClineModels(CREDS)).toBeNull();
  });
});
