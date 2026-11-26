/**
 * One definition per number (N-MO3, docs/design/PROGRAMME-v3.md K5a; `.council/…/r2_money.md` §2.2).
 *
 * Every headline figure on Money HQ, Portfolio and Taxes has an id here with exactly one label and one plain-language
 * definition. Two different figures never share a label: "Spent in budget", "All spending" and "Activity" are three
 * numbers with three names, and none of them is just "Spent". The `<Figure id>` popover (shared/Figure.tsx) reads the
 * label and definition from this table, so the words on screen and the maths behind them cannot drift apart.
 *
 * The figures the backend computes (net worth, savings rate, debt-free at minimums, portfolio returns, tax) are only
 * *named* here; the pure functions below compute the ones the UI derives, each documented where it is computed.
 */
import type { BudgetLine, BudgetMonth, PortfolioSummary, SankeyData, SpendingSlice, TaxEstimate } from "@/backend/types";
import { isIncomeGroup, isSavingGroup, spendingBudget } from "./figures";

export interface FigureDef {
  /** The exact label on screen. Unique across the registry. */
  label: string;
  /** One or two plain sentences: what is counted, and what is not. */
  definition: string;
}

export const FIGURES = {
  // ── Money HQ
  networth: { label: "Net worth", definition: "Assets minus debts, as of today. Investment accounts are valued by Portfolio. Closed and foreign-currency accounts are not counted." },
  assets: { label: "Assets", definition: "Everything you own that counts in net worth: cash, savings and investments." },
  debts: { label: "Debts", definition: "Everything you owe that counts in net worth: cards and loans, shown as a positive amount." },
  "networth.change": { label: "Change", definition: "Net worth at the end of the range minus net worth at its start." },
  "networth.30d": { label: "Change · last 30 days", definition: "Net worth today minus net worth 30 days ago." },
  "budget.toAssign": { label: "To be assigned", definition: "Money you have that no category has been given yet this month." },
  "budget.spent": { label: "Spent in budget", definition: "Net outflow this month in spending categories (refunds reduce it). Savings, debt payments, transfers and uncategorised rows are not counted." },
  "budget.left": { label: "Left this month", definition: "Assigned to spending categories this month minus spent in budget, never below zero." },
  "spending.all": { label: "All spending", definition: "Spent in budget plus uncategorised outflow and spending in categories without an assignment. Transfers, savings and debt payments are not counted." },
  "budget.activity": { label: "Activity", definition: "Net movement this month in every non-income category, savings and debt payments included." },
  savingsRate3m: { label: "Kept from income · 3 months", definition: "Income minus spending, divided by income, over the 3 months up to today. Transfers, savings and debt payments are not spending." },
  "cashflow.kept": { label: "Kept", definition: "Income minus spending for the month, as a share of income. The same definition as the 3-month figure, for one month." },
  efMonths: { label: "Emergency fund", definition: "Emergency-fund balance divided by your average essential spending per month." },
  "debtFree.minimum": { label: "Debt-free at minimum payments", definition: "The month your debts reach zero if you pay only each minimum, from next month." },
  "debtFree.plan": { label: "Debt-free with your plan", definition: "The month your debts reach zero with the strategy and extra payment set in the Debt planner, from next month." },
  "review.count": { label: "To review", definition: "Transactions not yet marked reviewed." },
  "uncat.count": { label: "Uncategorised", definition: "Transactions with no category that are not a transfer or a split." },
  "upcoming.7d": { label: "Due in the next 7 days", definition: "Scheduled bills and transfers out falling due in the next 7 days." },
  // ── Portfolio
  "pf.value": { label: "Total value", definition: "Quantity times the last price, summed over every holding, plus any uninvested cash the portfolio records." },
  "pf.day": { label: "Today", definition: "Change in value since the previous close." },
  "pf.unrealised": { label: "Unrealised gain", definition: "The value of your holdings minus the cost basis of the lots you still hold (first in, first out). Uninvested cash is not counted." },
  "pf.mwr.all": { label: "Money-weighted · since first buy", definition: "The yearly rate that turns every deposit and withdrawal since your first purchase into today's value (XIRR), annualised." },
  "pf.mwr.ytd": { label: "Money-weighted · this year", definition: "The money-weighted return from January 1 to today: the YTD range's XIRR, turned into this year's own return. Not annualised." },
  "pf.mwr.range": { label: "Money-weighted · range", definition: "The money-weighted return (XIRR) over the selected range. Annualised only when the range is a year or longer." },
  "pf.twr": { label: "Time-weighted · range", definition: "Growth over the selected range with the timing of your deposits removed, so it compares fairly with an index. Cumulative." },
  "pf.vsBench": { label: "Versus benchmark", definition: "Your time-weighted return minus the benchmark's return over the same range, in percentage points." },
  "pf.div12": { label: "Dividends · last 12 months", definition: "Dividends paid in the trailing 12 months." },
  // ── Taxes
  "tax.due": { label: "Due at filing", definition: "Estimated total tax minus withholding and estimated payments. A negative amount is a refund." },
  "tax.effective": { label: "Effective rate", definition: "Total tax divided by adjusted gross income." },
  "tax.marginal": { label: "Marginal rate", definition: "The rate on the next dollar of ordinary income." },
  "tax.itemised": { label: "Itemised would be", definition: "Your itemised deductions after the pack's floors and caps (medical above 7.5% of AGI, the SALT cap, charity above 0.5% of AGI), as the estimator applies them." },
  "tax.logged": { label: "Logged so far", definition: "Itemisable entries in your organiser before floors and caps. The estimator applies those when it compares with the standard deduction." },
  "tax.standard": { label: "Standard deduction", definition: "The pack's standard deduction for your filing status, plus the cash-gift deduction non-itemisers get when the pack has one. This is what itemising has to beat." },
} as const satisfies Record<string, FigureDef>;

