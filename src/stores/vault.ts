/**
 * Vault session (§9.9, §6.3): status, the app phase (booting → onboarding | lock | shell), unlock/lock, re-auth,
 * the 60 s auto-lock countdown and activity pings (at most one every 30 s while there is input).
 */
import { create } from 'zustand';
import { api, hasCode } from '@/backend';
import type { LockReason, VaultStatus } from '@/backend/types';

export type AppPhase = 'booting' | 'onboarding' | 'lock' | 'shell' | 'error';

interface VaultState {
  status: VaultStatus | null;
  phase: AppPhase;
  bootError: string | null;
  /** Seconds until auto-lock while inside the last minute, else null. */
  autoLockSecondsLeft: number | null;
  /** Why the vault last locked (shown on the lock screen). */
  lastLockReason: LockReason | null;
  /** True while an unlock KDF is running. */
  unlocking: boolean;

  setPhase(phase: AppPhase, error?: string): void;
  setStatus(status: VaultStatus): void;
  refresh(): Promise<VaultStatus>;
  /** Resolves with the new status; rejects with BAD_PASSWORD / RATE_LIMITED {retryAfterMs}. */
  unlock(password: string): Promise<VaultStatus>;
  unlockWithRecovery(words: string[], newPassword: string): Promise<VaultStatus>;
  lock(): Promise<void>;
  /** Re-auth ("sudo mode", 5 min). */
  reauth(password: string): Promise<number>;
  /** True if a re-auth is still valid. */
  reauthValid(): boolean;
  setCountdown(secondsLeft: number | null): void;
  markLocked(reason: LockReason): void;
}

export const useVault = create<VaultState>()((set, get) => ({
  status: null,
  phase: 'booting',
  bootError: null,
  autoLockSecondsLeft: null,
  lastLockReason: null,
  unlocking: false,

  setPhase: (phase, error) => set({ phase, bootError: error ?? null }),
  setStatus: (status) => set({ status }),

  async refresh() {
    const status = await api.vault.status();
    set({ status });
    return status;
  },

  async unlock(password) {
    set({ unlocking: true });
    try {
      const status = await api.vault.unlock({ password });
      set({ status, autoLockSecondsLeft: null });
      return status;
    } catch (e) {
      // Keep failedAttempts / retryAfterMs current for the lock screen.
      if (hasCode(e, 'BAD_PASSWORD', 'RATE_LIMITED')) void get().refresh().catch(() => undefined);
      throw e;
    } finally {
      set({ unlocking: false });
    }
  },

  async unlockWithRecovery(words, newPassword) {
    set({ unlocking: true });
    try {
      const status = await api.vault.unlockRecovery({ words, newPassword });
      set({ status, autoLockSecondsLeft: null });
      return status;
    } finally {
      set({ unlocking: false });
    }
  },

  async lock() {
    await api.vault.lock({ reason: 'manual' });
  },

  async reauth(password) {
    const { validUntil } = await api.vault.reauth({ password });
    const status = get().status;
    if (status) set({ status: { ...status, reauthValidUntil: validUntil } });
    return validUntil;
  },

  reauthValid() {
    const s = get().status;
    if (!s?.encrypted) return true;
    return !!s.reauthValidUntil && s.reauthValidUntil > Date.now();
  },

  setCountdown: (secondsLeft) => set({ autoLockSecondsLeft: secondsLeft }),

  markLocked(reason) {
    const s = get().status;
    set({
      lastLockReason: reason,
      autoLockSecondsLeft: null,
      status: s ? { ...s, state: 'locked', reauthValidUntil: undefined } : s,
    });
  },
}));

export const selectIsEncrypted = (s: VaultState) => !!s.status?.encrypted;
export const selectIsUnlocked = (s: VaultState) => s.status?.state === 'unlocked';

const PING_EVERY_MS = 30_000;
let lastPing = 0;
let trackingInstalled = false;

/** Sends `vault_activity_ping` at most once every 30 s while the user is active. */
export function installActivityTracking(): () => void {
  if (trackingInstalled || typeof window === 'undefined') return () => undefined;
  trackingInstalled = true;
  const onActivity = () => {
    const st = useVault.getState();
    if (st.autoLockSecondsLeft !== null) st.setCountdown(null);
    const now = Date.now();
    if (now - lastPing < PING_EVERY_MS) {
      // Inside the last minute every input must reach the backend so the countdown resets.
      if (st.autoLockSecondsLeft === null) return;
    }
    if (st.status?.state !== 'unlocked' || !st.status.encrypted) return;
    lastPing = now;
    api.vault.activityPing().catch(() => undefined);
  };
  const opts: AddEventListenerOptions = { passive: true, capture: true };
  const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
  events.forEach((ev) => window.addEventListener(ev, onActivity, opts));
  return () => {
    trackingInstalled = false;
    events.forEach((ev) => window.removeEventListener(ev, onActivity, opts));
  };
}
