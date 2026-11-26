/**
 * Spreadsheet Studio hub (§16.5): start a workbook from a well-built template (a tune-up that adds a workbook), import
 * a file or a Google Sheet, and pick up recent workbooks from anywhere in the workspace.
 */
import { ArrowRight, FileSpreadsheet, FileUp, Sheet as SheetIcon } from "lucide-react";
import { m } from "motion/react";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api, errorMessage } from "@/backend";
import type { LifeAppInstance } from "@/backend/types";
import { navigate } from "@/app/router";
import { formatRelative } from "@/lib/dates";
import { notify } from "@/stores/toasts";
import { useTree } from "@/stores/tree";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { Button } from "@/ui/Button";
import { Card } from "@/ui/Card";
import { Dialog } from "@/ui/Dialog";
import { Input } from "@/ui/Input";
import { Spinner } from "@/ui/Spinner";
import { Switch } from "@/ui/Switch";
import { spring } from "@/ui/motion/tokens";
import { PageIcon } from "@/features/shell/PageIcon";
import { GoogleSetupSheet } from "@/features/integrations/GoogleSetupSheet";
import { AppHeader } from "../AppHeader";
import { useMetrics } from "../data";
import { SHEET_INTENTS } from "../engine/manifests";
import { SHEET_TITLES } from "../engine/plan";
import { iconByName, identity } from "../identity";
import { StartHere } from "../StartHere";

/** A tiny abstract thumbnail per template: header row, input cells, an output cell. */
const THUMBS: Record<string, { in: number[]; out: number[] }> = {
  loan: { in: [6, 7, 8], out: [24] },
  budget: { in: [6, 11, 16], out: [19, 24] },
  decision: { in: [6, 7, 8, 11, 12, 13], out: [9, 14] },
  project_budget: { in: [7, 12, 17], out: [23] },
  timesheet: { in: [6, 7, 11, 12, 16, 17], out: [24] },
  inventory: { in: [7, 8, 12, 13], out: [14, 24] },
  split: { in: [7, 12, 17], out: [21, 22] },
  savings: { in: [6, 11], out: [9, 14, 19, 24] },
  blank: { in: [6, 11], out: [24] },
};

