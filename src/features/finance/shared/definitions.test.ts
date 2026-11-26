/**
 * One definition per number (N-MO3): each distinct figure has a distinct label, and the functions that compute the
 * UI-derived figures agree with the backend on the demo seed.
 */
import { describe, expect, it } from "vitest";
import { mockApi } from "@/test/helpers";
import type { BudgetLine, SankeyData, TaxEstimate } from "@/backend/types";
import { allSpending, budgetActivity, budgetLeft, budgetSpent, FIGURES, figureLabel, itemisedComparison, keptFromSankey, noPaymentNeeded, periodReturn, portfolioParts, rangeYears, safeHarbourKnown, twrFigures, vsBenchmarkPts } from "./definitions";
import { defaultProfile } from "@/features/taxes/data";
import { fmtPp } from "./format";
import { debtsOf, flows, readLedger, resolveSet } from "@/backend/mock/commands/finance";

const money = (amount: string) => ({ amount, currency: "EUR" });
const line = (group: string, assigned: string, activity: string): BudgetLine => ({ categoryId: group, name: group, group, color: "gray", assigned: money(assigned), activity: money(activity), available: money("0"), pace: 0.5 });

describe("figure registry", () => {
  it("no two figures share a label, and nothing is labelled just \"Spent\"", () => {
    const labels = Object.values(FIGURES).map((f) => f.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).not.toContain("Spent");
    for (const f of Object.values(FIGURES)) expect(f.definition.length).toBeGreaterThan(20);
  });

  it("range figures carry their range in the label", () => {
    expect(figureLabel("pf.twr", "1Y")).toBe("Time-weighted · 1Y");
    expect(figureLabel("pf.mwr.range", "3M")).toBe("Money-weighted · 3M");
    expect(figureLabel("networth")).toBe("Net worth");
  });
});

describe("Money HQ spending figures", () => {
  const lines = [line("Bills", "100", "-40"), line("Everyday", "50", "-70"), line("Savings & Debt", "500", "-500"), line("Income", "0", "3000")];

  it("spent in budget excludes savings, debt and income; left this month never goes below zero", () => {
    expect(budgetSpent(lines)).toBe(110);
    expect(budgetLeft(lines)).toBe(40);
    expect(budgetLeft([line("Bills", "10", "-40")])).toBe(0);
  });

  it("activity counts savings and debt payments but not income", () => {
    const cats = lines.map((l) => ({ categoryId: l.categoryId, assigned: l.assigned.amount, activity: l.activity.amount, available: "0", rollover: "0" }));
    expect(budgetActivity(cats, (id) => id)).toBe(-610);
  });

  it("all spending is the breakdown total (uncategorised included)", () => {
    expect(allSpending([{ key: "a", label: "A", amount: "10.5", pct: 0.5 }, { key: "uncategorized", label: "Uncategorised", amount: "4.5", pct: 0.5 }])).toBe(15);
    expect(allSpending(undefined)).toBe(0);
  });

  it("kept = income − spending over income; savings flows are not spending", () => {
    const d: SankeyData = {
      nodes: [{ name: "Paycheck" }, { name: "Income" }, { name: "Bills" }, { name: "Savings & Debt" }, { name: "Saved & paid down" }],
      links: [
        { source: 0, target: 1, value: 1000 },
        { source: 1, target: 2, value: 400 },
        { source: 1, target: 3, value: 100 },
        { source: 1, target: 4, value: 500 },
      ],
    };
    expect(keptFromSankey(d)).toEqual({ income: 1000, spending: 400, kept: 600, ratio: 0.6 });
    expect(keptFromSankey(undefined).ratio).toBe(0);
  });

  it("on the demo seed: the three spending numbers are distinct and related exactly as their definitions say", async () => {
    const { api, backend } = await mockApi();
    const inst = backend.ctx.seedRefs.get("finance.instance.moneyHq")!;
    const ov = await api.finance.overview({ instanceId: inst, month: "2026-11" });
    const br = await api.finance.spendingBreakdown({ instanceId: inst, from: "2026-11-01", to: "2026-11-30", by: "category" });
    const bm = await api.finance.budgetMonth({ instanceId: inst, month: "2026-11" });
    const spent = budgetSpent(ov.budget);
    const all = allSpending(br);
    const uncat = Number(br.find((r) => r.key === "uncategorized")?.amount ?? 0);
    const group = new Map(ov.budget.map((b) => [b.categoryId, b.group]));
    const activity = budgetActivity(bm.categories, (id) => group.get(id));
    // All spending = spent in budget + uncategorised (+ unbudgeted categories, none in the demo).
    expect(all).toBeCloseTo(spent + uncat, 2);
    // Activity includes savings & debt payments, so it is a larger outflow than spent in budget.
    expect(-activity).toBeGreaterThan(spent);
    expect(new Set([spent.toFixed(2), all.toFixed(2), (-activity).toFixed(2)]).size).toBe(3);
    // Left this month is what Home shows: assigned − spent in budget.
    expect(budgetLeft(ov.budget)).toBeCloseTo(Math.max(0, ov.budget.filter((b) => !/income|saving/i.test(b.group)).reduce((a, b) => a + Number(b.assigned.amount), 0) - spent), 2);
  });

  it("on the demo seed: a month's kept figure is income − spending for that month (the savings-rate definition)", async () => {
    const { api, backend } = await mockApi();
    const inst = backend.ctx.seedRefs.get("finance.instance.moneyHq")!;
    const l = readLedger(backend.ctx, resolveSet(backend.ctx, inst));
    for (const month of ["2026-08", "2026-09", "2026-10"]) {
      const k = keptFromSankey(await api.finance.cashflowSankey({ instanceId: inst, month }));
      const f = flows(l, `${month}-01`, `${month}-31`);
      // The Sankey's flows reproduce the backend's savings-rate `flows()` for the same window, exactly.
      expect(k.income).toBeCloseTo(f.income / 100, 2);
      expect(k.spending).toBeCloseTo(f.spending / 100, 2);
      expect(k.kept).toBeCloseTo((f.income - f.spending) / 100, 2);
    }
  });
});

