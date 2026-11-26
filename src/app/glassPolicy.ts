/**
 * Transparency (glass) policy — pure decision logic shared by the runtime controller (`app/glass.ts`) and mirrored,
 * byte for byte in meaning, by the inline boot script in index.html / ui-gallery.html (glassPolicy.test.ts checks the
 * two agree on every case).
 *
 *   pref "on"   → glass on. Forces glass even on Linux; OS reduced transparency still wins visually because Visual
 *                 effects=Auto resolves to data-effects="reduced", which makes glass opaque in CSS (§4.12).
 *   pref "off"  → glass off everywhere.
 *   pref "auto" → off when the OS asks for reduced transparency or effects are reduced; otherwise on. On Linux
 *                 (WebKitGTK, where backdrop blur is the expensive part) Auto starts *probing*: glass on while the
 *                 glass probe measures frames during overlay animations. When the dropped-frame budget is exceeded,
 *                 glass steps down for the rest of that session and a strike is recorded. A second strike in a later
 *                 session (no clean session in between, strikes older than STRIKE_TTL_MS forgotten) persists the
 *                 verdict "failed", and Auto resolves to off from then on, including at boot without a flash. A failed
 *                 verdict expires after VERDICT_TTL_MS or when the app version changes, and the probe runs again.
 *                 Choosing Auto again from On/Off (or "Test again") clears the verdict and strikes and re-probes.
 */

export type GlassPref = "auto" | "on" | "off";
/** Persisted step-down (the only verdict the boot script reads). Passes and strikes live in `GlassProbeLog`. */
export type GlassVerdict = "failed" | null;

/** Probe history for this machine (boot cache `glassLog`; the boot script ignores it). Times are epoch ms. */
export interface GlassProbeLog {
  /** Sessions in a row whose probe exceeded the budget (reset by a clean session). */
  strikes: number;
  lastFail: number;
  /** Sessions whose probe passed. */
  passes: number;
  lastPass: number;
  /** When the verdict "failed" was persisted, and on which app version ("" if unknown at the time). */
  failedAt: number;
  failedVersion: string;
}

export const EMPTY_LOG: GlassProbeLog = { strikes: 0, lastFail: 0, passes: 0, lastPass: 0, failedAt: 0, failedVersion: "" };
/** Sessions with a failed probe (consecutive, no pass between) before the step-down is persisted. */
export const FAIL_SESSIONS = 2;
/** A strike older than this is forgotten (a busy afternoon months ago says nothing about today). */
export const STRIKE_TTL_MS = 14 * 24 * 3600 * 1000;
/** A persisted step-down is measured again after this long (drivers and WebKitGTK get updated). */
export const VERDICT_TTL_MS = 30 * 24 * 3600 * 1000;

export type GlassStatus =
  | "forced-on"
  | "forced-off"
  /** Auto, not Linux: glass on, no probing. */
  | "auto-on"
  /** Auto on Linux: glass on while frames are measured. */
  | "auto-probing"
  /** Auto on Linux: enough smooth overlay frames this session — glass stays on. */
  | "auto-passed"
  /** Auto on Linux: the probe stepped down (persisted). */
  | "auto-stepped-down"
  /** Auto on Linux: the probe exceeded the budget this session; off until the next launch, which measures again. */
  | "auto-session-off"
  /** Auto: the OS asks for reduced transparency. */
  | "auto-os"
  /** Auto: visual effects are reduced (setting or frame monitor). */
  | "auto-effects";

export interface GlassInputs {
  pref: GlassPref;
  verdict: GlassVerdict;
  linux: boolean;
  reducedTransparency: boolean;
  effectsReduced: boolean;
  /** Probe finished cleanly this session. */
  passed?: boolean;
  /** Probe exceeded the budget this session, but not yet in enough sessions to persist the verdict. */
  sessionFailed?: boolean;
}

export interface GlassDecision {
  glass: "on" | "off";
  status: GlassStatus;
  /** The probe should be measuring (it still only samples while glass overlays animate and glass actually renders). */
  probe: boolean;
}

export function decideGlass(i: GlassInputs): GlassDecision {
  if (i.pref === "on") return { glass: "on", status: "forced-on", probe: false };
  if (i.pref === "off") return { glass: "off", status: "forced-off", probe: false };
  if (i.reducedTransparency) return { glass: "off", status: "auto-os", probe: false };
  if (i.effectsReduced) return { glass: "off", status: "auto-effects", probe: false };
  if (!i.linux) return { glass: "on", status: "auto-on", probe: false };
  if (i.verdict === "failed") return { glass: "off", status: "auto-stepped-down", probe: false };
  if (i.sessionFailed) return { glass: "off", status: "auto-session-off", probe: false };
  if (i.passed) return { glass: "on", status: "auto-passed", probe: false };
  return { glass: "on", status: "auto-probing", probe: true };
}

