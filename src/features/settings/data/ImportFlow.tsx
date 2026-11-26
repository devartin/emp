/**
 * Import flow (§17.4, §17.5, §9.16): detect → confirm (destination, options) → job progress → report with
 * clickable results and Undo. Handles Markdown files and folders, Notion export zips, CSV (new database), Excel
 * (workbook or database) and calendars. Bank files and EMP backups are redirected to where they belong.
 */
import {
  AlertTriangle, ArrowUpRight, CalendarDays, Database, FileArchive, FileSpreadsheet, FileText, Landmark, Link2Off, Paperclip,
  RotateCcw, Sheet as SheetIcon, Table,
} from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { navigate } from "@/app/router";
import { api, errorMessage } from "@/backend";
import type { FileGrant, Id, ImportKind, NotionImportResult, PageMeta } from "@/backend/types";
import { PageIcon } from "@/features/shell/PageIcon";
import { formatBytes } from "@/lib/format";
import { notify } from "@/stores/toasts";
import { useTree } from "@/stores/tree";
import { useWorkspace } from "@/stores/workspace";
import { Banner } from "@/ui/Banner";
import { Button } from "@/ui/Button";
import { Dialog } from "@/ui/Dialog";
import { Segmented } from "@/ui/Segmented";
import { Select } from "@/ui/Select";
import { Spinner } from "@/ui/Spinner";
import { ease, spring } from "@/ui/motion/tokens";
import { JobProgress, useJob } from "../JobProgress";
import { recordImport } from "./history";

export interface ImportTarget {
  grant: FileGrant;
}

const KIND_META: Record<string, { label: string; icon: typeof FileText; note: string }> = {
  markdown: { label: "Markdown file", icon: FileText, note: "Becomes a page. Front matter, tables, to-dos, code, math and [[wikilinks]] are kept." },
  markdown_folder: { label: "Markdown folder", icon: FileArchive, note: "Each file becomes a page; folders become parent pages. Images become attachments." },
  notion_zip: { label: "Notion export", icon: FileArchive, note: "Pages, databases, row pages, attachments and links between pages are rebuilt in EMP." },
  csv: { label: "CSV file", icon: Table, note: "Becomes a new database. Column types are detected from the values." },
  xlsx: { label: "Excel workbook", icon: FileSpreadsheet, note: "Opens as a workbook with formulas and formatting, or as a database from the first sheet." },
  ics: { label: "Calendar file", icon: CalendarDays, note: "Events are added to your EMP calendar." },
};

type Phase =
  | { t: "detecting" }
  | { t: "ready"; kind: ImportKind; details: Record<string, unknown> }
  | { t: "running"; kind: ImportKind }
  | { t: "report"; report: Report }
  | { t: "error"; message: string };

interface Report {
  kind: ImportKind;
  headline: string;
  stats: { label: string; value: number; icon: typeof FileText }[];
  pages: PageMeta[];
  warnings: string[];
  unresolved: { title: string; ref: string }[];
  undoJobId?: Id;
  trashIds?: Id[];
}

function Stat({ icon: Icon, label, value, i }: { icon: typeof FileText; label: string; value: number; i: number }) {
  return (
    <m.div className="st-stat" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring.gentle, delay: i * 0.05 }}>
      <Icon size={14} aria-hidden />
      <span className="st-stat-value tabular">{value.toLocaleString()}</span>
      <span className="st-stat-label">{label}</span>
    </m.div>
  );
}

