/**
 * The Debt planner's chosen scenario (strategy + extra monthly payment), remembered per Money HQ instance so the
 * Overview's "Debt-free" figure and the planner show the same scenario under the same label:
 *   - with a saved choice, both show `debtFree.plan` — "Debt-free with your plan" (that strategy and extra);
 *   - without one, the Overview shows `debtFree.minimum` — "Debt-free at minimum payments" (the backend's
 *     `FinanceOverview.debtFreeDate`), which the planner also shows as its "At minimum payments" line.
 * A choice is saved only by a user action in the planner (picking a strategy, releasing the slider); opening the
 * planner saves nothing. Kept in the vault (`kv` namespace `ui.finance.debtPlan`, key = instance id), never in browser
 * storage; the debts themselves always come from the ledger (`debtInputs`).
 */
import { listen } from "@/backend";
import type { Id } from "@/backend/types";
import { kvIo } from "./statements";
import { createVaultKv } from "./vaultKv";

export interface DebtPlanChoice {
  strategy: "avalanche" | "snowball" | "hybrid";
  /** Extra per month on top of the minimums, in the base currency. */
  extra: number;
}

const STRATEGIES = new Set(["avalanche", "snowball", "hybrid"]);

export function parseChoice(raw: unknown): DebtPlanChoice | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Partial<DebtPlanChoice>;
  if (!STRATEGIES.has(String(c.strategy))) return null;
  if (typeof c.extra !== "number" || !Number.isFinite(c.extra) || c.extra < 0) return null;
  return { strategy: c.strategy as DebtPlanChoice["strategy"], extra: c.extra };
}

const store = createVaultKv<DebtPlanChoice>("ui.finance.debtPlan", parseChoice, kvIo);
listen("vault:locked", () => store.getState().reset());

/** The saved choice for a Money HQ instance: `undefined` while loading, `null` when none was chosen. */
export function useDebtPlanChoice(instanceId: Id): DebtPlanChoice | null | undefined {
  return store((st) => st.values[instanceId]);
}

export function loadDebtPlanChoice(instanceId: Id): Promise<void> {
  return store.getState().load(instanceId);
}

/** What the planner shows before any choice is saved. Shown, never written: opening or computing saves nothing. */
export const DEFAULT_DEBT_PLAN: DebtPlanChoice = { strategy: "avalanche", extra: 200 };

/**
 * The choice to save after a user action in the planner, or `null` when the action is not a real edit (owner decision,
 * Phase 2): nothing is written unless the committed strategy or extra differs from what the planner showed before the
 * action — the saved choice, or `DEFAULT_DEBT_PLAN` when there is none. Releasing the slider where it started,
 * re-picking the selected strategy, a custom order, or an edited what-if (debts that are not the ledger's) save nothing.
 */
export function choiceToSave(saved: DebtPlanChoice | null | undefined, next: { strategy: string; extra: number }, isLedgerDebts: boolean): DebtPlanChoice | null {
  if (!isLedgerDebts) return null;
  const c = parseChoice(next);
  if (!c) return null;
  const base = saved ?? DEFAULT_DEBT_PLAN;
  return c.strategy === base.strategy && c.extra === base.extra ? null : c;
}

/** Which Debt-free scenario the Overview shows: "plan" only once a choice was saved by an edit, else "minimum". */
export function debtFreeKind(saved: DebtPlanChoice | null | undefined): "plan" | "minimum" {
  return saved ? "plan" : "minimum";
}

/** Save the user's choice (call only from a user action). No write when it is unchanged. */
export function saveDebtPlanChoice(instanceId: Id, c: DebtPlanChoice): Promise<void> {
  const prev = store.getState().values[instanceId];
  if (prev && prev.strategy === c.strategy && prev.extra === c.extra) return Promise.resolve();
  return store.getState().put(instanceId, c);
}

export const STRATEGY_LABEL: Record<DebtPlanChoice["strategy"], string> = { avalanche: "Avalanche", snowball: "Snowball", hybrid: "Hybrid" };
