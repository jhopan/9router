import { describe, it, expect } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

describe("HTML error page classification (Render cold-start)", () => {
  it("403 with HTML body → short cooldown, not long", () => {
    const html = "<!DOCTYPE html> <html lang=\"en\"> <head> <meta charset=\"utf-8\" /> ...";
    const res = checkFallbackError(403, `[403]: ${html}`, 0);
    expect(res.shouldFallback).toBe(true);
    expect(res.cooldownMs).toBe(5000); // COOLDOWN.short, bukan 2 menit
  });

  it("403 with HTML body (lowercase doctype) → short cooldown", () => {
    const res = checkFallbackError(403, "<!doctype html><html><body>upstream</body></html>", 0);
    expect(res.shouldFallback).toBe(true);
    expect(res.cooldownMs).toBe(5000);
  });

  it("503 with HTML body → short cooldown", () => {
    const res = checkFallbackError(503, "<!DOCTYPE html><html>502 Bad Gateway</html>", 0);
    expect(res.shouldFallback).toBe(true);
    expect(res.cooldownMs).toBe(5000);
  });

  it("generic 403 without HTML → still long cooldown", () => {
    const res = checkFallbackError(403, "forbidden: you do not have access", 0);
    expect(res.shouldFallback).toBe(true);
    expect(res.cooldownMs).toBe(120000);
  });
});
