/**
 * Reconcile maths (PROGRAMME-v3 K5b), kept apart from the dialog so it can be tested.
 *
 * Sign convention. The ledger stores what you owe on a card or loan as a negative balance (`openingAsCounted`:
 * `−|opening|`), but a card or loan statement prints the amount owed as a positive number. So for a debt account the
 * field is "Amount owed on statement" and what is typed is read as owed: ledger value = −typed (a statement that
 * prints a credit balance as a negative amount owed becomes a positive ledger balance, as it should). A balance from
 * an imported file is normalised to an amount owed, `|balance|`, since banks sign card balances either way.
 * For every other account the statement balance is compared as typed.
 */
import { num, toMoney } from "../shared/format";

/** What the statement field shows when it is pre-filled from an imported file's closing balance. */
export function statementFieldFromFile(isDebt: boolean, balance: string): string {
  return isDebt ? toMoney(Math.abs(num(balance))).amount : balance;
}

export interface ReconcileCompare {
  /** Something was typed. */
  entered: boolean;
  /** The statement figure in ledger sign (debts negative). */
  statement: number;
  /** statement − cleared, in ledger sign. */
  diff: number;
  ok: boolean;
  /** The cleared figure as the field reads it: an amount owed for debts, the balance otherwise. */
  clearedShown: number;
  /** Where to look when it does not match, or null. */
  hint: string | null;
}

export function reconcileCompare(isDebt: boolean, typed: string | null, cleared: number): ReconcileCompare {
  const entered = typed !== null && typed.trim() !== "";
  const statement = entered ? (isDebt ? -num(typed) : num(typed)) : 0;
  const diff = entered ? statement - cleared : 0;
  const ok = entered && Math.abs(diff) < 0.005;
  let hint: string | null = null;
  if (entered && !ok) {
    // For a debt, a lower ledger value means more owed.
    const side = isDebt ? (diff < 0 ? "statement shows more owed" : "statement shows less owed") : diff > 0 ? "statement is higher" : "statement is lower";
    hint = `${side}: look for a missing, uncleared or duplicate transaction`;
  }
  return { entered, statement, diff, ok, clearedShown: isDebt ? 0 - cleared : cleared, hint };
}
