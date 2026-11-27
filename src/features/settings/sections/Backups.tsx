/**
 * Backups & data (1.0 brief §2.4): automatic backups (on/off, where, how many), back up now, restore from a backup,
 * Import… (the one shared import dialog), Export everything and Trash retention. More options: the backup history
 * with Verify, a backup file to move to another computer, the backup password, the search index, background jobs and
 * the window layout reset.
 *
 * Automatic backups are snapshots (`.empsnap`) taken daily and when you quit. They are always sealed: with the
 * workspace key when it is encrypted, otherwise with a backup password the person sets here (never written as plain
 * files, since they often sit in a synced folder). The folder is chosen in the native folder dialog (Rust).
 */
import { Archive, ArchiveRestore, CheckCircle2, Download, FolderOpen, HardDriveDownload, Lock, ShieldCheck, Upload, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { api, backendMode, errorMessage, hasCode } from "@/backend";
import type { FileGrant, JobEvent, SnapshotInfo, VaultSettings } from "@/backend/types";
import { navigate } from "@/app/router";
import { formatDate, formatRelative, formatTime, isoDay } from "@/lib/dates";
import { formatBytes } from "@/lib/format";
import { selectRunningJobs, useJobs } from "@/stores/jobs";
import { useSettings } from "@/stores/settings";
import { notify } from "@/stores/toasts";
import { useTree } from "@/stores/tree";
import { SIDEBAR_DEFAULT, useUi } from "@/stores/ui";
import { useVault } from "@/stores/vault";
import { useWorkspace } from "@/stores/workspace";
import { useShallow } from "zustand/react/shallow";
import { Banner } from "@/ui/Banner";
import { Button } from "@/ui/Button";
import { Checkbox } from "@/ui/Checkbox";
import { Dialog } from "@/ui/Dialog";
import { Progress } from "@/ui/Progress";
import { Ring } from "@/ui/Ring";
import { Segmented } from "@/ui/Segmented";
import { Select } from "@/ui/Select";
import { Switch } from "@/ui/Switch";
import { Textarea } from "@/ui/Textarea";
import { PasswordField } from "@/features/vault/PasswordField";
import { JobProgress, useJob } from "../JobProgress";
import { Block, Group, MoreOptions, Row, SectionHeader } from "../parts";
import { closeSettings } from "../close";
import { withReauth } from "../reauth";
import { useSecurityInfo } from "../security/score";

const emptyReq = <T,>(r: { onEvent: (e: JobEvent) => void }) => r as unknown as T;
const TRASH_DAYS = [7, 14, 30, 60, 90, 180, 365];
const BACKUP_FILTERS = [{ name: "Ultranote backups", extensions: ["empbackup", "empsnap"] }];

/** "How many" as one choice: the three retention counts behind it. */
const KEEP = [
  { value: "week", label: "About a week", daily: 7, weekly: 0, monthly: 0 },
  { value: "month", label: "About a month", daily: 7, weekly: 4, monthly: 0 },
  { value: "half", label: "About six months", daily: 7, weekly: 4, monthly: 6 },
  { value: "year", label: "About a year", daily: 7, weekly: 4, monthly: 12 },
] as const;

function keepValue(s: VaultSettings["snapshots"]): string {
  return KEEP.find((k) => k.daily === s.keepDaily && k.weekly === s.keepWeekly && k.monthly === s.keepMonthly)?.value ?? "custom";
}

export function BackupsSection() {
  const vault = useSettings((s) => s.vault) as VaultSettings;
  const setVault = useSettings((s) => s.setVault);
  const snapshots = useSecurityInfo((s) => s.snapshots);
  const status = useSecurityInfo((s) => s.snapStatus);
  const snapJob = useJob<{ id: string }>();
  const [pwDialog, setPwDialog] = useState<null | { then?: "snapshot" }>(null);
  const [backupOpen, setBackupOpen] = useState(false);
  const [restoreGrant, setRestoreGrant] = useState<FileGrant | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const s = vault.snapshots;
  const refresh = () => useSecurityInfo.getState().refreshSnapshots();

  useEffect(() => {
    void refresh();
  }, []);

  const encrypted = status?.encrypted ?? !!useVault.getState().status?.encrypted;
  const canSnapshot = encrypted || !!status?.backupPasswordSet;
  const automatic = !!status?.automatic;

  const snapshotNow = async () => {
    if (!canSnapshot) return setPwDialog({ then: "snapshot" });
    try {
      await snapJob.start((onEvent) => api.snapshot.now(emptyReq<Parameters<typeof api.snapshot.now>[0]>({ onEvent })));
      await refresh();
      window.setTimeout(() => snapJob.reset(), 2400);
    } catch (e) {
      notify.fromError(e, "Couldn’t back up");
    }
  };

  const setAutomatic = async (on: boolean) => {
    if (on && !canSnapshot) return setPwDialog({});
    await setVault({ snapshots: { ...s, enabled: on } });
    await refresh();
  };

  const chooseFolder = async () => {
    try {
      const st = await api.snapshot.chooseFolder();
      if (!st) return;
      await useSettings.getState().load();
      await refresh();
      notify.success("New backups go to that folder", { description: "Earlier backups stay where they are and still show here." });
    } catch (e) {
      notify.fromError(e, "Couldn’t use that folder");
    }
  };

  const useDefaultFolder = async () => {
    try {
      await api.snapshot.setFolder({ grantId: null });
      await useSettings.getState().load();
      await refresh();
    } catch (e) {
      notify.fromError(e, "Couldn’t change the folder");
    }
  };

  const reveal = async () => {
    try {
      await api.snapshot.reveal();
    } catch (e) {
      if (hasCode(e, "UNSUPPORTED")) notify.info("Not available here", { description: errorMessage(e) });
      else notify.fromError(e, "Couldn’t open the folder");
    }
  };

  const pickRestore = async () => {
    try {
      const [g] = await api.file.pick({ purpose: "restore", filters: BACKUP_FILTERS, multiple: false });
      if (g) setRestoreGrant(g);
    } catch (e) {
      notify.fromError(e, "Couldn’t open the file");
    }
  };

  const latest = snapshots?.[0];
  const where = s.folderGrantLabel ? s.folderGrantLabel : "Ultranote’s data folder";
  const keep = keepValue(s);

  return (
    <div>
      <SectionHeader title="Backups & data" description="Copies of your workspace, and getting things in and out." />

      <Group>
        <Row
          id="snapshots"
          label="Automatic backups"
          description={
            automatic
              ? `Every day and when you quit. ${encrypted ? "Sealed with your workspace password." : "Sealed with your backup password."}`
              : encrypted
                ? "Off. Turn on to keep a daily copy."
                : "Off. Backups of an unencrypted workspace are protected with a backup password, which you set when you turn this on."
          }
        >
          <Switch checked={automatic} disabled={!status} onCheckedChange={(v) => void setAutomatic(v)} aria-label="Automatic backups" />
        </Row>
        <Row
          id="backup-location"
          label="Where"
          description={
            status?.customFolder ? (
              <>
                <span className="st-mono st-path">{status.folderPath}</span>
                {status.folderUnavailable ? <span className="block">{`${where} can’t be reached right now, so backups go to Ultranote’s data folder until it’s back.`}</span> : null}
              </>
            ) : (
              <span title={status?.folderPath}>Ultranote’s data folder on this computer. Choose a synced folder (Dropbox, iCloud Drive, a network drive) to keep a copy somewhere else.</span>
            )
          }
        >
          {status?.customFolder ? (
            <Button size="sm" variant="ghost" onClick={() => void useDefaultFolder()}>
              Use default
            </Button>
          ) : null}
          {backendMode === "tauri" ? (
            <Button size="sm" variant="ghost" icon={FolderOpen} onClick={() => void reveal()}>
              Show
            </Button>
          ) : null}
          <Button size="sm" variant="secondary" onClick={() => void chooseFolder()}>
            Choose folder…
          </Button>
        </Row>
        <Row id="backup-keep" label="How many to keep" description="Older backups are removed as new ones arrive.">
          <Select
            size="sm"
            value={keep}
            onValueChange={(v) => {
              const k = KEEP.find((x) => x.value === v);
              if (k) void setVault({ snapshots: { ...s, keepDaily: k.daily, keepWeekly: k.weekly, keepMonthly: k.monthly } });
            }}
            options={[...KEEP.map((k) => ({ value: k.value, label: k.label, description: `${k.daily} daily${k.weekly ? `, ${k.weekly} weekly` : ""}${k.monthly ? `, ${k.monthly} monthly` : ""}` })), ...(keep === "custom" ? [{ value: "custom", label: `${s.keepDaily} daily, ${s.keepWeekly} weekly, ${s.keepMonthly} monthly` }] : [])]}
            className="w-[200px]"
            aria-label="How many backups to keep"
          />
        </Row>
        <Row id="backup-now" label="Back up now" description={latest ? `Latest ${formatRelative(latest.at)} · ${formatBytes(latest.bytes)} · ${snapshots?.length ?? 0} kept` : "No backups yet."}>
          <Button size="sm" variant="secondary" icon={Archive} loading={snapJob.state.phase === "running"} onClick={() => void snapshotNow()}>
            Back up now
          </Button>
        </Row>
        {snapJob.state.phase === "running" || snapJob.state.phase === "done" ? (
          <Block>
            <JobProgress state={snapJob.state} title="Backing up" onCancel={snapJob.cancel} doneLabel="Backup saved" />
          </Block>
        ) : null}
        <Row id="restore" label="Restore from a backup" description="Opens it as a new workspace, so nothing here is overwritten.">
          <Button size="sm" variant="secondary" icon={ArchiveRestore} onClick={() => void pickRestore()}>
            Choose file…
          </Button>
        </Row>
      </Group>

      <Group>
        <Row id="import" label="Import" description="Notion, Markdown and Obsidian, CSV and Excel, calendars. Every import can be undone.">
          <Button
            size="sm"
            variant="secondary"
            icon={Upload}
            onClick={() => {
              closeSettings();
              useUi.getState().setImportOpen(true);
            }}
          >
            Import…
          </Button>
        </Row>
        <Row id="export-everything" label="Export everything" description="One zip with every page, database, spreadsheet, attachment and calendar, in open formats.">
          <Button size="sm" variant="secondary" icon={Download} onClick={() => setExportOpen(true)}>
            Export everything…
          </Button>
        </Row>
        <Row id="trash-retention" label="Keep items in Trash" description="Pages in Trash are deleted for good after this long.">
          <Select size="sm" value={String(vault.trashRetentionDays)} onValueChange={(v) => void setVault({ trashRetentionDays: Number(v) })} options={(TRASH_DAYS.includes(vault.trashRetentionDays) ? TRASH_DAYS : [...TRASH_DAYS, vault.trashRetentionDays].sort((a, b) => a - b)).map((n) => ({ value: String(n), label: n === 365 ? "1 year" : `${n} days` }))} className="w-[150px]" aria-label="Keep items in Trash" />
        </Row>
      </Group>

      <MoreOptions section="data">
        <SnapshotHistory snapshots={snapshots} />
        <Group title="Backup file and password">
          <Row id="backup-file" label="Save a backup file" description="One .empbackup file with everything, to move to another computer or keep an archive.">
            <Button size="sm" variant="secondary" icon={HardDriveDownload} onClick={() => setBackupOpen(true)}>
              Save backup file…
            </Button>
          </Row>
          {!encrypted && status?.backupPasswordSet ? (
            <Row id="backup-password" label="Backup password" description="Protects automatic backups of this workspace. Removing it stops them.">
              <Button size="sm" variant="ghost" onClick={() => setPwDialog({})}>
                Change…
              </Button>
              <Button
                size="sm"
                variant="destructive-ghost"
                onClick={async () => {
                  try {
                    useSecurityInfo.setState({ snapStatus: await api.snapshot.setBackupPassword({ password: null }) });
                    notify.info("Backup password removed", { description: "Automatic backups are off." });
                  } catch (e) {
                    notify.fromError(e, "Couldn’t remove it");
                  }
                }}
              >
                Remove
              </Button>
            </Row>
          ) : null}
        </Group>
        <Maintenance />
      </MoreOptions>

      <BackupPasswordDialog
        open={!!pwDialog}
        onClose={() => setPwDialog(null)}
        onSaved={async () => {
          const then = pwDialog?.then;
          setPwDialog(null);
          await refresh();
          await useSettings.getState().load();
          if (then === "snapshot") void snapshotNow();
          else notify.success("Automatic backups are on");
        }}
      />
      <CreateBackupDialog open={backupOpen} onOpenChange={setBackupOpen} encrypted={encrypted} />
      <RestoreDialog grant={restoreGrant} onClose={() => setRestoreGrant(null)} />
      <ExportEverythingDialog open={exportOpen} onOpenChange={setExportOpen} encrypted={encrypted} />
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── history

function SnapshotHistory({ snapshots }: { snapshots: SnapshotInfo[] | null }) {
  return (
    <Group id="snapshot-list" title="Backup history" description="Verify re-checks a backup’s seal without restoring it.">
      {snapshots && snapshots.length ? (
        <ol className="st-snaps">
          {snapshots.map((sn, i) => (
            <li key={sn.id}>
              <SnapshotRow sn={sn} latest={i === 0} />
            </li>
          ))}
        </ol>
      ) : (
        <Row label="No backups yet" description="Turn on automatic backups or back up now." />
      )}
    </Group>
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
      if (!r.ok) notify.error("This backup failed the check", { description: "It may have been changed outside Ultranote. Don’t restore from it." });
    } catch (e) {
      setVerify(null);
      notify.fromError(e, "Couldn’t check the backup");
    }
  };
  const today = isoDay(sn.at) === isoDay();
  return (
    <div className="st-snap">
      <div className="min-w-0 flex-1">
        <div className="st-snap-title">
          {today ? `Today, ${formatTime(sn.at)}` : `${formatDate(sn.at)}, ${formatTime(sn.at)}`}
          {latest ? <span className="st-tag">Latest</span> : null}
        </div>
        <div className="st-snap-meta tabular">
          {formatBytes(sn.bytes)} · {sn.location === "folder" ? "chosen folder" : "data folder"}
        </div>
      </div>
      {verify && "p" in verify ? (
        <span className="flex items-center gap-2 text-caption text-tertiary">
          <Ring value={verify.p} size={24} aria-label="Checking" /> Checking
        </span>
      ) : verify && "ok" in verify ? (
        <span className="st-verify" data-ok={verify.ok ? "" : undefined}>
          {verify.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />} {verify.ok ? "Verified" : "Failed"}
        </span>
      ) : (
        <Button size="xs" variant="ghost" icon={ShieldCheck} onClick={() => void run()}>
          Verify
        </Button>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── maintenance

const JOB_LABEL: Record<string, string> = {
  search_reindex: "Rebuilding the search index",
  snapshot_now: "Backing up",
  snapshot_verify: "Checking a backup",
  backup_create: "Saving a backup file",
  backup_restore: "Restoring a backup",
  export_pages: "Exporting pages",
  export_everything: "Exporting everything",
  import_markdown: "Importing Markdown",
  import_notion: "Importing from Notion",
  import_ics: "Importing a calendar",
  vault_integrity_check: "Running the integrity check",
  vault_enable_encryption: "Encrypting",
  vault_disable_encryption: "Decrypting",
};

function Maintenance() {
  const [index, setIndex] = useState<{ ready: boolean; docs: number; building: boolean } | null>(null);
  const reindex = useJob<void>();
  const running = useJobs(useShallow(selectRunningJobs));
  const loadIndex = () => api.search.status().then(setIndex).catch(() => setIndex(null));
  useEffect(() => {
    void loadIndex();
  }, []);
  const rebuild = async () => {
    try {
      await reindex.start((onEvent: (e: JobEvent) => void) => api.search.reindex({ onEvent } as unknown as Parameters<typeof api.search.reindex>[0]));
      await loadIndex();
    } catch (e) {
      notify.fromError(e, "Couldn’t rebuild the index");
    }
  };
  return (
    <Group title="Maintenance">
      <Row id="search-index" label="Search index" description={index ? (index.ready ? `${index.docs.toLocaleString()} pages indexed. Rebuilt after each unlock.` : "Building…") : "Checking…"}>
        <Button size="sm" variant="secondary" loading={reindex.state.phase === "running"} onClick={() => void rebuild()}>
          Rebuild
        </Button>
      </Row>
      {reindex.state.phase !== "idle" ? (
        <Block>
          <JobProgress state={reindex.state} title="Rebuilding the search index" doneLabel="Index rebuilt" />
        </Block>
      ) : null}
      <Row id="jobs" label="Background jobs" description={running.length ? undefined : "Nothing running. Imports, exports and backups show here while they run."} />
      {running.map((j) => (
        <Block key={j.jobId} className="flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-body-sm font-medium text-primary">{JOB_LABEL[j.command] ?? j.command.replace(/_/g, " ")}</div>
            <div className="mt-1.5">
              <Progress value={j.progress ?? 0} indeterminate={j.progress === null} size={2} aria-label="Job progress" />
            </div>
            <div className="mt-1 text-caption text-tertiary">
              {j.label ?? "Working"} · started {formatRelative(j.startedAt)}
            </div>
          </div>
          <Button size="xs" variant="ghost" onClick={() => void useJobs.getState().cancel(j.jobId).catch(() => undefined)}>
            Cancel
          </Button>
        </Block>
      ))}
      <Row id="reset-layout" label="Reset window layout" description="Sidebar width, right panel and zoom go back to their defaults.">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const ui = useUi.getState();
            ui.setSidebarWidth(SIDEBAR_DEFAULT);
            ui.setSidebarCollapsed(false);
            ui.zoomReset();
            if (ui.rightPanelOpen) ui.toggleRightPanel();
            notify.success("Layout reset");
          }}
        >
          Reset
        </Button>
      </Row>
    </Group>
  );
}

// ───────────────────────────────────────────────────────────────────────────── dialogs

/** Unencrypted workspaces: the password automatic backups are sealed with. */
function BackupPasswordDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setPw("");
      setConfirm("");
      setError(null);
    }
  }, [open]);
  const long = [...pw].length >= 10;
  const ok = long && pw === confirm;
  const save = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      useSecurityInfo.setState({ snapStatus: await api.snapshot.setBackupPassword({ password: pw }) });
      setPw("");
      setConfirm("");
      await onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !busy && onClose()}
      size="md"
      title="Set a backup password"
      description="Your workspace isn’t encrypted, so automatic backups are sealed with this password instead. You’ll need it to restore one. Ultranote can’t recover it."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" icon={Lock} disabled={!ok} loading={busy} onClick={() => void save()}>
            Save and turn on
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <PasswordField value={pw} onChange={setPw} label="Backup password" size="lg" purpose="new" helper="At least 10 characters." autoFocus />
        <PasswordField value={confirm} onChange={setConfirm} label="Confirm" size="lg" purpose="new" error={confirm && confirm !== pw ? "Passwords don’t match" : undefined} onEnter={() => void save()} />
        {error ? (
          <Banner tone="danger" inline>
            {error}
          </Banner>
        ) : null}
      </div>
    </Dialog>
  );
}

