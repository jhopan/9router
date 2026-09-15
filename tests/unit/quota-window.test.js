import { describe, it, expect, afterEach } from "vitest";
import {
  quotaWindowFor,
  calendarResetMs,
  pickResetFromUsage,
  resolveQuotaResetAt,
  isQuotaExhaustedError,
  _clearQuotaWindowCache,
  QUOTA_SCOPES,
} from "../../open-sse/services/quotaWindow.js";

afterEach(() => _clearQuotaWindowCache());

// A fixed "now": Wednesday 2026-09-16T10:00:00Z
const NOW = Date.UTC(2026, 8, 16, 10, 0, 0);

describe("quotaWindowFor", () => {
  it("returns the provider entry", () => {
    expect(quotaWindowFor("antigravity").scope).toBe(QUOTA_SCOPES.WEEKLY);
    expect(quotaWindowFor("kiro").scope).toBe(QUOTA_SCOPES.MONTHLY);
    expect(quotaWindowFor("codex").scope).toBe(QUOTA_SCOPES.SESSION);
  });

  it("falls back to the default entry for unknown providers", () => {
    expect(quotaWindowFor("nope").scope).toBe(QUOTA_SCOPES.DAILY);
  });

  it("is case-insensitive and carries shared knobs + ceiling", () => {
    const cfg = quotaWindowFor("FreeBuff");
    expect(cfg.scope).toBe(QUOTA_SCOPES.DAILY);
    expect(cfg.resetUtcHour).toBe(7);
    expect(cfg.maxCooldownMs).toBeGreaterThan(24 * 3600 * 1000);
    expect(cfg.weeklyResetWeekday).toBe(1);
  });
});

describe("calendarResetMs", () => {
  it("daily lands on the provider's UTC rollover", () => {
    expect(new Date(calendarResetMs(QUOTA_SCOPES.DAILY, { resetUtcHour: 0 }, NOW)).toISOString())
      .toBe("2026-09-17T00:00:00.000Z");
    expect(new Date(calendarResetMs(QUOTA_SCOPES.DAILY, { resetUtcHour: 7 }, NOW)).toISOString())
      .toBe("2026-09-17T07:00:00.000Z");
  });

  it("daily rolls to tomorrow when today's hour already passed", () => {
    const early = Date.UTC(2026, 8, 16, 1, 0, 0);
    expect(new Date(calendarResetMs(QUOTA_SCOPES.DAILY, { resetUtcHour: 7 }, early)).toISOString())
      .toBe("2026-09-16T07:00:00.000Z");
  });

  it("weekly lands on the next Monday (Antigravity cadence)", () => {
    // NOW is a Wednesday → next Monday
    expect(new Date(calendarResetMs(QUOTA_SCOPES.WEEKLY, {}, NOW)).toISOString())
      .toBe("2026-09-21T00:00:00.000Z");
  });

  it("monthly lands on the 1st of next month (Kiro cadence)", () => {
    expect(new Date(calendarResetMs(QUOTA_SCOPES.MONTHLY, {}, NOW)).toISOString())
      .toBe("2026-10-01T00:00:00.000Z");
  });

  it("session adds a full rolling window", () => {
    const ms = calendarResetMs(QUOTA_SCOPES.SESSION, { sessionWindowMs: 5 * 3600 * 1000 }, NOW);
    expect(ms - NOW).toBe(5 * 3600 * 1000);
  });
});

describe("pickResetFromUsage", () => {
  it("reads the preferred quota key (Antigravity weekly bucket)", () => {
    const usage = { quotas: { gemini_weekly: { resetAt: "2026-09-21T00:00:00Z", used: 100, total: 100 } } };
    expect(pickResetFromUsage(usage, "gemini_weekly", NOW)).toBe(Date.parse("2026-09-21T00:00:00Z"));
  });

  it("matches namespaced keys by suffix (Codex `gpt_session`)", () => {
    const usage = { quotas: { gpt_session: { resetAt: "2026-09-16T15:00:00Z" } } };
    expect(pickResetFromUsage(usage, "session", NOW)).toBe(Date.parse("2026-09-16T15:00:00Z"));
  });

  it("falls back to the earliest future reset when the key is unknown", () => {
    const usage = { quotas: {
      a: { resetAt: "2026-09-20T00:00:00Z" },
      b: { resetAt: "2026-09-18T00:00:00Z" },
    } };
    expect(pickResetFromUsage(usage, null, NOW)).toBe(Date.parse("2026-09-18T00:00:00Z"));
  });

  it("ignores past resets and unlimited buckets", () => {
    const usage = { quotas: {
      past: { resetAt: "2020-01-01T00:00:00Z" },
      free: { unlimited: true, resetAt: "2026-09-18T00:00:00Z" },
      good: { resetAt: "2026-09-19T00:00:00Z" },
    } };
    expect(pickResetFromUsage(usage, null, NOW)).toBe(Date.parse("2026-09-19T00:00:00Z"));
  });

  it("returns null when the usage payload has no quotas", () => {
    expect(pickResetFromUsage({ message: "not implemented" }, "session", NOW)).toBeNull();
    expect(pickResetFromUsage(null, "session", NOW)).toBeNull();
  });
});

describe("resolveQuotaResetAt", () => {
  it("calendar fallback: Kiro → next month, Antigravity → next Monday", async () => {
    const kiro = await resolveQuotaResetAt({ provider: "kiro", now: NOW, probe: false });
    expect(kiro.source).toBe("calendar");
    expect(new Date(kiro.resetAtMs).toISOString()).toBe("2026-10-01T00:00:00.000Z");

    const ag = await resolveQuotaResetAt({ provider: "antigravity", now: NOW, probe: false });
    expect(new Date(ag.resetAtMs).toISOString()).toBe("2026-09-21T00:00:00.000Z");
  });

  it("never returns a cooldown below the 1-minute floor", async () => {
    const past = await resolveQuotaResetAt({ provider: "cline", now: NOW, probe: false });
    expect(past.cooldownMs).toBeGreaterThanOrEqual(60 * 1000);
  });

  it("capped by the provider ceiling", async () => {
    const r = await resolveQuotaResetAt({ provider: "kiro", now: NOW, probe: false });
    const cfg = quotaWindowFor("kiro");
    expect(r.cooldownMs).toBeLessThanOrEqual(cfg.maxCooldownMs);
    expect(r.cooldownMs).toBeGreaterThan(14 * 24 * 3600 * 1000); // ~2 weeks to Oct 1
  });

  it("probe:false never touches the network even with a connection", async () => {
    const r = await resolveQuotaResetAt({ provider: "kiro", connection: { id: "x" }, now: NOW, probe: false });
    expect(r.source).toBe("calendar");
  });
});

describe("isQuotaExhaustedError", () => {
  it("matches the real Cline body", () => {
    const body = '[429]: {"error":{"code":"INFERENCE_CAP_ERROR","message":"Error 429: Daily free limit reached on model z-ai/glm-5.3-flash"}}';
    expect(isQuotaExhaustedError(body)).toBe(true);
  });

  it("matches weekly/monthly wordings", () => {
    expect(isQuotaExhaustedError("Weekly limit reached")).toBe(true);
    expect(isQuotaExhaustedError("monthly quota exceeded")).toBe(true);
  });

  it("does not match plain burst rate limits", () => {
    expect(isQuotaExhaustedError("too many requests")).toBe(false);
    expect(isQuotaExhaustedError("rate limit exceeded")).toBe(false);
    expect(isQuotaExhaustedError("")).toBe(false);
  });
});
