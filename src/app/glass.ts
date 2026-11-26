/**
 * Transparency controller (Settings › Appearance › Transparency: Auto / On / Off). Owns `<html data-glass>` at runtime;
 * the inline boot script sets the same value before first paint from `emp.boot` (`glass`, `glassProbe`), so there is
 * no flash. Decision logic lives in `./glassPolicy` (unit-tested), frame measurement in `@/ui/motion/glassProbe`.
 *
 * Persistence: the choice is mirrored to the boot cache (flash-free boot) and to kv `ui.appearance/transparency`
 * (durable, restored after unlock); a failed kv write rolls the choice back, like `useSettings.setDevice`. The probe
 * verdict and its history (strikes, passes) are properties of this machine and stay in the boot cache only. One bad
 * session only steps down for that session; see `glassPolicy` for when a step-down persists and when it expires.
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
  EMPTY_LOG,
  decideGlass,
  isLinuxUserAgent,
  mergeGlassFields,
  parseKvPref,
  readGlassFields,
  recordProbeResult,
  verdictExpired,
  type GlassDecision,
  type GlassPref,
  type GlassProbeLog,
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
let log: GlassProbeLog = { ...EMPTY_LOG };
let passed = false;
/** The probe exceeded the budget this session (first strike): off until the next launch. */
let sessionFailed = false;
/** Bumped by every user choice, so a late kv failure only rolls back the choice that failed. */
let prefSeq = 0;
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
    log = f.log;
  } catch {
    pref = "auto";
    verdict = null;
    log = { ...EMPTY_LOG };
  }
}

function writeCache(): void {
  try {
    const raw = window.localStorage.getItem(BOOT_KEY);
    const next = mergeGlassFields(raw, { pref, verdict, log });
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
  decision = decideGlass({ pref, verdict, linux, passed, sessionFailed, reducedTransparency: mq(RT_QUERY), effectsReduced: root().getAttribute("data-effects") === "reduced" });
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
    // While the frame monitor has effects reduced, glass isn't painted and the probe can't sample — keep its budget
    // (it pauses itself via glassRenders) so the evidence so far still counts if effects are restored.
    if (decision.status === "auto-effects" && linux && verdict === null && !passed && !sessionFailed && probe) return;
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
          const out = recordProbeResult(log, "exceeded", Date.now(), appVersion());
          verdict = out.verdict;
          log = out.log;
          sessionFailed = out.sessionFailed;
          writeCache();
          if (glassOverlayVisible()) startHold();
          apply();
        },
        onPassed: () => {
          probe = null;
          passed = true;
          log = recordProbeResult(log, "passed", Date.now(), appVersion()).log;
          writeCache();
          apply();
        },
      });
    },
    probeStarts === 0 ? FIRST_PROBE_DELAY_MS : 0,
  );
}

const appVersion = () => useSettings.getState().appInfo?.version ?? "";

/**
 * Drop a persisted step-down that has expired (age, or a new app version once app_info is known) so Auto measures
 * again; stamp an unstamped one. Turning glass back on here never flashes: no overlay is open at boot.
 */
function checkVerdictExpiry(): void {
  if (verdict !== "failed") return;
  const now = Date.now();
  const version = appVersion();
  if (verdictExpired(verdict, log, now, version)) {
    verdict = null;
    log = { ...log, strikes: 0, failedAt: 0, failedVersion: "" };
  } else if (!log.failedAt || (!log.failedVersion && version)) {
    log = { ...log, failedAt: log.failedAt || now, failedVersion: log.failedVersion || version };
  } else return;
  writeCache();
  apply();
}

/** Forget this session's measurements and the strike history (explicit re-test or a return to Auto). */
function resetProbe(): void {
  verdict = null;
  passed = false;
  sessionFailed = false;
  log = { ...log, strikes: 0, lastFail: 0, failedAt: 0, failedVersion: "" };
  releaseHold();
  stopProbe();
}

// ───────────────────────────────────────────────────────────────────────────── public API

/** Install once, as early as possible (boot()), before the first paint of the app. Idempotent. */
export function installGlass(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  readCache();
  checkVerdictExpiry();
  apply();
  // Re-assert after bootPrefs (or anything else) rewrites data-glass, and follow data-effects (frame monitor, setting).
  new MutationObserver(() => apply()).observe(root(), { attributes: true, attributeFilter: ["data-glass", "data-effects"] });
  if (window.matchMedia) window.matchMedia(RT_QUERY).addEventListener?.("change", () => apply());
  // writeBootPrefs() keeps a five-key whitelist: put our fields back after every settings write (same task). app_info
  // arrives through the same store: that's when a version-bound verdict can expire.
  useSettings.subscribe((s, prev) => {
    queueMicrotask(writeCache);
    if (s.appInfo?.version !== prev.appInfo?.version) checkVerdictExpiry();
  });
  if (import.meta.env.DEV) {
    Object.assign(window, {
      __empGlass: {
        state: () => ({ ...snapshot, verdict, log, passed, sessionFailed, holdOn, probe: probe?.state() ?? null }),
        /** Inject a measured window into the running probe (frames, dropped). */
        feedWindow: (frames: number, dropped: number): BudgetEvent | "no-probe" => probe?.feedWindow(frames, dropped) ?? "no-probe",
        setPref: (p: GlassPref) => setGlassPref(p),
        retest: () => retestGlass(),
      },
    });
  }
}

/** Everything a user choice can change, for rolling back a choice kv refused. */
interface LocalState {
  pref: GlassPref;
  verdict: GlassVerdict;
  log: GlassProbeLog;
  passed: boolean;
  sessionFailed: boolean;
}

function restoreLocal(s: LocalState): void {
  stopProbe();
  releaseHold();
  ({ pref, verdict, log, passed, sessionFailed } = s);
  writeCache();
  apply();
}

/** Settings › Appearance › Transparency. Applies at once; persisted to the boot cache and kv, rolled back on error. */
export async function setGlassPref(next: GlassPref): Promise<void> {
  if (next === pref) return;
  const prev: LocalState = { pref, verdict, log, passed, sessionFailed };
  const seq = ++prefSeq;
  // A user's return to Auto from On/Off re-probes from scratch.
  if (next === "auto") resetProbe();
  pref = next;
  writeCache();
  apply();
  try {
    await api.kv.set({ ns: KV.ns, key: KV.key, value: { pref: next } });
  } catch (e) {
    if (seq === prefSeq) restoreLocal(prev);
    notify.fromError(e, "Couldn't save that setting");
  }
}

/** Clear a step-down and measure again (Auto only). */
export function retestGlass(): void {
  if (pref !== "auto") return;
  resetProbe();
  writeCache();
  apply();
}

/** After unlock: kv holds the durable choice. Adopt it, or seed it from the boot cache on first run. */
export async function syncGlassFromKv(): Promise<void> {
  const seq = prefSeq;
  try {
    const stored = parseKvPref(await api.kv.get({ ns: KV.ns, key: KV.key }));
    if (seq !== prefSeq) return; // the user chose meanwhile: that choice wins (and is being written)
    if (stored === null) {
      if (pref !== "auto") await api.kv.set({ ns: KV.ns, key: KV.key, value: { pref } });
      return;
    }
    // Adopt the durable choice. This is not a user action: keep this machine's probe verdict and history.
    if (stored !== pref) {
      pref = stored;
      writeCache();
      apply();
    }
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
