/**
 * Import & export (§11.3, §17.4–17.5, §9.21 "Export"): import sources with job progress and undo; export a page,
 * database or workbook as Markdown, JSON, PDF (print), CSV or Excel; and "Export everything" as one zip with a
 * SHA-256 manifest. Exports from an encrypted vault need re-auth and an explicit acknowledgement.
 */
import {
  ArrowDownUp, CalendarDays, Database, Download, FileArchive, FileJson, FileSpreadsheet, FileText, Folder, FolderArchive,
  Landmark, Paperclip, Printer, RotateCcw, Sheet as SheetIcon, Table, Upload,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { navigate } from "@/app/router";
import { api, errorMessage, hasCode } from "@/backend";
import type { FileFilter, FileGrant, Id, PageMeta } from "@/backend/types";
import { PageIcon } from "@/features/shell/PageIcon";
import { cn } from "@/lib/cn";
import { formatRelative, isoDay } from "@/lib/dates";
import { formatBytes } from "@/lib/format";
import { notify } from "@/stores/toasts";
import { useTree } from "@/stores/tree";
import { useVault } from "@/stores/vault";
import { Button } from "@/ui/Button";
import { Checkbox } from "@/ui/Checkbox";
import { FileDropZone } from "@/ui/FileDropZone";
import { Select, type SelectOption } from "@/ui/Select";
import { Switch } from "@/ui/Switch";
import { spring } from "@/ui/motion/tokens";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { ImportFlow } from "../data/ImportFlow";
import { useImportHistory } from "../data/history";
import { JobProgress, useJob } from "../JobProgress";
import { Group, Row, SectionHeader } from "../parts";
import { withReauth } from "../reauth";

const ALL_IMPORT = ["md", "markdown", "zip", "csv", "tsv", "xlsx", "xls", "ods", "ics", "ofx", "qfx", "qif", "empbackup"];

interface Source {
  id: string;
  title: string;
  body: string;
  icon: LucideIcon | "notion";
  filters: FileFilter[];
}

const SOURCES: Source[] = [
  { id: "notion", title: "Notion", body: "Export as “Markdown & CSV” or “HTML”, then choose the .zip.", icon: "notion", filters: [{ name: "Notion export", extensions: ["zip"] }] },
  { id: "markdown", title: "Markdown & Obsidian", body: "Files or a zipped folder. Wikilinks and front matter are kept.", icon: FileText, filters: [{ name: "Markdown", extensions: ["md", "markdown", "zip"] }] },
  { id: "sheets", title: "CSV & Excel", body: "CSV becomes a database; Excel a workbook or a database.", icon: FileSpreadsheet, filters: [{ name: "Spreadsheets", extensions: ["csv", "tsv", "xlsx", "xls", "ods"] }] },
  { id: "ics", title: "Calendar", body: "An .ics file from any calendar app.", icon: CalendarDays, filters: [{ name: "Calendar", extensions: ["ics"] }] },
];

function NotionGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M9 16.5V8l6 8.5V8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type Format = "markdown" | "json" | "pdf" | "csv" | "xlsx";
const FORMATS: { id: Format; title: string; note: string; icon: LucideIcon; kinds: PageMeta["kind"][] }[] = [
  { id: "markdown", title: "Markdown", note: "Readable anywhere; lossless re-import", icon: FileText, kinds: ["doc", "dashboard", "database"] },
  { id: "pdf", title: "PDF", note: "Print-ready copy of a page", icon: Printer, kinds: ["doc", "dashboard"] },
  { id: "json", title: "JSON", note: "Complete page data", icon: FileJson, kinds: ["doc", "dashboard"] },
  { id: "csv", title: "CSV", note: "A database or sheet as a table", icon: Table, kinds: ["database", "sheet"] },
  { id: "xlsx", title: "Excel", note: "With formulas and formatting", icon: FileSpreadsheet, kinds: ["database", "sheet"] },
];

const safeName = (s: string) => (s || "Untitled").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 100) || "Untitled";