function CreateBackupDialog({ open, onOpenChange, encrypted }: { open: boolean; onOpenChange: (o: boolean) => void; encrypted: boolean }) {
  const [usePw, setUsePw] = useState(!encrypted);
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const job = useJob<{ bytes: number }>();
  const [file, setFile] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setUsePw(!encrypted);
      setPw("");
      setConfirm("");
      setFile(null);
      job.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const running = job.state.phase === "running";
  const done = job.state.phase === "done";
  // Rust refuses unprotected backup files of an unencrypted workspace, so a password is required there.
  const needsPw = !encrypted || usePw;
  const ready = !needsPw || ([...pw].length >= 8 && pw === confirm);

  const run = async () => {
    try {
      const g = await api.file.saveGrant({ purpose: "backup", suggestedName: `Ultranote Backup ${isoDay()}.empbackup`, filters: [{ name: "Ultranote backup", extensions: ["empbackup"] }] });
      if (!g) return;
      setFile(g.displayName);
      await job.start((onEvent) => api.backup.create({ grantId: g.grantId, password: needsPw && pw ? pw : undefined, onEvent }));
      setPw("");
      setConfirm("");
    } catch (e) {
      notify.fromError(e, "Couldn’t save the backup");
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !running && onOpenChange(o)}
      dismissible={!running}
      size="md"
      title="Save a backup file"
      description={done ? undefined : "Everything in this workspace, including attachments and settings, in one file."}
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
              Save…
            </Button>
          </>
        )
      }
    >
      {running || done ? (
        <div className="flex flex-col gap-4 py-1">
          <JobProgress state={job.state} title={file ?? "Backup"} doneLabel={job.state.result ? `Saved ${formatBytes(job.state.result.bytes)}` : "Saved"} />
          {done ? <p className="st-hint">The file is protected. Keep it somewhere other than this computer.</p> : null}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {encrypted ? (
            <>
              <div className="st-protect">
                <Lock size={14} aria-hidden /> Protected by your workspace password and recovery key.
              </div>
              <Checkbox checked={usePw} onCheckedChange={setUsePw} label="Also add a separate password" description="Useful if someone you trust will restore it." />
            </>
          ) : (
            <p className="st-hint">Your workspace isn’t encrypted, so the file is protected with a password you choose here.</p>
          )}
          {needsPw ? (
            <div className="flex flex-col gap-3">
              <PasswordField value={pw} onChange={setPw} label="Backup password" size="lg" purpose="new" helper="At least 8 characters. Ultranote can’t recover it." />
              <PasswordField value={confirm} onChange={setConfirm} label="Confirm" size="lg" purpose="new" error={confirm && confirm !== pw ? "Passwords don’t match" : undefined} />
            </div>
          ) : null}
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
      setError(hasCode(e, "BAD_PASSWORD", "CRYPTO") ? "That password or recovery key doesn’t open this backup." : hasCode(e, "AUTH_REQUIRED") ? "This backup is protected. Enter its password or recovery key." : errorMessage(e));
    }
  };

  const repick = async () => {
    try {
      const [ng] = await api.file.pick({ purpose: "restore", filters: BACKUP_FILTERS, multiple: false });
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
    // The desktop app restarts into the restored workspace by itself.
    if (backendMode === "tauri") return;
    await Promise.all([useVault.getState().refresh(), useSettings.getState().load()]);
    await useWorkspace.getState().openDefault();
    navigate({ t: "home" }, { replace: true });
    notify.success("Opened the restored workspace");
  };

  return (
    <Dialog
      open={!!grant}
      onOpenChange={(o) => !o && !running && onClose()}
      dismissible={!running}
      size="md"
      title="Restore from a backup"
      description={done ? undefined : "Ultranote checks the backup, opens it with its password and restores it as a new workspace. This one isn’t changed."}
      footer={
        done ? (
          <Button variant="primary" onClick={() => void openRestored()}>
            {backendMode === "tauri" ? "Restarting…" : "Open restored workspace"}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={running}>
              Cancel
            </Button>
            {g ? (
              <Button variant="primary" icon={ArchiveRestore} loading={running} disabled={running || (mode === "recovery" && list.length !== 24) || (mode === "password" && !pw)} onClick={() => void run()}>
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
        <JobProgress state={job.state} title={g?.displayName ?? "Restore"} doneLabel={job.state.result ? `Restored ${job.state.result.pages} pages into a new workspace` : "Restored"} />
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
          <Segmented size="sm" value={mode} onValueChange={setMode} options={[{ value: "password", label: "Password" }, { value: "recovery", label: "Recovery key" }]} aria-label="Open with" />
          {mode === "password" ? (
            <PasswordField value={pw} onChange={setPw} label="Password" size="lg" purpose="current" helper="The workspace password when the backup was made, or its backup password." onEnter={() => void run()} />
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

function ExportEverythingDialog({ open, onOpenChange, encrypted }: { open: boolean; onOpenChange: (o: boolean) => void; encrypted: boolean }) {
  const byId = useTree((s) => s.byId);
  const [ack, setAck] = useState(false);
  const job = useJob<{ bytes: number }>();
  const [file, setFile] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setAck(false);
      setFile(null);
      job.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  let pages = 0;
  let dbs = 0;
  let sheets = 0;
  for (const p of byId.values()) {
    if (p.deletedAt || p.flags.template) continue;
    if (p.kind === "database") dbs++;
    else if (p.kind === "sheet") sheets++;
    else pages++;
  }
  const running = job.state.phase === "running";
  const done = job.state.phase === "done";
  const run = async () => {
    try {
      await withReauth("export everything", async () => {
        const g = await api.file.saveGrant({ purpose: "export", suggestedName: `Ultranote Export ${isoDay()}.zip`, filters: [{ name: "Zip archive", extensions: ["zip"] }] });
        if (!g) return null;
        setFile(g.displayName);
        return job.start((onEvent) => api.export.everything({ grantId: g.grantId, onEvent }));
      });
    } catch (e) {
      if (!hasCode(e, "CANCELLED")) notify.error("The export didn’t finish", { description: errorMessage(e) });
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !running && onOpenChange(o)}
      dismissible={!running}
      size="md"
      title="Export everything"
      description={done ? undefined : `${pages} ${pages === 1 ? "page" : "pages"}, ${dbs} ${dbs === 1 ? "database" : "databases"} and ${sheets} ${sheets === 1 ? "spreadsheet" : "spreadsheets"} as Markdown, CSV, Excel and calendar files in one zip, with a checksum for each file.`}
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
            <Button variant="primary" icon={Download} disabled={(encrypted && !ack) || running} loading={running} onClick={() => void run()}>
              Export…
            </Button>
          </>
        )
      }
    >
      {running || done ? (
        <JobProgress state={job.state} title={file ?? "Export"} onCancel={job.cancel} doneLabel={job.state.result ? `Saved ${formatBytes(job.state.result.bytes)}` : "Saved"} />
      ) : encrypted ? (
        <Checkbox checked={ack} onCheckedChange={setAck} label="I understand the zip isn’t encrypted" description="Anyone with the file can read it. You’ll confirm your password." />
      ) : (
        <p className="st-hint">The zip isn’t encrypted. Keep it somewhere private.</p>
      )}
    </Dialog>
  );
}

