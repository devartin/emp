/**
 * Client view of the Money HQ ledger: Accounts, Categories, Transactions, Recurring and Goals read by role from
 * their databases, refreshed on `db:changed`. Edits go through `db_rows_update` / `db_row_create` (optimistic,
 * reconciled by the change event) so every other view of those databases stays coherent.
 */
import { createContext, useCallback, useContext, useMemo } from "react";
import { api } from "@/backend";
import type { CellValue, DbSchema, Id, RowDTO } from "@/backend/types";
import { notify } from "@/stores/toasts";
import { cell, queryAll, useAsync, useDbChanged, useRoleDbs, V } from "../shared/hooks";
import { addMonths, num, todayIso } from "../shared/format";

export interface Account {
  id: Id;
  name: string;
  type: string;
  institution: string;
  opening: number;
  apr: number | null;
  minPayment: number;
  limit: number | null;
  onBudget: boolean;
  lowThreshold: number | null;
  reconciled: string | null;
  closed: boolean;
  balance: number;
  cleared: number;
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
  splitParent: Id | null;
  cleared: string;
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
  kind: string;
  autopay: boolean;
  variable: boolean;
  prevAmount: number | null;
  cancelUrl: string;
}

export interface GoalRow {
  id: Id;
  name: string;
  kind: string;
  target: number;
  date: string | null;
  saved: number;
  accountId: Id | null;
  priority: string;
  icon: string;
}

const ROLES = { accounts: "acct.type", categories: "cat.group", txns: "txn.amount", recurring: "rec.amount", goals: "goal.target" } as const;
type DbKey = keyof typeof ROLES;

export interface Ledger {
  schemas: Partial<Record<DbKey, DbSchema>>;
  accounts: Account[];
  categories: Category[];
  /** Top-level transactions (split children nested in `splits`), newest first. */
  txns: Txn[];
  recurring: RecurringRow[];
  goals: GoalRow[];
  acct: Map<Id, Account>;
  cat: Map<Id, Category>;
  loading: boolean;
  error: string | null;
  reload: () => void;
  /** Optimistic transaction edit. */
  updateTxn: (id: Id, patch: Partial<Pick<Txn, "categoryId" | "payee" | "memo" | "date" | "amount" | "cleared">>) => Promise<void>;
  setSplits: (parent: Txn, parts: { categoryId: Id; amount: number }[]) => Promise<void>;
  addTxn: (t: { date: string; payee: string; amount: number; accountId: Id; categoryId?: Id | null; memo?: string }) => Promise<void>;
  deleteTxns: (ids: Id[]) => Promise<void>;
}

const roleOf = (s: DbSchema | undefined, role: string) => s?.database.roles[role];

