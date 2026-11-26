/**
 * Autosave (§7.8): dirty on change, save after 400ms idle or at most 2s after the first unsaved change; serialise in
 * requestIdleCallback (timeout 300ms) and call `page_save_doc` with `baseRev`. Flushed on blur, route change,
 * visibilitychange, before lock and on window close (registerFlush). CONFLICT hands the local draft to `onConflict`.
 */
import type { Editor } from '@tiptap/core';
import { useEffect, useSyncExternalStore } from 'react';
import { api, hasCode, errorMessage } from '@/backend';
import type { Id, Rev, TipTapDoc } from '@/backend/types';
import { registerFlush } from '@/app/boot';
import { requestIdle } from '@/lib/idle';
import { useEditorStatus, type SaveState } from './status';

const IDLE_MS = 400;
const MAX_MS = 2000;
const RETRY_MS = 5000;
export const REMOTE_META = 'emp:remote';

export interface SaverSnapshot {
  state: SaveState;
  savedAt: number | null;
  error: string | null;
  rev: Rev;
  edited: boolean;
}

export interface ConflictInfo {
  draft: TipTapDoc;
  currentRev: Rev | null;
}

export class DocSaver {
  rev: Rev;
  private dirty = false;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private max: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private snap: SaverSnapshot;
  onConflict: ((c: ConflictInfo) => void) | null = null;
  onSaved: ((rev: Rev) => void) | null = null;
  paused = false;

  constructor(
    private editor: Editor,
    readonly ownerId: Id,
    readonly ownerKind: 'page' | 'row',
    rev: Rev,
  ) {
    this.rev = rev;
    this.snap = { state: 'idle', savedAt: null, error: null, rev, edited: false };
    editor.on('update', this.onUpdate);
    editor.on('blur', this.onBlur);
  }

  get saving(): boolean {
    return !!this.inflight;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.snap;

  private emit(p: Partial<SaverSnapshot>) {
    this.snap = { ...this.snap, ...p, rev: this.rev };
    this.listeners.forEach((l) => l());
    const g = useEditorStatus.getState();
    if (g.ownerId === this.ownerId) g.set({ state: this.snap.state, savedAt: this.snap.savedAt, error: this.snap.error });
  }

  private onUpdate = ({ transaction }: { transaction: { getMeta(k: string): unknown; docChanged: boolean } }) => {
    if (!transaction.docChanged || transaction.getMeta(REMOTE_META)) return;
    this.markDirty();
  };

  private onBlur = () => {
    if (this.dirty) void this.flush();
  };

  markDirty(): void {
    if (this.paused) return;
    this.dirty = true;
    if (this.snap.state !== 'dirty') this.emit({ state: 'dirty', edited: true });
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => void this.save(), IDLE_MS);
    if (!this.max) this.max = setTimeout(() => void this.save(), MAX_MS);
  }

  private clearTimers() {
    if (this.idle) clearTimeout(this.idle);
    if (this.max) clearTimeout(this.max);
    this.idle = null;
    this.max = null;
  }

  /** Set the rev after an external change (restore, reload, turn into page). */
  setRev(rev: Rev): void {
    this.rev = rev;
    this.snap = { ...this.snap, rev };
  }

  /** Forget pending changes (after a reload replaced the doc). */
  discard(): void {
    this.clearTimers();
    this.dirty = false;
    this.emit({ state: 'idle' });
  }

  async flush(): Promise<void> {
    this.clearTimers();
    if (this.inflight) await this.inflight;
    if (this.dirty) await this.save();
  }

  private async save(): Promise<void> {
    if (this.paused || this.editor.isDestroyed) return;
    if (this.inflight) {
      // Another save is running; it re-schedules when it finishes.
      return;
    }
    if (!this.dirty) return;
    this.clearTimers();
    this.dirty = false;
    this.emit({ state: 'saving' });
    const run = async () => {
      await new Promise<void>((r) => requestIdle(() => r(), { timeout: 300 }));
      if (this.editor.isDestroyed) return;
      const json = this.editor.getJSON() as TipTapDoc;
      const doc: TipTapDoc = { type: 'doc', attrs: { schemaVersion: 1 }, content: json.content };
      try {
        const res = await api.page.saveDoc({ ownerId: this.ownerId, ownerKind: this.ownerKind, doc, baseRev: this.rev });
        this.rev = res.rev;
        this.emit({ state: this.dirty ? 'dirty' : 'saved', savedAt: Date.now(), error: null });
        this.onSaved?.(res.rev);
      } catch (e) {
        if (hasCode(e, 'CONFLICT')) {
          const details = (e as { details?: { currentRev?: number } }).details;
          this.emit({ state: 'conflict', error: 'Changed somewhere else' });
          this.onConflict?.({ draft: doc, currentRev: details?.currentRev ?? null });
          return;
        }
        if (hasCode(e, 'LOCKED')) {
          this.dirty = true;
          this.emit({ state: 'error', error: 'Locked' });
          return;
        }
        this.dirty = true;
        this.emit({ state: hasCode(e, 'OFFLINE') ? 'offline' : 'error', error: errorMessage(e) || 'Couldn’t save' });
        if (!this.idle) this.idle = setTimeout(() => void this.save(), RETRY_MS);
      }
    };
    this.inflight = run().finally(() => {
      this.inflight = null;
      if (this.dirty && this.snap.state !== 'conflict' && !this.idle) this.idle = setTimeout(() => void this.save(), IDLE_MS);
    });
    await this.inflight;
  }

  destroy(): void {
    this.clearTimers();
    this.editor.off('update', this.onUpdate);
    this.editor.off('blur', this.onBlur);
    this.listeners.clear();
  }
}

const savers = new WeakMap<Editor, DocSaver>();

export function saverFor(editor: Editor, ownerId: Id, ownerKind: 'page' | 'row', rev: Rev): DocSaver {
  let s = savers.get(editor);
  if (!s || s.ownerId !== ownerId) {
    s?.destroy();
    s = new DocSaver(editor, ownerId, ownerKind, rev);
    savers.set(editor, s);
  }
  return s;
}

export function existingSaver(editor: Editor): DocSaver | undefined {
  return savers.get(editor);
}

/** Wire the saver to app lifecycle (lock/close flush, tab hidden) while mounted, and expose its status. */
export function useDocSave(saver: DocSaver | null): SaverSnapshot | null {
  useEffect(() => {
    if (!saver) return;
    const offFlush = registerFlush(() => saver.flush());
    const vis = () => {
      if (document.visibilityState === 'hidden') void saver.flush();
    };
    const before = () => void saver.flush();
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('beforeunload', before);
    useEditorStatus.getState().set({ ownerId: saver.ownerId, state: saver.getSnapshot().state, savedAt: saver.getSnapshot().savedAt, error: null });
    return () => {
      offFlush();
      document.removeEventListener('visibilitychange', vis);
      window.removeEventListener('beforeunload', before);
      void saver.flush();
      if (useEditorStatus.getState().ownerId === saver.ownerId) useEditorStatus.getState().set({ ownerId: null, state: 'idle', savedAt: null });
    };
  }, [saver]);
  return useSyncExternalStore(saver?.subscribe ?? noopSub, saver?.getSnapshot ?? nullSnap);
}

const noopSub = () => () => undefined;
const nullSnap = () => null;