export type FigureId = keyof typeof FIGURES;

/** Label for an id; `range` fills the range figures ("Time-weighted · 1Y"). */
export function figureLabel(id: FigureId, range?: string): string {
  const l: string = FIGURES[id].label;
  return range ? l.replace(/ · range$/, ` · ${range}`) : l;
}

// ───────────────────────────────────────────────────────────────────────────── Money HQ

/**
 * `budget.spent` — "Spent in budget": net outflow this month in spending categories (non-income, non-saving budget
 * lines; refunds reduce it). Uncategorised outflow is in no envelope, so it is not here. One definition shared with
 * Home and the `month_spend` metric (`@/backend/figures` `spendingBudget`).
 */
export function budgetSpent(lines: readonly BudgetLine[] | undefined): number {
  return spendingBudget(lines).spent;
}

/** `budget.left` — "Left this month": assigned to spending categories minus spent in budget, never below zero. */
export function budgetLeft(lines: readonly BudgetLine[] | undefined): number {
  return spendingBudget(lines).remaining;
}

/**
 * `spending.all` — "All spending": the sum of `finance_spending_breakdown` by category for the month. That is spent in
 * budget plus uncategorised outflow (its own row) plus spending in categories without an assignment; transfers,
 * savings and debt payments are excluded by the backend.
 */
export function allSpending(rows: readonly SpendingSlice[] | undefined): number {
  return (rows ?? []).reduce((a, r) => a + (Number(r.amount) || 0), 0);
}

/**
 * `budget.activity` — "Activity": net movement this month in every non-income category, savings and debt payments
 * included (YNAB semantics), as a signed amount (outflow negative). Shown on the Budget tab only, never next to a
 * spending figure.
 */
export function budgetActivity(categories: BudgetMonth["categories"] | undefined, groupOf: (categoryId: string) => string | undefined): number {
  let total = 0;
  for (const c of categories ?? []) {
    const g = groupOf(c.categoryId);
    if (g !== undefined && isIncomeGroup(g)) continue;
    total += Number(c.activity) || 0;
  }
  return total;
}

export interface KeptFigure {
  income: number;
  spending: number;
  /** income − spending */
  kept: number;
  /** kept ÷ income (0 without income) */
  ratio: number;
}