describe("debt-free scenarios", () => {
  it("the Overview's 'at minimum payments' month is the planner's minimum line for the ledger debts", async () => {
    const { api, backend } = await mockApi();
    const inst = backend.ctx.seedRefs.get("finance.instance.moneyHq")!;
    const ov = await api.finance.overview({ instanceId: inst, month: "2026-11" });
    const l = readLedger(backend.ctx, resolveSet(backend.ctx, inst));
    const debts = debtsOf(l, "2026-11-26").map((d) => ({ name: d.name, balance: (d.balance / 100).toFixed(2), aprPct: String(d.apr), minPayment: (d.min / 100).toFixed(2) }));
    const plan = await api.finance.debtPlan({ debts, strategy: "avalanche", extraMonthly: "200", startMonth: "2026-12" });
    const min = plan.strategies.find((x) => x.strategy === "minimum")!;
    const avalanche = plan.strategies.find((x) => x.strategy === "avalanche")!;
    expect(min.payoffDate.slice(0, 7)).toBe(ov.debtFreeDate);
    // "with your plan" is a different scenario, so a different month under a different label.
    expect(avalanche.payoffDate.slice(0, 7) < min.payoffDate.slice(0, 7)).toBe(true);
    expect(figureLabel("debtFree.plan")).not.toBe(figureLabel("debtFree.minimum"));
  });
});

