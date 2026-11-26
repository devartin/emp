/**
 * Transparency controller (Settings › Appearance › Transparency: Auto / On / Off). Owns `<html data-glass>` at runtime;
 * the inline boot script sets the same value before first paint from `emp.boot` (`glass`, `glassProbe`), so there is
 * no flash. Decision logic lives in `./glassPolicy` (unit-tested), frame measurement in `@/ui/motion/glassProbe`.
 *
 * Persistence: the choice is mirrored to the boot cache (flash-free boot) and to kv `ui.appearance/transparency`
 * (durable, restored after unlock). The probe verdict is a property of this machine and stays in the boot cache only.
 *
 * Two places outside this module also write: `lib/bootPrefs.applyAppearance()` sets `data-glass` to its own
 * platform default, and `writeBootPrefs()` rewrites `emp.boot` with a five-key whitelist. Until bootPrefs learns
 * about transparency, this module re-asserts its attribute (MutationObserver → microtask, so before paint) and
 * re-merges its two boot-cache fields after every settings write.
 */
import { useSyncExternalStore } from "react";
import { api } from "@/backend";
import { useSettings } from "@/stores/settings";
import { notify } from "@/stores/toasts";
import { glassOverlayVisible, startGlassProbe, type BudgetEvent, type GlassProbeHandle } from "@/ui/motion/glassProbe";
import {
  BOOT_KEY,
  decideGlass,
  isLinuxUserAgent,
  mergeGlassFields,
  parseKvPref,
  readGlassFields,
  type GlassDecision,
  type GlassPref,
  type GlassStatus,
  type GlassVerdict,
} from "./glassPolicy";

export type { GlassPref, GlassStatus } from "./glassPolicy";

const KV = { ns: "ui.appearance", key: "transparency" } as const;
const RT_QUERY = "(prefers-reduced-transparency: reduce)";
/** Let boot settle (chunk loads, first route) before calibrating the refresh interval. */
const FIRST_PROBE_DELAY_MS = 1500;

export interface GlassSnapshot {
  pref: GlassPref;
  status: GlassStatus;
  /** Resolved `data-glass`. */
  glass: "on" | "off";
  linux: boolean;
}

let pref: GlassPref = "auto";
let verdict: GlassVerdict = null;
let passed = false;
/** Verdict reached while an overlay is open: keep it glassy until it closes (running animations finish, §5). */
let holdOn = false;
let holdTimer: ReturnType<typeof setInterval> | null = null;
let decision: GlassDecision = { glass: "on", status: "auto-on", probe: false };
let probe: GlassProbeHandle | null = null;
let probeTimer: ReturnType<typeof setTimeout> | null = null;
let probeStarts = 0;
let installed = false;
const linux = typeof navigator !== "undefined" && isLinuxUserAgent(navigator.userAgent);

let snapshot: GlassSnapshot = { pref, status: decision.status, glass: decision.glass, linux };
const listeners = new Set<() => void>();

function emit() {
  const next: GlassSnapshot = { pref, status: decision.status, glass: holdOn ? "on" : decision.glass, linux };
  if (next.pref === snapshot.pref && next.status === snapshot.status && next.glass === snapshot.glass) return;
  snapshot = next;
  listeners.forEach((l) => l());
}

// ───────────────────────────────────────────────────────────────────────────── boot cache

function readCache(): void {
  try {
    const raw = window.localStorage.getItem(BOOT_KEY);
    const f = readGlassFields(raw ? (JSON.parse(raw) as unknown) : null);
    pref = f.pref;
    verdict = f.verdict;
  } catch {
    pref = "auto";
    verdict = null;
  }
}

function writeCache(): void {
  try {
    const raw = window.localStorage.getItem(BOOT_KEY);
    const next = mergeGlassFields(raw, { pref, verdict });
    if (next !== null) window.localStorage.setItem(BOOT_KEY, next);
  } catch {
    /* storage unavailable (private mode): the attribute still applies for this session */
  }
}

// ───────────────────────────────────────────────────────────────────────────── resolve + apply

const root = () => document.documentElement;
const mq = (q: string) => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(q).matches;

/** Glass is actually painted (CSS also turns it opaque under reduced effects and higher contrast). */
function glassRenders(): boolean {
  const r = root();
  return r.getAttribute("data-glass") === "on" && r.getAttribute("data-effects") !== "reduced" && r.getAttribute("data-contrast") !== "more";
}