export function DataSection() {
  const [grant, setGrant] = useState<FileGrant | null>(null);
  const history = useImportHistory((s) => s.items);
  const reduced = useReducedMotionPref();

  useEffect(() => {
    void useImportHistory.getState().load();
  }, []);

  const pick = async (filters: FileFilter[]) => {
    try {
      const [g] = await api.file.pick({ purpose: "import", filters, multiple: false });
      if (g) setGrant(g);
    } catch (e) {
      notify.fromError(e, "Couldn’t open the file");
    }
  };

  return (
    <div>
      <SectionHeader icon={ArrowDownUp} title="Import & export" description="Bring your notes and data in, take everything out. Files are read and written on this device." />

      <Group id="import" title="Import" description="Every import can be undone as one step.">
        <div className="st-block flex flex-col gap-4">
          <div className="st-sources">
            {SOURCES.map((s, i) => (
              <m.button
                key={s.id}
                type="button"
                className="st-source"
                onClick={() => void pick(s.filters)}
                initial={reduced ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...spring.gentle, delay: reduced ? 0 : i * 0.04 }}
                whileTap={reduced ? undefined : { scale: 0.985 }}
              >
                <span className="st-source-icon">{s.icon === "notion" ? <NotionGlyph /> : <s.icon size={18} strokeWidth={1.75} />}</span>
                <span className="st-source-title">{s.title}</span>
                <span className="st-source-body">{s.body}</span>
                <span className="st-source-cta" aria-hidden>
                  Choose file <Upload size={12} />
                </span>
              </m.button>
            ))}
          </div>
          <FileDropZone onBrowse={() => void pick([{ name: "Importable files", extensions: ALL_IMPORT }])} onFiles={() => notify.info("Choose the file to import", { description: "Files are opened through the file picker so EMP only reads what you allow." })} icon={Upload} title="Or choose any file" hint="EMP detects what it is: Markdown, Notion, CSV, Excel, .ics, bank statements or backups" accept={ALL_IMPORT.map((e) => `.${e}`)} />
        </div>
        <Row icon={<Landmark size={16} />} label="Bank statements" description="OFX, QFX, QIF and bank CSVs go through Money HQ so you can map accounts and review each transaction.">
          <Button size="sm" variant="ghost" onClick={() => navigate({ t: "lifeapps", appId: "money-hq" })}>
            Open Money HQ
          </Button>
        </Row>
      </Group>

      <AnimatePresence initial={false}>
        {history.length ? (
          <m.div key="hist" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <Group title="Recent imports" flush>
              {history.slice(0, 5).map((h) => (
                <Row
                  key={h.at}
                  icon={h.kind === "notion_zip" ? <FileArchive size={16} /> : h.kind === "csv" || h.kind === "xlsx" ? <FileSpreadsheet size={16} /> : h.kind === "ics" ? <CalendarDays size={16} /> : <FileText size={16} />}
                  label={h.title}
                  description={`${h.summary} · ${formatRelative(h.at)}`}
                >
                  {h.openId && useTree.getState().byId.get(h.openId) ? (
                    <Button size="xs" variant="ghost" onClick={() => navigate({ t: "page", id: h.openId as Id })}>
                      Open
                    </Button>
                  ) : null}
                  {h.jobId || h.trashIds?.length ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      icon={RotateCcw}
                      onClick={async () => {
                        try {
                          if (h.jobId) await api.import.undo({ importJobId: h.jobId });
                          else if (h.trashIds) await useTree.getState().trash(h.trashIds);
                          useImportHistory.getState().remove(h.at);
                          notify.success("Import undone");
                        } catch (e) {
                          if (hasCode(e, "NOT_FOUND")) useImportHistory.getState().remove(h.at);
                          notify.fromError(e, "Couldn’t undo the import");
                        }
                      }}
                    >
                      Undo
                    </Button>
                  ) : null}
                </Row>
              ))}
            </Group>
          </m.div>
        ) : null}
      </AnimatePresence>

      <ExportPanel />
      <ExportEverything />

      <ImportFlow grant={grant} onClose={() => setGrant(null)} />
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── export one thing

