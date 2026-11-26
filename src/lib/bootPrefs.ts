/**
 * Boot preference cache (D-23). The ONLY module allowed to touch Web Storage (§9.11):
 * `localStorage['emp.boot']` holds `{theme, accent, motion, density, textSize}` and nothing else.
 * Device settings (Rust) are the source of truth; callers mirror them here after `settings_get`/`settings_set_device`.
 *
 * The inline snippet in index.html performs the same resolution before first paint; keep the two in sync.
 */
import { isLinux } from "./platform";

export type ThemePref = "system" | "light" | "dark" | "midnight";
export type ResolvedTheme = "light" | "dark" | "midnight";
export type AccentName = "graphite" | "iris" | "ocean" | "jade" | "amber" | "ruby" | "orchid";
export type MotionPref = "system" | "reduced" | "full";
export type Density = "comfortable" | "compact";
export type TextSize = "s" | "m" | "l";
export type EffectsPref = "auto" | "full" | "reduced";
export type ContrastPref = "system" | "more";
export type NumberColors = "standard" | "cvd" | "eastasian" | "mono";

export interface BootPrefs {
  theme: ThemePref;
  accent: AccentName;
  motion: MotionPref;
  density: Density;
  textSize: TextSize;
}

export const ACCENTS: readonly AccentName[] = ["graphite", "iris", "ocean", "jade", "amber", "ruby", "orchid"] as const;
export const DEFAULT_BOOT: BootPrefs = { theme: "system", accent: "graphite", motion: "system", density: "comfortable", textSize: "m" };

const KEY = "emp.boot";
const THEMES: readonly ThemePref[] = ["system", "light", "dark", "midnight"];
const MOTIONS: readonly MotionPref[] = ["system", "reduced", "full"];
const DENSITIES: readonly Density[] = ["comfortable", "compact"];
const SIZES: readonly TextSize[] = ["s", "m", "l"];

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

export function readBootPrefs(): BootPrefs {
  let raw: unknown = null;
  try {
    const s = window.localStorage.getItem(KEY);
    raw = s ? JSON.parse(s) : null;
  } catch {
    raw = null;
  }
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    theme: pick(o.theme, THEMES, DEFAULT_BOOT.theme),
    accent: pick(o.accent, ACCENTS, DEFAULT_BOOT.accent),
    motion: pick(o.motion, MOTIONS, DEFAULT_BOOT.motion),
    density: pick(o.density, DENSITIES, DEFAULT_BOOT.density),
    textSize: pick(o.textSize, SIZES, DEFAULT_BOOT.textSize),
  };
}

export function writeBootPrefs(patch: Partial<BootPrefs>): BootPrefs {
  const next = { ...readBootPrefs(), ...patch };
  try {
    // Whitelist the five keys explicitly — never persist anything else here.
    const { theme, accent, motion, density, textSize } = next;
    window.localStorage.setItem(KEY, JSON.stringify({ theme, accent, motion, density, textSize }));
  } catch {
    /* storage unavailable (private mode) — attributes still apply for this session */
  }
  return next;
}

const mq = (q: string): boolean => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(q).matches;

export function resolveTheme(pref: ThemePref): ResolvedTheme {
  if (pref === "system") return mq("(prefers-color-scheme: dark)") ? "dark" : "light";
  return pref;
}

export function resolveMotion(pref: MotionPref): "full" | "reduced" {
  if (pref === "system") return mq("(prefers-reduced-motion: reduce)") ? "reduced" : "full";
  return pref;
}

export function resolveEffects(pref: EffectsPref): "full" | "reduced" {
  if (pref === "auto") {
    return isLinux || mq("(prefers-reduced-transparency: reduce)") ? "reduced" : "full";
  }
  return pref;
}

export function resolveContrast(pref: ContrastPref): "normal" | "more" {
  if (pref === "system") return mq("(prefers-contrast: more)") ? "more" : "normal";
  return pref;
}

/** Map a motion preference to motion's MotionConfig `reducedMotion` (§4.3). */
export function motionConfigValue(pref: MotionPref): "user" | "always" | "never" {
  return pref === "system" ? "user" : pref === "reduced" ? "always" : "never";
}

let current: BootPrefs = DEFAULT_BOOT;
let effectsPref: EffectsPref = "auto";
let contrastPref: ContrastPref = "system";

function setAttr(name: string, value: string) {
  const el = document.documentElement;
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

/** Apply boot prefs to <html> data-* attributes (§3). Idempotent. */
let applied = false;
export function applyBootPrefs(p: BootPrefs): void {
  const root = document.documentElement;
  if (applied && root.getAttribute("data-accent") !== p.accent) {
    // 240ms colour transition on accent change (§3.2)
    root.style.setProperty("--emp-switch-ms", "240ms");
    root.classList.add("emp-accent-switching");
    window.setTimeout(() => root.classList.remove("emp-accent-switching"), 280);
  }
  applied = true;
  current = p;
  setAttr("data-theme", resolveTheme(p.theme));
  setAttr("data-accent", p.accent);
  setAttr("data-motion", resolveMotion(p.motion));
  setAttr("data-density", p.density);
  setAttr("data-text-size", p.textSize);
  document.documentElement.style.colorScheme = resolveTheme(p.theme) === "light" ? "light" : "dark";
}

/** Device-setting attributes that are not part of the boot cache. */
export function applyAppearance(opts: {
  effects?: EffectsPref;
  contrast?: ContrastPref;
  numberColors?: NumberColors;
  readableFont?: boolean;
  letterSpacing?: boolean;
}): void {
  if (opts.effects) effectsPref = opts.effects;
  if (opts.contrast) contrastPref = opts.contrast;
  setAttr("data-effects", resolveEffects(effectsPref));
  setAttr("data-contrast", resolveContrast(contrastPref));
  if (opts.numberColors) setAttr("data-numbers", opts.numberColors);
  if (opts.readableFont !== undefined) setAttr("data-readable", opts.readableFont ? "on" : "off");
  if (opts.letterSpacing !== undefined) setAttr("data-letter-spacing", opts.letterSpacing ? "wide" : "normal");
}

/** Force effects to reduced at runtime (frame-drop monitor, §4.4) while the preference is `auto`. */
export function degradeEffects(): void {
  if (effectsPref === "auto") setAttr("data-effects", "reduced");
}

export function getBootPrefs(): BootPrefs {
  return current;
}

/** Persist + apply in one step (what settings UIs should call after a successful `settings_set_device`). */
export function updateBootPrefs(patch: Partial<BootPrefs>): BootPrefs {
  const next = writeBootPrefs(patch);
  applyBootPrefs(next);
  return next;
}

let watching = false;
/** Keep `system` values live when the OS appearance changes. Call once at startup. */
export function watchSystemPrefs(): () => void {
  if (watching || typeof window === "undefined" || !window.matchMedia) return () => {};
  watching = true;
  const queries = [
    "(prefers-color-scheme: dark)",
    "(prefers-reduced-motion: reduce)",
    "(prefers-contrast: more)",
    "(prefers-reduced-transparency: reduce)",
  ].map((q) => window.matchMedia(q));
  const onChange = () => {
    applyBootPrefs(current);
    applyAppearance({});
  };
  queries.forEach((m) => m.addEventListener("change", onChange));
  return () => {
    watching = false;
    queries.forEach((m) => m.removeEventListener("change", onChange));
  };
}

/** Read prefs, apply everything and start watching. Safe to call more than once. */
export function initAppearance(): BootPrefs {
  const p = readBootPrefs();
  applyBootPrefs(p);
  applyAppearance({});
  watchSystemPrefs();
  return p;
}