export function ImportFlow({ grant, onClose }: { grant: FileGrant | null; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>({ t: "detecting" });
  const [parentId, setParentId] = useState<Id | "root">("root");
  const [asDatabase, setAsDatabase] = useState(false);
  const job = useJob<unknown>();
  const wsId = useWorkspace((s) => s.workspace?.id);
  const byId = useTree((s) => s.byId);

  useEffect(() => {
    if (!grant) return;
    setParentId("root");
    setAsDatabase(false);
    job.reset();
    setPhase({ t: "detecting" });
    let live = true;
    api.import
      .detect({ grantId: grant.grantId })
      .then((r) => live && setPhase({ t: "ready", kind: r.kind, details: r.details }))
      .catch((e) => live && setPhase({ t: "error", message: errorMessage(e) || "Couldn’t read that file" }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grant]);

  const parentOptions = useMemo(() => {
    const opts = [{ value: "root", label: "Top level of Pages" }];
    for (const p of byId.values()) {
      if (p.deletedAt || p.flags.template || p.kind !== "doc" || p.flags.inline) continue;
      opts.push({ value: p.id, label: p.title || "Untitled" });
    }
    return opts.slice(0, 400);
  }, [byId]);

  const run = async (kind: ImportKind) => {
    if (!grant || !wsId) return;
    const parent = parentId === "root" ? null : parentId;
    const before = new Set(useTree.getState().byId.keys());
    setPhase({ t: "running", kind });
    try {
      let report: Report;
      if (kind === "markdown" || kind === "markdown_folder") {
        let jobId = "";
        const r = (await job.start(async (onEvent) => {
          const h = await api.import.markdown({ grantId: grant.grantId, workspaceId: wsId, parentId: parent, onEvent });
          jobId = h.jobId;
          return h as never;
        })) as { pages: number; warnings: string[] };
        report = { kind, headline: `Imported ${r.pages} ${r.pages === 1 ? "page" : "pages"}`, stats: [{ label: r.pages === 1 ? "page" : "pages", value: r.pages, icon: FileText }], pages: [], warnings: r.warnings, unresolved: [], undoJobId: jobId };
      } else if (kind === "notion_zip") {
        let jobId = "";
        const r = (await job.start(async (onEvent) => {
          const h = await api.import.notion({ grantId: grant.grantId, workspaceId: wsId, parentId: parent, onEvent });
          jobId = h.jobId;
          return h as never;
        })) as NotionImportResult;
        report = {
          kind,
          headline: r.unresolved.length ? "Imported, with a few loose ends" : "Your Notion workspace is here",
          stats: [
            { label: r.pages === 1 ? "page" : "pages", value: r.pages, icon: FileText },
            { label: r.databases === 1 ? "database" : "databases", value: r.databases, icon: Database },
            { label: r.rows === 1 ? "row" : "rows", value: r.rows, icon: Table },
            { label: r.assets === 1 ? "attachment" : "attachments", value: r.assets, icon: Paperclip },
          ],
          pages: [],
          warnings: r.warnings,
          unresolved: r.unresolved,
          undoJobId: jobId,
        };
      } else if (kind === "csv") {
        const title = grant.displayName.replace(/\.[^.]+$/, "") || "Imported data";
        const r = (await job.start((onEvent) => api.db.importCsv({ grantId: grant.grantId, target: { workspaceId: wsId, parentId: parent, title }, onEvent }) as never)) as { databaseId: Id; inserted: number };
        const meta = (await api.page.getMeta({ ids: [r.databaseId] }))[0];
        if (meta) useTree.getState().upsert([meta]);
        report = { kind, headline: `Created “${title}”`, stats: [{ label: r.inserted === 1 ? "row" : "rows", value: r.inserted, icon: Table }], pages: meta ? [meta] : [], warnings: [], unresolved: [], trashIds: [r.databaseId] };
      } else if (kind === "xlsx") {
        const r = (await job.start((onEvent) => api.sheet.importFile({ grantId: grant.grantId, workspaceId: wsId, parentId: parent, asDatabase, onEvent }) as never)) as { page: PageMeta; warnings: string[] };
        useTree.getState().upsert([r.page]);
        report = { kind, headline: `Created “${r.page.title || "Untitled"}”`, stats: [], pages: [r.page], warnings: r.warnings, unresolved: [], trashIds: [r.page.id] };
      } else if (kind === "ics") {
        const r = (await job.start((onEvent) => api.import.ics({ grantId: grant.grantId, target: "calendar", onEvent }) as never)) as { events: number };
        report = { kind, headline: `Added ${r.events} ${r.events === 1 ? "event" : "events"} to your calendar`, stats: [{ label: "events", value: r.events, icon: CalendarDays }], pages: [], warnings: [], unresolved: [] };
      } else return;

      // Pick up the new top-level pages for clickable results (tree events arrive just after the job).
      if (report.undoJobId) {
        for (let i = 0; i < 15 && !report.pages.length; i++) {
          await new Promise((r) => window.setTimeout(r, 80));
          report.pages = Array.from(useTree.getState().byId.values())
            .filter((p) => !before.has(p.id) && !p.deletedAt && (parent ? p.parentId === parent : !p.parentId))
            .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
            .slice(0, 6);
        }
      }
      recordImport({ jobId: report.undoJobId, trashIds: report.trashIds, title: grant.displayName, kind, summary: report.headline, at: Date.now(), openId: report.pages[0]?.id });
      setPhase({ t: "report", report });
    } catch (e) {
      if ((e as { code?: string }).code === "CANCELLED") return setPhase({ t: "ready", kind, details: {} });
      setPhase({ t: "error", message: errorMessage(e) || "The import didn’t finish" });
    }
  };

  const undo = async (r: Report) => {
    try {
      if (r.undoJobId) {
        const { removed } = await api.import.undo({ importJobId: r.undoJobId });
        notify.success("Import undone", { description: `Removed ${removed} ${removed === 1 ? "item" : "items"}.` });
      } else if (r.trashIds?.length) {
        await useTree.getState().trash(r.trashIds);
        notify.success("Import undone", { description: "Moved to Trash." });
      }
      onClose();
    } catch (e) {
      notify.fromError(e, "Couldn’t undo the import");
    }
  };

  const running = phase.t === "running";
  const info = phase.t === "ready" ? KIND_META[phase.kind] : undefined;

  return (
    <Dialog
      open={!!grant}
      onOpenChange={(o) => !o && !running && onClose()}
      dismissible={!running}
      size="md"
      title={phase.t === "report" ? phase.report.headline : "Import"}
      description={phase.t === "report" ? undefined : "Files are read on this device; nothing is uploaded."}
      footer={
        phase.t === "ready" && info ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void run(phase.kind)} autoFocus>
              Import
            </Button>
          </>
        ) : phase.t === "report" ? (
          <>
            {phase.report.undoJobId || phase.report.trashIds?.length ? (
              <Button variant="ghost" icon={RotateCcw} onClick={() => void undo(phase.report)}>
                Undo import
              </Button>
            ) : null}
            {phase.report.kind === "ics" ? (
              <Button variant="secondary" onClick={() => (onClose(), navigate({ t: "calendar" }))}>
                Open calendar
              </Button>
            ) : null}
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        ) : phase.t === "error" ? (
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        ) : undefined
      }
    >
      <AnimatePresence mode="wait" initial={false}>
        <m.div key={phase.t} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0, transition: { duration: 0.18, ease: ease.out } }} exit={{ opacity: 0, transition: { duration: 0.1 } }}>
          {phase.t === "detecting" ? (
            <div className="flex items-center gap-3 py-6 text-body text-secondary">
              <Spinner /> Reading {grant?.displayName}…
            </div>
          ) : null}

          {phase.t === "ready" ? (
            info ? (
              <div className="flex flex-col gap-4">
                <div className="st-file">
                  <info.icon size={20} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-body font-medium text-primary">{grant?.displayName}</div>
                    <div className="text-caption text-tertiary">
                      {info.label} · {formatBytes(grant?.size ?? 0)}
                      {describe(phase.details)}
                    </div>
                  </div>
                </div>
                <p className="text-body-sm text-secondary">{info.note}</p>
                {phase.kind === "xlsx" ? (
                  <div className="st-field-row">
                    <span>Open as</span>
                    <Segmented size="sm" value={asDatabase ? "db" : "wb"} onValueChange={(v) => setAsDatabase(v === "db")} options={[{ value: "wb", label: "Workbook", icon: SheetIcon }, { value: "db", label: "Database", icon: Database }]} aria-label="Open as" />
                  </div>
                ) : null}
                {phase.kind !== "ics" ? (
                  <div className="st-field-row">
                    <span>Put it in</span>
                    <Select size="sm" value={parentId} onValueChange={(v) => setParentId(v as Id | "root")} options={parentOptions} searchable className="w-[260px]" aria-label="Destination" />
                  </div>
                ) : null}
              </div>
            ) : (
              <Redirect kind={phase.kind} details={phase.details} onClose={onClose} />
            )
          ) : null}

          {phase.t === "running" ? (
            <div className="py-2">
              <JobProgress state={job.state} title={grant?.displayName} onCancel={job.cancel} doneLabel="Finishing up" />
            </div>
          ) : null}

          {phase.t === "report" ? <ReportView report={phase.report} onOpen={(p) => (onClose(), navigate(p.kind === "database" ? { t: "db", id: p.id } : p.kind === "sheet" ? { t: "sheet", id: p.id } : { t: "page", id: p.id }))} /> : null}

          {phase.t === "error" ? (
            <Banner tone="danger" inline>
              {phase.message}
            </Banner>
          ) : null}
        </m.div>
      </AnimatePresence>
    </Dialog>
  );
}

