/**
 * Client view of the Money HQ ledger (ULTRANOTE-1.0 §5). The backend builds it over its cached ledger
 * (`finance_ledger`): accounts with exact balances, cleared balances and 90-day history, categories, recurring items,
 * goals, the latest transactions and the review counts. Select and status values arrive as option keys, and every
 * edit goes through a key-based command (`finance_txns_update`, `finance_txn_create`, `finance_txn_split`), so the
 * frontend never compares or writes generated option ids. Refreshed on `db:changed` of the instance's databases.
 */
import { createContext, useCallback, useContext, useMemo } from "react";
import { api } from "@/backend";
import type { FinanceLedger, Id, LedgerAccount, LedgerTxn } from "@/backend/types";
import { notify } from "@/stores/toasts";
import { useAsync, useDbChanged } from "../shared/hooks";
import { addMonths, num, todayIso } from "../shared/format";
import { debtMinimum } from "../shared/figures";

export interface Account {
  id: Id;
  name: string;
  /** `acct.type` key. */
  type: string;
  institution: string;
  /** ISO 4217 code; "" means the base currency. */
  currency: string;
  opening: number;
  apr: number | null;
  minPayment: number;
  limit: number | null;
  onBudget: boolean;
  lowThreshold: number | null;
  reconciled: string | null;
  closed: boolean;
  /** As of today, computed by the backend in exact decimals. */
  balance: number;
  cleared: number;
  /** End-of-day balances of the last 90 days, oldest first. */
  history: number[];
}

export interface Category {
  id: Id;
  name: string;
  group: string;
  color: string;
  icon: string;
  essential: boolean;
  rollover: boolean;
  target: number;
}

export interface Txn {
  id: Id;
  rev: number;
  date: string;
  payee: string;
  raw: string;
  memo: string;
  amount: number;
  accountId: Id | null;
  categoryId: Id | null;
  transferId: Id | null;
  /** The account on the other side of a transfer. */
  transferAccountId: Id | null;
  splitParent: Id | null;
  /** `uncleared`, `cleared` or `reconciled`. */
  cleared: string;
  /** `txn.reviewed` (SPEC §16): null when the Transactions database has no Reviewed property. */
  reviewed: boolean | null;
  /** `txn.source` key (`manual`, `import`, `rule`), or "". */
  source: string;
  tags: string[];
  splits: Txn[];
}

export interface RecurringRow {
  id: Id;
  name: string;
  amount: number;
  rrule: string;
  dtstart: string;
  accountId: Id | null;
  categoryId: Id | null;
  /** bill, income, subscription, transfer, savings */
  kind: string;
  autopay: boolean;
  variable: boolean;
  prevAmount: number | null;
  cancelUrl: string;
}

export interface GoalRow {
  id: Id;
  name: string;
  /** emergency, sinking, savings */
  kind: string;
  target: number;
  date: string | null;
  saved: number;
  accountId: Id | null;
  priority: string;
  icon: string;
}

export type TxnPatch = Partial<Pick<Txn, "categoryId" | "memo" | "date" | "amount" | "cleared" | "reviewed">>;

export interface Ledger {
  /** The instance's database ids (for `db:changed` subscriptions). */
  dbs: FinanceLedger["dbs"];
  /** Every id in `dbs`. */
  dbIds: Id[];
  currency: string;
  accounts: Account[];
  categories: Category[];
  /** The latest top-level transactions, newest first (split parts nested in `splits`). */
  recent: Txn[];
  counts: FinanceLedger["counts"];
  recurring: RecurringRow[];
  goals: GoalRow[];
  acct: Map<Id, Account>;
  cat: Map<Id, Category>;
  loading: boolean;
  error: string | null;
  reload: () => void;
  /** Whether the Transactions database carries the Reviewed property (`txn.reviewed`). */
  hasReviewed: boolean;
  /** Edits transactions by meaning (one batch). Resolves false when the backend refused. */
  updateTxns: (updates: ({ id: Id } & TxnPatch)[]) => Promise<boolean>;
  updateTxn: (id: Id, patch: TxnPatch) => Promise<boolean>;
  setSplits: (parent: Txn, parts: { categoryId: Id; amount: number }[]) => Promise<void>;
  addTxn: (t: { date: string; payee: string; amount: number; accountId: Id; categoryId?: Id | null; memo?: string }) => Promise<boolean>;
  deleteTxns: (ids: Id[]) => Promise<void>;
}