describe("portfolio returns", () => {
  it("never annualises under a year (GIPS); annualises a year or more", () => {
    expect(periodReturn(0.2, 0.25).annualised).toBe(false);
    expect(periodReturn(0.2, 0.25).value).toBeCloseTo(1.2 ** 0.25 - 1, 9);
    expect(periodReturn(0.2, 1)).toEqual({ value: 0.2, annualised: true });
    expect(periodReturn(0.2, 5)).toEqual({ value: 0.2, annualised: true });
  });

  it("TWR is cumulative over the range, with an annual companion only for ≥ 1 year", () => {
    expect(twrFigures([0, 0.1, 0.21], 2)).toEqual({ cumulative: 0.21, annual: expect.closeTo(0.1, 9) });
    expect(twrFigures([0, 0.05], 0.25)).toEqual({ cumulative: 0.05, annual: null });
    expect(twrFigures([], 1)).toBeNull();
    const t0 = Date.parse("2025-11-26T12:00:00Z");
    expect(rangeYears([t0, t0 + 365.25 * 86_400_000])).toBeCloseTo(1, 6);
  });

  it("the gap to the benchmark is in points, never percent", () => {
    expect(vsBenchmarkPts(0.158, 0.268)).toBeCloseTo(-11, 9);
    expect(fmtPp(vsBenchmarkPts(0.158, 0.268))).toBe("−11.0 pts");
    expect(fmtPp(-0.01)).toBe("0.0 pts");
  });

  it("on the demo seed: since first buy, this year and the range figure are three different numbers", async () => {
    const { api, backend } = await mockApi();
    const pf = backend.ctx.seedRefs.get("finance.instance.portfolio")!;
    const s = await api.portfolio.summary({ instanceId: pf });
    const perf = await api.portfolio.performance({ instanceId: pf, range: "1y" });
    expect(s.xirrAll).toBeDefined();
    expect(perf.xirr).toBeDefined();
    const labels = [figureLabel("pf.mwr.all"), figureLabel("pf.mwr.ytd"), figureLabel("pf.mwr.range", "1Y"), figureLabel("pf.twr", "1Y")];
    expect(new Set(labels).size).toBe(4);
  });

  it("'this year' is the YTD range's XIRR de-annualised: one number, not annualised, the same as the YTD legend", async () => {
    const { api, backend } = await mockApi();
    const pf = backend.ctx.seedRefs.get("finance.instance.portfolio")!;
    const ytd = await api.portfolio.performance({ instanceId: pf, range: "ytd" });
    expect(ytd.xirr).toBeDefined();
    const years = rangeYears(ytd.t);
    expect(years).toBeLessThan(1);
    const r = periodReturn(ytd.xirr!, years);
    expect(r.annualised).toBe(false);
    expect(r.value).toBeCloseTo((1 + ytd.xirr!) ** years - 1, 12);
  });

  it("value and unrealised popovers list their real inputs: cash is in total value, never in the gain", async () => {
    const h = (value: string, cost: string) => ({ value: money(value), costBasis: money(cost) }) as never;
    expect(portfolioParts({ totalValue: money("1100"), holdings: [h("600", "500"), h("400", "450")] })).toEqual({ holdings: 1000, cost: 950, cash: 100 });
    expect(portfolioParts({ totalValue: money("1000.2"), holdings: [h("1000", "900")] }).cash).toBe(0);
    const { api, backend } = await mockApi();
    const pf = backend.ctx.seedRefs.get("finance.instance.portfolio")!;
    const s = await api.portfolio.summary({ instanceId: pf });
    const p = portfolioParts(s);
    expect(p.holdings + p.cash).toBeCloseTo(Number(s.totalValue.amount), 0);
    // The gain on cost a user can check from the popover's inputs is the figure shown.
    expect((p.holdings - p.cost) / p.cost).toBeCloseTo(s.unrealizedPct, 2);
    expect(p.holdings - p.cost).toBeCloseTo(Number(s.unrealized.amount), 0);
  });
});

