/**
 * Keymap registry (§8.7, D-10). Bindings match by `KeyboardEvent.code` (layout-independent); labels come from the
 * current platform (⌘ on macOS, Ctrl elsewhere). App-level bindings run palette commands (app/commands.ts).
 *
 * Editors handle their own keys first: they should `preventDefault()` anything they consume (e.g. ⌘K with a text
 * selection opens the link popover). The global listener runs in the bubble phase and skips handled events.
 */
import { isMac, shortcutLabel } from '@/lib/platform';
import { useNav } from '@/stores/nav';
import { runCommand } from './commands';

export type ShortcutScope = 'app' | 'formatting' | 'blocks' | 'database' | 'sheets';

export interface ShortcutDef {
  id: string;
  /** e.g. 'mod+shift+l', 'mod+[', 'f6', 'shift+f6', '?' */
  keys: string | string[];
  description: string;
  scope: ShortcutScope;
  /** Palette command to run (app scope). Defaults to `id`. */
  command?: string;
  /** Also fire while typing in an input/editor (default false for unmodified keys, true for mod combos). */
  inEditable?: boolean;
}

/** §8.7 — the full map. Only `app` entries are bound globally; the rest document editor/database/sheet keys. */
export const SHORTCUTS: ShortcutDef[] = [
  // App
  { id: 'palette.open', keys: 'mod+k', description: 'Command palette', scope: 'app' },
  { id: 'palette.pages', keys: 'mod+p', description: 'Quick find', scope: 'app' },
  { id: 'palette.commands', keys: 'mod+shift+p', description: 'Run a command', scope: 'app' },
  { id: 'page.new', keys: 'mod+n', description: 'New page', scope: 'app' },
  { id: 'nav.back', keys: 'mod+[', description: 'Back', scope: 'app' },
  { id: 'nav.forward', keys: 'mod+]', description: 'Forward', scope: 'app' },
  { id: 'nav.parent', keys: 'mod+shift+u', description: 'Go to parent page', scope: 'app' },
  { id: 'sidebar.toggle', keys: 'mod+\\', description: 'Toggle sidebar', scope: 'app' },
  { id: 'hub.tab', keys: 'mod+1', description: 'Switch tab in a life app (⌘1–9)', scope: 'app' },
  { id: 'vault.lock', keys: 'mod+shift+l', description: 'Lock now', scope: 'app' },
  { id: 'privacy.toggle', keys: 'mod+shift+h', description: 'Hide numbers', scope: 'app' },
  { id: 'network.offline', keys: 'mod+shift+o', description: 'Offline mode', scope: 'app' },
  { id: 'theme.toggle', keys: 'mod+shift+d', description: 'Toggle theme', scope: 'app' },
  { id: 'daily.today', keys: 'mod+alt+d', description: 'Today’s note', scope: 'app' },
  { id: 'settings.open', keys: 'mod+,', description: 'Settings', scope: 'app' },
  { id: 'page.copyLink', keys: 'mod+l', description: 'Copy link to current page', scope: 'app' },
  { id: 'shortcuts.open', keys: ['mod+/', '?'], description: 'Keyboard shortcuts', scope: 'app' },
  { id: 'zoom.in', keys: ['mod+=', 'mod+shift+='], description: 'Zoom in', scope: 'app' },
  { id: 'zoom.out', keys: 'mod+-', description: 'Zoom out', scope: 'app' },
  { id: 'zoom.reset', keys: 'mod+0', description: 'Actual size', scope: 'app' },
  { id: 'region.next', keys: 'f6', description: 'Next region', scope: 'app', inEditable: true },
  { id: 'region.prev', keys: 'shift+f6', description: 'Previous region', scope: 'app', inEditable: true },
  { id: 'app.undo', keys: 'mod+z', description: 'Undo', scope: 'app' },
  { id: 'app.redo', keys: ['mod+shift+z', 'mod+y'], description: 'Redo', scope: 'app' },
  // Formatting (editor)
  { id: 'fmt.bold', keys: 'mod+b', description: 'Bold', scope: 'formatting' },
  { id: 'fmt.italic', keys: 'mod+i', description: 'Italic', scope: 'formatting' },
  { id: 'fmt.underline', keys: 'mod+u', description: 'Underline', scope: 'formatting' },
  { id: 'fmt.strike', keys: 'mod+shift+s', description: 'Strikethrough', scope: 'formatting' },
  { id: 'fmt.code', keys: 'mod+e', description: 'Inline code', scope: 'formatting' },
  { id: 'fmt.math', keys: 'mod+shift+e', description: 'Inline equation', scope: 'formatting' },
  { id: 'fmt.link', keys: 'mod+k', description: 'Link (with selection)', scope: 'formatting' },
  { id: 'fmt.lastColor', keys: 'mod+alt+h', description: 'Apply last colour', scope: 'formatting' },
  { id: 'fmt.pastePlain', keys: 'mod+shift+v', description: 'Paste plain text', scope: 'formatting' },
  { id: 'find.open', keys: 'mod+f', description: 'Find', scope: 'formatting' },
  { id: 'find.replace', keys: 'mod+alt+f', description: 'Find and replace', scope: 'formatting' },
  // Blocks (editor)
  { id: 'block.select', keys: 'esc', description: 'Select current block', scope: 'blocks' },
  { id: 'block.selectAll', keys: 'mod+a', description: 'Select block text, then all blocks', scope: 'blocks' },
  { id: 'block.extend', keys: ['shift+arrowup', 'shift+arrowdown'], description: 'Extend block selection', scope: 'blocks' },
  { id: 'block.duplicate', keys: 'mod+d', description: 'Duplicate', scope: 'blocks' },
  { id: 'block.moveUp', keys: 'mod+shift+arrowup', description: 'Move block up', scope: 'blocks' },
  { id: 'block.moveDown', keys: 'mod+shift+arrowdown', description: 'Move block down', scope: 'blocks' },
  { id: 'block.indent', keys: ['tab', 'shift+tab'], description: 'Indent / outdent', scope: 'blocks' },
  { id: 'block.toggle', keys: 'mod+enter', description: 'Toggle to-do or toggle; open link', scope: 'blocks' },
  { id: 'block.toggleAll', keys: 'mod+alt+t', description: 'Expand or collapse all toggles', scope: 'blocks' },
  { id: 'block.menu', keys: 'mod+/', description: 'Block menu (block selected)', scope: 'blocks' },
  { id: 'block.turnInto', keys: 'mod+alt+0', description: 'Turn into (⌘⌥0–9)', scope: 'blocks' },
  { id: 'editor.undo', keys: ['mod+z', 'mod+shift+z'], description: 'Undo / redo', scope: 'blocks' },
  // Database
  { id: 'db.navigate', keys: ['arrowup', 'arrowdown', 'enter', 'esc', 'tab'], description: 'Cell navigation', scope: 'database' },
  { id: 'db.peek', keys: 'space', description: 'Open peek (row selected)', scope: 'database' },
  { id: 'db.openRow', keys: 'mod+enter', description: 'Open row (title cell)', scope: 'database' },
  { id: 'db.deleteRows', keys: 'mod+shift+backspace', description: 'Delete selected rows', scope: 'database' },
  { id: 'db.newRow', keys: 'alt+shift+n', description: 'New row', scope: 'database' },
  // Sheets
  { id: 'sheet.edit', keys: 'f2', description: 'Edit cell', scope: 'sheets' },
  { id: 'sheet.fill', keys: 'mod+enter', description: 'Fill selection', scope: 'sheets' },
  { id: 'sheet.fillDown', keys: 'mod+d', description: 'Fill down', scope: 'sheets' },
  { id: 'sheet.fillRight', keys: 'mod+r', description: 'Fill right', scope: 'sheets' },
  { id: 'sheet.filter', keys: 'mod+shift+f', description: 'Toggle filters', scope: 'sheets' },
];

