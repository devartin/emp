/**
 * Backups & snapshots (§9.21): automatic encrypted snapshots (schedule, retention, folder, "Snapshot now", verify
 * with a ring), password-protected `.empbackup` files, and restore — which always opens as a new vault.
 */
import { Archive, ArchiveRestore, CheckCircle2, FolderOpen, HardDriveDownload, Lock, ShieldCheck, XCircle } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useState } from "react";
import { navigate } from "@/app/router";
import { api, backendMode, errorMessage, hasCode } from "@/backend";
import type { FileGrant, JobEvent, SnapshotInfo, VaultSettings } from "@/backend/types";
import { formatDate, formatRelative, formatTime, isoDay } from "@/lib/dates";
import { formatBytes } from "@/lib/format";
import { useSettings } from "@/stores/settings";
import { notify } from "@/stores/toasts";
import { useVault } from "@/stores/vault";
import { useWorkspace } from "@/stores/workspace";
import { Banner } from "@/ui/Banner";
import { Button } from "@/ui/Button";
import { Checkbox } from "@/ui/Checkbox";
import { Dialog } from "@/ui/Dialog";
import { Ring } from "@/ui/Ring";
import { Segmented } from "@/ui/Segmented";
import { Select } from "@/ui/Select";
import { Switch } from "@/ui/Switch";
import { spring } from "@/ui/motion/tokens";
import { Textarea } from "@/ui/Textarea";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { PasswordField } from "@/features/vault/PasswordField";
import { JobProgress, useJob } from "../JobProgress";
import { Group, Row, SectionHeader } from "../parts";
import { useSecurityInfo } from "../security/score";

const emptyReq = <T,>(r: { onEvent: (e: JobEvent) => void }) => r as unknown as T;