/** A wire transaction as the client model (amounts as numbers, for display only). */
export function toTxn(t: LedgerTxn): Txn {
  return {
    id: t.id,
    rev: t.rev,
    date: t.date,
    payee: t.payee,
    raw: t.raw,
    memo: t.memo,
    amount: num(t.amount),
    accountId: t.accountId,
    categoryId: t.categoryId,
    transferId: t.transferId,
    transferAccountId: t.transferAccountId,
    splitParent: t.splitParent,
    cleared: t.cleared,
    reviewed: t.reviewed,
    source: t.source,
    tags: t.tags,
    splits: t.splits.map(toTxn),
  };
}

function toAccount(a: LedgerAccount): Account {
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    institution: a.institution,
    currency: a.currency,
    opening: num(a.opening),
    apr: a.apr,
    minPayment: num(a.minPayment),
    limit: a.limit === null ? null : num(a.limit),
    onBudget: a.onBudget,
    lowThreshold: a.lowThreshold === null ? null : num(a.lowThreshold),
    reconciled: a.reconciled,
    closed: a.closed,
    balance: num(a.balance),
    cleared: num(a.cleared),
    history: a.history,
  };
}

function parse(v: FinanceLedger) {
  const accounts = v.accounts.map(toAccount);
  const categories: Category[] = v.categories.map((c) => ({ id: c.id, name: c.name, group: c.group, color: c.color, icon: c.icon, essential: c.essential, rollover: c.rollover, target: num(c.target) }));
  const recurring: RecurringRow[] = v.recurring.map((r) => ({ ...r, amount: num(r.amount), prevAmount: r.prevAmount === null ? null : num(r.prevAmount) }));
  const goals: GoalRow[] = v.goals.map((g) => ({ ...g, target: num(g.target), saved: num(g.saved) }));
  return {
    view: v,
    accounts,
    categories,
    recent: v.recent.map(toTxn),
    recurring,
    goals,
    acct: new Map(accounts.map((a) => [a.id, a])),
    cat: new Map(categories.map((c) => [c.id, c])),
  };
}

/** Exact two-decimal string of a display amount (inputs from fields are already cents-precise). */
export const amountStr = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);

/** The wire form of a transaction patch. */
function wirePatch(id: Id, p: TxnPatch) {
  return {
    id,
    ...("categoryId" in p ? { categoryId: p.categoryId ?? null } : {}),
    ...(p.memo !== undefined ? { memo: p.memo } : {}),
    ...(p.date !== undefined ? { date: p.date } : {}),
    ...(p.amount !== undefined ? { amount: amountStr(p.amount) } : {}),
    ...(p.cleared !== undefined ? { cleared: p.cleared as "uncleared" | "cleared" | "reconciled" } : {}),
    ...(p.reviewed !== undefined && p.reviewed !== null ? { reviewed: p.reviewed } : {}),
  };
}