// ───────────────────────────────────────────────────────────────────────────── parsing & matching

export interface Combo {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  /** Physical Ctrl on macOS (⌃). On other platforms `mod` already is Ctrl. */
  ctrl: boolean;
  /** KeyboardEvent.code, or '?' which matches by `key`. */
  code: string;
}

const CODE_FOR: Record<string, string> = {
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  '=': 'Equal',
  '+': 'Equal',
  '-': 'Minus',
  ';': 'Semicolon',
  "'": 'Quote',
  '`': 'Backquote',
  enter: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  space: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
};

export function parseCombo(spec: string): Combo {
  // Split on '+' but keep a literal '+' / '=' key.
  const parts = spec.toLowerCase().split(/\+(?!$)/);
  const c: Combo = { mod: false, shift: false, alt: false, ctrl: false, code: '' };
  for (const raw of parts) {
    const p = raw.trim();
    if (p === 'mod' || p === 'cmd' || p === 'meta') c.mod = true;
    else if (p === 'shift') c.shift = true;
    else if (p === 'alt' || p === 'option' || p === 'opt') c.alt = true;
    else if (p === 'ctrl' || p === 'control') c.ctrl = true;
    else if (p === '?') c.code = '?';
    else if (/^[a-z]$/.test(p)) c.code = `Key${p.toUpperCase()}`;
    else if (/^[0-9]$/.test(p)) c.code = `Digit${p}`;
    else if (/^f([1-9]|1[0-2])$/.test(p)) c.code = p.toUpperCase();
    else c.code = CODE_FOR[p] ?? p;
  }
  return c;
}