export function BackupsSection() {
  const vault = useSettings((s) => s.vault) as VaultSettings;
  const setVault = useSettings((s) => s.setVault);
  const encrypted = useVault((s) => !!s.status?.encrypted);
  const snapshots = useSecurityInfo((s) => s.snapshots);
  const snapJob = useJob<{ id: string }>();
  const [backupOpen, setBackupOpen] = useState(false);
  const [restoreGrant, setRestoreGrant] = useState<FileGrant | null>(null);
  const reduced = useReducedMotionPref();
  const s = vault.snapshots;

  useEffect(() => {
    void useSecurityInfo.getState().refreshSnapshots();
  }, []);

  const snapshotNow = async () => {
    try {
      await snapJob.start((onEvent) => api.snapshot.now(emptyReq<Parameters<typeof api.snapshot.now>[0]>({ onEvent })));
      await useSecurityInfo.getState().refreshSnapshots();
      window.setTimeout(() => snapJob.reset(), 2400);
    } catch (e) {
      notify.fromError(e, "Couldn’t take a snapshot");
    }
  };

  const chooseFolder = async () => {
    try {
      const g = await api.file.saveGrant({ purpose: "backup", suggestedName: "Ultranote Snapshots", filters: [] });
      if (!g) return;
      await api.snapshot.setFolder({ grantId: g.grantId });
      await setVault({ snapshots: { ...s, folderGrantLabel: g.displayName } });
      notify.success("Snapshots will be saved to the new folder", { description: "Existing snapshots stay where they are." });
    } catch (e) {
      notify.fromError(e, "Couldn’t use that folder");
    }
  };

  const pickRestore = async () => {
    try {
      const [g] = await api.file.pick({ purpose: "restore", filters: [{ name: "Ultranote backups", extensions: ["empbackup", "empsnap"] }], multiple: false });
      if (g) setRestoreGrant(g);
    } catch (e) {
      notify.fromError(e, "Couldn’t open the file");
    }
  };

  const keep = (n: number, unit: string) => (n === 0 ? `No ${unit}` : `${n}`);

  return (
    <div>
      <SectionHeader icon={Archive} title="Backups & snapshots" description="Snapshots are sealed copies of your workspace, encrypted with your vault key. Backup files are for moving or archiving." />

      {!encrypted ? (
        <div className="mb-6">
          <Banner
            tone="warning"
            inline
            action={
              <Button size="xs" variant="secondary" onClick={() => navigate({ t: "settings", section: "security:encryption" }, { replace: true })}>
                Turn on encryption
              </Button>
            }
          >
            Automatic backups are off: set a backup password. Turning on encryption protects snapshots with your vault key — or save a password-protected backup file below.
          </Banner>
        </div>
      ) : null}

      <Group id="snapshots" title="Automatic snapshots" description="Taken daily and when you quit (at most every 6 hours).">
        <Row label="Take snapshots automatically" description={encrypted ? "Encrypted with your vault key. Restoring needs the password or recovery key that was current when the snapshot was taken." : "Needs encryption or a backup password."}>
          <Switch checked={s.enabled && encrypted} disabled={!encrypted} onCheckedChange={(v) => void setVault({ snapshots: { ...s, enabled: v } })} aria-label="Take snapshots automatically" />
        </Row>
        <Row label="Keep" description="Older snapshots are removed automatically.">
          <div className="st-retention">
            <Select size="sm" value={String(s.keepDaily)} onValueChange={(v) => void setVault({ snapshots: { ...s, keepDaily: Number(v) } })} options={[3, 5, 7, 10, 14].map((n) => ({ value: String(n), label: `${keep(n, "daily")} daily` }))} aria-label="Daily snapshots to keep" />
            <Select size="sm" value={String(s.keepWeekly)} onValueChange={(v) => void setVault({ snapshots: { ...s, keepWeekly: Number(v) } })} options={[0, 2, 4, 8].map((n) => ({ value: String(n), label: n ? `${n} weekly` : "No weekly" }))} aria-label="Weekly snapshots to keep" />
            <Select size="sm" value={String(s.keepMonthly)} onValueChange={(v) => void setVault({ snapshots: { ...s, keepMonthly: Number(v) } })} options={[0, 3, 6, 12].map((n) => ({ value: String(n), label: n ? `${n} monthly` : "No monthly" }))} aria-label="Monthly snapshots to keep" />
          </div>
        </Row>
        <Row icon={<FolderOpen size={16} />} label="Location" description={s.folderGrantLabel ? `${s.folderGrantLabel} — a synced folder (iCloud Drive, Dropbox, a NAS) keeps a copy off this computer.` : "In Ultranote’s data folder on this computer. Choose a synced folder to keep a copy elsewhere."}>
          {s.folderGrantLabel ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                try {
                  await api.snapshot.setFolder({ grantId: null });
                  await useSettings.getState().load();
                } catch (e) {
                  notify.fromError(e, "Couldn’t change the folder");
                }
              }}
            >
              Use default
            </Button>
          ) : null}
          <Button size="sm" variant="secondary" onClick={() => void chooseFolder()}>
            Choose folder…
          </Button>
        </Row>
        <div className="st-block">
          <AnimatePresence initial={false} mode="wait">
            {snapJob.state.phase === "running" || snapJob.state.phase === "done" ? (
              <m.div key="job" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <JobProgress state={snapJob.state} title="Taking a snapshot" onCancel={snapJob.cancel} doneLabel="Snapshot saved and sealed" />
              </m.div>
            ) : (
              <m.div key="btn" className="flex items-center justify-between gap-3" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <span className="st-hint">{snapshots?.[0] ? `Last snapshot ${formatRelative(snapshots[0].at)} · ${snapshots.length} kept` : encrypted ? "No snapshots yet." : "Snapshots are off."}</span>
                <Button size="sm" variant="secondary" icon={Archive} disabled={!encrypted} disabledReason="Needs encryption" onClick={() => void snapshotNow()}>
                  Snapshot now
                </Button>
              </m.div>
            )}
          </AnimatePresence>
        </div>
      </Group>

      {snapshots && snapshots.length ? (
        <Group title="Snapshots" description="Verify re-checks a snapshot’s seal and structure without restoring it." flush>
          <ol className="st-snaps">
            <AnimatePresence initial={false}>
              {snapshots.map((sn, i) => (
                <m.li key={sn.id} layout={reduced ? false : "position"} initial={reduced ? false : { opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring.layout}>
                  <SnapshotRow sn={sn} latest={i === 0} />
                </m.li>
              ))}
            </AnimatePresence>
          </ol>
        </Group>
      ) : null}

      <Group id="backup-file" title="Backup file" description="One .empbackup file with everything, including attachments. Use it to move to a new computer or keep an archive.">
        <Row icon={<HardDriveDownload size={16} />} label="Create a backup file" description={encrypted ? "Protected by your vault password and recovery key, and optionally a separate backup password." : "Protect it with a backup password — otherwise anyone with the file can read it."}>
          <Button size="sm" variant="secondary" onClick={() => setBackupOpen(true)}>
            Create backup…
          </Button>
        </Row>
      </Group>

      <Group id="restore" title="Restore" description="A restore always opens as a new vault, so nothing here is overwritten.">
        <Row icon={<ArchiveRestore size={16} />} label="Restore from a backup" description=".empbackup or .empsnap files. You’ll need the password or recovery key that was current when it was made.">
          <Button size="sm" variant="secondary" onClick={() => void pickRestore()}>
            Choose file…
          </Button>
        </Row>
      </Group>

      <CreateBackupDialog open={backupOpen} onOpenChange={setBackupOpen} encrypted={encrypted} />
      <RestoreDialog grant={restoreGrant} onClose={() => setRestoreGrant(null)} />
    </div>
  );
}

