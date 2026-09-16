import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// cursorModels.js speaks the AgentService Connect RPC over node:http2 (the host
// is HTTP/2-only — see the comment in open-sse/services/cursorModels.js), so
// stubbing global.fetch can never intercept it. These tests drive a fake h2
// client instead; `h2.respond` decides what the next request returns.
const h2 = vi.hoisted(() => ({ connects: [], respond: null }));

vi.mock("http2", () => {
  const connect = (origin) => {
    h2.connects.push(origin);
    const client = {
      on() { return this; },
      close() {},
      request() {
        const handlers = {};
        return {
          on(event, cb) { handlers[event] = cb; return this; },
          end() {
            const reply = h2.respond;
            if (!reply) return;
            queueMicrotask(() => {
              if (reply.error) { handlers.error?.(new Error(reply.error)); return; }
              handlers.response?.({ ":status": reply.status ?? 200 });
              if (reply.body) handlers.data?.(Buffer.from(reply.body));
              handlers.end?.();
            });
          },
        };
      },
    };
    return client;
  };
  return { default: { connect }, connect };
});

const { clearCursorModelCache, parseCursorUsableModels, resolveCursorModels } =
  await import("../../open-sse/services/cursorModels.js");

function varint(value) {
  const bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return Uint8Array.from(bytes);
}

function field(fieldNumber, value) {
  return Uint8Array.from([(fieldNumber << 3) | 2, ...varint(value.length), ...value]);
}

function text(value) {
  return new TextEncoder().encode(value);
}

function concat(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function model(id, name) {
  return field(1, concat(field(1, text(id)), field(4, text(name))));
}

describe("Cursor live model catalog", () => {
  beforeEach(() => {
    clearCursorModelCache();
    h2.connects.length = 0;
    h2.respond = null;
  });

  afterEach(() => {
    h2.respond = null;
    clearCursorModelCache();
  });

  it("decodes the GetUsableModels protobuf response", () => {
    const payload = concat(
      model("default", "Auto"),
      model("gpt-5.3-codex", "GPT 5.3 Codex"),
      model("gpt-5.3-codex", "Duplicate"),
    );

    expect(parseCursorUsableModels(payload)).toEqual([
      { id: "default", name: "Auto" },
      { id: "gpt-5.3-codex", name: "GPT 5.3 Codex" },
    ]);
  });

  it("fetches the account-specific catalog and caches it", async () => {
    const payload = concat(model("claude-4.6-opus", "Claude 4.6 Opus"));
    h2.respond = { status: 200, body: payload };
    const credentials = {
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    };

    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });
    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });

    // Second call is served from the catalog cache — one h2 connection total.
    expect(h2.connects).toHaveLength(1);
    expect(h2.connects[0]).toBe("https://agent.api5.cursor.sh");
  });

  it("fails open when the Cursor catalog request fails", async () => {
    h2.respond = { error: "connect ECONNREFUSED" };

    await expect(resolveCursorModels({
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    })).resolves.toBeNull();
  });

  it("fails open on a non-200 status", async () => {
    h2.respond = { status: 403, body: Buffer.from("no") };

    await expect(resolveCursorModels({
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    })).resolves.toBeNull();
  });
});
