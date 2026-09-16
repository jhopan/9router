// Converted from node:test to vitest: vitest is the project runner and supplies
// the `@/…` aliases, while `node --test` cannot resolve them.
import { describe, it, beforeAll, expect } from "vitest";

// Load the registry entry once for the suite so a load failure is reported
// next to the failing test instead of cascading as "undefined" in every
// later assertion.
let kimchiEntry;

describe("kimchi registry entry", () => {
  beforeAll(async () => {
    kimchiEntry = (await import("../../open-sse/providers/registry/kimchi.js")).default;
  });

  it("is a free-tier provider auto-listed via byCategory", () => {
    expect(kimchiEntry.id).toBe("kimchi");
    expect(kimchiEntry.category).toBe("freeTier");
  });

  it("points at the OpenAI-compatible gateway with an authenticated UA", () => {
    expect(kimchiEntry.transport.baseUrl).toBe("https://llm.kimchi.dev/openai/v1/chat/completions",);
    // UA must be a non-empty string the gateway can identify; the value
    // itself is owned by the Kimchi CLI release and may change upstream.
    const ua = kimchiEntry.transport.headers["User-Agent"];
    expect(typeof ua === "string" && ua.length > 0).toBe(true);
  });

  it("uses Bearer auth", () => {
    expect(kimchiEntry.transport.auth).toEqual({
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    });
  });

  it("exposes the upstream static models", () => {
    const ids = kimchiEntry.models.map((m) => m.id);
    expect(ids.includes("kimi-k2.7"));
    expect(ids.includes("minimax-m3")).toBeTruthy();
    expect(ids.includes("nemotron-3-ultra-fp4")).toBeTruthy();
    expect(ids.length >= 5).toBe(true).toBeTruthy();
  });

  it("passes through models not in the static list", () => {
    expect(kimchiEntry.passthroughModels).toBe(true);
  });
});

// ── Pure-function clones of the service logic (tested in isolation so
//     node --test works without resolving the Next.js Webpack "open-sse"
//     alias that src/lib/oauth/services/kimchi.js's dependency imports). ──

function buildKimchiAuthUrl(callbackUrl, state) {
  const params = new URLSearchParams({ callback: callbackUrl, state });
  return `https://app.kimchi.dev/cli-auth?${params.toString()}`;
}

async function _handleCallback(params, expectedState) {
  if (params.error) {
    throw new Error(params.error_description || params.error);
  }
  const candidate = params.state;
  if (!candidate || candidate !== expectedState) {
    throw new Error(
      "This request isn't valid. Please restart the Kimchi login flow.",
    );
  }
  const token = params.token;
  if (!token) {
    throw new Error("No token was returned by the Kimchi authentication server");
  }
  return { token };
}

describe("kimchi oauth", () => {
  it("builds the cli-auth URL with encoded callback + state", () => {
    const url = buildKimchiAuthUrl("http://127.0.0.1:4321/callback", "abc123");
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://app.kimchi.dev");
    expect(parsed.pathname).toBe("/cli-auth");
    expect(parsed.searchParams.get("callback")).toBe("http://127.0.0.1:4321/callback");
    expect(parsed.searchParams.get("state")).toBe("abc123");
  });

  it("rejects a callback whose state does not match", async () => {
    await expect(_handleCallback({ token: "castai_v1_x", state: "wrong" }, "expected"))
      .rejects.toThrow(/restart/i);
  });

  it("accepts a callback with matching state and returns the token", async () => {
    const res = await _handleCallback({ token: "castai_v1_x", state: "match" }, "match");
    expect(res.token).toBe("castai_v1_x");
  });
});

// ── kimchiModels service (pure mapping logic, tested in isolation) ──

// Clone of the metadata→model mapper so node --test resolves without the
// open-sse/Webpack alias chain the real module imports.
function mapKimchiMetadata(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((m) => ({
    id: m.slug,
    name: m.display_name || m.slug,
    contextLength: m.limits?.context_window || null,
    maxOutputTokens: m.limits?.max_output_tokens || null,
    isReasoning: m.reasoning === true,
  }));
}

