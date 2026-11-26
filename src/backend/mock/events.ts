/**
 * Mock event bus. Two channels:
 * - `emit(name, payload)` — §11.4 events delivered to the webview (asynchronously, structured-cloned, like Tauri).
 * - `internal` — synchronous in-mock hooks between namespaces (e.g. `page:duplicated` so the databases mock can
 *   copy its tables). Internal events never reach the UI.
 */
import type { EventMap, EventName } from '../types';

type AnyHandler = (payload: unknown) => void;

export interface InternalEventMap {
  /** A page (and possibly its subtree) moved to Trash. `ids` includes every descendant. */
  'page:deleted': { ids: string[]; workspaceId: string };
  'page:restored': { ids: string[]; workspaceId: string };
  /** Permanently removed. */
  'page:purged': { ids: string[]; workspaceId: string };
  /** A page was duplicated; `map` maps every source page id to its copy. */
  'page:duplicated': { sourceId: string; newId: string; map: Record<string, string> };
  'doc:saved': { ownerId: string; ownerKind: 'page' | 'row'; rev: number };
  'vault:locked': { reason: string };
  'vault:unlocked': Record<string, never>;
  /** Getting Started checklist (core seed): 'create_page' | 'try_slash' | 'open_palette' | 'add_transaction' | 'hide_numbers' | 'lock' | 'templates'. */
  'gettingStarted:tick': { item: string };
}

export type InternalEventName = keyof InternalEventMap;

export class MockEvents {
  private handlers = new Map<string, Set<AnyHandler>>();
  private internalHandlers = new Map<string, Set<AnyHandler>>();
  private muted = 0;

  /** Emit a §11.4 event to the webview. */
  emit<E extends EventName>(name: E, payload: EventMap[E]): void {
    if (this.muted > 0) return;
    const set = this.handlers.get(name);
    if (!set || set.size === 0) return;
    let cloned: unknown;
    try {
      cloned = structuredClone(payload);
    } catch {
      cloned = payload;
    }
    setTimeout(() => {
      for (const fn of Array.from(set)) {
        try {
          fn(cloned);
        } catch (err) {
          console.error(`[emp mock] listener for ${name} failed`, err);
        }
      }
    }, 0);
  }

  listen<E extends EventName>(name: E, fn: (payload: EventMap[E]) => void): () => void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(fn as AnyHandler);
    return () => set.delete(fn as AnyHandler);
  }

  /** Synchronous in-mock hook. */
  on<E extends InternalEventName>(name: E, fn: (payload: InternalEventMap[E]) => void): () => void {
    let set = this.internalHandlers.get(name);
    if (!set) {
      set = new Set();
      this.internalHandlers.set(name, set);
    }
    set.add(fn as AnyHandler);
    return () => set.delete(fn as AnyHandler);
  }

  internal<E extends InternalEventName>(name: E, payload: InternalEventMap[E]): void {
    const set = this.internalHandlers.get(name);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[emp mock] internal hook ${name} failed`, err);
      }
    }
  }

  /** Suppress webview events while `fn` runs (sync or async; used while seeding). */
  muteWhile<T>(fn: () => T): T {
    this.muted++;
    let result: T;
    try {
      result = fn();
    } catch (e) {
      this.muted--;
      throw e;
    }
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      return (result as unknown as Promise<unknown>).finally(() => {
        this.muted--;
      }) as unknown as T;
    }
    this.muted--;
    return result;
  }

  clearInternal(): void {
    this.internalHandlers.clear();
  }
}
