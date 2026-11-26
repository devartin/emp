/**
 * Platform detection (sync, cheap, safe in browser mode).
 * The Tauri side reports the authoritative value via `app_info`; this is the boot-time guess used for
 * shortcut labels, glass defaults and window chrome.
 */
export type PlatformName = "macos" | "windows" | "linux";

function detect(): PlatformName {
  if (typeof navigator === "undefined") return "macos";
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const p = (nav.userAgentData?.platform || nav.platform || nav.userAgent || "").toLowerCase();
  if (p.includes("mac") || p.includes("iphone") || p.includes("ipad")) return "macos";
  if (p.includes("win")) return "windows";
  return "linux";
}

export const platform: PlatformName = detect();
export const isMac = platform === "macos";
export const isWindows = platform === "windows";
export const isLinux = platform === "linux";
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Modifier glyphs/labels per §5.11 (macOS ⌘⌥⇧⌃, others spelled out). */
export const modLabels = isMac
  ? { mod: "⌘", alt: "⌥", shift: "⇧", ctrl: "⌃", enter: "↵", backspace: "⌫", esc: "esc", tab: "⇥" }
  : { mod: "Ctrl", alt: "Alt", shift: "Shift", ctrl: "Ctrl", enter: "Enter", backspace: "Backspace", esc: "Esc", tab: "Tab" };

const KEY_GLYPHS: Record<string, string> = {
  arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→", space: "Space", delete: "Del",
  pageup: "PgUp", pagedown: "PgDn", home: "Home", end: "End",
};

/**
 * Split a shortcut spec like "mod+shift+l" or "⌘⇧L" into display keys for <Kbd>.
 * Accepts tokens: mod, cmd, meta, ctrl, alt, option, shift, enter, esc, tab, backspace and any key.
 */
export function shortcutKeys(spec: string): string[] {
  if (!spec) return [];
  const tokens = spec.includes("+") ? spec.split("+") : splitGlyphs(spec);
  return tokens.filter(Boolean).map((raw) => {
    const t = raw.trim().toLowerCase();
    switch (t) {
      case "mod": case "cmd": case "meta": case "⌘": return modLabels.mod;
      case "ctrl": case "control": case "⌃": return modLabels.ctrl;
      case "alt": case "option": case "opt": case "⌥": return modLabels.alt;
      case "shift": case "⇧": return modLabels.shift;
      case "enter": case "return": case "↵": return modLabels.enter;
      case "esc": case "escape": return modLabels.esc;
      case "tab": return modLabels.tab;
      case "backspace": return modLabels.backspace;
      default:
        if (KEY_GLYPHS[t]) return KEY_GLYPHS[t];
        return raw.length === 1 ? raw.toUpperCase() : raw.charAt(0).toUpperCase() + raw.slice(1);
    }
  });
}

function splitGlyphs(spec: string): string[] {
  // "⌘⇧L" → ["⌘","⇧","L"]; a plain word ("Esc") stays whole.
  if (/^[A-Za-z0-9]+$/.test(spec) && spec.length > 1) return [spec];
  return Array.from(spec);
}

/** Human string for aria-keyshortcuts / tooltips ("⌘⇧L" on mac, "Ctrl+Shift+L" elsewhere). */
export function shortcutLabel(spec: string): string {
  const keys = shortcutKeys(spec);
  return isMac ? keys.join("") : keys.join("+");
}
