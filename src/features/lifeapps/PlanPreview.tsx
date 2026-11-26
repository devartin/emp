/**
 * Live plan preview (§6.5 right column): a miniature of the hub that reacts to answers, then "What we'll create" —
 * every generated item grouped by kind, with a switch on each optional one so the user can opt out.
 */
import { AlertTriangle, Bell, Database, Eye, FileText, LayoutDashboard, ListChecks, Repeat, Sheet as SheetIcon, Target, Wand2 } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useMemo, type ReactNode } from "react";
import type { GenerationPlan, GenerationPlanItem, LifeAppManifest } from "@/backend/types";
import { cn } from "@/lib/cn";
import { formatCurrency } from "@/lib/format";
import { Skeleton } from "@/ui/Skeleton";
import { Switch } from "@/ui/Switch";
import { spring } from "@/ui/motion/tokens";
import { describeCounts, SHEET_TITLES } from "./engine/plan";
import { identity } from "./identity";
import { humanValue } from "./steps/fields";

const KIND: Record<GenerationPlanItem["kind"], { label: string; icon: typeof FileText }> = {
  dashboard: { label: "Dashboards", icon: LayoutDashboard },
  page: { label: "Pages", icon: FileText },
  database: { label: "Databases", icon: Database },
  sheet: { label: "Workbooks", icon: SheetIcon },
  view: { label: "Views", icon: Eye },
  reminder: { label: "Reminders", icon: Bell },
  recurring: { label: "Recurring", icon: Repeat },
  rule: { label: "Rules", icon: Wand2 },
  goal: { label: "Goals", icon: Target },
};
const ORDER: GenerationPlanItem["kind"][] = ["dashboard", "page", "database", "sheet", "view", "goal", "rule", "recurring", "reminder"];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function PlanPreview({ manifest, plan, answers, disabled, onToggle, currency }: { manifest: LifeAppManifest; plan: GenerationPlan | null; answers: Record<string, unknown>; disabled: string[]; onToggle: (key: string, on: boolean) => void; currency: string }) {
  const groups = useMemo(() => {
    if (!plan) return [];
    return ORDER.map((k) => ({ kind: k, items: plan.items.filter((i) => i.kind === k) })).filter((g) => g.items.length);
  }, [plan]);
  const counts = plan ? describeCounts(plan.counts) : "";
  return (
    <div className="la-preview">
      <MiniHub manifest={manifest} answers={answers} currency={currency} />
      <div className="la-preview-head">
        <span className="text-micro uppercase text-tertiary">What we’ll create</span>
        <AnimatePresence mode="wait" initial={false}>
          <m.span key={counts} className="la-preview-counts" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
            {counts || " "}
          </m.span>
        </AnimatePresence>
      </div>
      {!plan ? (
        <div className="flex flex-col gap-2 px-1">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} height={16} width={`${80 - i * 7}%`} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((g) => {
            const K = KIND[g.kind];
            return (
              <section key={g.kind} aria-label={K.label}>
                <h4 className="la-preview-group">
                  <K.icon size={12} aria-hidden />
                  {K.label}
                </h4>
                <ul className="flex flex-col">
                  <AnimatePresence initial={false}>
                    {g.items.map((it) => {
                      const off = disabled.includes(it.key);
                      return (
                        <m.li key={it.key} layout="position" className={cn("la-preview-item", off && "is-off")} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0, transition: spring.gentle }} exit={{ opacity: 0, transition: { duration: 0.1 } }}>
                          <span className="min-w-0 flex-1 truncate">{it.title}</span>
                          {it.count !== undefined && it.count > 1 ? <span className="la-count">×{it.count}</span> : null}
                          {it.optional ? <Switch size="sm" checked={!off} onCheckedChange={(on) => onToggle(it.key, on)} aria-label={`Create ${it.title}`} /> : null}
                        </m.li>
                      );
                    })}
                  </AnimatePresence>
                </ul>
              </section>
            );
          })}
          {plan.warnings.length ? (
            <ul className="flex flex-col gap-1.5 pt-1">
              {plan.warnings.map((w) => (
                <li key={w} className="flex items-start gap-2 text-caption text-secondary">
                  <AlertTriangle size={13} className="mt-px flex-none text-warning-text" aria-hidden />
                  {w}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** A miniature of the hub that reacts to answers (crossfades over 160 ms). */
function MiniHub({ manifest, answers, currency }: { manifest: LifeAppManifest; answers: Record<string, unknown>; currency: string }) {
  const id = identity(manifest.id);
  const Icon = id.icon;
  const content = miniContent(manifest.id, answers, currency);
  return (
    <div className="la-mini" style={{ ["--app" as string]: id.color }}>
      <div className="la-mini-banner" />
      <div className="la-mini-head">
        <span className="la-tile la-tile-sm" style={{ background: id.color }}>
          <Icon size={12} strokeWidth={2.25} aria-hidden />
        </span>
        <span className="truncate text-body-sm font-semibold">{content.title ?? manifest.title}</span>
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <m.div key={content.key} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }} className="la-mini-body">
          {content.node}
        </m.div>
      </AnimatePresence>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="la-mini-kpi">
      <span className="la-mini-kpi-l">{label}</span>
      <span className="la-mini-kpi-v tabular">{value}</span>
    </div>
  );
}

function miniContent(appId: string, a: Record<string, unknown>, currency: string): { key: string; node: ReactNode; title?: string } {
  switch (appId) {
    case "money-hq": {
      const method = String(a.method ?? "fifty_thirty_twenty");
      const income = isObj(a.income) && Array.isArray(a.income.items) ? (a.income.items as Record<string, unknown>[]) : [];
      const pay = income.reduce((s, i) => s + (Number(i.amount) || 0), 0);
      const months = isObj(a.emergency) ? Number(a.emergency.months ?? 6) : 6;
      const label = method === "zero_based" || method === "envelopes" ? "To be assigned" : "Left to spend";
      return {
        key: `${method}-${pay}-${months}`,
        node: (
          <>
            <div className="grid grid-cols-3 gap-1.5">
              <Kpi label={label} value={pay ? formatCurrency(pay, currency, { maximumFractionDigits: 0 }) : "—"} />
              <Kpi label="Savings rate" value="—" />
              <Kpi label="Emergency" value={`${months} mo`} />
            </div>
            <div className="la-mini-bars" aria-hidden>
              {[0.82, 0.55, 0.7, 0.38, 0.62, 0.48].map((h, i) => (
                <span key={i} style={{ height: `${h * 100}%` }} />
              ))}
            </div>
            <p className="la-mini-caption">{({ fifty_thirty_twenty: "50/30/20 · Needs, Wants, Savings & Debt", zero_based: "Zero-based · every dollar gets a job", pay_yourself_first: "Pay yourself first · savings move on payday", envelopes: "Envelopes · fixed amounts per category", track_only: "Track only · no targets" } as Record<string, string>)[method]}</p>
          </>
        ),
      };
    }
    case "portfolio": {
      const t = String(a.targets ?? "three_fund");
      const mix: Record<string, [string, number][]> = { three_fund: [["US", 60], ["Intl", 30], ["Bonds", 10]], sixty_forty: [["Stocks", 60], ["Bonds", 40]], age_based: [["Stocks", 77], ["Bonds", 23]], all_equity: [["US", 70], ["Intl", 20], ["EM", 10]], custom: [] };
      const rows = mix[t] ?? [];
      return {
        key: t,
        node: (
          <>
            <div className="la-mini-alloc" aria-hidden>
              {rows.map(([, v], i) => (
                <span key={i} style={{ flexGrow: v, opacity: 1 - i * 0.22 }} />
              ))}
              {!rows.length ? <span style={{ flexGrow: 1, opacity: 0.18 }} /> : null}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-caption text-secondary">
              {rows.length ? rows.map(([k, v]) => <span key={k} className="tabular">{k} {v}%</span>) : <span>Set your own targets</span>}
            </div>
            <p className="la-mini-caption">Example starting point, not a recommendation.</p>
          </>
        ),
      };
    }
    case "tax-organizer": {
      const j = isObj(a.jurisdiction) ? a.jurisdiction : {};
      const income = Array.isArray(a.income) ? (a.income as string[]) : [];
      return {
        key: `${j.year}-${income.join()}`,
        title: `Tax Year ${j.year ?? new Date().getFullYear()}`,
        node: (
          <>
            <div className="grid grid-cols-2 gap-1.5">
              <Kpi label="Documents" value={`0 of ${Math.max(1, income.length + 2)}`} />
              <Kpi label="Next deadline" value={income.includes("self_employment") ? "Jan 15" : "Apr 15"} />
            </div>
            <div className="flex flex-wrap gap-1">
              {income.slice(0, 5).map((i) => (
                <span key={i} className="la-mini-chip">{humanValue(i)}</span>
              ))}
            </div>
          </>
        ),
      };
    }
    case "spreadsheet-studio": {
      const intent = String(a.intent ?? "blank");
      const tabs: Record<string, string[]> = { loan: ["Inputs", "Schedule", "Scenarios"], budget: ["Overview", "Budget", "Transactions"], decision: ["Decision"], project_budget: ["Budget"], timesheet: ["Timesheet"], inventory: ["Inventory"], split: ["Expenses", "Balances"], savings: ["Growth"], blank: ["Inputs", "Calculations", "Output", "Checks"] };
      return {
        key: intent,
        title: SHEET_TITLES[intent] ?? "Workbook",
        node: (
          <>
            <div className="la-mini-grid" aria-hidden>
              {Array.from({ length: 24 }, (_, i) => (
                <span key={i} className={cn(i % 6 === 0 && "is-head", (i === 7 || i === 8) && "is-input", i === 21 && "is-out")} />
              ))}
            </div>
            <div className="flex gap-1">
              {(tabs[intent] ?? ["Sheet1"]).map((t, i) => (
                <span key={t} className={cn("la-mini-tab", i === 0 && "is-on")}>{t}</span>
              ))}
            </div>
          </>
        ),
      };
    }
    case "life-os": {
      const areas = Array.isArray(a.areas) ? (a.areas as string[]) : [];
      return {
        key: areas.join(),
        node: (
          <>
            <div className="flex flex-col gap-1">
              {["Plan the week", "Inbox zero", "Call about the boiler"].map((t, i) => (
                <div key={t} className="la-mini-task">
                  <span className={cn("la-mini-box", i === 0 && "is-done")} />
                  <span className={cn("truncate", i === 0 && "line-through text-tertiary")}>{t}</span>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-1">
              {areas.slice(0, 6).map((x) => (
                <span key={x} className="la-mini-chip">{x}</span>
              ))}
              {areas.length > 6 ? <span className="la-mini-chip">+{areas.length - 6}</span> : null}
            </div>
          </>
        ),
      };
    }
    case "habits": {
      const pick = Array.isArray(a.pick) ? (a.pick as unknown[]) : [];
      const names = pick.map((p) => (typeof p === "string" ? p : isObj(p) ? String(p.name ?? "") : "")).filter(Boolean);
      return {
        key: names.join(),
        node: (
          <>
            <div className="la-mini-heat" aria-hidden>
              {Array.from({ length: 42 }, (_, i) => (
                <span key={i} style={{ opacity: [0.15, 1, 0.8, 1, 0.55, 1, 1][(i * 5) % 7] }} />
              ))}
            </div>
            <div className="flex flex-wrap gap-1">
              {names.slice(0, 4).map((n) => (
                <span key={n} className="la-mini-chip">{n}</span>
              ))}
              {!names.length ? <span className="la-mini-chip">Pick a habit</span> : null}
            </div>
          </>
        ),
      };
    }
    default:
      return { key: "x", node: <ListChecks size={18} aria-hidden /> };
  }
}
