/**
 * The closing balance the last imported file reported for each account (`FinanceImportPreview.statement`, OFX
 * `<LEDGERBAL>` or the CSV balance column), remembered so the reconcile dialog can offer it — labelled with its
 * source and date — instead of pre-filling Ultra Note's own figure. Per device (browser storage, best effort): it is a
 * convenience, never the record; the reconciled state itself lives in the ledger.
 */
import { create } from "zustand";
import type { FinanceImportStatement, Id } from "@/backend/types";

export interface RememberedStatement extends FinanceImportStatement {
  /** Display name of the imported file. */
  fileName?: string;
  /** YYYY-MM-DD the file was imported. */
  importedOn: string;
}

const KEY = "emp.finance.statements.v1";

function load(): Record<Id, RememberedStatement> {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" ? (v as Record<Id, RememberedStatement>) : {};
  } catch {
    return {};
  }
}

interface StatementsState {
  byAccount: Record<Id, RememberedStatement>;
  remember: (accountId: Id, s: RememberedStatement) => void;
  forget: (accountId: Id) => void;
}

export const useStatements = create<StatementsState>()((set, get) => {
  const save = (byAccount: Record<Id, RememberedStatement>) => {
    set({ byAccount });
    try {
      globalThis.localStorage?.setItem(KEY, JSON.stringify(byAccount));
    } catch {
      /* storage unavailable: keep it for this session only */
    }
  };
  return {
    byAccount: load(),
    remember: (accountId, s) => save({ ...get().byAccount, [accountId]: s }),
    forget: (accountId) => {
      const next = { ...get().byAccount };
      delete next[accountId];
      save(next);
    },
  };
});