/**
 * `cashflow.kept` — "Kept · {month}": income minus spending for one month, over income. The same definition as the
 * 3-month savings rate (`FinanceOverview.savingsRate3m`), read off that month's cash-flow Sankey: income is every flow
 * into the "Income" hub; spending is every flow out of it except "Saved & paid down" and a Savings & Debt group
 * (savings and debt payments are not spending). What is neither spent nor moved to savings still counts as kept.
 */
export function keptFromSankey(d: SankeyData | undefined): KeptFigure {
  if (!d) return { income: 0, spending: 0, kept: 0, ratio: 0 };
  const hub = d.nodes.findIndex((n) => n.name === "Income");
  let income = 0;
  let spending = 0;
  for (const l of d.links) {
    if (l.target === hub) income += l.value;
    else if (l.source === hub) {
      const name = d.nodes[l.target]?.name ?? "";
      if (name !== "Saved & paid down" && !isSavingGroup(name)) spending += l.value;
    }
  }
  const kept = income - spending;
  return { income, spending, kept, ratio: income > 0 ? kept / income : 0 };
}

/** `savingsRate3m` by its parts, for the popover: income − spending over income. */
export function keptRatio(income: number, spending: number): number {
  return income > 0 ? (income - spending) / income : 0;
}

/** Group lookup for a budget line set (Activity excludes income groups). */
export function groupLookup(lines: readonly { categoryId: string; group: string }[]): (id: string) => string | undefined {
  const m = new Map(lines.map((l) => [l.categoryId, l.group]));
  return (id) => m.get(id);
}

export { isIncomeGroup, isSavingGroup };

// ───────────────────────────────────────────────────────────────────────────── Portfolio

const YEAR_MS = 365.25 * 86_400_000;

/** Length of a performance series in years (first to last timestamp). */
export function rangeYears(t: readonly number[] | undefined): number {
  if (!t || t.length < 2) return 0;
  return Math.max(0, (t[t.length - 1] - t[0]) / YEAR_MS);
}

/**
 * The inputs behind `pf.value` and `pf.unrealised`, from the summary itself:
 *   - `holdings`: Σ holding market value (quantity × last price) — what the heat map totals;
 *   - `cash`: uninvested cash the portfolio records, `totalValue − holdings` (0 when the backend records none);
 *   - `cost`: Σ cost basis of the lots still held. Unrealised gain = holdings − cost; "on cost" = gain ÷ cost.
 * Cash is in Total value but never in the gain, so the unrealised popover lists holdings and cost, not total value.
 */
export function portfolioParts(s: Pick<PortfolioSummary, "totalValue" | "holdings">): { holdings: number; cost: number; cash: number } {
  let holdings = 0;
  let cost = 0;
  for (const h of s.holdings) {
    holdings += Number(h.value.amount) || 0;
    cost += Number(h.costBasis.amount) || 0;
  }
  const rest = Math.round(((Number(s.totalValue.amount) || 0) - holdings) * 100) / 100;
  return { holdings, cost, cash: Math.abs(rest) < 0.5 ? 0 : rest };
}

/**
 * GIPS: a return over less than a year is never annualised. `annual` is an annualised rate (XIRR); for a period
 * shorter than a year this returns the period's own return `(1 + annual)^years − 1`; for a year or more it returns
 * `annual` unchanged (shown with "a year").
 */
export function periodReturn(annual: number, years: number): { value: number; annualised: boolean } {
  if (years >= 0.997) return { value: annual, annualised: true };
  return { value: (1 + annual) ** Math.max(0, years) - 1, annualised: false };
}

/**
 * `pf.twr` — cumulative time-weighted return over the range: the last point of the TWR index (0 = start). Annualised
 * companion only for ranges of a year or more: `(1 + cumulative)^(1/years) − 1`.
 */
export function twrFigures(twr: readonly number[] | undefined, years: number): { cumulative: number; annual: number | null } | null {
  if (!twr || !twr.length) return null;
  const cumulative = twr[twr.length - 1];
  return { cumulative, annual: years >= 0.997 ? (1 + cumulative) ** (1 / years) - 1 : null };
}

/** `pf.vsBench` — the difference between two returns, in percentage points (never "%"). */
export function vsBenchmarkPts(twr: number, bench: number): number {
  return (twr - bench) * 100;
}

