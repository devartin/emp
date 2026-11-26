/**
 * No lost keystrokes after ⌘K (PROGRAMME-v3 K4, N-FL4): from the moment the palette is asked for until its input has
 * mounted, printable keys (and Backspace) are held here; the palette replays them into its input on mount.
 */
let buffer = "";
let active = false;
let timer: number | undefined;

function onKey(e: KeyboardEvent) {
  if (!active || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key.length === 1) buffer += e.key;
  else if (e.key === "Backspace") buffer = buffer.slice(0, -1);
  else return;
  e.preventDefault();
  e.stopPropagation();
}

function stop() {
  active = false;
  window.clearTimeout(timer);
  window.removeEventListener("keydown", onKey, true);
}

/** Start holding keys (call right before opening the palette). Stops by itself after 3 s. */
export function holdKeys(): void {
  if (typeof window === "undefined") return;
  buffer = "";
  if (!active) {
    active = true;
    window.addEventListener("keydown", onKey, true);
  }
  window.clearTimeout(timer);
  timer = window.setTimeout(stop, 3000);
}

/** The keys typed since `holdKeys`, and stop holding. */
export function takeHeldKeys(): string {
  const b = buffer;
  buffer = "";
  stop();
  return b;
}
