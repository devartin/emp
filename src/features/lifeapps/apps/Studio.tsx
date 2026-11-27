/**
 * Spreadsheet Studio hub (§16.5): start a spreadsheet from a well-built template (`lifeapp_add_workbook`: a new,
 * ordinary spreadsheet next to the hub on every click), import a file or a Google Sheet, and pick up recent
 * spreadsheets from anywhere in the workspace. The template list is the manifest's `intent` step (the same on both
 * backends); this file only adds the thumbnails and one-line descriptions.
 */
import { FileSpreadsheet, FileUp, Sheet as SheetIcon } from "lucide-react";
import { useMemo, useState } from "react";
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
import { PageIcon } from "@/features/shell/PageIcon";
import { GoogleSetupSheet } from "@/features/integrations/GoogleSetupSheet";
import { AppHeader } from "../AppHeader";
import { useManifest, useMetrics } from "../data";
import { iconByName, identity } from "../identity";

/** A tiny abstract thumbnail per template: header row, input cells, an output cell. */
const THUMBS: Record<string, { in: number[]; out: number[] }> = {
  loan: { in: [6, 7, 8], out: [24] },
  budget: { in: [6, 11, 16], out: [19, 24] },
  decision: { in: [6, 7, 8, 11, 12, 13], out: [9, 14] },
  project: { in: [7, 12, 17], out: [23] },
  timesheet: { in: [6, 7, 11, 12, 16, 17], out: [24] },
  inventory: { in: [7, 8, 12, 13], out: [14, 24] },
  split: { in: [7, 12, 17], out: [21, 22] },
  compound: { in: [6, 11], out: [9, 14, 19, 24] },
  blank: { in: [6, 11], out: [24] },
};

/** Presentation of each template (`intent` value): icon and one line. */
const ABOUT: Record<string, { icon: string; description: string }> = {
  loan: { icon: "landmark", description: "Payment, amortization schedule and extra payments." },
  budget: { icon: "wallet", description: "Income and spending, budget against actual." },
  decision: { icon: "scale", description: "Weighted scores and a clear winner." },
  project: { icon: "hammer", description: "Line items, estimates against actuals, contingency." },
  timesheet: { icon: "clock", description: "Hours with breaks, weekly totals and overtime." },
  inventory: { icon: "package", description: "Stock value and reorder alerts." },
  split: { icon: "split", description: "Who paid, and what each person owes or gets back." },
  compound: { icon: "sprout", description: "Growth over time with an inflation-adjusted column." },
  blank: { icon: "table-2", description: "Inputs, Calculations, Output and Checks sheets." },
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
  const manifest = useManifest(instance.appId);
  const templates = useMemo(
    () => (manifest?.steps.find((st) => st.id === "intent")?.options ?? []).filter((o) => o.value !== "import" && ABOUT[o.value]),
    [manifest],
  );
  const byId = useTree((s) => s.byId);
  const recent = useMemo(() => {
    const out = [];
    for (const p of byId.values()) if (p.kind === "sheet" && !p.deletedAt) out.push(p);
    return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12);
  }, [byId]);
  const pathOf = (id: string) => {
    const parts: string[] = [];
    let cur = byId.get(id)?.parentId ?? null;
    while (cur) {
      const p = byId.get(cur);
      if (!p) break;
      parts.unshift(p.title || "Untitled");
      cur = p.parentId;
    }
    return parts.join(" / ");
  };

  const create = async (intent: string) => {
    setCreating(intent);
    try {
      const meta = await api.lifeapp.addWorkbook({ instanceId: instance.id, intent });
      notify.success(`${meta.title} created`, { description: "Inputs are tinted; formulas and checks are ready." });
      navigate({ t: "page", id: meta.id });
    } catch (e) {
      notify.fromError(e, "Couldn’t create the spreadsheet");
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
        title={identity("spreadsheet-studio").name}
        subtitle={(() => {
          const n = Number(metrics?.workbook_count?.value ?? recent.length);
          return `Calculators and trackers built to be checked · ${n} ${n === 1 ? "spreadsheet" : "spreadsheets"}`;
        })()}
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
                {!manifest
                  ? Array.from({ length: 6 }, (_, i) => <div key={i} className="st-tpl panel" aria-hidden />)
                  : null}
                {templates.map((t) => {
                  const about = ABOUT[t.value];
                  const Icon = iconByName(about.icon) ?? SheetIcon;
                  const th = THUMBS[t.value] ?? THUMBS.blank;
                  return (
                    <button key={t.value} type="button" className="st-tpl panel" aria-busy={creating === t.value || undefined} onClick={() => void create(t.value)} disabled={!!creating}>
                      <div className="st-thumb well" data-static="" aria-hidden>
                        {Array.from({ length: 25 }, (_, k) => {
                          const kind = th.in.includes(k) ? "is-in" : th.out.includes(k) ? "is-out" : k < 5 ? "is-h" : undefined;
                          return <span key={k} className={kind} />;
                        })}
                      </div>
                      <div className="st-meta">
                        <div className="flex items-center gap-2">
                          {creating === t.value ? <Spinner size={14} /> : <Icon size={14} className="text-tertiary" aria-hidden />}
                          <span className="text-body-sm font-semibold text-primary">{t.label}</span>
                        </div>
                        <span className="text-caption text-tertiary">{about.description}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
            <section>
              <h2 className="la-section-title">Recent spreadsheets</h2>
              <Card pad="md">
                {recent.length ? (
                  <ul className="flex flex-col">
                    {recent.map((p) => (
                      <li key={p.id}>
                        <button type="button" className="st-wb-row w-full" onClick={() => navigate({ t: "page", id: p.id })}>
                          <PageIcon icon={p.icon} kind="sheet" size={20} />
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate text-body font-medium text-primary">{p.title || "Untitled"}</span>
                            <span className="truncate text-caption text-tertiary">{pathOf(p.id) || "Workspace"}</span>
                          </span>
                          <span className="text-caption text-tertiary">{formatRelative(p.updatedAt)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="py-6 text-center text-body-sm text-tertiary">Your spreadsheets will show up here.</p>
                )}
              </Card>
            </section>
          </div>
          <div className="flex min-w-0 flex-col gap-5">
            <Card title="How these spreadsheets are built">
              <ul className="flex flex-col gap-2.5 text-body-sm text-secondary">
                <li className="flex gap-2.5"><span className="st-legend" style={{ background: `color-mix(in oklab, ${color} 26%, transparent)`, boxShadow: "inset 0 0 0 1px color-mix(in oklab, var(--app) 30%, transparent)" }} />Tinted cells are inputs. Change these.</li>
                <li className="flex gap-2.5"><span className="st-legend" style={{ background: color }} /><span><strong className="font-semibold text-primary">Bold</strong> cells are the answers.</span></li>
                <li className="flex gap-2.5"><span className="st-legend bg-gain-soft" style={{ boxShadow: "inset 0 0 0 1px color-mix(in oklab, var(--gain) 35%, transparent)" }} />The Checks tab shows whether the numbers add up.</li>
                <li className="flex gap-2.5"><span className="st-legend well" data-static="" />Header rows stay in view as you scroll.</li>
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
