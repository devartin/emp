/** settings_get / settings_set_device / settings_set_vault. Device scope is readable before unlock. */
import { BackendError } from '../../errors';
import type { DeviceSettings, VaultSettings } from '../../types';
import type { MockHandlers } from '../ctx';
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
  if (patch.trashRetentionDays !== undefined && (patch.trashRetentionDays < 1 || patch.trashRetentionDays > 365)) {
    throw new BackendError('INVALID', 'Keep items in Trash for 1–365 days', { field: 'trashRetentionDays' });
  }
  if (patch.clipboardClearSeconds !== undefined && (patch.clipboardClearSeconds < 5 || patch.clipboardClearSeconds > 600)) {
    throw new BackendError('INVALID', 'Clipboard clear time must be 5–600 seconds', { field: 'clipboardClearSeconds' });
  }
  if (patch.baseCurrency !== undefined && !/^[A-Z]{3}$/.test(patch.baseCurrency)) {
    throw new BackendError('INVALID', 'Use a 3-letter currency code', { field: 'baseCurrency' });
  }
  if (patch.profileName !== undefined && patch.profileName.length > 80) {
    throw new BackendError('INVALID', 'That name is too long', { field: 'profileName' });
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
};