export function matchesCombo(e: KeyboardEvent, c: Combo, mac = isMac): boolean {
  if (c.code === '?') return e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey;
  const mod = mac ? e.metaKey : e.ctrlKey;
  const ctrl = mac ? e.ctrlKey : false;
  if (mod !== c.mod || e.shiftKey !== c.shift || e.altKey !== c.alt || ctrl !== c.ctrl) return false;
  if (!mac && e.metaKey) return false;
  if (e.code === c.code) return true;
  // Numpad +/− for zoom.
  if (c.code === 'Equal' && e.code === 'NumpadAdd') return true;
  if (c.code === 'Minus' && e.code === 'NumpadSubtract') return true;
  if (c.code === 'Digit0' && e.code === 'Numpad0') return true;
  return false;
}

const keysOf = (d: ShortcutDef) => (Array.isArray(d.keys) ? d.keys : [d.keys]);

/** "⌘⇧L" on macOS, "Ctrl+Shift+L" elsewhere (first binding of the shortcut). */
export function shortcutFor(id: string): string | undefined {
  const def = SHORTCUTS.find((s) => s.id === id || s.command === id);
  return def ? shortcutLabel(keysOf(def)[0]) : undefined;
}

/** Raw spec ('mod+shift+l') for <Kbd> components. */
export function shortcutSpec(id: string): string | undefined {
  const def = SHORTCUTS.find((s) => s.id === id || s.command === id);
  return def ? keysOf(def)[0] : undefined;
}

export function shortcutsByScope(): Record<ShortcutScope, ShortcutDef[]> {
  const out: Record<ShortcutScope, ShortcutDef[]> = { app: [], formatting: [], blocks: [], database: [], sheets: [] };
  for (const s of SHORTCUTS) out[s.scope].push(s);
  return out;
}

// ───────────────────────────────────────────────────────────────────────────── global listener

export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (t as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
  }
  return false;
}

/** Elements that own their own undo history (editor, sheet grid) mark themselves with `data-undo-scope`. */
export function inOwnUndoScope(t: EventTarget | null): boolean {
  return t instanceof Element && !!t.closest('[data-undo-scope], [contenteditable="true"]');
}

interface Bound {
  def: ShortcutDef;
  combos: Combo[];
}

let bound: Bound[] | null = null;
const overrides = new Map<string, (e: KeyboardEvent) => boolean | void>();

/** Let a feature handle an app shortcut contextually (return true to consume). Returns the unregister function. */
export function overrideShortcut(id: string, fn: (e: KeyboardEvent) => boolean | void): () => void {
  overrides.set(id, fn);
  return () => {
    if (overrides.get(id) === fn) overrides.delete(id);
  };
}

/**
 * ⌘1–9 (PROGRAMME-v3 N-FL4): the nth tab of the open life app's tab strip. It presses the tab the way a pointer would
 * (mousedown for the kit `Tabs`, then click for route-driven strips), so the hub keeps owning what a tab does.
 */
export function switchHubTab(n: number): boolean {
  if (useNav.getState().route.t !== 'app' || typeof document === 'undefined') return false;
  const list = document.querySelector('.emp-route [role="tablist"]');
  if (!list) return false;
  const tabs = [...list.querySelectorAll<HTMLElement>('[role="tab"]')].filter((t) => !t.hasAttribute('disabled') && t.getAttribute('aria-disabled') !== 'true');
  const tab = tabs[n - 1];
  if (!tab) return false;
  if (tab.getAttribute('aria-selected') !== 'true') {
    tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    tab.click();
  }
  tab.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
  return true;
}

function hubTabDigit(e: KeyboardEvent): number {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (!mod || e.shiftKey || e.altKey || (isMac && e.ctrlKey) || (!isMac && e.metaKey)) return 0;
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
  return m ? Number(m[1]) : 0;
}

export function handleKeydown(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.isComposing) return false;
  const digit = hubTabDigit(e);
  if (digit) {
    if (switchHubTab(digit)) {
      e.preventDefault();
      e.stopPropagation();
      return true;
    }
    return false;
  }
  bound ??= SHORTCUTS.filter((s) => s.scope === 'app').map((def) => ({ def, combos: keysOf(def).map(parseCombo) }));
  const editable = isEditableTarget(e.target);
  for (const { def, combos } of bound) {
    if (!combos.some((c) => matchesCombo(e, c))) continue;
    const isModCombo = combos.some((c) => c.mod || c.alt);
    if (editable && !(def.inEditable ?? isModCombo)) continue;
    if ((def.id === 'app.undo' || def.id === 'app.redo') && (editable || inOwnUndoScope(e.target))) continue;
    const override = overrides.get(def.id);
    if (override && override(e) === true) {
      e.preventDefault();
      return true;
    }
    if (runCommand(def.command ?? def.id)) {
      e.preventDefault();
      e.stopPropagation();
      return true;
    }
  }
  return false;
}

let installed = false;
export function installShortcuts(): () => void {
  if (installed || typeof window === 'undefined') return () => undefined;
  installed = true;
  const onKey = (e: KeyboardEvent) => void handleKeydown(e);
  window.addEventListener('keydown', onKey);
  return () => {
    installed = false;
    window.removeEventListener('keydown', onKey);
  };
}
