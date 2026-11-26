/** Recent imports (kv `ui.import/history`) so an import can be undone after its dialog closes. */
import { create } from "zustand";
import { api } from "@/backend";
import type { Id, ImportKind } from "@/backend/types";

export interface ImportRecord {
  /** Job id for `import_undo` (Markdown / Notion). */
  jobId?: Id;
  /** Pages to move to Trash instead (CSV / Excel imports). */
  trashIds?: Id[];
  title: string;
  kind: ImportKind;
  summary: string;
  at: number;
  openId?: Id;
}

interface HistoryState {
  items: ImportRecord[];
  loaded: boolean;
  load(): Promise<void>;
  remove(at: number): void;
}

export const useImportHistory = create<HistoryState>()((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    if (get().loaded) return;
    try {
      const v = await api.kv.get({ ns: "ui.import", key: "history" });
      set({ items: Array.isArray(v) ? (v as ImportRecord[]).slice(0, 10) : [], loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  remove(at) {
    const items = get().items.filter((i) => i.at !== at);
    set({ items });
    api.kv.set({ ns: "ui.import", key: "history", value: items }).catch(() => undefined);
  },
}));

export function recordImport(r: ImportRecord): void {
  const items = [r, ...useImportHistory.getState().items].slice(0, 10);
  useImportHistory.setState({ items });
  api.kv.set({ ns: "ui.import", key: "history", value: items }).catch(() => undefined);
}
