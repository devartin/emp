/**
 * One import entry for financial files (K4 "one import dialog"): the shell's Import dialog, ⌘K, first run and Money
 * HQ's own Import button all open the same finance import wizard. Callers outside Money HQ use `openFinanceImport`
 * (optionally with the file grant they already picked); Money HQ consumes the request on mount and opens the wizard,
 * starting straight from that file when one is given.
 */
import { create } from "zustand";
import type { Id } from "@/backend/types";
import { navigate } from "@/app/router";
import { useWorkspace } from "@/stores/workspace";

export interface FinanceImportFile {
  grantId: string;
  displayName: string;
}

interface RequestState {
  pending: { instanceId: Id; file?: FinanceImportFile } | null;
  take: (instanceId: Id) => { file?: FinanceImportFile } | null;
}

export const useFinanceImportRequest = create<RequestState>()((set, get) => ({
  pending: null,
  take: (instanceId) => {
    const p = get().pending;
    if (!p || p.instanceId !== instanceId) return null;
    set({ pending: null });
    return { file: p.file };
  },
}));

/**
 * Open the finance import wizard in Money HQ (navigating there), optionally starting from a file the caller already
 * picked. Returns false when Money HQ is not installed — the caller should offer to set it up (this navigates to its
 * Life apps page).
 */
export function openFinanceImport(file?: FinanceImportFile): boolean {
  const inst = useWorkspace.getState().lifeapps.find((i) => i.appId === "money-hq");
  if (!inst) {
    navigate({ t: "lifeapps", appId: "money-hq" });
    return false;
  }
  useFinanceImportRequest.setState({ pending: { instanceId: inst.id, file } });
  navigate({ t: "app", instanceId: inst.id });
  return true;
}