function SnapshotRow({ sn, latest }: { sn: SnapshotInfo; latest: boolean }) {
  const [verify, setVerify] = useState<{ p: number } | { ok: boolean } | null>(null);
  const run = async () => {
    setVerify({ p: 0 });
    try {
      const job = await api.snapshot.verify({ id: sn.id, onEvent: (e) => e.kind === "progress" && e.total > 0 && setVerify({ p: e.done / e.total }) });
      const r = await job.result;
      setVerify({ ok: r.ok });
      if (!r.ok) notify.error("This snapshot failed verification", { description: "It may have been modified outside Ultranote. Don’t restore from it." });
    } catch (e) {
      setVerify(null);
      notify.fromError(e, "Couldn’t verify the snapshot");
    }
  };
  const today = isoDay(sn.at) === isoDay();
  return (
    <div className="st-snap">
      <span className="st-snap-dot" data-latest={latest ? "" : undefined} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="st-snap-title">
          {today ? `Today, ${formatTime(sn.at)}` : `${formatDate(sn.at)}, ${formatTime(sn.at)}`}
          {latest ? <span className="st-tag" data-tone="ok">Latest</span> : null}
        </div>
        <div className="st-snap-meta">
          {formatRelative(sn.at)} · {formatBytes(sn.bytes)} · schema v{sn.schemaVersion} · {sn.location === "folder" ? "chosen folder" : "this computer"}
        </div>
      </div>
      <AnimatePresence initial={false} mode="wait">
        {verify && "p" in verify ? (
          <m.span key="ring" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-2 text-caption text-tertiary">
            <Ring value={verify.p} size={24} aria-label="Verifying" /> Verifying
          </m.span>
        ) : verify && "ok" in verify ? (
          <m.span key="res" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={spring.bouncy} className="st-verify" data-ok={verify.ok ? "" : undefined}>
            {verify.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />} {verify.ok ? "Verified" : "Failed"}
          </m.span>
        ) : (
          <m.span key="btn" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <Button size="xs" variant="ghost" icon={ShieldCheck} onClick={() => void run()}>
              Verify
            </Button>
          </m.span>
        )}
      </AnimatePresence>
    </div>
  );
}