function parseAll(schemas: Partial<Record<DbKey, DbSchema>>, rows: Partial<Record<DbKey, RowDTO[]>>) {
  const A = schemas.accounts;
  const C = schemas.categories;
  const X = schemas.txns;
  const R = schemas.recurring;
  const G = schemas.goals;
  const opt = (s: DbSchema | undefined, role: string, v: CellValue | undefined) => {
    const id = cell.sel(v);
    const p = s?.properties.find((x) => x.id === roleOf(s, role));
    return ((p?.config.options as { id: string; name: string }[] | undefined) ?? []).find((o) => o.id === id)?.name ?? id ?? "";
  };
  const inst = A?.properties.find((p) => p.name === "Institution")?.id;
  const accounts: Account[] = (rows.accounts ?? []).map((r) => ({
    id: r.id,
    name: cell.text(r.values[A!.database.primaryPropId]) || "Untitled account",
    type: cell.sel(r.values[roleOf(A, "acct.type")!]) ?? "other_asset",
    institution: inst ? cell.text(r.values[inst]) : "",
    opening: num(cell.money(r.values[roleOf(A, "acct.opening")!])),
    apr: cell.num(r.values[roleOf(A, "acct.apr")!]),
    minPayment: num(cell.money(r.values[roleOf(A, "acct.min_payment")!])),
    limit: cell.money(r.values[roleOf(A, "acct.limit")!]) !== null ? num(cell.money(r.values[roleOf(A, "acct.limit")!])) : null,
    onBudget: cell.check(r.values[roleOf(A, "acct.on_budget")!]),
    lowThreshold: cell.money(r.values[roleOf(A, "acct.low_threshold")!]) !== null ? num(cell.money(r.values[roleOf(A, "acct.low_threshold")!])) : null,
    reconciled: cell.date(r.values[roleOf(A, "acct.reconciled")!]),
    closed: cell.check(r.values[roleOf(A, "acct.closed")!]),
    balance: 0,
    cleared: 0,
  }));
  const categories: Category[] = (rows.categories ?? []).map((r) => ({
    id: r.id,
    name: cell.text(r.values[C!.database.primaryPropId]) || "Untitled",
    group: opt(C, "cat.group", r.values[roleOf(C, "cat.group")!]) || "Everyday",
    color: cell.sel(r.values[roleOf(C, "cat.color")!]) ?? "gray",
    icon: cell.text(r.values[roleOf(C, "cat.icon")!]) || "circle-dollar-sign",
    essential: cell.check(r.values[roleOf(C, "cat.essential")!]),
    rollover: cell.check(r.values[roleOf(C, "cat.rollover")!]),
    target: num(cell.money(r.values[roleOf(C, "cat.target")!])),
  }));
  const all: Txn[] = (rows.txns ?? []).map((r) => ({
    id: r.id,
    rev: r.rev,
    date: cell.date(r.values[roleOf(X, "txn.date")!]) ?? "",
    payee: cell.text(r.values[X!.database.primaryPropId]),
    raw: cell.text(r.values[roleOf(X, "txn.raw")!]),
    memo: cell.text(r.values[roleOf(X, "txn.memo")!]),
    amount: num(cell.money(r.values[roleOf(X, "txn.amount")!])),
    accountId: cell.rel(r.values[roleOf(X, "txn.account")!]),
    categoryId: cell.rel(r.values[roleOf(X, "txn.category")!]),
    transferId: cell.rel(r.values[roleOf(X, "txn.transfer")!]),
    splitParent: cell.rel(r.values[roleOf(X, "txn.split_parent")!]),
    cleared: cell.sel(r.values[roleOf(X, "txn.cleared")!]) ?? "uncleared",
    tags: cell.multi(r.values[roleOf(X, "txn.tags")!]),
    splits: [],
  }));
  const byId = new Map(all.map((t) => [t.id, t]));
  for (const t of all) if (t.splitParent) byId.get(t.splitParent)?.splits.push(t);
  const txns = all.filter((t) => !t.splitParent).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const acct = new Map(accounts.map((a) => [a.id, a]));
  for (const a of accounts) a.balance = a.cleared = a.opening;
  // Balances are "as of today", the same cut the backend uses for net worth (finance_overview / networth_series);
  // future-dated (scheduled) rows otherwise made Accounts disagree with the Overview hero.
  const today = todayIso();
  for (const t of txns) {
    const a = t.accountId ? acct.get(t.accountId) : undefined;
    if (!a || t.date > today) continue;
    a.balance += t.amount;
    if (t.cleared !== "uncleared") a.cleared += t.amount;
  }
  const recurring: RecurringRow[] = (rows.recurring ?? []).map((r) => {
    const sv = r.values[roleOf(R, "rec.schedule")!];
    const rv = sv && sv.t === "recurrence" ? sv.v : null;
    return {
      id: r.id,
      name: cell.text(r.values[R!.database.primaryPropId]),
      amount: num(cell.money(r.values[roleOf(R, "rec.amount")!])),
      rrule: rv?.rrule ?? "FREQ=MONTHLY",
      dtstart: rv?.dtstart?.slice(0, 10) ?? "",
      accountId: cell.rel(r.values[roleOf(R, "rec.account")!]),
      categoryId: cell.rel(r.values[roleOf(R, "rec.category")!]),
      kind: cell.sel(r.values[roleOf(R, "rec.kind")!]) ?? "bill",
      autopay: cell.check(r.values[roleOf(R, "rec.autopay")!]),
      variable: cell.check(r.values[roleOf(R, "rec.variable")!]),
      prevAmount: cell.money(r.values[roleOf(R, "rec.prev_amount")!]) !== null ? num(cell.money(r.values[roleOf(R, "rec.prev_amount")!])) : null,
      cancelUrl: cell.text(r.values[roleOf(R, "rec.cancel_url")!]),
    };
  });
  const goals: GoalRow[] = (rows.goals ?? []).map((r) => ({
    id: r.id,
    name: cell.text(r.values[G!.database.primaryPropId]),
    kind: cell.sel(r.values[roleOf(G, "goal.kind")!]) ?? "savings",
    target: num(cell.money(r.values[roleOf(G, "goal.target")!])),
    date: cell.date(r.values[roleOf(G, "goal.date")!]),
    saved: num(cell.money(r.values[roleOf(G, "goal.saved")!])),
    accountId: cell.rel(r.values[roleOf(G, "goal.account")!]),
    priority: cell.sel(r.values[roleOf(G, "goal.priority")!]) ?? "medium",
    icon: cell.text(r.values[roleOf(G, "goal.icon")!]) || "target",
  }));
  return { accounts, categories, txns, recurring, goals, acct, cat: new Map(categories.map((c) => [c.id, c])) };
}

