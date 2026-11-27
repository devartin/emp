/**
 * Settings (§11.3 Settings and kv, D-23). Device settings are the source of truth for appearance; every change is
 * mirrored into the boot cache (`localStorage['emp.boot']`, via lib/bootPrefs) and the `<html data-*>` attributes.
 * Vault settings arrive after unlock.
 *
 * After the first unlock of a session the store asks Rust to detect the region (`settings_detect_region`, apply:
 * saved once per workspace while locale, time zone, week start and clock are still the built-in defaults, 1.0 brief
 * §2.5), and starts the daily update check when "Check automatically" is on.
 */
import { create } from 'zustand';
import { api } from '@/backend';
import type { AppInfo, DeviceSettings, ResolvedTheme, VaultSettings } from '@/backend/types';
import {
  applyAppearance,
  motionConfigValue,
  resolveMotion,
  resolveTheme,
  updateBootPrefs,
} from '@/lib/bootPrefs';
import { setDatePrefs } from '@/lib/dates';
import { setFormatLocale } from '@/lib/format';
import { cancelUpdateCheck, scheduleUpdateCheck } from '@/features/settings/updates';
import { notify } from './toasts';

interface SettingsState {
  device: DeviceSettings | null;
  vault: VaultSettings | null;
  appInfo: AppInfo | null;
  loaded: boolean;

  /** settings_get (+ app_info once). Device only while locked. */
  load(): Promise<void>;
  /** Optimistic: applies immediately, rolls back on error. */
  setDevice(patch: Partial<DeviceSettings>): Promise<void>;
  setVault(patch: Partial<VaultSettings>): Promise<void>;
  /** ⌘⇧D — light ↔ dark (midnight counts as dark). */
  toggleTheme(): Promise<void>;
  /** Forget vault-scoped settings (on lock). */
  resetVault(): void;
}

/** Apply every appearance-related device setting to the document. */
export function applyDeviceSettings(d: DeviceSettings): void {
  if (typeof document === 'undefined') return;
  updateBootPrefs({ theme: d.theme, accent: d.accent, motion: d.motion, density: d.density, textSize: d.textSize });
  // `d.effects` stays in the IPC shape for older workspaces but no longer drives anything (no glass in 1.0).
  applyAppearance({
    contrast: d.contrast,
    numberColors: d.numberColors,
    readableFont: d.readableFont,
    letterSpacing: d.letterSpacing,
  });
  document.documentElement.lang = d.language || 'en';
}

function applyVaultSettings(v: VaultSettings): void {
  setDatePrefs({ dateFormat: v.dateFormat, clock: v.clock, weekStart: v.weekStart });
  setFormatLocale(v.locale);
}

let regionAsked = false;

/** The webview reports the OS language and time zone; Rust prefers its own OS time zone and derives the rest. */
async function detectRegionOnce(): Promise<VaultSettings | null> {
  if (regionAsked) return null;
  regionAsked = true;
  try {
    const locale = typeof navigator !== 'undefined' ? (navigator.languages?.[0] ?? navigator.language) : undefined;
    let timeZone: string | undefined;
    try {
      timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      timeZone = undefined;
    }
    const r = await api.settings.detectRegion({ ...(locale ? { locale } : {}), ...(timeZone ? { timeZone } : {}), apply: true });
    if (!r.applied) return null;
    return (await api.settings.get()).vault ?? null;
  } catch {
    regionAsked = false;
    return null;
  }
}

export const useSettings = create<SettingsState>()((set, get) => ({
  device: null,
  vault: null,
  appInfo: null,
  loaded: false,

  async load() {
    const [bundle, info] = await Promise.all([
      api.settings.get(),
      get().appInfo ? Promise.resolve(get().appInfo as AppInfo) : api.app.info().catch(() => null),
    ]);
    applyDeviceSettings(bundle.device);
    if (bundle.vault) applyVaultSettings(bundle.vault);
    set({ device: bundle.device, vault: bundle.vault ?? null, appInfo: info, loaded: true });
    if (bundle.vault) {
      const detected = await detectRegionOnce();
      if (detected) {
        applyVaultSettings(detected);
        set({ vault: detected });
      }
      scheduleUpdateCheck(() => get().device?.updates === 'check');
    }
  },

  async setDevice(patch) {
    const prev = get().device;
    if (!prev) return;
    const optimistic = { ...prev, ...patch };
    set({ device: optimistic });
    applyDeviceSettings(optimistic);
    try {
      const saved = await api.settings.setDevice({ patch });
      set({ device: saved });
      applyDeviceSettings(saved);
      if (patch.updates === 'check' && get().vault) scheduleUpdateCheck(() => get().device?.updates === 'check');
      if (patch.updates === 'off') cancelUpdateCheck();
    } catch (e) {
      set({ device: prev });
      applyDeviceSettings(prev);
      notify.fromError(e, "Couldn't save that setting");
    }
  },

  async setVault(patch) {
    const prev = get().vault;
    if (!prev) return;
    const optimistic = { ...prev, ...patch } as VaultSettings;
    set({ vault: optimistic });
    applyVaultSettings(optimistic);
    try {
      const saved = await api.settings.setVault({ patch });
      set({ vault: saved });
      applyVaultSettings(saved);
    } catch (e) {
      set({ vault: prev });
      applyVaultSettings(prev);
      notify.fromError(e, "Couldn't save that setting");
    }
  },

  async toggleTheme() {
    const d = get().device;
    if (!d) return;
    const current = resolveTheme(d.theme);
    await get().setDevice({ theme: current === 'light' ? 'dark' : 'light' });
  },

  resetVault: () => {
    cancelUpdateCheck();
    set({ vault: null });
  },
}));

// ── selectors

export const selectResolvedTheme = (s: SettingsState): ResolvedTheme => resolveTheme(s.device?.theme ?? 'system');
/** For `<MotionConfig reducedMotion>` (§4.3). */
export const selectReducedMotionConfig = (s: SettingsState): 'user' | 'always' | 'never' =>
  motionConfigValue(s.device?.motion ?? 'system');
export const selectMotionResolved = (s: SettingsState): 'full' | 'reduced' => resolveMotion(s.device?.motion ?? 'system');
export const selectBaseCurrency = (s: SettingsState): string => s.vault?.baseCurrency ?? 'USD';
