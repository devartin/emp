/**
 * Reconcile maths (PROGRAMME-v3 K5b): cards and loans are entered as the statement prints them — an amount owed.
 */
import { describe, expect, it } from "vitest";
import { clearedAsOf, reconcileCompare, statementFieldFromFile } from "./reconcile";

describe("reconcile", () => {
  it("a card reconciles from the positive amount owed its statement prints", () => {
    // Sapphire Rewards Card on the demo seed: cleared −$2,025.32 in the ledger.
    const c = reconcileCompare(true, "2025.32", -2025.32);
    expect(c.ok).toBe(true);
    expect(c.statement).toBe(-2025.32);
    expect(c.clearedShown).toBe(2025.32);
    expect(c.hint).toBeNull();
  });

  it("a card that is off says which way in terms of what is owed", () => {
    const more = reconcileCompare(true, "2100", -2025.32);
    expect(more.ok).toBe(false);
    expect(Math.abs(more.diff)).toBeCloseTo(74.68, 2);
    expect(more.hint).toMatch(/^statement shows more owed/);
    expect(reconcileCompare(true, "2000", -2025.32).hint).toMatch(/^statement shows less owed/);
    // A credit balance printed as a negative amount owed is a positive ledger balance.
    expect(reconcileCompare(true, "-50", 50).ok).toBe(true);
  });

  it("cash accounts compare the balance as typed", () => {
    expect(reconcileCompare(false, "11057.90", 11057.9).ok).toBe(true);
    expect(reconcileCompare(false, "11100", 11057.9).hint).toMatch(/^statement is higher/);
    expect(reconcileCompare(false, "11000", 11057.9).hint).toMatch(/^statement is lower/);
    const empty = reconcileCompare(false, null, 11057.9);
    expect(empty).toMatchObject({ entered: false, ok: false, hint: null });
    expect(reconcileCompare(false, "  ", 5).entered).toBe(false);
    expect(Object.is(reconcileCompare(true, null, 0).clearedShown, -0)).toBe(false);
  });

  it("a file's card balance is offered as an amount owed whichever sign the bank used", () => {
    expect(statementFieldFromFile(true, "-2025.32")).toBe("2025.32");
    expect(statementFieldFromFile(true, "2025.32")).toBe("2025.32");
    expect(statementFieldFromFile(false, "-12.50")).toBe("-12.50");
    expect(reconcileCompare(true, statementFieldFromFile(true, "-2025.32"), -2025.32).ok).toBe(true);
  });

  it("cleared as of the statement date counts cleared and reconciled rows up to that day", () => {
    const txns = [
      { accountId: "a", date: "2026-11-01", amount: -100, cleared: "cleared" },
      { accountId: "a", date: "2026-11-02", amount: -50, cleared: "reconciled" },
      { accountId: "a", date: "2026-11-03", amount: -25, cleared: "uncleared" },
      { accountId: "a", date: "2026-11-30", amount: -10, cleared: "cleared" },
      { accountId: "b", date: "2026-11-01", amount: -999, cleared: "cleared" },
    ];
    expect(clearedAsOf({ id: "a", opening: -1000 }, txns, "2026-11-20")).toBe(-1150);
  });
});