export function useLedger(instanceId: Id): Ledger {
  const { schemas, ready, error: dbErr } = useRoleDbs(instanceId, ROLES);
  const ids = (Object.keys(ROLES) as DbKey[]).map((k) => schemas[k]?.database.id);
  const state = useAsync(
    async () => {
      const keys = Object.keys(ROLES) as DbKey[];
      const results = await Promise.all(keys.map((k) => (schemas[k] ? queryAll(schemas[k]!.database.id) : Promise.resolve([] as RowDTO[]))));
      const rows: Partial<Record<DbKey, RowDTO[]>> = {};
      keys.forEach((k, i) => (rows[k] = results[i]));
      return parseAll(schemas, rows);
    },
    [ids.join("|")],
    { enabled: ready },
  );
  useDbChanged(ids, state.reload);

  const X = schemas.txns;
  const updateTxn = useCallback<Ledger["updateTxn"]>(
    async (id, patch) => {
      if (!X) return;
      const values: Record<Id, CellValue | null> = {};
      const r = X.database.roles;
      if ("categoryId" in patch) values[r["txn.category"]] = V.rel(patch.categoryId ? [patch.categoryId] : []);
      if (patch.payee !== undefined) values[X.database.primaryPropId] = V.text(patch.payee);
      if (patch.memo !== undefined) values[r["txn.memo"]] = V.text(patch.memo);
      if (patch.date !== undefined) values[r["txn.date"]] = V.date(patch.date);
      if (patch.amount !== undefined) values[r["txn.amount"]] = V.money(patch.amount.toFixed(2));
      if (patch.cleared !== undefined) values[r["txn.cleared"]] = V.status(patch.cleared);
      state.set((prev) => (prev ? { ...prev, txns: prev.txns.map((t) => (t.id === id ? { ...t, ...patch } : t)) } : prev));
      try {
        await api.db.rowsUpdate({ updates: [{ id, values }] });
      } catch (e) {
        notify.fromError(e, "Couldn't update the transaction");
        state.reload();
      }
    },
    [X, state],
  );

  const setSplits = useCallback<Ledger["setSplits"]>(
    async (parent, parts) => {
      if (!X) return;
      const r = X.database.roles;
      try {
        if (parent.splits.length) await api.db.rowsDelete({ ids: parent.splits.map((s) => s.id) });
        for (const p of parts) {
          await api.db.rowCreate({
            databaseId: X.database.id,
            values: {
              [X.database.primaryPropId]: V.text(parent.payee),
              [r["txn.date"]]: V.date(parent.date),
              [r["txn.amount"]]: V.money(p.amount.toFixed(2)),
              ...(parent.accountId ? { [r["txn.account"]]: V.rel([parent.accountId]) } : {}),
              [r["txn.category"]]: V.rel([p.categoryId]),
              [r["txn.split_parent"]]: V.rel([parent.id]),
              [r["txn.cleared"]]: V.status(parent.cleared),
            },
          } as Parameters<typeof api.db.rowCreate>[0]);
        }
        if (parts.length) await api.db.rowsUpdate({ updates: [{ id: parent.id, values: { [r["txn.category"]]: V.rel([]) } }] });
        notify.success(parts.length ? `Split into ${parts.length} categories` : "Split removed");
      } catch (e) {
        notify.fromError(e, "Couldn't split the transaction");
      }
      state.reload();
    },
    [X, state],
  );

  const addTxn = useCallback<Ledger["addTxn"]>(
    async (t) => {
      if (!X) return;
      const r = X.database.roles;
      try {
        await api.db.rowCreate({
          databaseId: X.database.id,
          values: {
            [X.database.primaryPropId]: V.text(t.payee),
            [r["txn.date"]]: V.date(t.date),
            [r["txn.amount"]]: V.money(t.amount.toFixed(2)),
            [r["txn.account"]]: V.rel([t.accountId]),
            ...(t.categoryId ? { [r["txn.category"]]: V.rel([t.categoryId]) } : {}),
            ...(t.memo ? { [r["txn.memo"]]: V.text(t.memo) } : {}),
            [r["txn.cleared"]]: V.status("uncleared"),
            ...(r["txn.source"] ? { [r["txn.source"]]: V.sel("manual") } : {}),
          },
        } as Parameters<typeof api.db.rowCreate>[0]);
        state.reload();
      } catch (e) {
        notify.fromError(e, "Couldn't add the transaction");
      }
    },
    [X, state],
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
      schemas,
      accounts: d?.accounts ?? [],
      categories: d?.categories ?? [],
      txns: d?.txns ?? [],
      recurring: d?.recurring ?? [],
      goals: d?.goals ?? [],
      acct: d?.acct ?? new Map(),
      cat: d?.cat ?? new Map(),
      loading: !ready || (state.loading && !d),
      error: dbErr ?? state.error,
      reload: state.reload,
      updateTxn,
      setSplits,
      addTxn,
      deleteTxns,
    }),
    [schemas, d, ready, state.loading, state.error, dbErr, state.reload, updateTxn, setSplits, addTxn, deleteTxns],
  );
}

export const LedgerContext = createContext<Ledger | null>(null);
export function useLedgerCtx(): Ledger {
  const l = useContext(LedgerContext);
  if (!l) throw new Error("LedgerContext missing");
  return l;
}

export const DEBT_TYPES = new Set(["credit_card", "student_loan", "auto_loan", "mortgage", "personal_loan", "other_liability"]);
/** The debts the planner works on: open loan/card accounts carrying a balance owed. One source for the Overview
 * "Debt-free" tile and the Debt tab, so both quote the same plan. */
export function debtInputs(accounts: Account[]): { key: Id; name: string; balance: string; aprPct: string; minPayment: string }[] {
  return accounts
    .filter((a) => DEBT_TYPES.has(a.type) && !a.closed && a.balance < 0)
    .map((a) => ({ key: a.id, name: a.name, balance: (-a.balance).toFixed(2), aprPct: String(a.apr ?? 0), minPayment: a.minPayment.toFixed(2) }));
}

/** First month of a payoff plan: next month (this month's payments are already in the ledger). */
export const debtPlanStart = (): string => addMonths(todayIso().slice(0, 7), 1);

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
