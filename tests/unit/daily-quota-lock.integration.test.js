import { describe, it, expect, afterAll } from "vitest";
import { markAccountUnavailable } from "../../src/sse/services/auth.js";
import { getProviderConnections, createProviderConnection, deleteProviderConnection, updateProviderConnection } from "../../src/lib/localDb.js";

// Integration: the DB write path behind markAccountUnavailable. Uses a scratch
// connection named with a fixed marker and always deletes it, so the developer's
// real connections are never touched.
const MARKER = "__vitest_daily_quota__";
const CLINE_DAILY = '[429]: {"error":{"code":"INFERENCE_CAP_ERROR","message":"Error 429: Daily free limit reached on model z-ai/glm-5.3-flash"}}';

async function makeConn() {
  const conn = await createProviderConnection({
    provider: "cline",
    authType: "apikey",
    name: MARKER,
    apiKey: "scratch",
    isActive: true,
  });
  return conn;
}

async function readConn(id) {
  const all = await getProviderConnections({ provider: "cline" });
  return all.find((c) => c.id === id);
}

afterAll(async () => {
  const all = await getProviderConnections({ provider: "cline" });
  for (const c of all.filter((x) => x.name === MARKER)) await deleteProviderConnection(c.id);
});

describe("markAccountUnavailable — daily free-tier quota", () => {
  it("parks the model for hours and records quotaExhaustedUntil, keeping the connection active", async () => {
    const conn = await makeConn();
    try {
      const res = await markAccountUnavailable(conn.id, 429, CLINE_DAILY, "cline", "z-ai/glm-5.3-flash");
      expect(res.shouldFallback).toBe(true);

      const after = await readConn(conn.id);
      expect(after.isActive).not.toBe(false); // stays active → auto-recovers
      expect(after.quotaExhaustedUntil).toBeTruthy();

      const lockKey = Object.keys(after).find((k) => k === "modelLock_z-ai/glm-5.3-flash");
      const until = new Date(after[lockKey]).getTime();
      expect(until - Date.now()).toBeGreaterThan(60 * 60 * 1000); // hours, not minutes
      expect(after.lastError).toMatch(/Quota exhausted/);
    } finally {
      await deleteProviderConnection(conn.id);
    }
  });

  it("generic rate limits keep the short backoff path (no quotaExhaustedUntil)", async () => {
    const conn = await makeConn();
    try {
      await markAccountUnavailable(conn.id, 429, "too many requests", "cline", "z-ai/glm-5.3-flash");
      const after = await readConn(conn.id);
      expect(after.quotaExhaustedUntil ?? null).toBeFalsy();
      const lockKey = Object.keys(after).find((k) => k === "modelLock_z-ai/glm-5.3-flash");
      const until = new Date(after[lockKey]).getTime();
      expect(until - Date.now()).toBeLessThan(60 * 1000); // seconds
    } finally {
      await deleteProviderConnection(conn.id);
    }
  });
});
