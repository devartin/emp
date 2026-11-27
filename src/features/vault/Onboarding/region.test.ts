/** Region detection for first run (1.0 brief §2.5): first day of the week and clock per locale. */
import { describe, expect, test } from "vitest";
import { clockFor, detectRegion, weekStartFor } from "./region";

describe("region", () => {
  test("first day of the week follows the region", () => {
    expect(weekStartFor("en-US")).toBe(0);
    expect(weekStartFor("en-GB")).toBe(1);
    expect(weekStartFor("de-DE")).toBe(1);
    expect(weekStartFor("pt-BR")).toBe(0);
    expect(weekStartFor("ar-EG")).toBe(6);
    // A language without a region resolves to its likely region (fr → FR, Monday).
    expect(weekStartFor("fr")).toBe(1);
    expect(weekStartFor("not a locale")).toBe(1);
  });

  test("clock follows how the locale writes times", () => {
    expect(clockFor("en-US")).toBe(12);
    expect(clockFor("en-GB")).toBe(24);
    expect(clockFor("de-DE")).toBe(24);
  });

  test("detectRegion returns values settings accept", () => {
    const r = detectRegion();
    expect(r.locale).toMatch(/^[a-z]{2,3}(-[A-Za-z0-9]+)*$/);
    expect(r.timezone.length).toBeGreaterThan(0);
    expect([0, 1, 6]).toContain(r.weekStart);
    expect([12, 24]).toContain(r.clock);
  });
});
