/**
 * Settings (§11.3 Settings and kv, D-23). Device settings are the source of truth for appearance; every change is
 * mirrored into the boot cache (`localStorage['emp.boot']`, via lib/bootPrefs) and the `<html data-*>` attributes.
 * Vault settings arrive after unlock.
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
  applyAppearance({
    effects: d.effects,
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

  resetVault: () => set({ vault: null }),
}));

// ── selectors

export const selectResolvedTheme = (s: SettingsState): ResolvedTheme => resolveTheme(s.device?.theme ?? 'system');
/** For `<MotionConfig reducedMotion>` (§4.3). */
export const selectReducedMotionConfig = (s: SettingsState): 'user' | 'always' | 'never' =>
  motionConfigValue(s.device?.motion ?? 'system');
export const selectMotionResolved = (s: SettingsState): 'full' | 'reduced' => resolveMotion(s.device?.motion ?? 'system');
export const selectBaseCurrency = (s: SettingsState): string => s.vault?.baseCurrency ?? 'USD';
