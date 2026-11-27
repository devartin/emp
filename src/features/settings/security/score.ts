/**
 * Security facts for Settings › Privacy & security (1.0 brief §2.4): the snapshot list and status, the full-disk
 * encryption acknowledgement, the last integrity check, and a plain checklist (More options) built from them.
 *
 * An unencrypted workspace is a choice, not a failure: nothing here scores, ranks or colours it red. Items that need
 * encryption say so, and the checklist only states facts it can check (it never claims that a lock trigger works,
 * only how it is set).
 */
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { api } from "@/backend";
import type { SnapshotInfo, SnapshotStatus, VaultSettings, VaultStatus } from "@/backend/types";
import { useSettings } from "@/stores/settings";
import { useVault } from "@/stores/vault";

export type CheckId = "encryption" | "recovery" | "autolock" | "backups" | "integrity" | "clipboard" | "keys" | "fde";

export interface CheckItem {
  id: CheckId;
  /** What the item is about (not a claim): "Encryption", "Automatic backups". */
  title: string;
  /** The current state in plain words. */
  detail: string;
  done: boolean;
  /** Not applicable without encryption. */
  needsEncryption?: boolean;
}

interface SecurityInfo {
  snapshots: SnapshotInfo[] | null;
  snapStatus: SnapshotStatus | null;
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
  snapStatus: null,
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
    const [list, status] = await Promise.all([api.snapshot.list().catch(() => [] as SnapshotInfo[]), api.snapshot.status().catch(() => null)]);
    set({ snapshots: list, snapStatus: status });
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

const idleLabel = (m: number | null) => (m === null ? "never" : m >= 60 ? `${m / 60} h` : `${m} min`);

export function computeChecklist(status: VaultStatus | null, vault: VaultSettings | null, snapshots: SnapshotInfo[] | null, snap: SnapshotStatus | null, fde: boolean): CheckItem[] {
  const enc = !!status?.encrypted;
  const idle = status?.autoLock.idleMinutes ?? null;
  const last = snapshots?.[0]?.at ?? 0;
  const recent = !!last && Date.now() - last < 48 * 3600_000;
  const automatic = !!snap?.automatic;
  const clip = vault?.clipboardClearSeconds ?? 30;
  return [
    { id: "encryption", title: "Encryption", detail: enc ? "On. Everything you write is encrypted on this computer." : "Off. Your workspace is stored as plain files on this computer.", done: enc },
    { id: "recovery", title: "Recovery key", detail: !enc ? "Comes with encryption." : status?.recoveryConfirmed ? "Confirmed. You proved you saved your 24 words." : "Not confirmed yet.", done: enc && !!status?.recoveryConfirmed, needsEncryption: true },
    { id: "autolock", title: "Lock when idle", detail: !enc ? "Locking comes with encryption." : idle === null ? "Never locks when idle." : `Locks after ${idleLabel(idle)} without input.`, done: enc && idle !== null && idle <= 15, needsEncryption: true },
    { id: "backups", title: "Automatic backups", detail: !automatic ? (snap && !snap.encrypted && !snap.backupPasswordSet ? "Off. Set a backup password to turn them on." : "Off.") : recent ? "On. The latest is less than 2 days old." : last ? "On. The latest is more than 2 days old." : "On. The first one is taken within a day.", done: automatic && recent },
    { id: "integrity", title: "Integrity check", detail: status?.integrity === "ok" ? "Passed. Nothing changed outside Ultranote." : status?.integrity === "warning" ? "Something changed outside Ultranote." : "Not run yet.", done: status?.integrity === "ok" },
    { id: "clipboard", title: "Copied secrets", detail: `Cleared from the clipboard after ${clip >= 60 ? `${clip / 60} min` : `${clip} s`}.`, done: clip <= 30 },
    { id: "keys", title: "API keys", detail: enc ? "Sealed with your workspace key." : status?.keychainAvailable ? "Protected by this computer’s keychain." : "Obfuscated, not protected. Encryption protects them.", done: enc || !!status?.keychainAvailable },
    { id: "fde", title: "Full-disk encryption", detail: fde ? "You confirmed it is on for this computer." : "Covers the details Ultranote can’t hide (see below).", done: fde },
  ];
}

export function useChecklist(): CheckItem[] | null {
  const status = useVault((s) => s.status);
  const vault = useSettings((s) => s.vault);
  const snapshots = useSecurityInfo((s) => s.snapshots);
  const snap = useSecurityInfo((s) => s.snapStatus);
  const fde = useSecurityInfo((s) => s.fdeAcknowledged);
  useEffect(() => {
    void useSecurityInfo.getState().load();
  }, []);
  return useMemo(() => (status ? computeChecklist(status, vault, snapshots, snap, fde) : null), [status, vault, snapshots, snap, fde]);
}
