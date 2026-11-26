/**
 * Shared definitions for Money HQ headline figures that the frontend derives from `finance_overview`. They live in
 * `@/backend/figures` so the browser mock emits the very same figures as life-app metrics; re-exported here for the
 * finance screens.
 */
export { debtMinimum, isIncomeGroup, isSavingGroup, spendingBudget, type SpendingBudget } from "@/backend/figures";
