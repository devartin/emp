/**
 * vault_* (§9): create (encrypted or not), unlock with backoff, recovery unlock, lock, re-auth (5 min),
 * auto-lock settings, KDF benchmark/strengthen, password change, encryption on/off jobs, recovery key
 * view/regenerate/confirm, integrity check/reseal. With `?encrypted=1` the password is "demo".
 */
import { BackendError } from '../../errors';
import type { AutoLock } from '../../types';
import type { MockCtx, MockHandlers } from '../ctx';
import { patchVaultSettings } from '../lib/settings';
import {
  backoffMs,
  DEFAULT_AUTOLOCK,
  generateRecoveryWords,
  KDF_HIGH,
  KDF_SIM_MS,
  KDF_STANDARD,
  newVaultId,
  REAUTH_MS,
  saveVault,
  statusOf,
  vaultRecord,
  type VaultRecord,
} from '../lib/vault';
import { createStarterWorkspace } from '../seed/core';

const PW_MAX_BYTES = 1024;
const IDLE_OPTIONS = [1, 5, 15, 30, 60, 240];

function normalisePassword(pw: unknown, field = 'password'): string {
  if (typeof pw !== 'string' || !pw) throw new BackendError('INVALID', 'Enter your password', { field });
  const n = pw.normalize('NFKC');
  if (new TextEncoder().encode(n).length > PW_MAX_BYTES) {
    throw new BackendError('INVALID', 'Passwords are limited to 1,024 bytes', { field });
  }
  return n;
}

function validateNewPassword(pw: unknown, field = 'password'): string {
  const n = normalisePassword(pw, field);
  if ([...n].length < 10) throw new BackendError('INVALID', 'Use at least 10 characters', { field });
  return n;
}

function validateAutoLock(a: AutoLock): AutoLock {
  const out: AutoLock = {
    idleMinutes: a.idleMinutes === null ? null : Number(a.idleMinutes),
    onSleep: !!a.onSleep,
    onScreenLock: !!a.onScreenLock,
    onBlurMinutes: a.onBlurMinutes === null || a.onBlurMinutes === undefined ? null : Number(a.onBlurMinutes),
    maxSessionHours: a.maxSessionHours === null || a.maxSessionHours === undefined ? null : Number(a.maxSessionHours),
  };
  if (out.idleMinutes !== null && !IDLE_OPTIONS.includes(out.idleMinutes)) {
    throw new BackendError('INVALID', 'Choose 1, 5, 15, 30 or 60 minutes, 4 hours, or Never', { field: 'idleMinutes' });
  }
  if (out.onBlurMinutes !== null && ![0, 1, 5].includes(out.onBlurMinutes)) {
    throw new BackendError('INVALID', 'Choose 0, 1 or 5 minutes', { field: 'onBlurMinutes' });
  }
  if (out.maxSessionHours !== null && !(out.maxSessionHours > 0 && out.maxSessionHours <= 72)) {
    throw new BackendError('INVALID', 'Choose up to 72 hours', { field: 'maxSessionHours' });
  }
  return out;
}

/** Simulated Argon2id time; not affected by `&latency`. */
const kdf = (ctx: MockCtx) => ctx.sleep(KDF_SIM_MS);

function checkLockout(ctx: MockCtx, v: VaultRecord) {
  const wait = v.lockoutUntil - ctx.clock.now();
  if (wait > 0) {
    throw new BackendError('RATE_LIMITED', `Too many attempts. Try again in ${Math.ceil(wait / 1000)} s.`, {
      retryAfterMs: wait,
    });
  }
}

function recordFailure(ctx: MockCtx, v: VaultRecord): never {
  v.failedAttempts += 1;
  const delay = backoffMs(v.failedAttempts);
  v.lockoutUntil = delay ? ctx.clock.now() + delay : 0;
  saveVault(ctx, v);
  ctx.vault.securityLog('unlock_fail');
  throw new BackendError('BAD_PASSWORD', 'Incorrect password', delay ? { retryAfterMs: delay } : undefined);
}