function CreateBackupDialog({ open, onOpenChange, encrypted }: { open: boolean; onOpenChange: (o: boolean) => void; encrypted: boolean }) {
  const [usePw, setUsePw] = useState(!encrypted);
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [ack, setAck] = useState(false);
  const job = useJob<{ bytes: number }>();
  const [file, setFile] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setUsePw(!encrypted);
      setPw("");
      setConfirm("");
      setAck(false);
      setFile(null);
      job.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const running = job.state.phase === "running";
  const done = job.state.phase === "done";
  const pwOk = !usePw || ([...pw].length >= 8 && pw === confirm);
  const plain = !encrypted && !usePw;
  const ready = pwOk && (!plain || ack);

  const run = async () => {
    try {
      const name = `Ultranote Backup ${isoDay()}.empbackup`;
      const g = await api.file.saveGrant({ purpose: "backup", suggestedName: name, filters: [{ name: "Ultranote backup", extensions: ["empbackup"] }] });
      if (!g) return;
      setFile(g.displayName);
      await job.start((onEvent) => api.backup.create({ grantId: g.grantId, password: usePw && pw ? pw : undefined, onEvent }));
      setPw("");
      setConfirm("");
    } catch (e) {
      notify.fromError(e, "Couldn’t create the backup");
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !running && onOpenChange(o)}
      dismissible={!running}
      size="md"
      title="Create a backup file"
      description={done ? undefined : "Everything in this workspace — pages, databases, sheets, attachments and settings — in one file."}
      footer={
        done ? (
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={running}>
              Cancel
            </Button>
            <Button variant="primary" icon={HardDriveDownload} disabled={!ready || running} loading={running} onClick={() => void run()}>
              Save backup…
            </Button>
          </>
        )
      }
    >
      {running || done ? (
        <div className="flex flex-col gap-4 py-1">
          <JobProgress state={job.state} title={file ?? "Backup"} doneLabel={job.state.result ? `Saved ${formatBytes(job.state.result.bytes)}` : "Saved"} />
          {done ? <p className="st-hint">{encrypted || usePw ? "The file is encrypted. Keep it somewhere other than this computer." : "This file is not encrypted. Store it somewhere private."}</p> : null}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {encrypted ? (
            <div className="st-protect">
              <Lock size={14} aria-hidden /> Already protected by your vault password and recovery key.
            </div>
          ) : null}
          <Checkbox checked={usePw} onCheckedChange={setUsePw} label={encrypted ? "Also add a separate backup password" : "Protect with a backup password"} description="Useful if you’ll restore on another computer or share the file with someone you trust." />
          {/* DESIGN §1.6: no height animation — the fields mount at full size and rise in; on removal they pop out of flow. */}
          <AnimatePresence initial={false} mode="popLayout">
            {usePw ? (
              <m.div key="pw" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0, transition: { opacity: { duration: 0.16 }, y: spring.settle } }} exit={{ opacity: 0, y: -4, transition: { duration: 0.12 } }}>
                <div className="flex flex-col gap-3 pt-1">
                  <PasswordField value={pw} onChange={setPw} label="Backup password" size="lg" purpose="new" helper="At least 8 characters. Ultranote can’t recover it." />
                  <PasswordField value={confirm} onChange={setConfirm} label="Confirm" size="lg" purpose="new" error={confirm && confirm !== pw ? "Passwords don’t match" : undefined} />
                </div>
              </m.div>
            ) : null}
          </AnimatePresence>
          <AnimatePresence initial={false} mode="popLayout">
            {plain ? (
              <m.div key="ack" layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.1 } }}>
                <Checkbox checked={ack} onCheckedChange={setAck} label="I understand this file is readable by anyone who has it" />
              </m.div>
            ) : null}
          </AnimatePresence>
        </div>
      )}
    </Dialog>
  );
}

