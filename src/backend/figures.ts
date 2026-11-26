/**
 * Shared definitions of Money HQ figures derived from `finance_overview` budget lines, importable by the frontend
 * and by the browser mock backend (which emits the same figures as life-app metrics), so Home, the Money HQ screens
 * and the Money HQ KPI tiles can never disagree. Net worth, assets and liabilities are NOT derived here — they come
 * straight from the backend (`FinanceOverview.netWorth/assets/liabilities`).
 */
import type { BudgetLine } from "./types";

/** An income group (Rust `Category::is_income`). */
export function isIncomeGroup(group: string): boolean {
  return group.toLowerCase().includes("income");
}

/** A savings & debt group: outflows there are saving or paying down, not spending (Rust `Category::is_saving`). */
export function isSavingGroup(group: string): boolean {
  return group.toLowerCase().includes("saving");
}

export interface SpendingBudget {
  /** Assigned this month to spending envelopes. */
  assigned: number;
  /** Net spent this month in those envelopes (refunds reduce it). Uncategorised spending is in no envelope. */
  spent: number;
  /** `assigned − spent`, never below zero: what is left of this month's spending budget. */
  remaining: number;
  /** `spent / assigned` (0 without a budget). */
  ratio: number;
}

/**
 * "Spent vs budget" — one definition for the Home ring, the Overview envelopes and the `month_spend` /
 * `month_budget` metrics: every non-income budget line outside the Savings & Debt group (savings transfers and debt
 * payments are not spending).
 */
export function spendingBudget(lines: readonly BudgetLine[] | undefined): SpendingBudget {
  let assigned = 0;
  let spent = 0;
  for (const b of lines ?? []) {
    if (isSavingGroup(b.group) || isIncomeGroup(b.group)) continue;
    assigned += Number(b.assigned.amount) || 0;
    spent -= Number(b.activity.amount) || 0;
  }
  return { assigned, spent, remaining: Math.max(0, assigned - spent), ratio: assigned > 0 ? spent / assigned : 0 };
}

/**
 * The minimum payment Money HQ plans a debt with (Rust `ledger_debts`): the account's own minimum, else
 * `max($25, 2% of the balance owed)`. Amounts in dollars.
 */
export function debtMinimum(minPayment: number | null | undefined, owed: number): number {
  if (minPayment && minPayment > 0) return minPayment;
  return Math.max(25, Math.round(owed * 2) / 100);
}