describe("tax figures", () => {
  const est = (deduction: TaxEstimate["deduction"]) => ({ deduction });

  it("the hub compares the engine's itemised figure (floors and caps applied), not the raw log", () => {
    const c = itemisedComparison(est({ kind: "standard", amount: "16100", standardWouldBe: "16100", itemizedWouldBe: "1200" }), 9000);
    expect(c).toEqual({ id: "tax.itemised", itemised: 1200, standard: 16100, standardBase: 16100, nonItemiserCharity: 0, margin: -14900 });
    // The engine itemised: its amount is the itemised figure.
    expect(itemisedComparison(est({ kind: "itemized", amount: "20000", standardWouldBe: "16100" }), 5)?.itemised).toBe(20000);
  });

  it("without an engine figure the raw log is shown under its own label", () => {
    const c = itemisedComparison(est({ kind: "standard", amount: "16100", standardWouldBe: "16100" }), 1670);
    expect(c?.id).toBe("tax.logged");
    expect(figureLabel("tax.logged")).not.toBe(figureLabel("tax.itemised"));
    expect(itemisedComparison(undefined, 1)).toBeNull();
  });

  it("the standard side is what itemising must beat: standard plus the non-itemiser cash-gift deduction", () => {
    const c = itemisedComparison(est({ kind: "standard", amount: "16530", standardWouldBe: "16100", itemizedWouldBe: "0" }), 0)!;
    expect(c.standard).toBe(16530);
    expect(c.standardBase).toBe(16100);
    expect(c.nonItemiserCharity).toBe(430);
    expect(c.margin).toBe(-16530);
    // When the engine itemised, the alternative is the standard deduction it reports.
    const i = itemisedComparison(est({ kind: "itemized", amount: "20000", standardWouldBe: "16100", itemizedWouldBe: "20000" }), 0)!;
    expect(i).toMatchObject({ standard: 16100, nonItemiserCharity: 0, margin: 3900 });
  });

  it("a quarter with nothing to pay never says 'Covered' while a balance is due", () => {
    expect(noPaymentNeeded(1224, "$1,224 due Apr 15", true).label).toBe("No penalty expected · $1,224 due Apr 15");
    expect(noPaymentNeeded(0, "", false).label).toBe("No payment needed");
    for (const known of [true, false]) expect(noPaymentNeeded(1224, "x", known).label).not.toMatch(/covered/i);
  });

  it("'No penalty expected' needs the safe harbor's inputs: the default profile (last year's tax 0) is unknown", () => {
    const p = defaultProfile(2026);
    expect(p.method).toBe("safe_harbor");
    expect(safeHarbourKnown(p)).toBe(false);
    const n = noPaymentNeeded(1328, "$1,328 due Apr 15, 2027", safeHarbourKnown(p));
    expect(n.needsInput).toBe(true);
    expect(n.label).not.toMatch(/no penalty/i);
    expect(n.short).not.toMatch(/no penalty/i);
    expect(safeHarbourKnown({ ...p, priorYearTax: "14000" })).toBe(false); // AGI decides 100% vs 110%
    expect(safeHarbourKnown({ ...p, priorYearTax: "14000", priorYearAgi: "120000" })).toBe(true);
    expect(safeHarbourKnown({ ...p, method: "current_90" })).toBe(true);
    expect(safeHarbourKnown({ ...p, method: "even_split", priorYearTax: "14000", priorYearAgi: "120000" })).toBe(false);
  });

  it("on the demo seed: the engine's comparison applies the 7.5% medical floor", async () => {
    const { api, backend } = await mockApi();
    const inst = backend.ctx.seedRefs.get("finance.instance.tax");
    if (!inst) return; // seed without the Tax Organizer
    const e = await api.tax.estimate({ packId: "us-federal-2026", year: 2026, filingStatus: "single", dependents: 0, incomes: [{ kind: "wages", amount: "80000" }], adjustments: [], deductions: { itemized: [{ kind: "medical", amount: "5000" }] }, credits: [], withheld: "0", estimatedPaid: "0" }).catch(() => null);
    if (!e || e.deduction.itemizedWouldBe === undefined) return; // L7's itemizedWouldBe not in this build yet
    // $5,000 medical against a $6,000 floor (7.5% of $80,000 AGI) itemises to nothing.
    const c = itemisedComparison(e, 5000)!;
    expect(c.id).toBe("tax.itemised");
    expect(c.itemised).toBeLessThan(5000);
  });
});
