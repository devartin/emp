/**
 * Portfolio client data (ULTRANOTE-1.0 §5): summary and performance via commands; accounts, securities, open FIFO
 * lots, income and recent transactions from the backend's compact book (`portfolio_book`), with option keys and
 * exact lot figures — no whole databases over IPC, no lot replay in TypeScript.
 */
import { useMemo } from "react";
import { api } from "@/backend";
import type { Id, PortfolioBook as BookView, TaxTreatmentKey } from "@/backend/types";
import { useAsync, useDbChanged } from "../finance/shared/hooks";
import { num } from "../finance/shared/format";

export interface OpenLot {
  accountId: Id;
  accountName: string;
  taxTreatment: TaxTreatmentKey;
  acquired: string;
  qty: number;
  costPerUnit: number;
  /** Exact remaining cost basis of the lot. */
  basis: number;
}

export interface IncomeRow {
  id: Id;
  date: string;
  symbol: string;
  accountId: Id;
  amount: number;
  /** `dividend` or `interest`. */
  kind: string;
  reinvested: boolean;
  taxTreatment: TaxTreatmentKey;
}

export interface BookTxn {
  id: Id;
  date: string;
  /** buy, sell, dividend, reinvest, fee, split, transfer_in, transfer_out, return_of_capital, interest */
  type: string;
  symbol: string;
  name: string;
  accountId: Id;
  qty: number | null;
  price: number | null;
  amount: number | null;
  fees: number;
}

export interface PortfolioBook {
  dbs: BookView["dbs"];
  secByKey: Map<string, { id: Id; name: string; cls: string }>;
  accounts: Map<Id, { name: string; type: string; tax: TaxTreatmentKey }>;
  accountList: { id: Id; name: string; type: string; tax: TaxTreatmentKey }[];
  income: IncomeRow[];
  txns: BookTxn[];
  lotsFor: (symbol: string) => OpenLot[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

const nul = (s: string | null): number | null => (s === null ? null : num(s));

export function usePortfolioBook(instanceId: Id | undefined): PortfolioBook {
  const st = useAsync(() => (instanceId ? api.portfolio.book({ instanceId }) : Promise.resolve(null)), [instanceId]);
  const ids = st.data ? (Object.values(st.data.dbs).filter(Boolean) as Id[]) : [];
  useDbChanged(ids, st.reload);
  return useMemo(() => {
    const v = st.data;
    const lots = new Map<string, OpenLot[]>();
    for (const l of v?.lots ?? []) {
      const list = lots.get(l.symbol) ?? [];
      list.push({ accountId: l.accountId, accountName: l.accountName, taxTreatment: l.taxTreatment, acquired: l.acquired, qty: num(l.qty), costPerUnit: num(l.costPerUnit), basis: num(l.basis) });
      lots.set(l.symbol, list);
    }
    for (const list of lots.values()) list.sort((a, b) => (a.acquired < b.acquired ? -1 : a.acquired > b.acquired ? 1 : 0));
    const accountList = v?.accounts ?? [];
    return {
      dbs: v?.dbs ?? { accounts: null, securities: null, transactions: null, targets: null },
      secByKey: new Map((v?.securities ?? []).map((s) => [s.symbol, { id: s.id, name: s.name, cls: s.assetClass }])),
      accounts: new Map(accountList.map((a) => [a.id, { name: a.name, type: a.type, tax: a.tax }])),
      accountList,
      income: (v?.income ?? []).map((i) => ({ ...i, amount: num(i.amount) })),
      txns: (v?.txns ?? []).map((t) => ({ ...t, qty: nul(t.qty), price: nul(t.price), amount: nul(t.amount), fees: num(t.fees) })),
      lotsFor: (symbol: string) => lots.get(symbol) ?? [],
      loading: st.loading && !v,
      error: st.error,
      reload: st.reload,
    };
  }, [st.data, st.loading, st.error, st.reload]);
}

export function usePortfolioSummary(instanceId: Id) {
  const s = useAsync(() => api.portfolio.summary({ instanceId }), [instanceId]);
  return s;
}

export const CLASS_ORDER = ["US equity", "Intl developed", "Emerging", "Bonds", "Inflation-linked", "REIT", "Cash", "Crypto", "Other"];

/** Asset-class keys for a new security (`portfolio_trade.assetClass`) with their labels. */
export const ASSET_CLASS_OPTIONS = [
  { value: "us_equity", label: "US equity" },
  { value: "intl_developed", label: "Intl developed" },
  { value: "emerging", label: "Emerging" },
  { value: "bonds", label: "Bonds" },
  { value: "inflation_linked", label: "Inflation-linked" },
  { value: "reit", label: "REIT" },
  { value: "cash", label: "Cash" },
  { value: "crypto", label: "Crypto" },
  { value: "other", label: "Other" },
];
