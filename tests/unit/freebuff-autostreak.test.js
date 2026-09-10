import { describe, it, expect } from "vitest";

// Pure-function tests for the FreeBuff auto-streak scheduler.
// (network/DB paths are exercised live; here we pin the deterministic logic)

const mod = await import("../../src/shared/services/freebuffAutoStreak.js");
const { pacificDayKey, slotMinuteOfDay, pickCheapestModel } = mod;

describe("pacificDayKey", () => {
  it("formats a timestamp as en-CA date in America/Los_Angeles", () => {
    // 2026-09-09T14:00:00Z = 07:00 Pacific (DST) → same day
    expect(pacificDayKey(Date.parse("2026-09-09T14:00:00Z"))).toBe("2026-09-09");
  });
  it("rolls to the previous Pacific day for early-morning UTC times", () => {
    // 2026-09-10T06:59:00Z = 23:59 Pacific on Sep 9 → still the 9th
    expect(pacificDayKey(Date.parse("2026-09-10T06:59:00Z"))).toBe("2026-09-09");
  });
});

describe("slotMinuteOfDay (daily re-roll)", () => {
  it("stable within one pacific day, different across days", () => {
    const d1 = "2026-09-09", d2 = "2026-09-10";
    const a1 = slotMinuteOfDay("conn-a", d1, 7, 10);
    expect(a1).toBe(slotMinuteOfDay("conn-a", d1, 7, 10)); // same day = same slot
    const a2 = slotMinuteOfDay("conn-a", d2, 7, 10);
    expect(a2).not.toBe(a1); // new day = re-rolled (no fixed-hour pattern)
    expect(a1).toBeGreaterThanOrEqual(7 * 60);
    expect(a1).toBeLessThan(10 * 60);
  });
  it("gives different connections different slots on the same day (stagger)", () => {
    const slots = new Set(Array.from({ length: 12 }, (_, i) => slotMinuteOfDay(`freebuff-conn-${i}`, "2026-09-09", 7, 10)));
    expect(slots.size).toBeGreaterThanOrEqual(6);
  });
});

describe("pickCheapestModel", () => {
  const PRICES = {
    "z-ai/glm-5.3-flash": 5,
    "mimo/mimo-v2.5": 10,
    "deepseek/deepseek-v4-flash": 30,
    "openai/gpt-5.6-luna": 20,
    "upstage/solar-pro4": 5,
    "crof/kimi-k3-eco": 5,
    "meta/muse-spark-1.3-contributor": 15,
    "google/gemini-3.8-flash": 50,
  };

  it("picks a 5fb model when balance is 20 (never deepseek at 30)", () => {
    const [model, price] = pickCheapestModel(PRICES, 20);
    expect(price).toBe(5);
    expect(["z-ai/glm-5.3-flash", "upstage/solar-pro4", "crof/kimi-k3-eco"]).toContain(model);
  });

  it("never picks a model above the remaining balance", () => {
    const [model, price] = pickCheapestModel(PRICES, 8);
    expect(price).toBeLessThanOrEqual(8);
    expect(model).toBeTruthy();
  });

  it("returns null when nothing is affordable", () => {
    const [model, price] = pickCheapestModel(PRICES, 2);
    expect(model).toBeNull();
    expect(price).toBe(0);
  });

  it("ignores non-finite and free entries", () => {
    const [model] = pickCheapestModel({ "z-ai/glm-5.3-flash": 5, "weird/model": 0, "bad/model": "x" }, 20);
    expect(model).toBe("z-ai/glm-5.3-flash");
  });
});
