/**
 * Privacy (§13.1, §9.23): hide-numbers mirrored to `html[data-privacy]`, blur-when-inactive mirrored to
 * `html[data-inactive-blur]` (the stylesheet applies the 12px/160ms blur), and sensitive clipboard writes that clear
 * themselves after `clipboardClearSeconds` if the clipboard still holds them (compared by SHA-256).
 */
import { create } from 'zustand';
import { markTried } from './checklist';
import { useSettings } from './settings';
import { notify } from './toasts';

interface PrivacyState {
  /** Hide numbers (⌘⇧H). */
  hidden: boolean;
  /** The current view is tagged `sensitivity: high` (finance, portfolio, tax): blur on blur defaults on. */
  sensitiveView: boolean;
  windowFocused: boolean;
  setHidden(on: boolean): void;
  toggleHidden(): void;
  setSensitiveView(on: boolean): void;
  /** Copy a secret, recovery words or a passphrase; clears after the configured delay. */
  copySensitive(text: string): Promise<void>;
  clearClipboard(): Promise<void>;
}

function setAttr(name: string, value: string) {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

let lastCopyHash: string | null = null;
let clearTimer: ReturnType<typeof setTimeout> | null = null;

function syncBlur(s: Pick<PrivacyState, 'sensitiveView' | 'windowFocused'>) {
  const setting = useSettings.getState().vault?.blurWhenInactive ?? false;
  setAttr('data-inactive-blur', !s.windowFocused && (setting || s.sensitiveView) ? 'on' : 'off');
}

export const usePrivacy = create<PrivacyState>()((set, get) => ({
  hidden: false,
  sensitiveView: false,
  windowFocused: true,

  setHidden(on) {
    setAttr('data-privacy', on ? 'on' : 'off');
    set({ hidden: on });
  },
  toggleHidden() {
    get().setHidden(!get().hidden);
    markTried('hide_numbers');
  },
  setSensitiveView(on) {
    set({ sensitiveView: on });
    syncBlur(get());
  },

  async copySensitive(text) {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      notify.error("Couldn't copy", { description: 'Clipboard access is not available here.' });
      return;
    }
    await navigator.clipboard.writeText(text);
    lastCopyHash = await sha256(text);
    const seconds = useSettings.getState().vault?.clipboardClearSeconds ?? 30;
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = setTimeout(() => void get().clearClipboard(), seconds * 1000);
    notify.clipboard(seconds, () => void get().clearClipboard());
  },

  async clearClipboard() {
    if (clearTimer) {
      clearTimeout(clearTimer);
      clearTimer = null;
    }
    if (!lastCopyHash || typeof navigator === 'undefined' || !navigator.clipboard) return;
    const expected = lastCopyHash;
    lastCopyHash = null;
    try {
      const current = await navigator.clipboard.readText();
      if ((await sha256(current)) !== expected) return; // the user copied something else since
    } catch {
      // Reading is not permitted (desktop denies clipboard-read): clear conservatively.
    }
    try {
      await navigator.clipboard.writeText('');
    } catch {
      /* clipboard unavailable */
    }
  },
}));

let installed = false;
/** Window focus tracking for blur-when-inactive. Call once at shell start. */
export function installPrivacyWatchers(): () => void {
  if (installed || typeof window === 'undefined') return () => undefined;
  installed = true;
  setAttr('data-privacy', usePrivacy.getState().hidden ? 'on' : 'off');
  const onBlur = () => {
    usePrivacy.setState({ windowFocused: false });
    syncBlur(usePrivacy.getState());
  };
  const onFocus = () => {
    usePrivacy.setState({ windowFocused: true });
    syncBlur(usePrivacy.getState());
  };
  window.addEventListener('blur', onBlur);
  window.addEventListener('focus', onFocus);
  return () => {
    installed = false;
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('focus', onFocus);
  };
}