/** Same test the boot script uses (`/Linux/` and not Android) so boot and runtime never disagree. */
export function isLinuxUserAgent(ua: string): boolean {
  return /Linux/.test(ua) && !/Android/.test(ua);
}

export const BOOT_KEY = "emp.boot";

export interface GlassBootFields {
  pref: GlassPref;
  verdict: GlassVerdict;
  /** Omitted → the existing `glassLog` is kept as it is. */
  log?: GlassProbeLog;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

function readLog(v: unknown): GlassProbeLog {
  if (!v || typeof v !== "object") return { ...EMPTY_LOG };
  const r = v as Record<string, unknown>;
  return {
    strikes: Math.floor(num(r.strikes)),
    lastFail: num(r.lastFail),
    passes: Math.floor(num(r.passes)),
    lastPass: num(r.lastPass),
    failedAt: num(r.failedAt),
    failedVersion: typeof r.failedVersion === "string" ? r.failedVersion.slice(0, 64) : "",
  };
}

const isEmptyLog = (l: GlassProbeLog) => (Object.keys(EMPTY_LOG) as (keyof GlassProbeLog)[]).every((k) => l[k] === EMPTY_LOG[k]);

/** Read `glass` / `glassProbe` / `glassLog` from the parsed emp.boot object (absent or invalid → auto, no verdict). */
export function readGlassFields(o: unknown): Required<GlassBootFields> {
  const r = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
  const pref: GlassPref = r.glass === "on" || r.glass === "off" ? r.glass : "auto";
  const verdict: GlassVerdict = r.glassProbe === "failed" ? "failed" : null;
  return { pref, verdict, log: readLog(r.glassLog) };
}

// ───────────────────────────────────────────────────────────────────────────── probe outcomes

export interface ProbeOutcome {
  verdict: GlassVerdict;
  log: GlassProbeLog;
  /** Step down for the rest of this session only (verdict not persisted yet). */
  sessionFailed: boolean;
}

/**
 * Fold one session's probe result into the machine's history. A failure steps down at once for the session; it
 * persists the verdict only on the FAIL_SESSIONS-th consecutive failing session. A pass clears the strikes.
 */
export function recordProbeResult(log: GlassProbeLog, result: "exceeded" | "passed", now: number, version: string): ProbeOutcome {
  if (result === "passed") return { verdict: null, sessionFailed: false, log: { ...log, strikes: 0, passes: log.passes + 1, lastPass: now } };
  const recent = log.strikes > 0 && now - log.lastFail <= STRIKE_TTL_MS && log.lastFail >= log.lastPass;
  const strikes = (recent ? log.strikes : 0) + 1;
  const next: GlassProbeLog = { ...log, strikes, lastFail: now };
  if (strikes < FAIL_SESSIONS) return { verdict: null, sessionFailed: true, log: next };
  return { verdict: "failed", sessionFailed: false, log: { ...next, failedAt: now, failedVersion: version } };
}

/**
 * Whether a persisted "failed" verdict should be dropped and measured again: it is older than VERDICT_TTL_MS, or the
 * app version differs from the one it was recorded on (both known). A verdict with no timestamp (written by hand or by
 * an older build) is not expired; the caller stamps it.
 */
export function verdictExpired(verdict: GlassVerdict, log: GlassProbeLog, now: number, version: string): boolean {
  if (verdict !== "failed") return false;
  if (log.failedAt > 0 && now - log.failedAt > VERDICT_TTL_MS) return true;
  return !!version && !!log.failedVersion && version !== log.failedVersion;
}

/**
 * Merge the glass fields into the raw emp.boot JSON, preserving every other key. Defaults are omitted so an
 * untouched install keeps the boot cache as it was. Returns null when nothing changes (no write needed).
 */
export function mergeGlassFields(raw: string | null, f: GlassBootFields): string | null {
  let o: Record<string, unknown> = {};
  try {
    const v: unknown = raw ? JSON.parse(raw) : {};
    if (v && typeof v === "object" && !Array.isArray(v)) o = v as Record<string, unknown>;
  } catch {
    o = {};
  }
  if (raw === null && f.pref === "auto" && !f.verdict && (!f.log || isEmptyLog(f.log))) return null;
  const next: Record<string, unknown> = { ...o };
  delete next.glass;
  delete next.glassProbe;
  if (f.pref !== "auto") next.glass = f.pref;
  if (f.verdict) next.glassProbe = f.verdict;
  if (f.log) {
    delete next.glassLog;
    if (!isEmptyLog(f.log)) next.glassLog = { ...f.log };
  }
  const out = JSON.stringify(next);
  return out === raw ? null : out;
}

/**
 * The kv record (`ui.appearance` / `transparency`) holds the user's choice only; the probe verdict is a property of
 * this machine, so it lives in the device-local boot cache.
 */
export function parseKvPref(v: unknown): GlassPref | null {
  const p = v && typeof v === "object" ? (v as Record<string, unknown>).pref : v;
  return p === "auto" || p === "on" || p === "off" ? p : null;
}
