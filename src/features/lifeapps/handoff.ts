/**
 * S6 landing hand-off. The build stage lives inside the wizard, which unmounts with the route it was opened from, so
 * the last frame of the stage (its glass-3 veil and the app tile) is handed to a plain DOM layer that survives the
 * route change. The new app page then claims it: the tile flies into the AppHeader tile (FLIP, transform only) while
 * the veil lifts (opacity, 520ms expo) and the header plays its one-time edge-light sweep.
 *
 *   beginHandoff({ instanceId, appId, rect, tile })   // just before navigate()
 *   claimHandoff(instanceId)                          // AppPage, once the hub has rendered
 *   wasJustInstalled(instanceId)                      // AppHeader: play the sweep once
 *
 * Unclaimed hand-offs lift on their own after 2.4s, so nothing can be left covering the app.
 */
import { isReducedMotion } from "@/ui/motion/useReducedEffects";

interface Pending {
  instanceId: string;
  appId: string;
  veil: HTMLDivElement | null;
  tile: HTMLElement | null;
  timer: number;
}

let pending: Pending | null = null;
const landed = new Map<string, number>();

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function lift(p: Pending, target: HTMLElement | null) {
  window.clearTimeout(p.timer);
  if (pending === p) pending = null;
  const reduced = isReducedMotion();
  const veil = p.veil;
  if (veil) {
    const veilAnim = veil.animate([{ opacity: 1 }, { opacity: 0 }], { duration: reduced ? 140 : 520, easing: "cubic-bezier(.16,1,.3,1)", fill: "forwards", delay: reduced ? 0 : 90 });
    veilAnim.finished.catch(() => undefined).finally(() => veil.remove());
  }
  const tile = p.tile;
  if (!tile) return;
  if (reduced || !target) {
    tile.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: "forwards" }).finished.catch(() => undefined).finally(() => tile.remove());
    return;
  }
  const from = tile.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  const s = to.width / Math.max(1, from.width);
  const dx = to.left - from.left;
  const dy = to.top - from.top;
  target.style.visibility = "hidden";
  const a = tile.animate([{ transform: "translate(0,0) scale(1)" }, { transform: `translate(${dx}px, ${dy}px) scale(${s})` }], {
    duration: 520,
    easing: cssVar("--spring-settle", "cubic-bezier(.16,1,.3,1)"),
    fill: "forwards",
  });
  a.finished
    .catch(() => undefined)
    .finally(() => {
      target.style.visibility = "";
      tile.remove();
    });
}

/**
 * Freeze a tile (and, for installs, the stage's veil) into a layer that outlives the route. Call right before
 * navigating. Without `veil` it is a plain shared-element flight (gallery card → app header).
 */
export function beginHandoff({ instanceId, appId, tile, veil: v, install }: { instanceId: string; appId: string; tile: HTMLElement | null; veil?: { rect: DOMRect; app: string }; install?: boolean }): void {
  if (typeof document === "undefined") return;
  if (pending) lift(pending, null);
  let veil: HTMLDivElement | null = null;
  if (v) {
    veil = document.createElement("div");
    veil.className = "la-handoff la-stage-veil glass-3";
    veil.setAttribute("aria-hidden", "true");
    veil.style.cssText = `left:${v.rect.left}px;top:${v.rect.top}px;width:${v.rect.width}px;height:${v.rect.height}px;--app:${v.app};`;
    document.body.appendChild(veil);
  }
  let clone: HTMLElement | null = null;
  if (tile) {
    const r = tile.getBoundingClientRect();
    clone = tile.cloneNode(true) as HTMLElement;
    clone.classList.add("la-handoff-tile");
    clone.style.left = `${r.left}px`;
    clone.style.top = `${r.top}px`;
    clone.style.width = `${r.width}px`;
    clone.style.height = `${r.height}px`;
    clone.style.removeProperty("transform");
    clone.removeAttribute("id");
    document.body.appendChild(clone);
  }
  const p: Pending = { instanceId, appId, veil, tile: clone, timer: 0 };
  p.timer = window.setTimeout(() => lift(p, null), 2400);
  pending = p;
  if (install) landed.set(instanceId, Date.now());
}

/** The app page has rendered: fly the tile into `[data-app-tile=<appId>]` (if present) and lift the veil. */
export function claimHandoff(instanceId: string): boolean {
  const p = pending;
  if (!p || p.instanceId !== instanceId) return false;
  const target = document.querySelector<HTMLElement>(`[data-app-tile="${CSS.escape(p.appId)}"]`);
  lift(p, target);
  return true;
}

export function hasPendingHandoff(instanceId: string): boolean {
  return !!pending && pending.instanceId === instanceId;
}

/** True once per instance, within a few seconds of its install landing (AppHeader's edge-light sweep). */
export function wasJustInstalled(instanceId: string): boolean {
  const t = landed.get(instanceId);
  if (!t) return false;
  landed.delete(instanceId);
  return Date.now() - t < 5000;
}