export function useLedger(instanceId: Id): Ledger {
  const state = useAsync(async () => parse(await api.finance.ledger({ instanceId })), [instanceId]);
  const dbs = state.data?.view.dbs;
  const dbIds = useMemo(() => (dbs ? (Object.values(dbs).filter(Boolean) as Id[]) : []), [dbs]);
  useDbChanged(dbIds, state.reload);

  const updateTxns = useCallback<Ledger["updateTxns"]>(
    async (updates) => {
      if (!updates.length) return true;
      const byId = new Map(updates.map((u) => [u.id, u]));
      const patch = (t: Txn): Txn => {
        const u = byId.get(t.id);
        return u ? { ...t, ...u } : t;
      };
      state.set((prev) => (prev ? { ...prev, recent: prev.recent.map(patch) } : prev));
      try {
        await api.finance.txnsUpdate({ instanceId, updates: updates.map(({ id, ...p }) => wirePatch(id, p)) });
        return true;
      } catch (e) {
        notify.fromError(e, "Couldn't update the transaction");
        state.reload();
        return false;
      }
    },
    [instanceId, state],
  );
  const updateTxn = useCallback<Ledger["updateTxn"]>((id, patch) => updateTxns([{ id, ...patch }]), [updateTxns]);

  const setSplits = useCallback<Ledger["setSplits"]>(
    async (parent, parts) => {
      try {
        await api.finance.txnSplit({ instanceId, parentId: parent.id, parts: parts.map((p) => ({ categoryId: p.categoryId, amount: amountStr(p.amount) })) });
        notify.success(parts.length ? `Split into ${parts.length} categories` : "Split removed");
      } catch (e) {
        notify.fromError(e, "Couldn't split the transaction");
      }
      state.reload();
    },
    [instanceId, state],
  );

  const addTxn = useCallback<Ledger["addTxn"]>(
    async (t) => {
      try {
        await api.finance.txnCreate({ instanceId, date: t.date, payee: t.payee, amount: amountStr(t.amount), accountId: t.accountId, ...(t.categoryId ? { categoryId: t.categoryId } : {}), ...(t.memo ? { memo: t.memo } : {}) });
        state.reload();
        return true;
      } catch (e) {
        notify.fromError(e, "Couldn't add the transaction");
        return false;
      }
    },
    [instanceId, state],
  );

  const deleteTxns = useCallback<Ledger["deleteTxns"]>(
    async (ids) => {
      try {
        await api.db.rowsDelete({ ids });
        state.reload();
        notify.undo(ids.length === 1 ? "Transaction deleted" : `${ids.length} transactions deleted`, async () => {
          await api.db.rowsRestore({ ids });
          state.reload();
        });
      } catch (e) {
        notify.fromError(e, "Couldn't delete");
      }
    },
    [state],
  );

  const d = state.data;
  return useMemo(
    () => ({
      dbs: d?.view.dbs ?? { accounts: null, categories: null, transactions: null, recurring: null, goals: null, budgets: null, payees: null },
      dbIds,
      currency: d?.view.currency ?? "",
      accounts: d?.accounts ?? [],
      categories: d?.categories ?? [],
      recent: d?.recent ?? [],
      counts: d?.view.counts ?? { txns: 0, toReview: null, uncategorized: 0 },
      recurring: d?.recurring ?? [],
      goals: d?.goals ?? [],
      acct: d?.acct ?? new Map(),
      cat: d?.cat ?? new Map(),
      loading: state.loading && !d,
      error: state.error,
      reload: state.reload,
      hasReviewed: !!d?.view.hasReviewed,
      updateTxns,
      updateTxn,
      setSplits,
      addTxn,
      deleteTxns,
    }),
    [d, dbIds, state.loading, state.error, state.reload, updateTxns, updateTxn, setSplits, addTxn, deleteTxns],
  );
}

export const LedgerContext = createContext<Ledger | null>(null);
export function useLedgerCtx(): Ledger {
  const l = useContext(LedgerContext);
  if (!l) throw new Error("LedgerContext missing");
  return l;
}

export const DEBT_TYPES = new Set(["credit_card", "student_loan", "auto_loan", "mortgage", "personal_loan", "other_liability"]);

/** A liability's opening balance is the amount owed, either sign: counted as `−|opening|` (Rust `opening_as_counted`). */
export function openingAsCounted(type: string, opening: number): number {
  return DEBT_TYPES.has(type) ? -Math.abs(opening) : opening;
}
/** The debts the planner works on (Rust `ledger_debts`, the mock's `debtsOf` — the debts behind
 * `FinanceOverview.debtFreeDate`): open loan/card accounts carrying a balance owed, at their minimum payment or
 * `max($25, 2%)` without one. */
export function debtInputs(accounts: Account[]): { key: Id; name: string; balance: string; aprPct: string; minPayment: string }[] {
  return accounts
    .filter((a) => DEBT_TYPES.has(a.type) && !a.closed && a.balance < 0)
    .map((a) => ({ key: a.id, name: a.name, balance: (-a.balance).toFixed(2), aprPct: String(a.apr ?? 0), minPayment: debtMinimum(a.minPayment, -a.balance).toFixed(2) }));
}

/** First month of a payoff plan: next month (this month's payments are already in the ledger). */
export const debtPlanStart = (): string => addMonths(todayIso().slice(0, 7), 1);

/** Sum of display amounts in whole cents (no float drift across many rows). */
export function sumCents(values: readonly number[]): number {
  let c = 0;
  for (const v of values) c += Math.round(v * 100);
  return c / 100;
}

export const ACCOUNT_TYPE_LABEL: Record<string, string> = {
  checking: "Checking",
  savings: "Savings",
  credit_card: "Credit card",
  student_loan: "Student loan",
  auto_loan: "Auto loan",
  mortgage: "Mortgage",
  personal_loan: "Personal loan",
  investment: "Investment",
  cash: "Cash",
  other_asset: "Other asset",
  other_liability: "Other liability",
};