function ExportPanel() {
  const byId = useTree((s) => s.byId);
  const encrypted = useVault((s) => !!s.status?.encrypted);
  const [format, setFormat] = useState<Format>("markdown");
  const [pageId, setPageId] = useState<Id | null>(null);
  const [children, setChildren] = useState(true);
  const [assets, setAssets] = useState(true);
  const [ack, setAck] = useState(false);
  const job = useJob<{ files?: number; rows?: number; bytes?: number }>();
  const [savedAs, setSavedAs] = useState<string | null>(null);
  const reduced = useReducedMotionPref();
  const fmt = FORMATS.find((f) => f.id === format) ?? FORMATS[0];

  const options = useMemo<SelectOption[]>(() => {
    const list = Array.from(byId.values()).filter((p) => !p.deletedAt && !p.flags.template && fmt.kinds.includes(p.kind));
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    return list.slice(0, 500).map((p) => ({ value: p.id, label: p.title || "Untitled", icon: <PageIcon icon={p.icon} kind={p.kind} size={16} />, group: p.kind === "database" ? "Databases" : p.kind === "sheet" ? "Sheets" : "Pages" }));
  }, [byId, fmt]);

  useEffect(() => {
    if (!pageId || !options.some((o) => o.value === pageId)) setPageId((options[0]?.value as Id) ?? null);
  }, [options, pageId]);

  const meta = pageId ? byId.get(pageId) : undefined;
  const hasKids = !!meta?.hasChildren;
  const multi = format === "markdown" && ((children && hasKids) || meta?.kind === "database" || (assets && meta?.kind !== "sheet"));
  const needsAck = encrypted && format !== "pdf";

  const run = async () => {
    if (!meta) return;
    setSavedAs(null);
    if (format === "pdf") {
      navigate({ t: "page", id: meta.id });
      window.setTimeout(() => window.print(), 600);
      return;
    }
    const ext = format === "markdown" ? (multi ? "zip" : "md") : format;
    const filter: FileFilter = { name: fmt.title, extensions: [ext] };
    try {
      const res = await withReauth("export unencrypted data", async () => {
        const g = await api.file.saveGrant({ purpose: "export", suggestedName: `${safeName(meta.title)}.${ext}`, filters: [filter] });
        if (!g) return null;
        setSavedAs(g.displayName);
        return job.start((onEvent) => {
          if (format === "csv" || format === "xlsx") {
            return (meta.kind === "sheet" ? api.sheet.export({ workbookId: meta.id, format, grantId: g.grantId, onEvent }) : api.db.export({ databaseId: meta.id, format, grantId: g.grantId, onEvent })) as never;
          }
          return api.export.pages({ pageIds: [meta.id], format: format as "markdown" | "json", includeChildren: children, includeAssets: assets, grantId: g.grantId, onEvent }) as never;
        });
      });
      if (res === null) setSavedAs(null);
    } catch (e) {
      if (!hasCode(e, "CANCELLED")) notify.error("Couldn’t export", { description: errorMessage(e) });
    }
  };

  const busy = job.state.phase === "running";
  const result = job.state.result;
  return (
    <Group id="export" title="Export" description="Pick a format, then what to export.">
      <div className="st-block flex flex-col gap-4">
        <div className="st-formats" role="radiogroup" aria-label="Format">
          {FORMATS.map((f) => {
            const on = f.id === format;
            return (
              <button key={f.id} type="button" role="radio" aria-checked={on} className={cn("st-format", on && "is-on")} onClick={() => (setFormat(f.id), job.reset())}>
                {on ? <m.span layoutId="st-format-pill" className="st-format-pill" transition={reduced ? { duration: 0 } : spring.ui} /> : null}
                <f.icon size={18} strokeWidth={1.75} aria-hidden />
                <span className="st-format-title">{f.title}</span>
              </button>
            );
          })}
        </div>
        <p className="st-hint">{fmt.note}.</p>
      </div>
      <Row label={format === "csv" || format === "xlsx" ? "Database or sheet" : "Page"}>
        <Select size="sm" value={pageId} onValueChange={(v) => (setPageId(v as Id), job.reset())} options={options} searchable placeholder={options.length ? "Choose…" : "Nothing to export in this format"} className="w-[280px]" listWidth={320} aria-label="What to export" />
      </Row>
      {format === "markdown" || format === "json" ? (
        <Row label="Include sub-pages" description={hasKids ? "Sub-pages export into a folder next to the page." : "This page has no sub-pages."}>
          <Switch checked={children} disabled={!hasKids} onCheckedChange={setChildren} aria-label="Include sub-pages" />
        </Row>
      ) : null}
      {format === "markdown" ? (
        <Row label="Include attachments" description="Images and files go into an assets/ folder inside a .zip.">
          <Switch checked={assets} onCheckedChange={setAssets} aria-label="Include attachments" />
        </Row>
      ) : null}
      <div className="st-block flex flex-col gap-3">
        {needsAck ? <Checkbox checked={ack} onCheckedChange={setAck} label="I understand this file is readable by anyone who has it" description="Exports leave the encrypted vault. You’ll confirm your password." /> : null}
        <AnimatePresence initial={false} mode="wait">
          {job.state.phase !== "idle" ? (
            <m.div key="job" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <JobProgress state={job.state} title={savedAs ?? "Export"} onCancel={job.cancel} doneLabel={result ? `Saved${result.files ? ` · ${result.files} ${result.files === 1 ? "file" : "files"}` : result.rows !== undefined ? ` · ${result.rows} rows` : result.bytes ? ` · ${formatBytes(result.bytes)}` : ""}` : "Saved"} />
            </m.div>
          ) : null}
        </AnimatePresence>
        <div className="flex items-center justify-between gap-3">
          <span className="st-hint">{format === "pdf" ? "Opens the page and your system’s print dialog — choose “Save as PDF”." : multi ? "Saved as a .zip with a folder per page." : `Saved as a single .${format === "markdown" ? "md" : format} file.`}</span>
          <Button variant="primary" size="sm" icon={format === "pdf" ? Printer : Download} disabled={!meta || busy || (needsAck && !ack)} loading={busy} onClick={() => void run()}>
            {format === "pdf" ? "Print to PDF…" : "Export…"}
          </Button>
        </div>
      </div>
    </Group>
  );
}

