/**
 * Shell UI state (§5.8, §5.9, §6.1): sidebar, command palette, side peek, right panel, sheets/dialogs the app opens
 * from anywhere, zoom, and pending backend prompts (open-external confirmation, dropped files).
 */
import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { api } from '@/backend';
import type { FileGrant, Id } from '@/backend/types';
import type { AppRoute } from '@/app/router';
import { markTried } from './checklist';

export type PaletteMode = 'all' | 'pages' | 'commands' | 'shortcuts';
export type RightPanelTab = 'outline' | 'info' | 'guide';

export const SIDEBAR_DEFAULT = 248;
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 420;
export const RIGHT_PANEL_DEFAULT = 320;
export const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5] as const;

export interface OpenExternalPrompt {
  requestId: Id;
  url: string;
  host: string;
  punycode: boolean;
}

interface ShellPrefs {
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  rightPanelOpen: boolean;
  rightPanelTab: RightPanelTab;
  rightPanelWidth: number;
  zoom: number;
}

interface UiState extends ShellPrefs {
  paletteOpen: boolean;
  paletteMode: PaletteMode;
  paletteQuery: string;
  /** Side peek target (rows, pages opened with ⇧↵). */
  peek: AppRoute | null;
  shortcutsOpen: boolean;
  templatesOpen: boolean;
  importOpen: boolean;
  /** Sidebar hover-peek while collapsed. */
  sidebarPeeking: boolean;
  /** Last network activity (pulses the indicator). */
  netPulse: { connector: string; host: string; at: number } | null;
  openExternal: OpenExternalPrompt[];
  droppedFiles: { grants: FileGrant[]; x: number; y: number; at: number } | null;

  openPalette(mode?: PaletteMode, query?: string): void;
  closePalette(): void;
  togglePalette(mode?: PaletteMode): void;
  setPaletteQuery(q: string): void;

  toggleSidebar(): void;
  setSidebarCollapsed(collapsed: boolean): void;
  setSidebarWidth(px: number): void;
  setSidebarPeeking(on: boolean): void;

  openPeek(route: AppRoute): void;
  closePeek(): void;

  toggleRightPanel(tab?: RightPanelTab): void;
  setRightPanelTab(tab: RightPanelTab): void;
  setRightPanelWidth(px: number): void;

  setShortcutsOpen(open: boolean): void;
  setTemplatesOpen(open: boolean): void;
  setImportOpen(open: boolean): void;

  zoomIn(): void;
  zoomOut(): void;
  zoomReset(): void;

  pulseNet(connector: string, host: string): void;
  pushOpenExternal(p: OpenExternalPrompt): void;
  answerOpenExternal(requestId: Id, allow: boolean, rememberHost: boolean): Promise<void>;
  setDroppedFiles(d: { grants: FileGrant[]; x: number; y: number } | null): void;

  loadPrefs(): Promise<void>;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function applyZoom(z: number) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (z === 1) root.style.removeProperty('zoom');
  else root.style.setProperty('zoom', String(z));
}

/**
 * The sidebar's open/hidden state and width are remembered per device (brief §2.1): this localStorage mirror is read
 * synchronously, so the very first frame (and the loading skeleton) already has the right layout. The vault kv copy
 * below is the fallback when this device has nothing stored yet (or storage is unavailable).
 */
const DEVICE_SIDEBAR_KEY = 'emp.shell.sidebar';

interface DeviceSidebar {
  collapsed: boolean;
  width: number;
}

function readDeviceSidebar(): DeviceSidebar | null {
  try {
    const raw = JSON.parse(localStorage.getItem(DEVICE_SIDEBAR_KEY) ?? 'null') as Partial<DeviceSidebar> | null;
    if (!raw || typeof raw !== 'object' || typeof raw.collapsed !== 'boolean') return null;
    const width = typeof raw.width === 'number' && Number.isFinite(raw.width) ? clamp(Math.round(raw.width), SIDEBAR_MIN, SIDEBAR_MAX) : SIDEBAR_DEFAULT;
    return { collapsed: raw.collapsed, width };
  } catch {
    return null;
  }
}

