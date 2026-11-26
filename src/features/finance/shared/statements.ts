/**
 * The closing balance the last imported file reported for each account (`FinanceImportPreview.statement`, OFX
 * `<LEDGERBAL>` or the CSV balance column), remembered so the reconcile dialog can offer it — labelled with its
 * source and date — instead of pre-filling Ultra Note's own figure. Kept in the vault (`kv` namespace
 * `ui.finance.statement`, key = account id), never in browser storage; it is a convenience, never the record — the
 * reconciled state itself lives in the ledger.
 */
import { api, listen } from "@/backend";
import type { FinanceImportStatement, Id } from "@/backend/types";
import { createVaultKv, type KvIo } from "./vaultKv";

export interface RememberedStatement extends FinanceImportStatement {
  /** Display name of the imported file. */
  fileName?: string;
  /** YYYY-MM-DD the file was imported. */
  importedOn: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Accepts only a well-formed record (the kv value is untyped JSON). */
export function parseStatement(raw: unknown): RememberedStatement | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.balance !== "string" || !Number.isFinite(Number(r.balance))) return null;
  if (r.source !== "ofx" && r.source !== "csv") return null;
  if (typeof r.importedOn !== "string" || !DAY.test(r.importedOn)) return null;
  return {
    balance: r.balance,
    source: r.source,
    importedOn: r.importedOn,
    ...(typeof r.asOf === "string" && DAY.test(r.asOf) ? { asOf: r.asOf } : {}),
    ...(typeof r.currency === "string" && /^[A-Z]{3}$/.test(r.currency) ? { currency: r.currency } : {}),
    ...(typeof r.fileName === "string" ? { fileName: r.fileName.slice(0, 200) } : {}),
  };
}

export const kvIo: KvIo = {
  get: (ns, key) => api.kv.get({ ns, key }),
  set: (ns, key, value) => api.kv.set({ ns, key, value }),
};

const store = createVaultKv<RememberedStatement>("ui.finance.statement", parseStatement, kvIo);
listen("vault:locked", () => store.getState().reset());

/** The remembered statement for `accountId`: `undefined` while loading, `null` when there is none. */
export function useRememberedStatement(accountId: Id): RememberedStatement | null | undefined {
  return store((st) => st.values[accountId]);
}

export function loadStatement(accountId: Id): Promise<void> {
  return store.getState().load(accountId);
}

export function rememberStatement(accountId: Id, s: RememberedStatement): Promise<void> {
  return store.getState().put(accountId, s);
}