function describe(d: Record<string, unknown>): string {
  const parts: string[] = [];
  const n = (k: string) => (typeof d[k] === "number" ? (d[k] as number) : null);
  if (n("pages")) parts.push(`${n("pages")} pages`);
  if (n("databases")) parts.push(`${n("databases")} databases`);
  if (n("files")) parts.push(`${n("files")} files`);
  if (n("attachments")) parts.push(`${n("attachments")} attachments`);
  if (n("words")) parts.push(`${(n("words") as number).toLocaleString()} words`);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

function Redirect({ kind, details, onClose }: { kind: ImportKind; details: Record<string, unknown>; onClose: () => void }) {
  if (kind === "ofx" || kind === "qfx" || kind === "qif") {
    return (
      <div className="st-redirect">
        <Landmark size={20} aria-hidden />
        <div>
          <p className="text-body font-medium text-primary">Bank statement</p>
          <p className="mt-1 text-body-sm text-secondary">Bank files are imported in Money HQ, where you map them to an account and review each transaction.</p>
          <Button className="mt-3" size="sm" variant="secondary" iconRight={ArrowUpRight} onClick={() => (onClose(), navigate({ t: "lifeapps", appId: "money-hq" }))}>
            Go to Money HQ
          </Button>
        </div>
      </div>
    );
  }
  if (kind === "empbackup") {
    return (
      <div className="st-redirect">
        <FileArchive size={20} aria-hidden />
        <div>
          <p className="text-body font-medium text-primary">EMP backup</p>
          <p className="mt-1 text-body-sm text-secondary">Backups are restored from Backups & snapshots. A restore always opens as a new vault, so nothing here is overwritten.</p>
          <Button className="mt-3" size="sm" variant="secondary" onClick={() => (onClose(), navigate({ t: "settings", section: "backups:restore" }, { replace: true }))}>
            Open Backups
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="st-redirect">
      <AlertTriangle size={20} aria-hidden />
      <div>
        <p className="text-body font-medium text-primary">EMP can’t import this file</p>
        <p className="mt-1 text-body-sm text-secondary">{typeof details.reason === "string" ? `${details.reason}. ` : ""}Try Markdown, a Notion export (.zip), CSV, Excel or an .ics calendar.</p>
      </div>
    </div>
  );
}

function ReportView({ report, onOpen }: { report: Report; onOpen: (p: PageMeta) => void }) {
  return (
    <div className="flex flex-col gap-4">
      {report.stats.length ? (
        <div className="st-stats">
          {report.stats.map((s, i) => (
            <Stat key={s.label} {...s} i={i} />
          ))}
        </div>
      ) : null}
      {report.pages.length ? (
        <div className="st-report-list">
          <div className="st-report-head">Open</div>
          {report.pages.map((p) => (
            <button key={p.id} type="button" className="st-report-item" onClick={() => onOpen(p)}>
              <PageIcon icon={p.icon} kind={p.kind} size={16} />
              <span className="flex-1 truncate">{p.title || "Untitled"}</span>
              <ArrowUpRight size={14} aria-hidden />
            </button>
          ))}
        </div>
      ) : null}
      {report.unresolved.length ? (
        <div className="st-report-list">
          <div className="st-report-head">
            <Link2Off size={12} aria-hidden /> {report.unresolved.length} {report.unresolved.length === 1 ? "link" : "links"} couldn’t be matched — kept as text
          </div>
          {report.unresolved.slice(0, 6).map((u) => (
            <div key={u.ref} className="st-report-item is-static" title={u.ref}>
              <span className="flex-1 truncate">{u.title}</span>
              <span className="st-report-ref truncate">{(u.ref.split("/").pop() ?? u.ref).replace(/\s?[0-9a-f]{32}(?=\.\w+$)/i, "")}</span>
            </div>
          ))}
        </div>
      ) : null}
      {report.warnings.length ? (
        <Banner tone="warning" inline>
          {report.warnings.slice(0, 4).join(" · ")}
          {report.warnings.length > 4 ? ` · and ${report.warnings.length - 4} more` : ""}
        </Banner>
      ) : null}
    </div>
  );
}
