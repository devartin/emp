/**
 * Import (sidebar → Import, palette "Import…", onboarding "Import from Notion, Markdown or CSV"). Picks a file through
 * a grant (§9.14), detects what it is (`import_detect`) and runs the right importer as a job with progress:
 * Markdown / folders, Notion export zips, ICS, CSV (new database) and XLSX (new workbook). Bank files go to Money HQ's
 * import wizard and EMP backups to Settings → Backups, where they belong. Finished imports offer Undo.
 */
import { CalendarDays, CheckCircle2, FileArchive, FileSpreadsheet, FileText, FileUp, Landmark, RotateCcw, Table, UploadCloud } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useState } from "react";
import { navigate } from "@/app/router";
import { api, errorMessage, hasCode } from "@/backend";
import type { FileGrant, ImportKind } from "@/backend/types";
import { formatBytes } from "@/lib/format";
import { notify } from "@/stores/toasts";
import { useTree } from "@/stores/tree";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { Banner } from "@/ui/Banner";
import { Button } from "@/ui/Button";
import { Dialog } from "@/ui/Dialog";
import { FileDropZone } from "@/ui/FileDropZone";
import { Progress } from "@/ui/Progress";
import { Spinner } from "@/ui/Spinner";

type Phase =
  | { t: "pick" }
  | { t: "detecting"; grant: FileGrant }
  | { t: "ready"; grant: FileGrant; kind: ImportKind }
  | { t: "running"; grant: FileGrant; kind: ImportKind; done: number; total: number; label?: string }
  | { t: "done"; summary: string; warnings: string[]; jobId?: string; openId?: string }
  | { t: "error"; message: string; grant?: FileGrant };

const KIND: Partial<Record<ImportKind, { label: string; icon: typeof FileText; note: string }>> = {
  markdown: { label: "Markdown file", icon: FileText, note: "Becomes a page. Front matter, tables, tasks and images are kept." },
  markdown_folder: { label: "Markdown folder", icon: FileArchive, note: "Each file becomes a page; folders become parent pages." },
  notion_zip: { label: "Notion export", icon: FileArchive, note: "Pages, databases, relations and attachments are rebuilt as EMP pages and databases." },
  ics: { label: "Calendar file", icon: CalendarDays, note: "Events are added to your EMP calendar." },
  csv: { label: "CSV file", icon: Table, note: "Becomes a new database. Column types are detected from the values." },
  xlsx: { label: "Excel workbook", icon: FileSpreadsheet, note: "Becomes a new workbook with formulas and formatting." },
};

const ACCEPT = ["md", "markdown", "zip", "csv", "xlsx", "ics", "ofx", "qfx", "qif", "empbackup"];

