// Providers without a usage API (Cline, ClinePass, OpenAI-compatible nodes…)
// returned "Usage API not implemented" and the quota page showed an empty card —
// even while the router had parked the account on a quota reset it had computed
// itself. These tests pin the synthetic rows that fill that gap, and the rule
// that provider-reported rows always win.
import { describe, it, expect, vi, afterEach } from "vitest";
import { buildRouterQuotaState, hasQuotaRows } from "../../open-sse/services/routerQuotaState.js";

const NOW = Date.parse("2026-09-15T10:00:00Z");
const FUTURE = new Date(NOW + 6 * 3600 * 1000).toISOString();
const PAST = new Date(NOW - 3600 * 1000).toISOString();

afterEach(() => vi.restoreAllMocks());

describe("buildRouterQuotaState", () => {
  it("returns null when nothing is parked (provider data stays untouched)", () => {
    expect(buildRouterQuotaState({ provider: "cline" }, NOW)).toBeNull();
    expect(buildRouterQuotaState({ provider: "cline", quotaExhaustedUntil: PAST }, NOW)).toBeNull();
    expect(buildRouterQuotaState(null, NOW)).toBeNull();
    expect(buildRouterQuotaState({}, NOW)).toBeNull();
  });

  it("surfaces a quota park as a depleted row with the reset time", () => {
    const state = buildRouterQuotaState(
      { provider: "cline", quotaExhaustedUntil: FUTURE },
      NOW,
    );
    expect(state.synthetic).toBe(true);
    const rows = Object.values(state.quotas);
    expect(rows).toHaveLength(1);
    expect(rows[0].remainingPercentage).toBe(0);
    expect(rows[0].unlimited).toBe(false);
    expect(rows[0].resetAt).toBe(FUTURE);
  });

  it("labels the row with the provider's own quota cadence", () => {
    const daily = buildRouterQuotaState({ provider: "cline", quotaExhaustedUntil: FUTURE }, NOW);
    expect(Object.keys(daily.quotas)).toEqual(["Quota (daily)"]);

    const weekly = buildRouterQuotaState({ provider: "grok-cli", quotaExhaustedUntil: FUTURE }, NOW);
    expect(Object.keys(weekly.quotas)).toEqual(["Quota (weekly)"]);

    const monthly = buildRouterQuotaState({ provider: "kiro", quotaExhaustedUntil: FUTURE }, NOW);
    expect(Object.keys(monthly.quotas)).toEqual(["Quota (monthly)"]);

    const session = buildRouterQuotaState({ provider: "codex", quotaExhaustedUntil: FUTURE }, NOW);
    expect(Object.keys(session.quotas)).toEqual(["Quota (session)"]);
  });

  it("the quota park outranks per-model locks (whole account vs one model)", () => {
    const state = buildRouterQuotaState(
      {
        provider: "cline",
        quotaExhaustedUntil: FUTURE,
        "modelLock_z-ai/glm-5.3-flash": FUTURE,
      },
      NOW,
    );
    expect(Object.keys(state.quotas)).toEqual(["Quota (daily)"]);
  });

  it("lists per-model cooldowns when there is no account-level park", () => {
    const state = buildRouterQuotaState(
      {
        provider: "cline",
        "modelLock_z-ai/glm-5.3-flash": FUTURE,
        "modelLock_cline-free/solar-pro4": PAST, // expired → dropped
      },
      NOW,
    );
    expect(Object.keys(state.quotas)).toEqual(["z-ai/glm-5.3-flash"]);
  });

  it("modelLock___all means the whole account", () => {
    const state = buildRouterQuotaState(
      {
        provider: "cline",
        "modelLock___all": FUTURE,
        "modelLock_z-ai/glm-5.3-flash": FUTURE,
      },
      NOW,
    );
    expect(Object.keys(state.quotas)).toEqual(["Quota (account)"]);
  });

  it("caps the model rows so a broad outage can't flood the card", () => {
    const conn = { provider: "cline" };
    for (let i = 0; i < 9; i++) conn[`modelLock_model-${i}`] = FUTURE;
    const state = buildRouterQuotaState(conn, NOW);
    expect(Object.keys(state.quotas)).toHaveLength(5);
  });

  it("shows a short rate-limit cooldown when nothing else is parked", () => {
    const state = buildRouterQuotaState(
      { provider: "cline", rateLimitedUntil: FUTURE },
      NOW,
    );
    expect(Object.keys(state.quotas)).toEqual(["Rate limited"]);
  });

  it("ignores unparseable timestamps instead of throwing", () => {
    expect(buildRouterQuotaState({ provider: "cline", quotaExhaustedUntil: "not-a-date" }, NOW)).toBeNull();
    expect(buildRouterQuotaState({ provider: "cline", "modelLock_x": {} }, NOW)).toBeNull();
  });
});

describe("hasQuotaRows", () => {
  it("detects provider-reported rows", () => {
    expect(hasQuotaRows({ quotas: { "Weekly SuperGrok": { used: 1, total: 100 } } })).toBe(true);
  });

  it("is false for the not-implemented / empty payloads", () => {
    expect(hasQuotaRows({ message: "Usage API not implemented for cline" })).toBe(false);
    expect(hasQuotaRows({ quotas: {} })).toBe(false);
    expect(hasQuotaRows(null)).toBe(false);
    expect(hasQuotaRows(undefined)).toBe(false);
  });
});
