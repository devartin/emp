/** Device + vault settings storage for the mock (defaults per §11.3; device defaults follow the boot cache). */
import { DEFAULT_BOOT, readBootPrefs } from '@/lib/bootPrefs';
import type { DeviceSettings, VaultSettings } from '../../types';
import type { MockCtx } from '../ctx';

export function defaultDeviceSettings(): DeviceSettings {
  // Seed theme/accent/motion/density/textSize from the boot cache so a reload never flips the appearance.
  let boot = DEFAULT_BOOT;
  try {
    if (typeof window !== 'undefined') boot = readBootPrefs();
  } catch {
    boot = DEFAULT_BOOT;
  }
  return {
    theme: boot.theme,
    accent: boot.accent,
    density: boot.density,
    textSize: boot.textSize,
    motion: boot.motion,
    effects: 'auto',
    contrast: 'system',
    numberColors: 'standard',
    readableFont: false,
    letterSpacing: false,
    updates: 'off',
    language: 'en',
  };
}

export function defaultVaultSettings(): VaultSettings {
  let timezone = 'UTC';
  let locale = 'en-US';
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
  } catch {
    /* defaults */
  }
  return {
    profileName: '',
    baseCurrency: 'USD',
    locale,
    timezone,
    weekStart: 1,
    dateFormat: 'full',
    clock: 12,
    spellcheck: true,
    typography: true,
    markdownShortcuts: true,
    stripImageLocation: true,
    remoteImages: 'ask',
    trashRetentionDays: 30,
    hideNumbersOnLaunch: false,
    blurWhenInactive: false,
    clipboardClearSeconds: 30,
    celebrations: true,
    startPage: 'home',
    snapshots: { enabled: true, keepDaily: 7, keepWeekly: 4, keepMonthly: 6 },
    marketProviders: { order: ['finnhub', 'tiingo', 'stooq', 'coingecko', 'frankfurter'], refreshSeconds: 60 },
    offline: false,
  };
}

export function deviceSettings(ctx: MockCtx): DeviceSettings {
  const cur = ctx.db.meta<DeviceSettings>('settings.device');
  if (cur) return cur;
  const d = defaultDeviceSettings();
  ctx.db.setMeta('settings.device', d);
  return d;
}

export function vaultSettings(ctx: MockCtx): VaultSettings {
  const cur = ctx.db.meta<VaultSettings>('settings.vault');
  if (cur) return cur;
  const d = defaultVaultSettings();
  ctx.db.setMeta('settings.vault', d);
  return d;
}

export function patchDeviceSettings(ctx: MockCtx, patch: Partial<DeviceSettings>): DeviceSettings {
  const next = { ...deviceSettings(ctx), ...patch };
  ctx.db.setMeta('settings.device', next);
  return next;
}

export function patchVaultSettings(ctx: MockCtx, patch: Partial<VaultSettings>): VaultSettings {
  const cur = vaultSettings(ctx);
  const next: VaultSettings = {
    ...cur,
    ...patch,
    snapshots: { ...cur.snapshots, ...(patch.snapshots ?? {}) },
    marketProviders: { ...cur.marketProviders, ...(patch.marketProviders ?? {}) },
  };
  ctx.db.setMeta('settings.vault', next);
  return next;
}
