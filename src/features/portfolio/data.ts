/** Portfolio client data: summary/performance via commands; lots and transactions read by role for display. */
import { useMemo } from "react";
import { api } from "@/backend";
import type { DbSchema, Id, RowDTO } from "@/backend/types";
import { cell, queryAll, useAsync, useDbChanged, useRoleDbs } from "../finance/shared/hooks";
import { num } from "../finance/shared/format";

const ROLES = { accounts: "iacct.type", securities: "sec.ticker", txns: "inv.type", targets: "alloc.target" } as const;

export interface InvTxn {
  id: Id;
  date: string;
  type: string;
  secId: Id | null;
  qty: number;
  price: number;
  amount: number;
  fees: number;
  accountId: Id | null;
}
export interface OpenLot {
  accountId: Id;
  accountName: string;
  taxTreatment: string;
  acquired: string;
  qty: number;
  costPerUnit: number;
}
export interface PortfolioBook {
  schemas: Partial<Record<keyof typeof ROLES, DbSchema>>;
  secByKey: Map<string, { id: Id; name: string; cls: string; er: number }>;
  accounts: Map<Id, { name: string; type: string; tax: string }>;
  txns: InvTxn[];
  lotsFor: (symbol: string) => OpenLot[];
  loading: boolean;
}

export function usePortfolioBook(instanceId: Id): PortfolioBook {
  const { schemas, ready } = useRoleDbs(instanceId, ROLES);
  const ids = [schemas.accounts?.database.id, schemas.securities?.database.id, schemas.txns?.database.id];
  const rows = useAsync(
    async () => {
      const [a, s, x] = await Promise.all(ids.map((id) => (id ? queryAll(id) : Promise.resolve([] as RowDTO[]))));
      return { a, s, x };
    },
    [ids.join("|")],
    { enabled: ready },
  );
  useDbChanged(ids, rows.reload);
  return useMemo(() => {
    const A = schemas.accounts;
    const S = schemas.securities;
    const X = schemas.txns;
    const accounts = new Map<Id, { name: string; type: string; tax: string }>();
    for (const r of rows.data?.a ?? []) accounts.set(r.id, { name: cell.text(r.values[A!.database.primaryPropId]), type: cell.sel(r.values[A!.database.roles["iacct.type"]]) ?? "taxable", tax: cell.sel(r.values[A!.database.roles["iacct.tax"]]) ?? "taxable" });
    const secById = new Map<Id, { key: string; name: string; cls: string; er: number }>();
    const secByKey = new Map<string, { id: Id; name: string; cls: string; er: number }>();
    const clsProp = S?.properties.find((p) => p.id === S.database.roles["sec.class"]);
    const clsName = (id: string | null) => ((clsProp?.config.options as { id: string; name: string }[] | undefined) ?? []).find((o) => o.id === id)?.name ?? "Other";
    for (const r of rows.data?.s ?? []) {
      const key = cell.ticker(r.values[S!.database.roles["sec.ticker"]]) ?? "";
      const v = { id: r.id, key, name: cell.text(r.values[S!.database.primaryPropId]), cls: clsName(cell.sel(r.values[S!.database.roles["sec.class"]])), er: cell.num(r.values[S!.database.roles["sec.expense_ratio"]]) ?? 0 };
      secById.set(r.id, v);
      if (key) secByKey.set(key, v);
    }
    const R = X?.database.roles ?? {};
    const txns: InvTxn[] = (rows.data?.x ?? [])
      .map((r) => ({
        id: r.id,
        date: cell.date(r.values[R["inv.date"]]) ?? "",
        type: cell.sel(r.values[R["inv.type"]]) ?? "buy",
        secId: cell.rel(r.values[R["inv.security"]]),
        qty: cell.num(r.values[R["inv.qty"]]) ?? 0,
        price: num(cell.money(r.values[R["inv.price"]])),
        amount: num(cell.money(r.values[R["inv.amount"]])),
        fees: num(cell.money(r.values[R["inv.fees"]])),
        accountId: cell.rel(r.values[R["inv.account"]]),
      }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const lotsFor = (symbol: string): OpenLot[] => {
      const sec = secByKey.get(symbol);
      if (!sec) return [];
      const open: (OpenLot & { qty: number })[] = [];
      for (const t of txns) {
        if (t.secId !== sec.id || !t.accountId) continue;
        const acct = accounts.get(t.accountId);
        if (t.type === "buy" || t.type === "reinvest" || t.type === "transfer_in") {
          if (t.qty > 0) open.push({ accountId: t.accountId, accountName: acct?.name ?? "", taxTreatment: acct?.tax ?? "taxable", acquired: t.date, qty: t.qty, costPerUnit: Math.abs(t.amount) / t.qty });
        } else if (t.type === "sell" || t.type === "transfer_out") {
          let left = t.qty;
          for (const lot of open) {
            if (lot.accountId !== t.accountId || lot.qty <= 1e-9) continue;
            const take = Math.min(lot.qty, left);
            lot.qty -= take;
            left -= take;
            if (left <= 1e-9) break;
          }
        } else if (t.type === "split" && t.qty > 0) {
          for (const lot of open) if (lot.accountId === t.accountId) {
            lot.qty *= t.qty;
            lot.costPerUnit /= t.qty;
          }
        }
      }
      return open.filter((l) => l.qty > 1e-6);
    };
    return { schemas, secByKey, accounts, txns, lotsFor, loading: !ready || (rows.loading && !rows.data) };
  }, [schemas, rows.data, rows.loading, ready]);
}

export function usePortfolioSummary(instanceId: Id) {
  const s = useAsync(() => api.portfolio.summary({ instanceId }), [instanceId]);
  return s;
}

export const CLASS_ORDER = ["US equity", "Intl developed", "Emerging", "Bonds", "Inflation-linked", "REIT", "Cash", "Crypto", "Other"];