function writeDeviceSidebar(v: DeviceSidebar) {
  try {
    localStorage.setItem(DEVICE_SIDEBAR_KEY, JSON.stringify(v));
  } catch {
    /* storage unavailable: the vault kv copy still remembers it */
  }
}

/** The sidebar layout this device remembers (the shell skeleton reads it before the shell chunk loads). */
export function deviceSidebar(): DeviceSidebar {
  return readDeviceSidebar() ?? { collapsed: false, width: SIDEBAR_DEFAULT };
}

/**
 * Compact window (< 900px, brief §2.1): the sidebar can only be an overlay. One live source for the shell's render
 * and for the commands, so they can never disagree.
 *
 * The answer is read fresh on every render (a new MediaQueryList evaluates the current viewport) and re-read whenever
 * anything could have changed it. A launch shows the window only after the first render, and WebKitGTK runs no
 * rendering steps for a hidden window, so the breakpoint can be crossed before anything listens and without a
 * `change` event; `useSyncExternalStore` re-reads after it subscribes, and resize / visibility / focus re-read too.
 * (A stale value once left the docked sidebar hidden after a relaunch, with Show only floating a peek.)
 */
export const COMPACT_QUERY = '(max-width: 899px)';

export function isCompactWindow(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(COMPACT_QUERY).matches;
  } catch {
    return false;
  }
}

/** Calls `onChange` whenever the answer may have changed (exported for tests). */
export function subscribeCompact(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const mq = typeof window.matchMedia === 'function' ? window.matchMedia(COMPACT_QUERY) : null;
  mq?.addEventListener?.('change', onChange);
  window.addEventListener('resize', onChange);
  window.addEventListener('focus', onChange);
  document.addEventListener('visibilitychange', onChange);
  return () => {
    mq?.removeEventListener?.('change', onChange);
    window.removeEventListener('resize', onChange);
    window.removeEventListener('focus', onChange);
    document.removeEventListener('visibilitychange', onChange);
  };
}

/** Whether the window is compact, kept in step with the viewport (see `isCompactWindow`). */
export function useCompactWindow(): boolean {
  return useSyncExternalStore(subscribeCompact, isCompactWindow, () => false);
}

let prefsTimer: ReturnType<typeof setTimeout> | null = null;
function savePrefs(s: ShellPrefs) {
  writeDeviceSidebar({ collapsed: s.sidebarCollapsed, width: s.sidebarWidth });
  if (prefsTimer) clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => {
    prefsTimer = null;
    const { sidebarCollapsed, sidebarWidth, rightPanelOpen, rightPanelTab, rightPanelWidth, zoom } = s;
    api.kv
      .set({ ns: 'ui.shell', key: 'prefs', value: { sidebarCollapsed, sidebarWidth, rightPanelOpen, rightPanelTab, rightPanelWidth, zoom } })
      .catch(() => undefined);
  }, 300);
}

