/**
 * Security score (Security Center hero): a weighted checklist over the vault status, auto-lock, snapshots, KDF,
 * integrity, clipboard and full-disk encryption. Every item carries the action that fixes it.
 */
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { api } from "@/backend";
import type { SnapshotInfo, VaultStatus, VaultSettings } from "@/backend/types";
import { useSettings } from "@/stores/settings";
import { useVault } from "@/stores/vault";

export type CheckId = "encryption" | "recovery" | "autolock" | "sleep" | "snapshots" | "kdf" | "integrity" | "clipboard" | "fde" | "keys";

export interface CheckItem {
  id: CheckId;
  title: string;
  detail: string;
  weight: number;
  done: boolean;
  /** Not applicable until another item is done (e.g. recovery key needs encryption). */
  blocked?: string;
}

interface SecurityInfo {
  snapshots: SnapshotInfo[] | null;
  fdeAcknowledged: boolean;
  lastIntegrity: number | null;
  loaded: boolean;
  load(): Promise<void>;
  refreshSnapshots(): Promise<void>;
  setFde(on: boolean): void;
  markIntegrity(at: number): void;
}

export const useSecurityInfo = create<SecurityInfo>()((set, get) => ({
  snapshots: null,
  fdeAcknowledged: false,
  lastIntegrity: null,
  loaded: false,
  async load() {
    if (get().loaded) return;
    set({ loaded: true });
    try {
      const kv = await api.kv.getMany({ ns: "ui.security", keys: ["fde", "lastIntegrity"] });
      set({ fdeAcknowledged: kv.fde === true, lastIntegrity: typeof kv.lastIntegrity === "number" ? kv.lastIntegrity : null });
    } catch {
      /* defaults */
    }
    await get().refreshSnapshots();
  },
  async refreshSnapshots() {
    try {
      set({ snapshots: await api.snapshot.list() });
    } catch {
      set({ snapshots: [] });
    }
  },
  setFde(on) {
    set({ fdeAcknowledged: on });
    api.kv.set({ ns: "ui.security", key: "fde", value: on }).catch(() => undefined);
  },
  markIntegrity(at) {
    set({ lastIntegrity: at });
    api.kv.set({ ns: "ui.security", key: "lastIntegrity", value: at }).catch(() => undefined);
  },
}));

const IDLE_LABEL = (m: number | null) => (m === null ? "never" : m >= 60 ? `${m / 60} h` : `${m} min`);

export function computeChecklist(status: VaultStatus | null, vault: VaultSettings | null, snapshots: SnapshotInfo[] | null, fde: boolean): CheckItem[] {
  const enc = !!status?.encrypted;
  const idle = status?.autoLock.idleMinutes ?? null;
  const last = snapshots?.[0]?.at ?? 0;
  const freshSnap = enc && !!vault?.snapshots.enabled && Date.now() - last < 48 * 3600_000;
  const needsEnc = enc ? undefined : "Needs encryption";
  return [
    { id: "encryption", title: "Encryption is on", detail: enc ? "Everything you write is encrypted on this device." : "Your workspace is stored unencrypted on this device.", weight: 30, done: enc },
    { id: "recovery", title: "Recovery key confirmed", detail: enc ? (status?.recoveryConfirmed ? "You proved you saved your 24 words." : "Confirm you saved your 24 recovery words.") : "Comes with encryption.", weight: 15, done: enc && !!status?.recoveryConfirmed, blocked: needsEnc },
    { id: "autolock", title: "Locks when you step away", detail: enc ? `Auto-lock after ${IDLE_LABEL(idle)} idle.` : "Locking needs encryption.", weight: 10, done: enc && idle !== null && idle <= 15, blocked: needsEnc },
    { id: "sleep", title: "Locks on sleep and screen lock", detail: status?.autoLock.onSleep && status.autoLock.onScreenLock ? "Both triggers are on." : "Lock whenever your computer sleeps or locks.", weight: 5, done: enc && !!status?.autoLock.onSleep && !!status.autoLock.onScreenLock, blocked: needsEnc },
    { id: "snapshots", title: "Recent encrypted snapshot", detail: !enc ? "Automatic backups are off: set a backup password." : !vault?.snapshots.enabled ? "Automatic snapshots are turned off." : last ? "A snapshot was taken in the last 2 days." : "No snapshot yet.", weight: 15, done: freshSnap },
    { id: "kdf", title: "Key derivation at full strength", detail: status?.kdf?.belowStandard ? "Your key uses older, lighter settings." : "Argon2id at the Standard profile or above.", weight: 5, done: enc && !status?.kdf?.belowStandard, blocked: needsEnc },
    { id: "integrity", title: "Integrity check passed", detail: status?.integrity === "ok" ? "No tampering detected." : status?.integrity === "warning" ? "Something changed outside Ultra Note." : "Not checked yet.", weight: 5, done: status?.integrity === "ok" },
    { id: "clipboard", title: "Clipboard clears quickly", detail: `Copied secrets clear after ${vault?.clipboardClearSeconds ?? 30} s.`, weight: 5, done: (vault?.clipboardClearSeconds ?? 30) <= 30 },
    { id: "keys", title: "API keys protected", detail: enc ? "Keys are sealed with your vault key." : status?.keychainAvailable ? "Keys use this computer’s keychain." : "Your API keys are obfuscated, not protected. Turn on vault encryption to protect them.", weight: 5, done: enc || !!status?.keychainAvailable },
    { id: "fde", title: "Full-disk encryption", detail: fde ? "You confirmed FileVault, BitLocker or LUKS is on." : "Covers the metadata Ultra Note can’t hide (see below).", weight: 5, done: fde },
  ];
}

export function useSecurityScore(): { score: number; tone: "ok" | "warn" | "bad"; items: CheckItem[] } | null {
  const status = useVault((s) => s.status);
  const vault = useSettings((s) => s.vault);
  const snapshots = useSecurityInfo((s) => s.snapshots);
  const fde = useSecurityInfo((s) => s.fdeAcknowledged);
  useEffect(() => {
    void useSecurityInfo.getState().load();
  }, []);
  return useMemo(() => {
    if (!status) return null;
    const items = computeChecklist(status, vault, snapshots, fde);
    const score = items.reduce((n, i) => n + (i.done ? i.weight : 0), 0);
    return { score, tone: score >= 80 ? "ok" : score >= 50 ? "warn" : "bad", items };
  }, [status, vault, snapshots, fde]);
}
