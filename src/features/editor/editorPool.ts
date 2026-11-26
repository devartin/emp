/**
 * Editor pool (§13.3, §7.8): TipTap instances for recently opened pages stay alive (detached from the DOM) so going
 * back is instant and each page keeps its own undo history. LRU of 8; evicted editors are destroyed.
 */
import type { Editor } from '@tiptap/core';

interface Entry {
  editor: Editor;
  /** Doc rev this editor last loaded or saved. */
  rev: number;
  inUse: number;
  touched: number;
}

const MAX = 8;
const pool = new Map<string, Entry>();

export function poolKey(kind: 'page' | 'row', id: string): string {
  return `${kind}:${id}`;
}

export function pooled(key: string): Entry | undefined {
  return pool.get(key);
}

export function acquire(key: string, create: () => Editor, rev: number): Entry {
  let e = pool.get(key);
  if (e && e.editor.isDestroyed) {
    pool.delete(key);
    e = undefined;
  }
  if (!e) {
    e = { editor: create(), rev, inUse: 0, touched: Date.now() };
    pool.set(key, e);
  }
  e.touched = Date.now();
  return e;
}

/** Mark a pooled editor as on screen (call from an effect; pair with `release`). */
export function retain(key: string): void {
  const e = pool.get(key);
  if (!e) return;
  e.inUse++;
  e.touched = Date.now();
  evict();
}

export function release(key: string): void {
  const e = pool.get(key);
  if (!e) return;
  e.inUse = Math.max(0, e.inUse - 1);
  e.touched = Date.now();
  evict();
}

export function setPooledRev(key: string, rev: number): void {
  const e = pool.get(key);
  if (e) e.rev = rev;
}

/** Destroy a pooled editor (e.g. the page was deleted or its doc was replaced elsewhere). */
export function drop(key: string): void {
  const e = pool.get(key);
  if (!e || e.inUse > 0) return;
  pool.delete(key);
  e.editor.destroy();
}

function evict(): void {
  if (pool.size <= MAX) return;
  const idle = [...pool.entries()].filter(([, e]) => e.inUse === 0).sort((a, b) => a[1].touched - b[1].touched);
  while (pool.size > MAX && idle.length) {
    const [key, e] = idle.shift()!;
    pool.delete(key);
    e.editor.destroy();
  }
}