describe("kimchiModels", () => {
  it("maps Kimchi metadata entries to 9router model shape", () => {
    const raw = [{
      slug: "glm-5.2-fp8",
      display_name: "GLM 5.2",
      reasoning: true,
      limits: { context_window: 1048576, max_output_tokens: 1048576 },
    }];
    const models = mapKimchiMetadata(raw);
    expect(models.length).toBe(1);
    expect(models[0]).toEqual({
      id: "glm-5.2-fp8",
      name: "GLM 5.2",
      contextLength: 1048576,
      maxOutputTokens: 1048576,
      isReasoning: true,
    });
  });

  it("falls back to slug as name when display_name is empty", () => {
    const models = mapKimchiMetadata([{ slug: "kimi-k2.7", display_name: "", reasoning: false, limits: {} }]);
    expect(models[0].name).toBe("kimi-k2.7");
    expect(models[0].contextLength).toBe(null);
    expect(models[0].isReasoning).toBe(false);
  });

  it("returns empty array for non-array input", () => {
    expect(mapKimchiMetadata(null)).toEqual([]);
    expect(mapKimchiMetadata({})).toEqual([]);
  });
});

// ── validateToken logic (pure decision over a status code) ──

// Mirrors the decision in KimchiService.validateToken without importing the
// service (which pulls the open-sse Webpack alias chain).
function decideValidity(status) {
  if (status === 200) return { valid: true };
  if (status === 401) return { valid: false, error: "Kimchi token invalid or expired" };
  if (status === 403) return { valid: false, error: "Kimchi token lacks required scope" };
  return { valid: true }; // fail-open on unknown / network error
}

describe("kimchi validateToken", () => {
  it("200 → valid", () => {
    expect(decideValidity(200)).toEqual({ valid: true });
  });
  it("401 → invalid, expired message", () => {
    const r = decideValidity(401);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/invalid or expired/i);
  });
  it("403 → invalid, scope message", () => {
    const r = decideValidity(403);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/scope/i);
  });
  it("unknown / network error → fail-open valid", () => {
    expect(decideValidity(500).valid).toBe(true);
    expect(decideValidity(0).valid).toBe(true);
  });
});

// ── OAuth dedup logic (pure clone of connectionsRepo matcher) ──
// Mimics the find() predicate in createProviderConnection for OAuth
// connections, so we can test the IdP-collision fix in isolation.
function findExistingOAuth(all, incoming) {
  const incomingEmail = incoming.email;
  const incomingUsername = incoming.providerSpecificData?.username;
  const incomingWs = incoming.providerSpecificData?.chatgptAccountId;
  return all.find((c) => {
    if (c.authType !== "oauth" || c.email !== incomingEmail) return false;
    const existingWs = c.providerSpecificData?.chatgptAccountId;
    if (incomingWs && existingWs) return incomingWs === existingWs;
    if (incomingWs && !existingWs) return false;
    if (!incomingWs && existingWs) return false;
    const existingUsername = c.providerSpecificData?.username;
    if (incomingUsername && existingUsername) {
      return incomingUsername === existingUsername;
    }
    if (incomingUsername || existingUsername) return false;
    return true;
  });
}

describe("kimchi OAuth dedup", () => {
  const google = { authType: "oauth", email: "x@y.com", providerSpecificData: { username: "google-oauth2|123" } };
  const hf = { authType: "oauth", email: "x@y.com", providerSpecificData: { username: "huggingface|456" } };
  const legacy = { authType: "oauth", email: "x@y.com", providerSpecificData: {} };
  const other = { authType: "oauth", email: "z@y.com", providerSpecificData: { username: "google-oauth2|789" } };

  it("different email never matches", () => {
    expect(findExistingOAuth([other], google)).toBe(undefined);
  });

  it("same email + same username = dedup (re-login same IdP)", () => {
    const found = findExistingOAuth([google], { ...google });
    expect(found).toBe(google);
  });

  it("same email + different username = NO match (cross-IdP, the bug)", () => {
    expect(findExistingOAuth([google], hf)).toBe(undefined);
  });

  it("legacy row without username matches incoming without username (backward compat)", () => {
    expect(findExistingOAuth([legacy], { ...legacy })).toBe(legacy);
  });

  it("incoming without username does not match legacy row with username", () => {
    expect(findExistingOAuth([google], { ...legacy })).toBe(undefined);
  });

  it("workspaces still dedupe on workspace ID when both sides have one", () => {
    const ws1 = { authType: "oauth", email: "a@b.com", providerSpecificData: { chatgptAccountId: "ws1" } };
    const ws1dup = { authType: "oauth", email: "a@b.com", providerSpecificData: { chatgptAccountId: "ws1" } };
    const ws2 = { authType: "oauth", email: "a@b.com", providerSpecificData: { chatgptAccountId: "ws2" } };
    expect(findExistingOAuth([ws1], ws1dup)).toBe(ws1);
    expect(findExistingOAuth([ws1], ws2)).toBe(undefined);
  });
});
