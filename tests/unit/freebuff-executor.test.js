import { describe, it, expect, vi, beforeEach } from "vitest";

// Offline executor tests: mock global fetch (proxyAwareFetch uses it), assert
// session pooling (one handshake for many chats), stable client_id, Buffy
// injection, 429 cooldown, and per-endpoint UA.

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => globalThis.__fbFetchMock(...args),
}));

const { FreebuffExecutor } = await import("../../open-sse/executors/freebuff.js");

function sseResponse(payload, model = "deepseek/deepseek-v4-flash") {
  return new Response(JSON.stringify({ choices: [{ message: { content: payload } }], model }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeFetchMock({ chatStatus = 200, sessionFail = null } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (url.includes("/freebuff/session")) {
      if (sessionFail) return new Response(sessionFail.body || "err", { status: sessionFail.status });
      return new Response(JSON.stringify({ instanceId: "inst-1" }), { status: 200 });
    }
    if (url.includes("/agent-runs")) {
      const body = JSON.parse(init.body || "{}");
      return new Response(JSON.stringify({ runId: body.action === "START" ? "run-1" : undefined }), { status: 200 });
    }
    if (url.includes("/chat/completions")) {
      if (chatStatus !== 200) return new Response("quota", { status: chatStatus });
      return sseResponse("hi", JSON.parse(init.body).model);
    }
    return new Response("not found", { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

const creds = { apiKey: "cb_test_token_123" };
const creds2 = { apiKey: "cb_test_token_456" }; // fresh token for UA test (pool is module-level)
const req = (content = "hello", c = creds) => ({
  model: "freebuff/deepseek/deepseek-v4-flash",
  body: { messages: [{ role: "user", content }], stream: false },
  stream: false,
  credentials: c,
});

describe("FreebuffExecutor", () => {
  beforeEach(() => {
    vi.resetModules();
    globalThis.__fbFetchMock = makeFetchMock();
  });

  it("performs ONE session handshake for two chats (session reuse)", async () => {
    const exec = new FreebuffExecutor();
    await exec.execute(req("a"));
    await exec.execute(req("b"));
    const handshakes = globalThis.__fbFetchMock.calls.filter((c) => c.url.includes("/freebuff/session"));
    expect(handshakes.length).toBe(1);
    const chats = globalThis.__fbFetchMock.calls.filter((c) => c.url.includes("/chat/completions"));
    expect(chats.length).toBe(2);
    // both chats share the same instance
    for (const c of chats) {
      const body = JSON.parse(c.init.body);
      expect(body.codebuff_metadata.freebuff_instance_id).toBe("inst-1");
    }
  });

  it("uses a STABLE client_id across requests (not random per request)", async () => {
    const exec = new FreebuffExecutor();
    await exec.execute(req("a"));
    await exec.execute(req("b"));
    const chats = globalThis.__fbFetchMock.calls.filter((c) => c.url.includes("/chat/completions"));
    const ids = chats.map((c) => JSON.parse(c.init.body).codebuff_metadata.client_id);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toMatch(/^[0-9a-z]{13}$/);
  });

  it("injects the Buffy system prompt only when absent", async () => {
    const exec = new FreebuffExecutor();
    await exec.execute(req("a"));
    await exec.execute({
      model: "freebuff/deepseek/deepseek-v4-flash",
      body: { messages: [{ role: "system", content: "You are Buffy, the strategic coding assistant." }, { role: "user", content: "b" }], stream: false },
      stream: false,
      credentials: creds,
    });
    const chats = globalThis.__fbFetchMock.calls.filter((c) => c.url.includes("/chat/completions"));
    const first = JSON.parse(chats[0].init.body);
    const second = JSON.parse(chats[1].init.body);
    expect(first.messages[0].content.startsWith("You are Buffy")).toBe(true);
    expect(second.messages.filter((m) => String(m.content || "").startsWith("You are Buffy")).length).toBe(1);
  });

  it("sends per-endpoint User-Agents (Bun for session, ai-sdk for chat)", async () => {
    const exec = new FreebuffExecutor();
    await exec.execute(req("a", creds2)); // fresh token → forces a handshake
    const session = globalThis.__fbFetchMock.calls.find((c) => c.url.includes("/freebuff/session"));
    const chat = globalThis.__fbFetchMock.calls.find((c) => c.url.includes("/chat/completions"));
    expect(session.init.headers["User-Agent"]).toBe("Bun/1.3.14");
    expect(chat.init.headers["User-Agent"]).toContain("ai-sdk/openai-compatible");
  });

  it("locks the token locally on 429 and short-circuits the next call", async () => {
    globalThis.__fbFetchMock = makeFetchMock({ chatStatus: 429 });
    const exec = new FreebuffExecutor();
    const first = await exec.execute(req("a"));
    expect(first.response.status).toBe(429);
    // session invalidated after the 429; next call must NOT hit upstream
    const callsBefore = globalThis.__fbFetchMock.calls.length;
    const second = await exec.execute(req("b"));
    expect(second.response.status).toBe(429);
    expect(globalThis.__fbFetchMock.calls.length).toBe(callsBefore); // zero new upstream calls
  });

  it("returns 401 when no token is configured", async () => {
    const exec = new FreebuffExecutor();
    const res = await exec.execute({ model: "freebuff/deepseek/deepseek-v4-flash", body: { messages: [] }, stream: false, credentials: {} });
    expect(res.response.status).toBe(401);
  });
});
