/**
 * Kbd chips that answer your hands (docs/DESIGN.md §5.2, R-4 "keys that answer your hands"). A rendered
 * `[data-chord="mod+k"]` (a <Kbd> group, or a single <Kbd>) goes down for 120ms ONLY when:
 *   1. the event's full chord matches exactly (modifiers + key — pressing K alone never moves a "⌘K" hint),
 *   2. focus is not in a text field (input, textarea, select, contenteditable): ordinary typing never moves a chip,
 *   3. the shortcut actually fired: some handler called preventDefault() during dispatch.
 * One module-level keydown listener (ref-counted, installed by MotionProvider and by <Kbd>). Clears on window blur.
 */
import { isMac } from "@/lib/platform";

let refs = 0;
const timers = new Map<Element, number>();
const PRESS_MS = 120;

/** Normalise a KeyboardEvent.key (or a shortcut-spec token) to the data-key vocabulary. */
export function normalizeKey(raw: string, fromEvent = false): string {
  const k = raw.trim().toLowerCase();
  switch (k) {
    case "meta":
    case "os":
    case "cmd":
    case "command":
    case "⌘":
      return fromEvent ? (isMac ? "mod" : "meta") : "mod";
    case "control":
    case "ctrl":
    case "⌃":
      return fromEvent ? (isMac ? "ctrl" : "mod") : "ctrl";
    case "mod":
      return "mod";
    case "alt":
    case "option":
    case "opt":
    case "altgraph":
    case "⌥":
      return "alt";
    case "shift":
    case "⇧":
      return "shift";
    case "enter":
    case "return":
    case "↵":
      return "enter";
    case "escape":
    case "esc":
      return "esc";
    case " ":
    case "spacebar":
    case "space":
      return "space";
    case "arrowup":
    case "↑":
      return "arrowup";
    case "arrowdown":
    case "↓":
      return "arrowdown";
    case "arrowleft":
    case "←":
      return "arrowleft";
    case "arrowright":
    case "→":
      return "arrowright";
    case "backspace":
    case "⌫":
      return "backspace";
    case "tab":
    case "⇥":
      return "tab";
    default:
      return k;
  }
}

/** Split a shortcut spec ("mod+shift+l", "⌘K", "esc") into normalised data-key tokens (same order as shortcutKeys). */
export function specKeys(spec: string): string[] {
  if (!spec) return [];
  const tokens = spec.includes("+") ? spec.split("+") : /^[A-Za-z0-9]+$/.test(spec) && spec.length > 1 ? [spec] : Array.from(spec);
  return tokens.filter(Boolean).map((t) => normalizeKey(t));
}

const MOD_ORDER = ["mod", "ctrl", "meta", "alt", "shift"];
const MODIFIERS = new Set(MOD_ORDER);

/** Canonical chord string for a list of normalised tokens: modifiers in a fixed order, then the key. */
export function chordOf(tokens: string[]): string {
  const mods = MOD_ORDER.filter((m) => tokens.includes(m));
  const rest = tokens.filter((t) => !MODIFIERS.has(t));
  return [...mods, ...rest].join("+");
}

/** The canonical chord of a shortcut spec ("mod+shift+l", "⌘K", "esc"). */
export function specChord(spec: string): string {
  return chordOf(specKeys(spec));
}

/** The canonical chord of a keyboard event, or null for a bare modifier press. */
export function eventChord(e: KeyboardEvent): string | null {
  let key = normalizeKey(e.key, true);
  // Letters and digits by physical key, so ⌥K on macOS (which types "˚") still reads as alt+k.
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  else if (/^Digit\d$/.test(e.code) && !e.shiftKey) key = e.code.slice(5);
  if (MODIFIERS.has(key)) return null;
  const mods: string[] = [];
  if (isMac) {
    if (e.metaKey) mods.push("mod");
    if (e.ctrlKey) mods.push("ctrl");
  } else {
    if (e.ctrlKey) mods.push("mod");
    if (e.metaKey) mods.push("meta");
  }
  if (e.altKey) mods.push("alt");
  // Shift is part of the chord for letters and named keys; for symbols ("?", "+") it is how the symbol is typed.
  const symbol = key.length === 1 && !/[a-z0-9]/.test(key);
  if (e.shiftKey && !symbol) mods.push("shift");
  return chordOf([...mods, key]);
}

function isEditable(t: EventTarget | null): boolean {
  if (!(t instanceof Element)) return false;
  if (t instanceof HTMLInputElement) {
    const type = t.type;
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(type);
  }
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  return t instanceof HTMLElement && (t.isContentEditable || !!t.closest("[contenteditable=''],[contenteditable='true']"));
}

function press(el: Element) {
  const caps = el.matches(".emp-kbd") ? [el] : Array.from(el.querySelectorAll(".emp-kbd"));
  caps.forEach((c) => c.setAttribute("data-down", ""));
  window.clearTimeout(timers.get(el));
  timers.set(
    el,
    window.setTimeout(() => {
      caps.forEach((c) => c.removeAttribute("data-down"));
      timers.delete(el);
    }, PRESS_MS),
  );
}

function onDown(e: KeyboardEvent) {
  if (e.repeat || e.isComposing) return;
  if (isEditable(e.target) || isEditable(document.activeElement)) return;
  const chord = eventChord(e);
  if (!chord) return;
  // Judge after dispatch: only a shortcut some handler actually took (preventDefault) presses its chip.
  window.setTimeout(() => {
    if (!e.defaultPrevented) return;
    document.querySelectorAll(`[data-chord="${CSS.escape(chord)}"]`).forEach(press);
  }, 0);
}

function clearAll() {
  timers.forEach((t) => window.clearTimeout(t));
  timers.clear();
  document.querySelectorAll<HTMLElement>(".emp-kbd[data-down]").forEach((el) => el.removeAttribute("data-down"));
}

export function installKeycaps(): () => void {
  if (typeof window === "undefined") return () => undefined;
  if (refs++ === 0) {
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("blur", clearAll);
  }
  return () => {
    if (--refs > 0) return;
    window.removeEventListener("keydown", onDown, true);
    window.removeEventListener("blur", clearAll);
    clearAll();
  };
}