export default function Studio({ instance }: { instance: LifeAppInstance }) {
  const [creating, setCreating] = useState<string | null>(null);
  const [gsOpen, setGsOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [asDb, setAsDb] = useState(false);
  const [importing, setImporting] = useState(false);
  const ws = useWorkspace((s) => s.workspace);
  const color = identity("spreadsheet-studio").color;
  const { metrics } = useMetrics(instance.id, ["workbook_count"]);
  const recent = useTree(
    useShallow((s) => {
      const out = [];
      for (const p of s.byId.values()) if (p.kind === "sheet" && !p.deletedAt) out.push(p);
      return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12);
    }),
  );
  const pathOf = useTree((s) => (id: string) => {
    const parts: string[] = [];
    let cur = s.byId.get(id)?.parentId ?? null;
    while (cur) {
      const p = s.byId.get(cur);
      if (!p) break;
      parts.unshift(p.title || "Untitled");
      cur = p.parentId;
    }
    return parts.join(" / ");
  });

  const create = async (intent: string) => {
    setCreating(intent);
    try {
      const job = await api.lifeapp.tuneupApply({ instanceId: instance.id, answers: { intent }, acceptConflicts: [] });
      const res = await job.result;
      const id = res.changed[0];
      notify.success(`${SHEET_TITLES[intent] ?? "Workbook"} created`, { description: "Inputs are tinted; formulas and checks are ready." });
      if (id) navigate({ t: "page", id });
    } catch (e) {
      notify.fromError(e, "Couldn’t create the workbook");
    } finally {
      setCreating(null);
    }
  };

  const importSheet = async () => {
    if (!ws) return;
    setImporting(true);
    try {
      const status = await api.google.status();
      const acct = status.accounts[0];
      if (!acct) {
        setGsOpen(false);
        setSetupOpen(true);
        return;
      }
      if (!acct.scopes.includes("https://www.googleapis.com/auth/spreadsheets.readonly")) {
        const j = await api.google.connect({ feature: "sheets_import", accountId: acct.id });
        await j.result;
      }
      const job = await api.gsheets.import({ accountId: acct.id, url, workspaceId: ws.id, parentId: instance.rootPageId, asDatabase: asDb });
      const res = await job.result;
      setGsOpen(false);
      setUrl("");
      notify.success("Imported from Google Sheets", { description: res.warnings[0] });
      navigate({ t: "page", id: res.page.id });
    } catch (e) {
      notify.error("Couldn’t import", { description: errorMessage(e) });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="la-hub">
      <AppHeader
        instance={instance}
        title="Spreadsheet Studio"
        subtitle={`Calculators and trackers built to be audited · ${Number(metrics?.workbook_count?.value ?? recent.length)} workbooks`}
        actions={
          <>
            <Button size="sm" variant="ghost" icon={FileUp} onClick={() => useUi.getState().setImportOpen(true)}>
              Import file
            </Button>
            <Button size="sm" variant="ghost" icon={FileSpreadsheet} onClick={() => setGsOpen(true)}>
              Google Sheets
            </Button>
          </>
        }
      />
      <div className="la-hub-body" style={{ ["--app" as string]: color }}>
        <div className="lo-grid">
          <div className="flex min-w-0 flex-col gap-8">
            <section>
              <h2 className="la-section-title">Start from a template <span className="la-dim">· inputs, checks and a legend included</span></h2>
              <div className="st-grid">
                {SHEET_INTENTS.map((t, i) => {
                  const Icon = iconByName(t.icon) ?? SheetIcon;
                  const th = THUMBS[t.value] ?? THUMBS.blank;
                  return (
                    <m.button key={t.value} type="button" className="st-tpl" onClick={() => void create(t.value)} disabled={!!creating} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, transition: { ...spring.gentle, delay: i * 0.03 } }} whileTap={{ scale: 0.985 }}>
                      <div className="st-thumb" aria-hidden>
                        {Array.from({ length: 25 }, (_, k) => (
                          <span key={k} className={th.in.includes(k) ? "is-in" : th.out.includes(k) ? "is-out" : undefined} style={k < 5 ? { background: "rgba(var(--text-rgb),.14)" } : undefined} />
                        ))}
                      </div>
                      <div className="flex items-center gap-2">
                        {creating === t.value ? <Spinner size={14} /> : <Icon size={14} className="text-tertiary" aria-hidden />}
                        <span className="text-body-sm font-semibold text-primary">{t.label}</span>
                      </div>
                      <span className="text-caption text-tertiary">{t.description}</span>
                    </m.button>
                  );
                })}
              </div>
            </section>
            <section>
              <h2 className="la-section-title">Recent workbooks</h2>
              <Card pad="md">
                {recent.length ? (
                  <ul className="flex flex-col">
                    {recent.map((p) => (
                      <li key={p.id}>
                        <button type="button" className="st-row w-full" onClick={() => navigate({ t: "page", id: p.id })}>
                          <PageIcon icon={p.icon} kind="sheet" size={20} />
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate text-body font-medium text-primary">{p.title || "Untitled"}</span>
                            <span className="truncate text-caption text-tertiary">{pathOf(p.id) || "Workspace"}</span>
                          </span>
                          <span className="text-caption text-tertiary">{formatRelative(p.updatedAt)}</span>
                          <ArrowRight size={14} className="text-tertiary" aria-hidden />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="py-6 text-center text-body-sm text-tertiary">Your workbooks will show up here.</p>
                )}
              </Card>
            </section>
          </div>
          <div className="flex min-w-0 flex-col gap-5">
            <StartHere instance={instance} />
            <Card title="How these workbooks are built">
              <ul className="flex flex-col gap-2.5 text-body-sm text-secondary">
                <li className="flex gap-2"><span className="mt-1 h-3 w-3 flex-none rounded-[3px]" style={{ background: `color-mix(in oklab, ${color} 22%, transparent)` }} />Tinted cells are inputs — change these.</li>
                <li className="flex gap-2"><span className="mt-1 h-3 w-3 flex-none rounded-[3px] bg-surface-3" /><strong className="font-semibold text-primary">Bold</strong>&nbsp;cells are outputs.</li>
                <li className="flex gap-2"><span className="mt-1 h-3 w-3 flex-none rounded-[3px] bg-gain-soft" />Checks turn green when the model adds up.</li>
                <li className="flex gap-2"><span className="mt-1 h-3 w-3 flex-none rounded-[3px] bg-surface-2" />Constants live in named ranges; headers are frozen; dates are ISO.</li>
              </ul>
            </Card>
          </div>
        </div>
      </div>
      <Dialog
        open={gsOpen}
        onOpenChange={setGsOpen}
        title="Import from Google Sheets"
        description="Paste a link to a spreadsheet you can open. Unsupported functions keep their last value and get an amber corner flag."
        footer={
          <>
            <Button variant="ghost" onClick={() => setGsOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={importing} disabled={!/\/spreadsheets\/d\//.test(url)} onClick={importSheet}>
              Import
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Input label="Spreadsheet link" placeholder="https://docs.google.com/spreadsheets/d/…" value={url} onChange={(e) => setUrl(e.currentTarget.value)} autoFocus />
          <Switch checked={asDb} onCheckedChange={setAsDb} label="Import as a database" description="Best for lists with one header row. Keep as a spreadsheet for models with formulas." />
        </div>
      </Dialog>
      <GoogleSetupSheet open={setupOpen} onOpenChange={setSetupOpen} feature="sheets_import" />
    </div>
  );
}
