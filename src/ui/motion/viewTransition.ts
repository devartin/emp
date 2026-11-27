/**
 * View Transitions helpers for shared-element morphs across lazy routes (docs/DESIGN.md §5.4.2, S9/S6).
 *
 *   <span style={vtStyle(vt.pageIcon(page.id))}>…</span>         on BOTH the source row and the destination header
 *   withViewTransition(() => navigate({ t: "page", id }), { waitFor: vt.pageIcon(page.id) })   wraps the DOM update
 *
 * Falls back to calling `update` directly where the API is missing or motion is reduced (the route crossfade runs).
 * Group timing (380ms, morph spring) lives in material.css.
 */
import type { CSSProperties } from "react";
import { flushSync } from "react-dom";
import { isReducedMotion } from "./useReducedEffects";

type Doc = Document & { startViewTransition?: (cb: () => void | Promise<void>) => { finished: Promise<void>; ready: Promise<void> } };

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

/**
 * WebKitGTK (the Linux desktop webview) exposes `startViewTransition` but its web process crashes on it when
 * accelerated compositing is off (`WEBKIT_DISABLE_COMPOSITING_MODE=1`, common on NVIDIA and in VMs), taking the
 * whole app down. The crash is native, so it cannot be caught: never use View Transitions there.
 */
export function isWebKitGtk(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /Linux/.test(ua) && /AppleWebKit/.test(ua) && !/Chrome|Chromium|Android/.test(ua);
}

export function supportsViewTransitions(): boolean {
  return typeof document !== "undefined" && typeof (document as Doc).startViewTransition === "function" && !isWebKitGtk();
}

let running = false;

/** True while a shared-element View Transition is capturing; route transitions swap instantly then (routes.tsx). */
export function isViewTransitionActive(): boolean {
  return running;
}

function hasName(name: string): boolean {
  for (const el of document.querySelectorAll<HTMLElement>('[style*="view-transition-name"]')) {
    if (el.style.viewTransitionName === name) return true;
  }
  return false;
}

/**
 * Resolve once an element carrying `view-transition-name: name` is in the DOM, or after `timeoutMs`. Never uses
 * requestAnimationFrame: rendering is paused while the update callback is pending, so rAF would never fire and the
 * transition would freeze the screen until Chrome aborts it ("DOM update timed out").
 */
function waitForName(name: string | undefined, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!name || hasName(name)) {
      // Still yield a macrotask so React can commit a Suspense boundary that resolved synchronously.
      window.setTimeout(resolve, 0);
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      mo.disconnect();
      window.clearTimeout(timer);
      resolve();
    };
    const mo = new MutationObserver(() => {
      if (hasName(name)) finish();
    });
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["style"] });
    const timer = window.setTimeout(finish, timeoutMs);
  });
}

export interface ViewTransitionOptions {
  /** The destination's `view-transition-name` (e.g. `vt.pageIcon(id)`): capture as soon as it mounts. */
  waitFor?: string;
  /** Longest wait for the destination before capturing anyway (default 120ms). */
  timeoutMs?: number;
  /** @deprecated ignored — waiting on animation frames inside the update callback deadlocks the transition. */
  settleFrames?: number;
}

/**
 * Run a DOM update inside a View Transition. React state updates are flushed synchronously; the capture then waits
 * for the destination element (`waitFor`) to mount — raced against a short timeout — so lazy routes can supply it.
 * Nested / overlapping calls just run the update.
 */
export function withViewTransition(update: () => void, opts: ViewTransitionOptions = {}): Promise<void> {
  const doc = document as Doc;
  if (running || !doc.startViewTransition || !supportsViewTransitions() || isReducedMotion()) {
    update();
    return Promise.resolve();
  }
  running = true;
  let t: { finished: Promise<void> };
  try {
    t = doc.startViewTransition(async () => {
      flushSync(update);
      await waitForName(opts.waitFor, opts.timeoutMs ?? 120);
    });
  } catch {
    running = false;
    update();
    return Promise.resolve();
  }
  return t.finished.catch(() => undefined).finally(() => {
    running = false;
  });
}
