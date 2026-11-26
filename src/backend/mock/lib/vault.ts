/**
 * Vault state machine for the mock (§9.2–§9.10): create/unlock/lock, online backoff, re-auth window, recovery key,
 * auto-lock ticker (idle, blur, max session) with the 60 s `vault:autolock-soon` countdown.
 */
import { BackendError } from '../../errors';
import type { AutoLock, LockReason, VaultStatus } from '../../types';
import type { MockCtx, VaultService } from '../ctx';
import { randomHex } from '../rng';
import { BIP39_SUBSET } from './words';

export interface VaultRecord {
  state: 'uninitialized' | 'locked' | 'unlocked';
  encrypted: boolean;
  vaultId?: string;
  /** Mock only: the real app never stores the password. */
  password?: string;
  profile: 'standard' | 'high';
  kdf: { mKiB: number; t: number; p: number; estMs: number };
  recoveryWords?: string[];
  recoveryConfirmed: boolean;
  autoLock: AutoLock;
  failedAttempts: number;
  lockoutUntil: number;
  reauthValidUntil?: number;
  integrity: 'ok' | 'warning' | 'unchecked';
  lastActivity: number;
  unlockedAt?: number;
  lastLockReason?: LockReason;
  createdAt?: number;
}

export const DEFAULT_AUTOLOCK: AutoLock = {
  idleMinutes: 15,
  onSleep: true,
  onScreenLock: true,
  onBlurMinutes: null,
  maxSessionHours: null,
};

export const KDF_STANDARD = { mKiB: 262144, t: 3, p: 4 };
export const KDF_HIGH = { mKiB: 1048576, t: 4, p: 4 };
/** Simulated Argon2id time (§13.6). */
export const KDF_SIM_MS = 600;
export const REAUTH_MS = 5 * 60 * 1000;

export function backoffMs(failures: number): number {
  if (failures < 5) return 0;
  return Math.min(300, 2 ** (failures - 5)) * 1000;
}

export function vaultRecord(ctx: MockCtx): VaultRecord {
  const rec = ctx.db.meta<VaultRecord>('vault');
  if (rec) return rec;
  const fresh: VaultRecord = {
    state: 'uninitialized',
    encrypted: false,
    profile: 'standard',
    kdf: { ...KDF_STANDARD, estMs: 900 },
    recoveryConfirmed: false,
    autoLock: { ...DEFAULT_AUTOLOCK },
    failedAttempts: 0,
    lockoutUntil: 0,
    integrity: 'unchecked',
    lastActivity: ctx.clock.now(),
  };
  ctx.db.setMeta('vault', fresh);
  return fresh;
}

export function saveVault(ctx: MockCtx, rec: VaultRecord): void {
  ctx.db.setMeta('vault', rec);
}

export function generateRecoveryWords(ctx: MockCtx): string[] {
  return Array.from({ length: 24 }, () => ctx.rng.pick(BIP39_SUBSET));
}

export function newVaultId(ctx: MockCtx): string {
  return randomHex(ctx.rng, 16);
}

export function statusOf(ctx: MockCtx, rec: VaultRecord = vaultRecord(ctx)): VaultStatus {
  const now = ctx.clock.now();
  const status: VaultStatus = {
    state: rec.state,
    encrypted: rec.encrypted,
    recoveryConfirmed: rec.recoveryConfirmed,
    autoLock: { ...rec.autoLock },
    failedAttempts: rec.failedAttempts,
    retryAfterMs: Math.max(0, rec.lockoutUntil - now),
    schemaVersion: 1,
    pendingMigrations: 0,
    keychainAvailable: true,
    integrity: rec.integrity,
  };
  if (rec.vaultId) status.vaultId = rec.vaultId;
  if (rec.encrypted) {
    status.kdf = {
      ...rec.kdf,
      belowStandard: rec.kdf.mKiB < KDF_STANDARD.mKiB || rec.kdf.t < KDF_STANDARD.t,
    };
  }
  if (rec.reauthValidUntil && rec.reauthValidUntil > now) status.reauthValidUntil = rec.reauthValidUntil;
  return status;
}

export function createVaultService(ctx: MockCtx): VaultService {
  let blurredAt: number | null = null;
  let lastSoon = -1;
  let locking = false;

  const service: VaultService = {
    status: () => statusOf(ctx),
    isUnlocked: () => vaultRecord(ctx).state === 'unlocked',
    isEncrypted: () => vaultRecord(ctx).encrypted,
    requireReauth() {
      const rec = vaultRecord(ctx);
      if (!rec.encrypted) return;
      if (!rec.reauthValidUntil || rec.reauthValidUntil <= ctx.clock.now()) {
        throw new BackendError('REAUTH_REQUIRED', 'Confirm your password to continue.');
      }
    },
    async lock(reason) {
      const rec = vaultRecord(ctx);
      if (!rec.encrypted || rec.state !== 'unlocked' || locking) return;
      locking = true;
      try {
        ctx.emit('vault:will-lock', { reason });
        // Rust gives the UI up to 1.5 s to flush saves; the mock waits briefly so flushes land first.
        await new Promise((r) => setTimeout(r, 180));
        const cur = vaultRecord(ctx);
        cur.state = 'locked';
        delete cur.reauthValidUntil;
        delete cur.unlockedAt;
        cur.lastLockReason = reason;
        saveVault(ctx, cur);
        lastSoon = -1;
        service.securityLog('lock');
        for (const job of ctx.jobs.values()) job.controller.abort();
        ctx.events.internal('vault:locked', { reason });
        ctx.emit('vault:locked', { reason });
      } finally {
        locking = false;
      }
    },
    stampActivity() {
      const rec = vaultRecord(ctx);
      rec.lastActivity = ctx.clock.now();
      // Not saved through setMeta on purpose: activity stamps should not trigger persistence writes.
      if (lastSoon >= 0) lastSoon = -1;
    },
    securityLog(event) {
      const log = ctx.db.table<{ id: string; at: number; event: string }>('security_log');
      log.insert({ id: `${ctx.clock.now()}-${log.size}`, at: ctx.clock.now(), event });
    },
  };

  // Auto-lock ticker (Rust: 10 s ticker; the mock ticks every second so the countdown ring is smooth).
  ctx.every(1000, () => {
    const rec = vaultRecord(ctx);
    if (!rec.encrypted || rec.state !== 'unlocked' || locking) return;
    const now = ctx.clock.now();
    if (rec.autoLock.maxSessionHours && rec.unlockedAt && now - rec.unlockedAt >= rec.autoLock.maxSessionHours * 3600_000) {
      void service.lock('session_max');
      return;
    }
    if (rec.autoLock.onBlurMinutes !== null && blurredAt !== null && now - blurredAt >= rec.autoLock.onBlurMinutes * 60_000) {
      void service.lock('blur');
      return;
    }
    if (rec.autoLock.idleMinutes === null) return;
    const remaining = rec.lastActivity + rec.autoLock.idleMinutes * 60_000 - now;
    if (remaining <= 0) {
      void service.lock('idle');
      return;
    }
    if (remaining <= 60_000) {
      const secondsLeft = Math.ceil(remaining / 1000);
      if (secondsLeft !== lastSoon) {
        lastSoon = secondsLeft;
        ctx.emit('vault:autolock-soon', { secondsLeft });
      }
    }
  });

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('blur', () => {
      blurredAt = ctx.clock.now();
    });
    window.addEventListener('focus', () => {
      blurredAt = null;
    });
  }

  return service;
}