// ───────────────────────────────────────────────────────────────────────────── export everything

const LAYOUT: { path: string; note: string; icon: LucideIcon }[] = [
  { path: "pages/", note: "Every page as Markdown, in your page tree", icon: Folder },
  { path: "databases/", note: "CSV plus a .schema.json per database", icon: Database },
  { path: "sheets/", note: "Workbooks as .xlsx", icon: SheetIcon },
  { path: "attachments/", note: "Images and files", icon: Paperclip },
  { path: "calendar/", note: "Events as .ics", icon: CalendarDays },
  { path: "emp-full.json", note: "Lossless data dump, no secrets", icon: FileJson },
  { path: "manifest.json", note: "SHA-256 of every file", icon: FileText },
];

function ExportEverything() {
  const byId = useTree((s) => s.byId);
  const encrypted = useVault((s) => !!s.status?.encrypted);
  const [ack, setAck] = useState(false);
  const job = useJob<{ bytes: number }>();
  const [file, setFile] = useState<string | null>(null);
  const counts = useMemo(() => {
    let pages = 0;
    let dbs = 0;
    let sheets = 0;
    for (const p of byId.values()) {
      if (p.deletedAt || p.flags.template) continue;
      if (p.kind === "database") dbs++;
      else if (p.kind === "sheet") sheets++;
      else pages++;
    }
    return { pages, dbs, sheets };
  }, [byId]);

  const run = async () => {
    try {
      await withReauth("export everything unencrypted", async () => {
        const g = await api.file.saveGrant({ purpose: "export", suggestedName: `EMP Export ${isoDay()}.zip`, filters: [{ name: "Zip archive", extensions: ["zip"] }] });
        if (!g) return null;
        setFile(g.displayName);
        return job.start((onEvent) => api.export.everything({ grantId: g.grantId, onEvent }));
      });
    } catch (e) {
      if (!hasCode(e, "CANCELLED")) notify.error("Export didn’t finish", { description: errorMessage(e) });
    }
  };

  return (
    <Group id="export-everything" title="Export everything" description="One zip with all your pages, databases, sheets, attachments and calendars — yours to keep, in open formats.">
      <div className="st-block st-everything">
        <div className="st-everything-art" aria-hidden>
          <FolderArchive size={28} strokeWidth={1.5} />
          <div className="st-everything-counts">
            <span>
              <b className="tabular">{counts.pages}</b> pages
            </span>
            <span>
              <b className="tabular">{counts.dbs}</b> databases
            </span>
            <span>
              <b className="tabular">{counts.sheets}</b> sheets
            </span>
          </div>
        </div>
        <ul className="st-tree">
          {LAYOUT.map((l) => (
            <li key={l.path}>
              <l.icon size={14} aria-hidden />
              <code>{l.path}</code>
              <span>{l.note}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="st-block flex flex-col gap-3">
        {encrypted ? <Checkbox checked={ack} onCheckedChange={setAck} label="I understand this file is readable by anyone who has it" description="The zip isn’t encrypted. You’ll confirm your password." /> : null}
        <AnimatePresence initial={false}>
          {job.state.phase !== "idle" ? (
            <m.div key="job" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <JobProgress state={job.state} title={file ?? "Export"} onCancel={job.cancel} doneLabel={job.state.result ? `Saved ${formatBytes(job.state.result.bytes)} — check manifest.json to verify it` : "Saved"} />
            </m.div>
          ) : null}
        </AnimatePresence>
        <div className="flex justify-end">
          <Button variant="primary" icon={Download} disabled={(encrypted && !ack) || job.state.phase === "running"} loading={job.state.phase === "running"} onClick={() => void run()}>
            Export everything…
          </Button>
        </div>
      </div>
    </Group>
  );
}