function RestoreDialog({ grant, onClose }: { grant: FileGrant | null; onClose: () => void }) {
  const [mode, setMode] = useState<"password" | "recovery">("password");
  const [pw, setPw] = useState("");
  const [words, setWords] = useState("");
  const [error, setError] = useState<string | null>(null);
  const job = useJob<{ vaultId: string; pages: number }>();
  const [g, setG] = useState<FileGrant | null>(null);

  useEffect(() => {
    if (grant) {
      setG(grant);
      setPw("");
      setWords("");
      setError(null);
      setMode("password");
      job.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grant]);

  const running = job.state.phase === "running";
  const done = job.state.phase === "done";
  const list = words.trim().split(/\s+/).filter(Boolean);

  const run = async () => {
    if (!g) return;
    setError(null);
    try {
      await job.start((onEvent) => api.backup.restore({ grantId: g.grantId, password: mode === "password" && pw ? pw : undefined, recoveryWords: mode === "recovery" ? list : undefined, onEvent }));
      setPw("");
      setWords("");
    } catch (e) {
      // Grants are single use: ask for the file again after a failed attempt.
      setG(null);
      setError(hasCode(e, "BAD_PASSWORD") ? "Incorrect password." : hasCode(e, "AUTH_REQUIRED") ? "This backup is encrypted — enter its password or recovery key." : errorMessage(e));
    }
  };

  const repick = async () => {
    try {
      const [ng] = await api.file.pick({ purpose: "restore", filters: [{ name: "Ultranote backups", extensions: ["empbackup", "empsnap"] }], multiple: false });
      if (ng) {
        setG(ng);
        job.reset();
      }
    } catch (e) {
      notify.fromError(e, "Couldn’t open the file");
    }
  };

  const openRestored = async () => {
    onClose();
    if (backendMode === "tauri") {
      window.location.reload();
      return;
    }
    await Promise.all([useVault.getState().refresh(), useSettings.getState().load()]);
    await useWorkspace.getState().openDefault();
    navigate({ t: "home" }, { replace: true });
    notify.success("Opened the restored vault");
  };

  return (
    <Dialog
      open={!!grant}
      onOpenChange={(o) => !o && !running && onClose()}
      dismissible={!running}
      size="md"
      title="Restore from a backup"
      description={done ? undefined : "Ultranote checks the file’s seal, opens it with your key and restores it as a new vault. Your current workspace isn’t changed."}
      footer={
        done ? (
          <Button variant="primary" onClick={() => void openRestored()}>
            Open restored vault
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={running}>
              Cancel
            </Button>
            {g ? (
              <Button variant="primary" icon={ArchiveRestore} loading={running} disabled={running || (mode === "recovery" && list.length !== 24)} onClick={() => void run()}>
                Restore
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void repick()}>
                Choose the file again…
              </Button>
            )}
          </>
        )
      }
    >
      {running || done ? (
        <JobProgress state={job.state} title={g?.displayName ?? "Restore"} doneLabel={job.state.result ? `Restored ${job.state.result.pages} pages into a new vault` : "Restored"} />
      ) : (
        <div className="flex flex-col gap-4">
          {g ? (
            <div className="st-file">
              <Archive size={18} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="truncate text-body font-medium text-primary">{g.displayName}</div>
                <div className="text-caption text-tertiary">{formatBytes(g.size)}</div>
              </div>
            </div>
          ) : null}
          <Segmented size="sm" value={mode} onValueChange={setMode} options={[{ value: "password", label: "Password" }, { value: "recovery", label: "Recovery key" }]} aria-label="Unlock with" />
          {mode === "password" ? (
            <PasswordField value={pw} onChange={setPw} label="Password used when the backup was made" size="lg" purpose="current" helper="Leave empty for an unprotected backup." onEnter={() => void run()} />
          ) : (
            <Textarea label="24 recovery words" value={words} onChange={(e) => setWords(e.currentTarget.value)} minRows={3} maxRows={5} placeholder="word1 word2 word3 …" spellCheck={false} helper={`${list.length} of 24 words`} className="st-mono" />
          )}
          {error ? (
            <Banner tone="danger" inline>
              {error}
            </Banner>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
