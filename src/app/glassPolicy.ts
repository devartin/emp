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
 *                 glass probe measures frames during overlay animations; when the dropped-frame budget is exceeded the
 *                 verdict "failed" is persisted and Auto resolves to off from then on (including at boot, flash-free).
 *                 Choosing Auto again from On/Off (or "Test again") clears the verdict and re-probes.
 */

export type GlassPref = "auto" | "on" | "off";
/** Persisted probe outcome. Only "failed" is ever stored; a pass is per session. */
export type GlassVerdict = "failed" | null;

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
  /** Probe finished cleanly this session (not persisted). */
  passed?: boolean;
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
}

/** Read `glass` / `glassProbe` from the parsed emp.boot object (absent or invalid → auto, no verdict). */
export function readGlassFields(o: unknown): GlassBootFields {
  const r = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
  const pref: GlassPref = r.glass === "on" || r.glass === "off" ? r.glass : "auto";
  const verdict: GlassVerdict = r.glassProbe === "failed" ? "failed" : null;
  return { pref, verdict };
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
  if (raw === null && f.pref === "auto" && !f.verdict) return null;
  const next: Record<string, unknown> = { ...o };
  delete next.glass;
  delete next.glassProbe;
  if (f.pref !== "auto") next.glass = f.pref;
  if (f.verdict) next.glassProbe = f.verdict;
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