export function ImportDialog() {
  const open = useUi((s) => s.importOpen);
  const setOpen = useUi((s) => s.setImportOpen);
  const dropped = useUi((s) => s.droppedFiles);
  const wsId = useWorkspace((s) => s.workspace?.id);
  const [phase, setPhase] = useState<Phase>({ t: "pick" });

  useEffect(() => {
    if (open) setPhase({ t: "pick" });
  }, [open]);

  // Desktop drag-and-drop arrives as grants via `file:dropped`.
  useEffect(() => {
    if (!open || !dropped?.grants.length) return;
    void detect(dropped.grants[0]);
    useUi.getState().setDroppedFiles(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropped, open]);

  const detect = async (grant: FileGrant) => {
    setPhase({ t: "detecting", grant });
    try {
      const r = await api.import.detect({ grantId: grant.grantId });
      setPhase({ t: "ready", grant, kind: r.kind });
    } catch (e) {
      setPhase({ t: "error", message: errorMessage(e) || "Couldn't read that file", grant });
    }
  };

  const pick = async () => {
    try {
      const grants = await api.file.pick({ purpose: "import", filters: [{ name: "Importable files", extensions: ACCEPT }], multiple: false });
      if (grants[0]) await detect(grants[0]);
    } catch (e) {
      notify.fromError(e, "Couldn't open the file");
    }
  };

  const run = async (grant: FileGrant, kind: ImportKind) => {
    if (!wsId) return;
    const onEvent = (e: { kind: string; done?: number; total?: number; label?: string }) => {
      if (e.kind === "progress") setPhase({ t: "running", grant, kind, done: e.done ?? 0, total: e.total ?? 0, label: e.label });
    };
    setPhase({ t: "running", grant, kind, done: 0, total: 0 });
    try {
      if (kind === "markdown" || kind === "markdown_folder") {
        const job = await api.import.markdown({ grantId: grant.grantId, workspaceId: wsId, parentId: null, onEvent });
        const r = await job.result;
        setPhase({ t: "done", summary: `Imported ${r.pages} ${r.pages === 1 ? "page" : "pages"}.`, warnings: r.warnings, jobId: job.jobId });
      } else if (kind === "notion_zip") {
        const job = await api.import.notion({ grantId: grant.grantId, workspaceId: wsId, parentId: null, onEvent });
        const r = await job.result;
        const parts = [`${r.pages} pages`, r.databases ? `${r.databases} databases (${r.rows} rows)` : null, r.assets ? `${r.assets} attachments` : null].filter(Boolean);
        const unresolved = r.unresolved.length ? [`${r.unresolved.length} links couldn't be matched: ${r.unresolved.slice(0, 3).map((u) => u.title).join(", ")}${r.unresolved.length > 3 ? "…" : ""}`] : [];
        setPhase({ t: "done", summary: `Imported ${parts.join(", ")}.`, warnings: [...unresolved, ...r.warnings], jobId: job.jobId });
      } else if (kind === "ics") {
        const job = await api.import.ics({ grantId: grant.grantId, target: "calendar", onEvent });
        const r = await job.result;
        setPhase({ t: "done", summary: `Added ${r.events} ${r.events === 1 ? "event" : "events"} to your calendar.`, warnings: [], jobId: job.jobId });
      } else if (kind === "csv") {
        const title = grant.displayName.replace(/\.[^.]+$/, "") || "Imported data";
        const job = await api.db.importCsv({ grantId: grant.grantId, target: { workspaceId: wsId, parentId: null, title }, onEvent });
        const r = await job.result;
        setPhase({ t: "done", summary: `Created “${title}” with ${r.inserted} rows.`, warnings: [], openId: r.databaseId });
      } else if (kind === "xlsx") {
        const job = await api.sheet.importFile({ grantId: grant.grantId, workspaceId: wsId, parentId: null, asDatabase: false, onEvent });
        const r = await job.result;
        useTree.getState().upsert([r.page]);
        setPhase({ t: "done", summary: `Created “${r.page.title || "Untitled"}”.`, warnings: r.warnings, openId: r.page.id });
      }
    } catch (e) {
      if (hasCode(e, "CANCELLED")) return setPhase({ t: "ready", grant, kind });
      setPhase({ t: "error", message: errorMessage(e) || "The import didn't finish", grant });
    }
  };

  const undo = async (jobId: string) => {
    try {
      const { removed } = await api.import.undo({ importJobId: jobId });
      notify.success("Import undone", { description: `Removed ${removed} ${removed === 1 ? "item" : "items"}.` });
      setOpen(false);
    } catch (e) {
      notify.fromError(e, "Couldn't undo the import");
    }
  };

  const busy = phase.t === "running" || phase.t === "detecting";

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)} dismissible={!busy} size="md" title="Import" description="Bring in notes, exports and data. Files are read on this device; nothing is uploaded.">
      <AnimatePresence mode="wait" initial={false}>
        <m.div key={phase.t} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: 0.16 } }} exit={{ opacity: 0, transition: { duration: 0.1 } }}>
          {phase.t === "pick" ? (
            <div className="flex flex-col gap-4">
              <FileDropZone
                onBrowse={() => void pick()}
                onFiles={() => notify.info("Click to choose the file", { description: "In this preview, files are opened through the file picker." })}
                icon={UploadCloud}
                title="Choose a file to import"
                hint="Markdown, Notion export (.zip), CSV, Excel, calendar (.ics)"
                accept={ACCEPT.map((e) => `.${e}`)}
              />
              <ul className="grid grid-cols-3 gap-2 text-caption text-tertiary" style={{ fontWeight: 400 }}>
                <li className="flex items-center gap-1.5"><FileArchive size={13} aria-hidden /> Notion workspaces</li>
                <li className="flex items-center gap-1.5"><FileText size={13} aria-hidden /> Markdown and Obsidian</li>
                <li className="flex items-center gap-1.5"><Table size={13} aria-hidden /> CSV and Excel</li>
              </ul>
            </div>
          ) : null}
          {phase.t === "detecting" ? (
            <div className="flex items-center gap-3 py-6 text-body text-secondary">
              <Spinner /> Reading {phase.grant.displayName}…
            </div>
          ) : null}
          {phase.t === "ready" ? <Ready grant={phase.grant} kind={phase.kind} onRun={() => void run(phase.grant, phase.kind)} onPickAgain={() => setPhase({ t: "pick" })} onClose={() => setOpen(false)} /> : null}
          {phase.t === "running" ? (
            <div className="flex flex-col gap-3 py-2">
              <div className="flex items-center gap-3">
                <FileUp size={18} className="text-tertiary" aria-hidden />
                <span className="flex-1 truncate text-body text-primary">{phase.grant.displayName}</span>
                <span className="text-caption text-tertiary tabular">{phase.total ? `${phase.done} / ${phase.total}` : ""}</span>
              </div>
              <Progress value={phase.total ? phase.done / phase.total : 0} indeterminate={!phase.total} aria-label="Import progress" />
              <p className="truncate text-caption text-tertiary" style={{ fontWeight: 400 }}>
                {phase.label ?? "Importing…"}
              </p>
            </div>
          ) : null}
          {phase.t === "done" ? (
            <div className="flex flex-col gap-4">
              <div className="flex items-start gap-3">
                <CheckCircle2 size={20} className="mt-0.5 flex-none text-gain-text" aria-hidden />
                <p className="text-body text-primary">{phase.summary}</p>
              </div>
              {phase.warnings.length ? (
                <Banner tone="warning" inline>
                  {phase.warnings.slice(0, 4).join(" · ")}
                </Banner>
              ) : null}
              <div className="flex justify-end gap-2">
                {phase.jobId ? (
                  <Button variant="ghost" icon={RotateCcw} onClick={() => undo(phase.jobId as string)}>
                    Undo import
                  </Button>
                ) : null}
                {phase.openId ? (
                  <Button
                    onClick={() => {
                      setOpen(false);
                      navigate({ t: "page", id: phase.openId as string });
                    }}
                  >
                    Open
                  </Button>
                ) : null}
                <Button variant="primary" onClick={() => setOpen(false)}>
                  Done
                </Button>
              </div>
            </div>
          ) : null}
          {phase.t === "error" ? (
            <div className="flex flex-col gap-4">
              <Banner tone="danger" inline>
                {phase.message}
              </Banner>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setOpen(false)}>
                  Close
                </Button>
                <Button variant="primary" onClick={() => setPhase({ t: "pick" })}>
                  Choose another file
                </Button>
              </div>
            </div>
          ) : null}
        </m.div>
      </AnimatePresence>
    </Dialog>
  );
}

