/**
 * Live reads of the resolved html[data-motion] / html[data-effects] / html[data-privacy] attributes.
 * One shared MutationObserver; components subscribe through useSyncExternalStore.
 */
import { useSyncExternalStore } from "react";

type Listener = () => void;
const listeners = new Set<Listener>();
let observer: MutationObserver | null = null;

function ensureObserver() {
  if (observer || typeof document === "undefined") return;
  observer = new MutationObserver(() => listeners.forEach((l) => l()));
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-motion", "data-effects", "data-privacy", "data-theme", "data-accent", "data-numbers", "data-contrast", "data-density"],
  });
}

export function subscribeRootAttrs(l: Listener): () => void {
  ensureObserver();
  listeners.add(l);
  return () => listeners.delete(l);
}

function attr(name: string): string | null {
  return typeof document === "undefined" ? null : document.documentElement.getAttribute(name);
}

export function useRootAttr(name: string): string | null {
  return useSyncExternalStore(subscribeRootAttrs, () => attr(name), () => null);
}

/** True when animations should be reduced (resolved motion pref). */
export function isReducedMotion(): boolean {
  const v = attr("data-motion");
  if (v) return v === "reduced";
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export function useReducedMotionPref(): boolean {
  return useSyncExternalStore(subscribeRootAttrs, isReducedMotion, () => false);
}

/** True when effects are reduced: no glass, shadows capped at elev-2, no particles (§4.4). */
export function isReducedEffects(): boolean {
  return attr("data-effects") === "reduced";
}

export function useReducedEffects(): boolean {
  return useSyncExternalStore(subscribeRootAttrs, isReducedEffects, () => false);
}

export function isPrivacyOn(): boolean {
  return attr("data-privacy") === "on";
}

export function usePrivacy(): boolean {
  return useSyncExternalStore(subscribeRootAttrs, isPrivacyOn, () => false);
}

/** Resolved theme, for components that need JS-side colours (charts). */
export function useResolvedTheme(): "light" | "dark" | "midnight" {
  return (useRootAttr("data-theme") as "light" | "dark" | "midnight" | null) ?? "light";
}