function markUnlocked(ctx: MockCtx, v: VaultRecord) {
  const wasLocked = v.state !== 'unlocked';
  v.state = 'unlocked';
  v.failedAttempts = 0;
  v.lockoutUntil = 0;
  v.lastActivity = ctx.clock.now();
  v.unlockedAt = ctx.clock.now();
  saveVault(ctx, v);
  if (wasLocked) ctx.events.internal('vault:unlocked', {});
}

function requireUnlocked(v: VaultRecord) {
  if (v.state !== 'unlocked') throw new BackendError('LOCKED', 'EMP is locked');
}

function emitStatus(ctx: MockCtx) {
  ctx.emit('vault:status', statusOf(ctx));
}

export const handlers: MockHandlers = {
  vault_status: (_req, ctx) => statusOf(ctx),

  vault_create: async (req, ctx) => {
    const v = vaultRecord(ctx);
    if (v.state !== 'uninitialized') throw new BackendError('INVALID', 'EMP is already set up');
    const autoLock = validateAutoLock(req.autoLock ?? DEFAULT_AUTOLOCK);
    const encrypted = typeof req.password === 'string' && req.password.length > 0;
    let recoveryWords: string[] | undefined;
    if (encrypted) {
      v.password = validateNewPassword(req.password);
      const params = req.profile === 'high' ? KDF_HIGH : KDF_STANDARD;
      v.kdf = { ...params, estMs: req.profile === 'high' ? 2400 : 900 };
      v.profile = req.profile;
      recoveryWords = generateRecoveryWords(ctx);
      v.recoveryWords = recoveryWords;
      v.recoveryConfirmed = false;
      await kdf(ctx);
    } else {
      v.recoveryConfirmed = false;
    }
    v.encrypted = encrypted;
    v.vaultId = newVaultId(ctx);
    v.autoLock = autoLock;
    v.integrity = 'ok';
    v.createdAt = ctx.clock.now();
    markUnlocked(ctx, v);
    createStarterWorkspace(ctx);
    if (encrypted) ctx.vault.securityLog('enc_on');
    ctx.vault.securityLog('unlock_ok');
    return recoveryWords ? { status: statusOf(ctx), recoveryWords } : { status: statusOf(ctx) };
  },

  vault_unlock: async (req, ctx) => {
    const v = vaultRecord(ctx);
    if (v.state === 'uninitialized') throw new BackendError('INVALID', 'Set up EMP first');
    if (v.state === 'unlocked') return statusOf(ctx);
    checkLockout(ctx, v);
    const pw = normalisePassword(req.password);
    await kdf(ctx);
    if (pw !== v.password) recordFailure(ctx, v);
    markUnlocked(ctx, v);
    ctx.vault.securityLog('unlock_ok');
    return statusOf(ctx);
  },

  vault_unlock_recovery: async (req, ctx) => {
    const v = vaultRecord(ctx);
    if (!v.encrypted || !v.recoveryWords) throw new BackendError('UNSUPPORTED', 'This workspace has no recovery key');
    checkLockout(ctx, v);
    const words = (req.words ?? []).map((w) => String(w).trim().toLowerCase());
    if (words.length !== 24) throw new BackendError('INVALID', 'Enter all 24 words', { field: 'words' });
    const newPassword = validateNewPassword(req.newPassword, 'newPassword');
    await kdf(ctx);
    if (words.join(' ') !== v.recoveryWords.join(' ')) {
      v.failedAttempts += 1;
      const delay = backoffMs(v.failedAttempts);
      v.lockoutUntil = delay ? ctx.clock.now() + delay : 0;
      saveVault(ctx, v);
      throw new BackendError('CRYPTO', "Those words don't match this workspace's recovery key", { field: 'words' });
    }
    v.password = newPassword;
    markUnlocked(ctx, v);
    ctx.vault.securityLog('recovery_unlock');
    ctx.vault.securityLog('pw_change');
    return statusOf(ctx);
  },

  vault_lock: async (_req, ctx) => {
    const v = vaultRecord(ctx);
    if (!v.encrypted) throw new BackendError('UNSUPPORTED', 'Turn on encryption to lock EMP');
    await ctx.vault.lock('manual');
    ctx.events.internal('gettingStarted:tick', { item: 'lock' });
  },

  vault_activity_ping: (_req, ctx) => {
    ctx.vault.stampActivity();
  },

  vault_reauth: async (req, ctx) => {
    const v = vaultRecord(ctx);
    requireUnlocked(v);
    if (!v.encrypted) {
      const validUntil = ctx.clock.now() + REAUTH_MS;
      v.reauthValidUntil = validUntil;
      saveVault(ctx, v);
      return { validUntil };
    }
    checkLockout(ctx, v);
    const pw = normalisePassword(req.password);
    await kdf(ctx);
    if (pw !== v.password) recordFailure(ctx, v);
    v.failedAttempts = 0;
    v.reauthValidUntil = ctx.clock.now() + REAUTH_MS;
    saveVault(ctx, v);
    return { validUntil: v.reauthValidUntil };
  },

  vault_set_auto_lock: (req, ctx) => {
    const next = validateAutoLock(req);
    if (next.idleMinutes === null) ctx.vault.requireReauth();
    const v = vaultRecord(ctx);
    v.autoLock = next;
    saveVault(ctx, v);
    emitStatus(ctx);
    return statusOf(ctx);
  },

  vault_benchmark_kdf: async (_req, ctx) => {
    await ctx.sleep(220);
    const ms = Math.round(780 + ctx.rng.float(-120, 160));
    return { ...KDF_STANDARD, ms };
  },

  vault_strengthen_kdf: async (req, ctx) => {
    const v = vaultRecord(ctx);
    if (!v.encrypted) throw new BackendError('UNSUPPORTED', 'Encryption is off');
    if (normalisePassword(req.password) !== v.password) recordFailure(ctx, v);
    await kdf(ctx);
    v.kdf = { ...(v.profile === 'high' ? KDF_HIGH : KDF_STANDARD), estMs: v.profile === 'high' ? 2400 : 900 };
    saveVault(ctx, v);
    emitStatus(ctx);
    return statusOf(ctx);
  },

  vault_change_password: async (req, ctx) => {
    const v = vaultRecord(ctx);
    if (!v.encrypted) throw new BackendError('UNSUPPORTED', 'Encryption is off');
    if (normalisePassword(req.oldPassword, 'oldPassword') !== v.password) recordFailure(ctx, v);
    const next = validateNewPassword(req.newPassword, 'newPassword');
    if (next === v.password) throw new BackendError('INVALID', 'Choose a different password', { field: 'newPassword' });
    await kdf(ctx);
    v.password = next;
    saveVault(ctx, v);
    ctx.vault.securityLog('pw_change');
    emitStatus(ctx);
    return statusOf(ctx);
  },

  vault_enable_encryption: async (req, ctx) => {
    const v = vaultRecord(ctx);
    if (v.encrypted) throw new BackendError('INVALID', 'Encryption is already on');
    const pw = validateNewPassword(req.password);
    const tables = ctx.db.tableNames().filter((n) => !n.startsWith('_'));
    const total = Math.max(1, tables.reduce((n, name) => n + ctx.db.table(name).size, 0));
    let done = 0;
    ctx.progress(0, total, 'Deriving key');
    await ctx.sleep(KDF_SIM_MS, ctx.signal);
    for (const name of tables) {
      ctx.checkCancelled();
      done += ctx.db.table(name).size;
      ctx.progress(Math.min(done, total), total, `Encrypting ${name.replace(/_/g, ' ')}`);
      await ctx.sleep(60, ctx.signal);
    }
    const words = generateRecoveryWords(ctx);
    const cur = vaultRecord(ctx);
    cur.encrypted = true;
    cur.password = pw;
    cur.kdf = { ...KDF_STANDARD, estMs: 900 };
    cur.recoveryWords = words;
    cur.recoveryConfirmed = false;
    cur.reauthValidUntil = ctx.clock.now() + REAUTH_MS;
    saveVault(ctx, cur);
    ctx.vault.securityLog('enc_on');
    emitStatus(ctx);
    return { recoveryWords: words };
  },

  vault_disable_encryption: async (req, ctx) => {
    const v = vaultRecord(ctx);
    if (!v.encrypted) throw new BackendError('INVALID', 'Encryption is already off');
    if (req.confirm !== 'DECRYPT') throw new BackendError('INVALID', 'Type DECRYPT to confirm', { field: 'confirm' });
    if (normalisePassword(req.password) !== v.password) recordFailure(ctx, v);
    const tables = ctx.db.tableNames().filter((n) => !n.startsWith('_'));
    for (let i = 0; i < tables.length; i++) {
      ctx.checkCancelled();
      ctx.progress(i + 1, tables.length, `Decrypting ${tables[i].replace(/_/g, ' ')}`);
      await ctx.sleep(50, ctx.signal);
    }
    const cur = vaultRecord(ctx);
    cur.encrypted = false;
    delete cur.password;
    delete cur.recoveryWords;
    cur.recoveryConfirmed = false;
    saveVault(ctx, cur);
    ctx.vault.securityLog('enc_off');
    emitStatus(ctx);
  },

  vault_recovery_view: (_req, ctx) => {
    const v = vaultRecord(ctx);
    if (!v.encrypted || !v.recoveryWords) throw new BackendError('UNSUPPORTED', 'Encryption is off');
    if (v.recoveryConfirmed) {
      throw new BackendError('UNSUPPORTED', 'The recovery key was confirmed and can no longer be shown. Generate a new one instead.');
    }
    return { words: [...v.recoveryWords] };
  },

  vault_recovery_regenerate: (_req, ctx) => {
    const v = vaultRecord(ctx);
    if (!v.encrypted) throw new BackendError('UNSUPPORTED', 'Encryption is off');
    v.recoveryWords = generateRecoveryWords(ctx);
    v.recoveryConfirmed = false;
    saveVault(ctx, v);
    ctx.vault.securityLog('recovery_regen');
    emitStatus(ctx);
    return { words: [...v.recoveryWords] };
  },

  vault_recovery_confirm: (req, ctx) => {
    const v = vaultRecord(ctx);
    if (!v.recoveryWords) throw new BackendError('UNSUPPORTED', 'Encryption is off');
    if (req.positions.length !== req.words.length || req.positions.length < 3) {
      throw new BackendError('INVALID', 'Enter the requested words', { field: 'words' });
    }
    const ok = req.positions.every(
      (pos, i) => v.recoveryWords?.[pos]?.toLowerCase() === String(req.words[i] ?? '').trim().toLowerCase(),
    );
    if (ok) {
      v.recoveryConfirmed = true;
      saveVault(ctx, v);
      emitStatus(ctx);
    }
    return { confirmed: ok };
  },

  vault_integrity_check: async (_req, ctx) => {
    const tables = ctx.db.tableNames().filter((n) => !n.startsWith('_'));
    const total = tables.reduce((n, name) => n + ctx.db.table(name).size, 0) || 1;
    let done = 0;
    for (const name of tables) {
      ctx.checkCancelled();
      done += ctx.db.table(name).size;
      ctx.progress(done, total, `Checking ${name.replace(/_/g, ' ')}`);
      await ctx.sleep(40, ctx.signal);
    }
    const v = vaultRecord(ctx);
    v.integrity = 'ok';
    saveVault(ctx, v);
    ctx.db.setMeta('integrity.lastCheck', ctx.clock.now());
    return { ok: true, damaged: [], msetMismatch: false };
  },

  vault_integrity_reseal: (_req, ctx) => {
    const v = vaultRecord(ctx);
    v.integrity = 'ok';
    saveVault(ctx, v);
    ctx.vault.securityLog('reseal');
    emitStatus(ctx);
  },
};

/** Used by onboarding seeds/tests: set the profile name right after creation. */
export function setProfileName(ctx: MockCtx, name: string): void {
  patchVaultSettings(ctx, { profileName: name });
}