// ───────────────────────────────────────────────────────────────────────────── Taxes

export interface ItemisedComparison {
  /** Which figure is shown, and so which label: the engine's, or the raw log while the engine has none. */
  id: "tax.itemised" | "tax.logged";
  itemised: number;
  /** `tax.standard`: what itemising has to beat — the standard deduction plus the non-itemiser cash-gift deduction. */
  standard: number;
  /** The pack's standard deduction alone (`deduction.standardWouldBe`). */
  standardBase: number;
  /** The non-itemiser cash-gift deduction inside `standard` (0 when none applies, or when the engine itemised). */
  nonItemiserCharity: number;
  /** itemised − standard (positive: itemising wins) */
  margin: number;
}

/**
 * `tax.itemised` — the estimator engine's own itemised total, floors and caps applied (`TaxEstimate.deduction.
 * itemizedWouldBe`, or `amount` when the engine itemised). The hub never re-adds raw entries: that skipped the 7.5% of
 * AGI medical floor and the SALT cap. Without an engine figure it falls back to the raw log under its own label,
 * `tax.logged` ("Logged so far"), so a raw sum is never presented as the comparison.
 *
 * `tax.standard` — the alternative the engine actually compares against: when it took the standard deduction,
 * `deduction.amount` (standard plus the non-itemiser cash-gift deduction); when it itemised, `standardWouldBe` (the
 * engine does not report the cash-gift part then, and itemising already won).
 */
export function itemisedComparison(est: Pick<TaxEstimate, "deduction"> | undefined, loggedRaw: number): ItemisedComparison | null {
  if (!est) return null;
  const d = est.deduction;
  const standardBase = Number(d.standardWouldBe) || 0;
  const standard = d.kind === "standard" ? Math.max(standardBase, Number(d.amount) || 0) : standardBase;
  const nonItemiserCharity = standard - standardBase;
  const engine = d.itemizedWouldBe !== undefined ? Number(d.itemizedWouldBe) : d.kind === "itemized" ? Number(d.amount) : null;
  const base = { standard, standardBase, nonItemiserCharity };
  if (engine !== null && Number.isFinite(engine)) return { id: "tax.itemised", itemised: engine, ...base, margin: engine - standard };
  return { id: "tax.logged", itemised: loggedRaw, ...base, margin: loggedRaw - standard };
}

/**
 * Whether the inputs the chosen sizing method's penalty test depends on are known (`tax.safeHarbour`):
 *   - `safe_harbor` works from last year's total tax (100%, or 110% when last year's AGI was over $150k), so both
 *     must be entered. A profile default of "0" is not an answer: it reads as unknown.
 *   - `current_90` works from this year's estimate alone.
 *   - `even_split` is not a penalty test, so it never supports a "no penalty" claim.
 */
export function safeHarbourKnown(p: { method: string; priorYearTax: string; priorYearAgi: string } | null | undefined): boolean {
  if (!p) return false;
  if (p.method === "current_90") return true;
  if (p.method === "safe_harbor") return (Number(p.priorYearTax) || 0) > 0 && (Number(p.priorYearAgi) || 0) > 0;
  return false;
}

/**
 * The quarterly status for an unpaid, not-late period with no payment suggested. Only a period whose penalty test has
 * known inputs may say "No penalty expected"; that is still not owing nothing, so with a balance due at filing it says
 * so ("No penalty expected · $1,224 due Apr 15"). "Covered" is never used while money is owed. With no balance due at
 * filing nothing is owed, so no payment is needed whatever the method. `short` is for tight spots (hub timeline);
 * `needsInput` marks the unknown case.
 */
export function noPaymentNeeded(balanceDue: number, dueText: string, known: boolean): { label: string; short: string; needsInput: boolean } {
  if (balanceDue <= 0.5) return { label: "No payment needed", short: "None needed", needsInput: false };
  if (known) return { label: `No penalty expected · ${dueText}`, short: "No penalty", needsInput: false };
  return { label: "Enter last year's tax and AGI to check the safe harbor", short: "Check safe harbor", needsInput: true };
}
