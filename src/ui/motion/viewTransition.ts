/**
 * View Transitions helpers for shared-element morphs across lazy routes (docs/DESIGN.md §5.4.2, S9/S6).
 *
 *   <span style={vtStyle(vt.pageIcon(page.id))}>…</span>         on BOTH the source row and the destination header
 *   withViewTransition(() => navigate({ t: "page", id }))         wraps the DOM update
 *
 * Falls back to calling `update` directly where the API is missing or motion is reduced (the route crossfade runs).
 * Group timing (380ms, morph spring) lives in material.css.
 */
import type { CSSProperties } from "react";
import { flushSync } from "react-dom";
import { isReducedMotion } from "./useReducedEffects";

type Doc = Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void>; ready: Promise<void> } };

/** Canonical names (§5.4.2). */
export const vt = {
  pageIcon: (id: string) => `vt-page-icon-${safe(id)}`,
  pageTitle: (id: string) => `vt-page-title-${safe(id)}`,
  kpi: (id: string) => `vt-kpi-${safe(id)}`,
  appTile: (appId: string) => `vt-app-tile-${safe(appId)}`,
} as const;

function safe(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function vtStyle(name: string | undefined | null): CSSProperties | undefined {
  return name ? ({ viewTransitionName: name } as CSSProperties) : undefined;
}

export function supportsViewTransitions(): boolean {
  return typeof document !== "undefined" && typeof (document as Doc).startViewTransition === "function";
}

let running = false;

/**
 * Run a DOM update inside a View Transition. React state updates are flushed synchronously so the new snapshot is
 * captured. Nested / overlapping calls just run the update.
 */
export function withViewTransition(update: () => void): Promise<void> {
  const doc = document as Doc;
  if (running || !doc.startViewTransition || isReducedMotion()) {
    update();
    return Promise.resolve();
  }
  running = true;
  const t = doc.startViewTransition(() => {
    flushSync(update);
  });
  return t.finished.catch(() => undefined).finally(() => {
    running = false;
  });
}