export const useUi = create<UiState>()((set, get) => {
  const setPrefs = (p: Partial<ShellPrefs>) => {
    set(p);
    savePrefs(get());
  };
  const stepZoom = (dir: 1 | -1) => {
    const cur = get().zoom;
    const i = ZOOM_STEPS.findIndex((z) => Math.abs(z - cur) < 0.001);
    const next = ZOOM_STEPS[clamp((i < 0 ? 2 : i) + dir, 0, ZOOM_STEPS.length - 1)];
    applyZoom(next);
    setPrefs({ zoom: next });
  };

  const device = readDeviceSidebar();
  return {
    sidebarCollapsed: device?.collapsed ?? false,
    sidebarWidth: device?.width ?? SIDEBAR_DEFAULT,
    rightPanelOpen: false,
    rightPanelTab: 'outline',
    rightPanelWidth: RIGHT_PANEL_DEFAULT,
    zoom: 1,
    paletteOpen: false,
    paletteMode: 'all',
    paletteQuery: '',
    peek: null,
    shortcutsOpen: false,
    templatesOpen: false,
    importOpen: false,
    sidebarPeeking: false,
    netPulse: null,
    openExternal: [],
    droppedFiles: null,

    openPalette(mode = 'all', query = '') {
      set({ paletteOpen: true, paletteMode: mode, paletteQuery: query });
      markTried('open_palette');
    },
    closePalette: () => set({ paletteOpen: false, paletteQuery: '' }),
    togglePalette(mode = 'all') {
      const s = get();
      if (s.paletteOpen && s.paletteMode === mode) s.closePalette();
      else s.openPalette(mode);
    },
    setPaletteQuery: (q) => set({ paletteQuery: q }),

    toggleSidebar: () => setPrefs({ sidebarCollapsed: !get().sidebarCollapsed }),
    setSidebarCollapsed: (sidebarCollapsed) => setPrefs({ sidebarCollapsed }),
    setSidebarWidth: (px) => setPrefs({ sidebarWidth: clamp(Math.round(px), SIDEBAR_MIN, SIDEBAR_MAX) }),
    setSidebarPeeking: (sidebarPeeking) => set({ sidebarPeeking }),

    openPeek: (peek) => set({ peek }),
    closePeek: () => set({ peek: null }),

    toggleRightPanel(tab) {
      const s = get();
      if (tab && (!s.rightPanelOpen || s.rightPanelTab !== tab)) setPrefs({ rightPanelOpen: true, rightPanelTab: tab });
      else setPrefs({ rightPanelOpen: !s.rightPanelOpen });
    },
    setRightPanelTab: (rightPanelTab) => setPrefs({ rightPanelTab, rightPanelOpen: true }),
    setRightPanelWidth: (px) => setPrefs({ rightPanelWidth: clamp(Math.round(px), 280, 480) }),

    setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
    setTemplatesOpen: (templatesOpen) => set({ templatesOpen }),
    setImportOpen: (importOpen) => set({ importOpen }),

    zoomIn: () => stepZoom(1),
    zoomOut: () => stepZoom(-1),
    zoomReset() {
      applyZoom(1);
      setPrefs({ zoom: 1 });
    },

    pulseNet: (connector, host) => set({ netPulse: { connector, host, at: Date.now() } }),
    pushOpenExternal: (p) => set((s) => ({ openExternal: [...s.openExternal.filter((x) => x.requestId !== p.requestId), p] })),
    async answerOpenExternal(requestId, allow, rememberHost) {
      set((s) => ({ openExternal: s.openExternal.filter((x) => x.requestId !== requestId) }));
      await api.open.externalConfirm({ requestId, allow, rememberHost });
    },
    setDroppedFiles: (d) => set({ droppedFiles: d ? { ...d, at: Date.now() } : null }),

    async loadPrefs() {
      try {
        const v = (await api.kv.get({ ns: 'ui.shell', key: 'prefs' })) as Partial<ShellPrefs> | null;
        if (!v || typeof v !== 'object') return;
        const next: Partial<ShellPrefs> = {};
        // This device's own sidebar layout wins over the vault's copy (per-device preference).
        const device = readDeviceSidebar();
        if (device) {
          next.sidebarCollapsed = device.collapsed;
          next.sidebarWidth = device.width;
        } else {
          if (typeof v.sidebarCollapsed === 'boolean') next.sidebarCollapsed = v.sidebarCollapsed;
          if (typeof v.sidebarWidth === 'number') next.sidebarWidth = clamp(v.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX);
        }
        if (typeof v.rightPanelOpen === 'boolean') next.rightPanelOpen = v.rightPanelOpen;
        if (v.rightPanelTab === 'outline' || v.rightPanelTab === 'info' || v.rightPanelTab === 'guide') next.rightPanelTab = v.rightPanelTab;
        if (typeof v.rightPanelWidth === 'number') next.rightPanelWidth = clamp(v.rightPanelWidth, 280, 480);
        if (typeof v.zoom === 'number' && v.zoom >= 0.8 && v.zoom <= 1.5) {
          next.zoom = v.zoom;
          applyZoom(v.zoom);
        }
        set(next);
      } catch {
        /* defaults */
      }
    },
  };
});