function Ready({ grant, kind, onRun, onPickAgain, onClose }: { grant: FileGrant; kind: ImportKind; onRun: () => void; onPickAgain: () => void; onClose: () => void }) {
  const info = KIND[kind];
  if (kind === "ofx" || kind === "qfx" || kind === "qif") {
    return (
      <Redirect icon={Landmark} title="Bank statement" body="Bank files are imported in Money HQ, where you can map them to an account and review each transaction." action="Open life apps" onAction={() => (onClose(), navigate({ t: "lifeapps", appId: "money-hq" }))} onPickAgain={onPickAgain} />
    );
  }
  if (kind === "empbackup") {
    return <Redirect icon={FileArchive} title="EMP backup" body="Backups are restored from Settings → Backups. A restore always opens as a new vault, so nothing here is overwritten." action="Open Backups" onAction={() => (onClose(), navigate({ t: "settings", section: "backups" }))} onPickAgain={onPickAgain} />;
  }
  if (!info) {
    return <Redirect icon={FileText} title="Unsupported file" body={`EMP can't import ${grant.displayName}. Try Markdown, a Notion export zip, CSV, XLSX or an .ics calendar.`} onPickAgain={onPickAgain} />;
  }
  const Icon = info.icon;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3 rounded-xl border border-subtle bg-surface-2 p-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-[10px] border border-subtle bg-surface-1">
          <Icon size={20} className="text-secondary" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-body font-medium text-primary">{grant.displayName}</p>
          <p className="text-caption text-tertiary" style={{ fontWeight: 400 }}>
            {info.label} · {formatBytes(grant.size)}
          </p>
        </div>
      </div>
      <p className="text-body-sm text-secondary">{info.note}</p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onPickAgain}>
          Choose another
        </Button>
        <Button variant="primary" onClick={onRun} autoFocus>
          Import
        </Button>
      </div>
    </div>
  );
}

function Redirect({ icon: Icon, title, body, action, onAction, onPickAgain }: { icon: typeof FileText; title: string; body: string; action?: string; onAction?: () => void; onPickAgain: () => void }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <Icon size={20} className="mt-0.5 flex-none text-tertiary" aria-hidden />
        <div>
          <p className="text-body font-medium text-primary">{title}</p>
          <p className="mt-1 text-body-sm text-secondary">{body}</p>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onPickAgain}>
          Choose another
        </Button>
        {action ? (
          <Button variant="primary" onClick={onAction}>
            {action}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export default ImportDialog;
