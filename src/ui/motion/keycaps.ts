/**
 * Living keycaps (docs/DESIGN.md §4.3, S1): every rendered `.emp-kbd[data-key="…"]` physically depresses while the real
 * key is held. One module-level keydown/keyup listener (ref-counted, installed by MotionProvider and by <Kbd>);
 * keys are normalised so `mod` matches ⌘ on macOS and Ctrl elsewhere. Everything clears on window blur.
 */
import { isMac } from "@/lib/platform";

let refs = 0;
const down = new Set<string>();

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

function sync(key: string, on: boolean) {
  const sel = `.emp-kbd[data-key="${CSS.escape(key)}"]`;
  document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
    if (on) el.setAttribute("data-down", "");
    else el.removeAttribute("data-down");
  });
}

function onDown(e: KeyboardEvent) {
  const k = normalizeKey(e.key, true);
  if (down.has(k)) return;
  down.add(k);
  sync(k, true);
}
function onUp(e: KeyboardEvent) {
  const k = normalizeKey(e.key, true);
  down.delete(k);
  sync(k, false);
  // A held modifier swallows keyup of the letter on macOS: release everything when the modifier goes up.
  if (k === "mod" || k === "meta") clearAll();
}
function clearAll() {
  down.clear();
  document.querySelectorAll<HTMLElement>(".emp-kbd[data-down]").forEach((el) => el.removeAttribute("data-down"));
}

export function installKeycaps(): () => void {
  if (typeof window === "undefined") return () => undefined;
  if (refs++ === 0) {
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    window.addEventListener("blur", clearAll);
  }
  return () => {
    if (--refs > 0) return;
    window.removeEventListener("keydown", onDown, true);
    window.removeEventListener("keyup", onUp, true);
    window.removeEventListener("blur", clearAll);
    clearAll();
  };
}