function apply(): void {
  if (typeof document === "undefined") return;
  decision = decideGlass({ pref, verdict, linux, passed, reducedTransparency: mq(RT_QUERY), effectsReduced: root().getAttribute("data-effects") === "reduced" });
  if (holdOn && (decision.glass === "on" || !glassOverlayVisible())) releaseHold();
  const value = holdOn ? "on" : decision.glass;
  if (root().getAttribute("data-glass") !== value) root().setAttribute("data-glass", value);
  syncProbe();
  emit();
}

function releaseHold() {
  holdOn = false;
  if (holdTimer) clearInterval(holdTimer);
  holdTimer = null;
}

function startHold() {
  holdOn = true;
  holdTimer ??= setInterval(() => {
    if (!glassOverlayVisible()) {
      releaseHold();
      apply();
    }
  }, 250);
}

function stopProbe() {
  if (probeTimer) clearTimeout(probeTimer);
  probeTimer = null;
  probe?.stop();
  probe = null;
}

function syncProbe() {
  if (!decision.probe) {
    stopProbe();
    return;
  }
  if (probe || probeTimer) return;
  probeTimer = setTimeout(
    () => {
      probeTimer = null;
      if (!decision.probe || probe) return;
      probeStarts += 1;
      probe = startGlassProbe({
        glassRenders,
        onExceeded: () => {
          probe = null;
          verdict = "failed";
          writeCache();
          if (glassOverlayVisible()) startHold();
          apply();
        },
        onPassed: () => {
          probe = null;
          passed = true;
          apply();
        },
      });
    },
    probeStarts === 0 ? FIRST_PROBE_DELAY_MS : 0,
  );
}

// ───────────────────────────────────────────────────────────────────────────── public API

/** Install once, as early as possible (boot()), before the first paint of the app. Idempotent. */
export function installGlass(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  readCache();
  apply();
  // Re-assert after bootPrefs (or anything else) rewrites data-glass, and follow data-effects (frame monitor, setting).
  new MutationObserver(() => apply()).observe(root(), { attributes: true, attributeFilter: ["data-glass", "data-effects"] });
  if (window.matchMedia) window.matchMedia(RT_QUERY).addEventListener?.("change", () => apply());
  // writeBootPrefs() keeps a five-key whitelist: put our fields back after every settings write (same task).
  useSettings.subscribe(() => queueMicrotask(writeCache));
  if (import.meta.env.DEV) {
    Object.assign(window, {
      __empGlass: {
        state: () => ({ ...snapshot, verdict, passed, holdOn, probe: probe?.state() ?? null }),
        /** Inject a measured window into the running probe (frames, dropped). */
        feedWindow: (frames: number, dropped: number): BudgetEvent | "no-probe" => probe?.feedWindow(frames, dropped) ?? "no-probe",
        setPref: (p: GlassPref) => setGlassPref(p),
        retest: () => retestGlass(),
      },
    });
  }
}

function setLocal(next: GlassPref): void {
  if (next === "auto" && pref !== "auto") {
    // Back to Auto re-probes from scratch.
    verdict = null;
    passed = false;
    stopProbe();
  }
  pref = next;
  writeCache();
  apply();
}

/** Settings › Appearance › Transparency. Applies at once; persisted to the boot cache and kv. */
export async function setGlassPref(next: GlassPref): Promise<void> {
  if (next === pref) return;
  setLocal(next);
  try {
    await api.kv.set({ ns: KV.ns, key: KV.key, value: { pref: next } });
  } catch (e) {
    notify.fromError(e, "Couldn't save that setting");
  }
}

/** Clear a step-down and measure again (Auto only). */
export function retestGlass(): void {
  if (pref !== "auto") return;
  verdict = null;
  passed = false;
  releaseHold();
  stopProbe();
  writeCache();
  apply();
}

/** After unlock: kv holds the durable choice. Adopt it, or seed it from the boot cache on first run. */
export async function syncGlassFromKv(): Promise<void> {
  try {
    const stored = parseKvPref(await api.kv.get({ ns: KV.ns, key: KV.key }));
    if (stored === null) {
      if (pref !== "auto") await api.kv.set({ ns: KV.ns, key: KV.key, value: { pref } });
      return;
    }
    if (stored !== pref) setLocal(stored);
  } catch {
    /* locked or unavailable: the boot cache keeps working */
  }
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useGlass(): GlassSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
