/**
 * settings_get / settings_set_device / settings_set_vault / settings_detect_region. Device scope is readable before
 * unlock. Validation follows Rust (`VaultSettings::validate`).
 */
import { BackendError } from '../../errors';
import type { DeviceSettings, VaultSettings } from '../../types';
import type { MockHandlers } from '../ctx';
import { detectRegion, regionUntouched, validLocale, validTimezone } from '../lib/region';
import { deviceSettings, patchDeviceSettings, patchVaultSettings, vaultSettings } from '../lib/settings';

const DEVICE_ENUMS: { [K in keyof DeviceSettings]?: readonly unknown[] } = {
  theme: ['system', 'light', 'dark', 'midnight'],
  accent: ['iris', 'ocean', 'jade', 'amber', 'ruby', 'orchid', 'graphite'],
  density: ['comfortable', 'compact'],
  textSize: ['s', 'm', 'l'],
  motion: ['system', 'reduced', 'full'],
  effects: ['auto', 'full', 'reduced'],
  contrast: ['system', 'more'],
  numberColors: ['standard', 'cvd', 'eastasian', 'mono'],
  updates: ['off', 'check'],
};

function validateDevice(patch: Partial<DeviceSettings>) {
  for (const [k, v] of Object.entries(patch)) {
    const allowed = DEVICE_ENUMS[k as keyof DeviceSettings];
    if (allowed && !allowed.includes(v)) throw new BackendError('INVALID', `Invalid ${k}`, { field: k });
  }
}

function validateVault(patch: Partial<VaultSettings>) {
  if (patch.trashRetentionDays !== undefined && (patch.trashRetentionDays < 1 || patch.trashRetentionDays > 3650)) {
    throw new BackendError('INVALID', 'must be between 1 and 3650', { field: 'trashRetentionDays' });
  }
  if (patch.clipboardClearSeconds !== undefined && (patch.clipboardClearSeconds < 5 || patch.clipboardClearSeconds > 600)) {
    throw new BackendError('INVALID', 'must be between 5 and 600 seconds', { field: 'clipboardClearSeconds' });
  }
  if (patch.baseCurrency !== undefined && (!patch.baseCurrency || patch.baseCurrency.length > 10)) {
    throw new BackendError('INVALID', 'invalid currency', { field: 'baseCurrency' });
  }
  if (patch.profileName !== undefined && [...patch.profileName].length > 1024) {
    throw new BackendError('INVALID', 'value too long', { field: 'profileName' });
  }
  if (patch.timezone !== undefined && !validTimezone(patch.timezone)) {
    throw new BackendError('INVALID', 'unknown time zone', { field: 'timezone' });
  }
  if (patch.locale !== undefined && !validLocale(patch.locale)) {
    throw new BackendError('INVALID', 'invalid locale', { field: 'locale' });
  }
  if (patch.weekStart !== undefined && ![0, 1, 6].includes(patch.weekStart)) {
    throw new BackendError('INVALID', 'must be 0, 1 or 6', { field: 'weekStart' });
  }
  if (patch.clock !== undefined && ![12, 24].includes(patch.clock)) {
    throw new BackendError('INVALID', 'must be 12 or 24', { field: 'clock' });
  }
}

export const handlers: MockHandlers = {
  settings_get: (_req, ctx) => {
    const device = deviceSettings(ctx);
    return ctx.vault.isUnlocked() ? { device, vault: vaultSettings(ctx) } : { device };
  },
  settings_set_device: (req, ctx) => {
    validateDevice(req.patch);
    return patchDeviceSettings(ctx, req.patch);
  },
  settings_set_vault: (req, ctx) => {
    validateVault(req.patch);
    return patchVaultSettings(ctx, req.patch);
  },
  settings_detect_region: (req, ctx) => {
    const region = detectRegion({ locale: req.locale, timeZone: req.timeZone });
    if (!req.apply) return region;
    if (!ctx.vault.isUnlocked()) throw new BackendError('LOCKED', 'Unlock first');
    if (ctx.db.meta<boolean>('settings.regionDetected')) return region;
    const cur = vaultSettings(ctx);
    let applied = false;
    if (regionUntouched(cur)) {
      patchVaultSettings(ctx, {
        locale: region.locale,
        timezone: region.timezone,
        weekStart: region.weekStart,
        clock: region.clock,
        dateFormat: region.dateFormat,
        ...(region.currency && cur.baseCurrency === 'USD' ? { baseCurrency: region.currency } : {}),
      });
      applied = true;
    }
    ctx.db.setMeta('settings.regionDetected', true);
    return { ...region, applied };
  },
};
