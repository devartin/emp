/**
 * App command stack (§13.4): undo outside the editor. `{label, do(), undo()}` per window, capped at 100.
 * ⌘Z routes to the focused editor first, then the sheet, then this stack (see app/shortcuts.ts).
 *
 *   await undoable({ label: 'Move page', do: () => api.page.move(…), undo: () => api.page.move(…) }, { toast: 'Moved' });
 */
import { create } from 'zustand';
import { notify } from './toasts';

export interface UndoCommand {
  label: string;
  do(): unknown | Promise<unknown>;
  undo(): unknown | Promise<unknown>;
  /** Offer undo only until this time (e.g. life-app install: 10 minutes). */
  expiresAt?: number;
}

interface UndoState {
  past: UndoCommand[];
  future: UndoCommand[];
  busy: boolean;
  /** Record a command whose `do` already ran. */
  push(cmd: UndoCommand): void;
  /** Run `do` and record it. */
  run(cmd: UndoCommand): Promise<void>;
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
  /** Undo one specific command (from its toast), wherever it sits in the stack. */
  undoCommand(cmd: UndoCommand): Promise<boolean>;
  clear(): void;
}

export const UNDO_CAP = 100;

const live = (c: UndoCommand) => !c.expiresAt || c.expiresAt > Date.now();

export const useUndo = create<UndoState>()((set, get) => ({
  past: [],
  future: [],
  busy: false,
  push(cmd) {
    set((s) => ({ past: [...s.past, cmd].slice(-UNDO_CAP), future: [] }));
  },
  async run(cmd) {
    await cmd.do();
    get().push(cmd);
  },
  async undo() {
    if (get().busy) return false;
    const past = get().past.filter(live);
    const cmd = past[past.length - 1];
    if (!cmd) return false;
    set({ busy: true });
    try {
      await cmd.undo();
      set((s) => ({ past: s.past.filter((c) => c !== cmd), future: [...s.future, cmd].slice(-UNDO_CAP) }));
      return true;
    } catch (e) {
      notify.fromError(e, `Couldn't undo ${cmd.label.toLowerCase()}`);
      set((s) => ({ past: s.past.filter((c) => c !== cmd) }));
      return false;
    } finally {
      set({ busy: false });
    }
  },
  async redo() {
    if (get().busy) return false;
    const cmd = get().future[get().future.length - 1];
    if (!cmd) return false;
    set({ busy: true });
    try {
      await cmd.do();
      set((s) => ({ future: s.future.filter((c) => c !== cmd), past: [...s.past, cmd].slice(-UNDO_CAP) }));
      return true;
    } catch (e) {
      notify.fromError(e, `Couldn't redo ${cmd.label.toLowerCase()}`);
      set((s) => ({ future: s.future.filter((c) => c !== cmd) }));
      return false;
    } finally {
      set({ busy: false });
    }
  },
  async undoCommand(cmd) {
    if (!get().past.includes(cmd) || !live(cmd)) return false;
    try {
      await cmd.undo();
      set((s) => ({ past: s.past.filter((c) => c !== cmd), future: [...s.future, cmd].slice(-UNDO_CAP) }));
      return true;
    } catch (e) {
      notify.fromError(e, `Couldn't undo ${cmd.label.toLowerCase()}`);
      return false;
    }
  },
  clear: () => set({ past: [], future: [] }),
}));

/**
 * Run a command, record it, and (optionally) show a "title · Undo" toast for 6 s.
 * Returns the value of `do()`.
 */
export async function undoable<T>(
  cmd: Omit<UndoCommand, 'do'> & { do(): T | Promise<T> },
  opts: { toast?: string } = {},
): Promise<T> {
  const result = await cmd.do();
  const recorded: UndoCommand = cmd;
  useUndo.getState().push(recorded);
  if (opts.toast) notify.undo(opts.toast, () => useUndo.getState().undoCommand(recorded).then(() => undefined));
  return result;
}
