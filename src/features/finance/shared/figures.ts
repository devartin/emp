/**
 * Shared definitions for Money HQ headline figures that the frontend derives from `finance_overview`, so Home and
 * the Money HQ screens can never disagree. Net worth, assets and liabilities are NOT derived here — they come
 * straight from the backend (`FinanceOverview.netWorth/assets/liabilities`).
 */
import type { BudgetLine } from "@/backend/types";

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
 * "Spent vs budget" — one definition for the Home ring and the Overview envelopes: every non-income budget line
 * outside the Savings & Debt group (savings transfers and debt payments are not spending).
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
