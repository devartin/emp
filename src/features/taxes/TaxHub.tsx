/**
 * Tax Organizer hub (§16.4): document status ring, next-deadline countdown, estimated balance card, quarterly
 * timeline, deductions vs standard, insights and the persistent disclaimer; plus Estimator, Quarterly plan,
 * Documents and Deductions tabs. Copy never says "you owe" — every figure is an estimate.
 */
import { AlertTriangle, Check, ChevronRight, FileCheck2, FileText, Plus, ReceiptText, ShieldAlert } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { Suspense, useMemo, useState } from "react";
import type { Id, Insight } from "@/backend/types";
import { navigate } from "@/app/router";
import { cn } from "@/lib/cn";
import { Badge } from "@/ui/Badge";
import { Banner } from "@/ui/Banner";
import { Button } from "@/ui/Button";
import { Checkbox } from "@/ui/Checkbox";
import { Dialog } from "@/ui/Dialog";
import { Input } from "@/ui/Input";
import { MoneyField } from "@/ui/MoneyField";
import { staggerItem, staggerList } from "@/ui/motion/presets";
import { Select } from "@/ui/Select";
import { Sensitive } from "@/ui/Sensitive";
import { Skeleton } from "@/ui/Skeleton";
import type { TabItem } from "@/ui/Tabs";
import { Tooltip } from "@/ui/Tooltip";
import "../finance/shared/finance.css";
import { daysBetween, dayLabel, fmtMoney, num, todayIso } from "../finance/shared/format";
import { HubPage, InsightCard, Quiet, Section } from "../finance/shared/ui";
import { BudgetRing } from "../finance/MoneyHQ/widgets";
import { DOC_FLOW, DOC_LABEL, STATUS_LABEL, TaxCtx, useTax, useTaxData, type DocRow } from "./data";
import Estimator, { Result } from "./Estimator";
import QuarterlyPlan, { useQuarterly } from "./QuarterlyPlan";
import "./taxes.css";


export interface TaxHubProps {
  instanceId: Id;
  tab?: string;
}

type TTab = "overview" | "estimator" | "quarterly" | "documents" | "deductions";
const TABS: TTab[] = ["overview", "estimator", "quarterly", "documents", "deductions"];

export default function TaxHub({ instanceId, tab }: TaxHubProps) {
  const data = useTaxData(instanceId);
  const current = (TABS.includes(tab as TTab) ? tab : "overview") as TTab;
  const go = (t: TTab) => navigate({ t: "app", instanceId, tab: t === "overview" ? undefined : t });
  const received = data.docs.filter((d) => d.status !== "expected" && d.status !== "na").length;
  const expected = data.docs.filter((d) => d.status !== "na").length;
  const tabs: TabItem<TTab>[] = [
    { value: "overview", label: "Overview" },
    { value: "estimator", label: "Estimator" },
    { value: "quarterly", label: "Quarterly payments" },
    { value: "documents", label: "Documents", count: expected ? expected - received : undefined },
    { value: "deductions", label: "Deductions" },
  ];
  const disclaimer = data.estimate?.disclaimer ?? (data.pack ? `Estimates for planning only, based on ${data.pack.name} ${data.pack.year} v${data.pack.version} verified ${data.pack.verifiedOn}. Not tax advice. Verify with official sources or a qualified professional.` : "Estimates for planning only. Not tax advice. Verify with official sources or a qualified professional.");
  return (
    <TaxCtx.Provider value={data}>
      <HubPage
        icon={ReceiptText}
        tone="amber"
        title={`Tax year ${data.year}`}
        subtitle={data.profile ? <>{STATUS_LABEL[data.profile.filingStatus] ?? data.profile.filingStatus} · {data.pack ? `${data.pack.name} pack v${data.pack.version} · verified ${dayLabel(data.pack.verifiedOn, true)}` : data.profile.packId}{data.pack?.stale ? <Badge tone="warning">Stale pack</Badge> : null}</> : null}
        actions={
          <Button size="sm" variant="secondary" iconRight={ChevronRight} onClick={() => go("estimator")}>
            Open estimator
          </Button>
        }
        tabs={tabs}
        tab={current}
        onTab={go}
      >
        <Banner tone="warning" icon={ShieldAlert} inline className="tx-disclaimer">
          {disclaimer}
        </Banner>
        <Suspense fallback={<Skeleton height={420} radius={14} />}>
          {current === "overview" ? <Overview go={go} instanceId={instanceId} /> : null}
          {current === "estimator" ? <Estimator /> : null}
          {current === "quarterly" ? <QuarterlyPlan /> : null}
          {current === "documents" ? <Documents /> : null}
          {current === "deductions" ? <Deductions /> : null}
        </Suspense>
      </HubPage>
    </TaxCtx.Provider>
  );
}

// ───────────────────────────────────────────────────────────────────────────── overview

function Overview({ go, instanceId }: { go: (t: TTab) => void; instanceId: Id }) {
  const tx = useTax();
  const plan = useQuarterly();
  const received = tx.docs.filter((d) => d.status !== "expected" && d.status !== "na").length;
  const expected = tx.docs.filter((d) => d.status !== "na").length;
  const deadlines = useMemo(() => {
    const out: { name: string; date: string }[] = [];
    for (const d of plan.data?.due ?? []) if (d.status !== "paid") out.push({ name: `${d.period} estimated payment`, date: d.date });
    out.push({ name: "Federal return due", date: `${tx.year + 1}-04-15` });
    for (const d of tx.docs) if (d.status === "expected" && d.expected) out.push({ name: `${d.name} from ${d.issuer}`, date: d.expected });
    return out.filter((d) => d.date >= todayIso()).sort((a, b) => (a.date < b.date ? -1 : 1));
  }, [plan.data, tx.docs, tx.year]);
  const next = deadlines[0];
  const nextDays = next ? daysBetween(todayIso(), next.date) : null;
  const est = tx.estimate;
  const itemized = tx.deductions.filter((d) => ["charity", "medical", "salt", "mortgage"].includes(d.category)).reduce((a, d) => a + d.amount * d.pct, 0);
  const std = est ? num(est.deduction.standardWouldBe) : 0;
  const insights = useMemo(() => {
    const out: Insight[] = [];
    const tab = (t: string) => ({ t: "app" as const, instanceId, tab: t });
    if (next && nextDays !== null && nextDays <= 14) out.push({ id: "dl", appInstanceId: instanceId, ruleId: nextDays <= 3 ? "deadline-3" : "deadline-14", severity: nextDays <= 3 ? "warn" : "tip", title: `${next.name} in ${nextDays} days`, body: `Due ${dayLabel(next.date, true)}.`, actions: [{ label: "See plan", route: tab("quarterly") }] });
    const se = tx.input?.incomes.filter((i) => i.kind === "self_employment").reduce((a, i) => a + num(i.amount), 0) ?? 0;
    if (se > 0 && !tx.payments.some((p) => p.paidOn)) out.push({ id: "se", appInstanceId: instanceId, ruleId: "se-no-estimates", severity: "warn", title: "Self-employment income but no estimated payments yet", body: "The US pack expects quarterly payments when you'll owe $1,000 or more beyond withholding.", actions: [{ label: "Plan payments", route: tab("quarterly") }] });
    if (std && itemized >= std * 0.9 && itemized < std) out.push({ id: "item", appInstanceId: instanceId, ruleId: "itemize-close", severity: "info", title: "Itemised deductions are close to the standard deduction", body: `${fmtMoney(itemized, "USD", { noCents: true })} itemised vs ${fmtMoney(std, "USD", { noCents: true })} standard — a few more gifts or receipts could tip it.`, actions: [{ label: "Open deductions", route: tab("deductions") }] });
    const noReceipt = tx.deductions.filter((d) => d.amount > 250 && !d.receipt);
    if (noReceipt.length) out.push({ id: "rcpt", appInstanceId: instanceId, ruleId: "receipt-missing", severity: "tip", title: `${noReceipt.length} ${noReceipt.length === 1 ? "deduction over $250 has" : "deductions over $250 have"} no receipt`, body: noReceipt.map((d) => d.desc).slice(0, 3).join(", "), actions: [{ label: "Open deductions", route: tab("deductions") }] });
    const late = tx.docs.filter((d) => d.status === "expected" && d.expected && daysBetween(d.expected, todayIso()) > 14);
    if (late.length) out.push({ id: "late", appInstanceId: instanceId, ruleId: "doc-late", severity: "tip", title: `${late.length} expected ${late.length === 1 ? "document is" : "documents are"} late`, body: late.map((d) => `${d.name} (${d.issuer})`).join(", "), actions: [{ label: "Open documents", route: tab("documents") }] });
    if (tx.pack?.stale) out.push({ id: "stale", appInstanceId: instanceId, ruleId: "pack-stale", severity: "warn", title: "The tax pack may be out of date", body: "Figures come from a pack verified more than 13 months ago or for a different year.", actions: [] });
    return out;
  }, [next, nextDays, tx, std, itemized, instanceId]);

  return (
    <m.div className="fh-grid" variants={staggerList(0.04)} initial="hidden" animate="show">
      <m.div variants={staggerItem} className="fh-span-7">
        <Result est={est} loading={tx.estimating && !est} unsure={tx.profile?.unsure} compact />
      </m.div>
      <m.div variants={staggerItem} className="fh-span-5 flex flex-col gap-3">
        <button type="button" className="fh-metric" onClick={() => go("documents")}>
          <BudgetRing ratio={expected ? received / expected : 0} size={56} stroke={5} color={received === expected && expected ? "var(--gain)" : "var(--accent-solid)"}>
            <span className="text-caption font-semibold tabular">{received}/{expected}</span>
          </BudgetRing>
          <span className="min-w-0 flex-1 text-left">
            <span className="block text-caption text-secondary" style={{ fontWeight: 500 }}>Documents</span>
            <span className="block fh-metric-value">{expected - received ? `${expected - received} still expected` : "All received"}</span>
            <span className="block text-caption text-tertiary">W-2s and most 1099s arrive by Jan 31</span>
          </span>
        </button>
        <button type="button" className="fh-metric" onClick={() => go("quarterly")}>
          <span className="tx-countdown">
            <b className="tabular">{nextDays ?? "—"}</b>
            <span>days</span>
          </span>
          <span className="min-w-0 flex-1 text-left">
            <span className="block text-caption text-secondary" style={{ fontWeight: 500 }}>Next deadline</span>
            <span className="block fh-metric-value truncate" style={{ fontSize: 16 }}>{next?.name ?? "Nothing due"}</span>
            <span className="block text-caption text-tertiary">{next ? dayLabel(next.date, true) : ""}</span>
          </span>
        </button>
      </m.div>
      <m.div variants={staggerItem} className="fh-span-7">
        <Section title="Quarterly timeline" actions={<Button size="xs" variant="ghost" iconRight={ChevronRight} onClick={() => go("quarterly")}>Plan</Button>}>
          {!plan.data ? (
            <Skeleton height={80} />
          ) : (
            <div className="tx-mini-tl">
              {plan.data.due.map((d) => (
                <div key={d.period} className="tx-mini-q" data-status={d.status}>
                  <span className="tx-mini-dot">{d.status === "paid" ? <Check size={11} strokeWidth={3} /> : null}</span>
                  <span className="text-body-sm font-semibold">{d.period}</span>
                  <span className="text-caption text-tertiary">{dayLabel(d.date)}</span>
                  <span className="text-caption tabular font-medium">{d.status !== "paid" && num(d.suggested) === 0 ? <span className="text-gain-text">Covered</span> : <Sensitive>{fmtMoney(d.status === "paid" ? d.paid : d.suggested, "USD", { noCents: true })}</Sensitive>}</span>
                </div>
              ))}
            </div>
          )}
        </Section>
      </m.div>
      <m.div variants={staggerItem} className="fh-span-5">
        <Section title="Deductions vs standard" actions={<Button size="xs" variant="ghost" iconRight={ChevronRight} onClick={() => go("deductions")}>Log</Button>}>
          {est ? (
            <div className="flex flex-col gap-3">
              <DedBar label="Itemisable so far" value={itemized} max={Math.max(std, itemized) * 1.08} tone={itemized > std ? "gain" : "neutral"} />
              <DedBar label="Standard deduction" value={std} max={Math.max(std, itemized) * 1.08} tone="accent" />
              <span className="text-caption text-tertiary" style={{ fontWeight: 400 }}>
                {itemized > std ? "Itemising looks better this year." : `${fmtMoney(std - itemized, "USD", { noCents: true })} more in itemised deductions would be needed to beat the standard.`}
              </span>
            </div>
          ) : (
            <Skeleton height={90} />
          )}
        </Section>
      </m.div>
      <m.div variants={staggerItem} className="fh-span-12">
        <Section title="Insights" subtitle="From the pack's rules and your organiser.">
          {insights.length ? (
            <div className="fh-insights">
              {insights.map((i) => <InsightCard key={i.id} insight={i} />)}
            </div>
          ) : (
            <Quiet title="You're on track" body="No deadlines in the next two weeks and nothing missing." />
          )}
        </Section>
      </m.div>
    </m.div>
  );
}

function DedBar({ label, value, max, tone }: { label: string; value: number; max: number; tone: "gain" | "accent" | "neutral" }) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-body-sm mb-1">
        <span className="text-secondary">{label}</span>
        <span className="tabular font-semibold"><Sensitive>{fmtMoney(value, "USD", { noCents: true })}</Sensitive></span>
      </div>
      <div className="fh-meter" style={{ height: 10 }}>
        <m.i initial={{ scaleX: 0 }} animate={{ scaleX: max ? value / max : 0 }} transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }} style={{ background: tone === "gain" ? "var(--gain)" : tone === "accent" ? "var(--accent-solid)" : "color-mix(in oklab, var(--text-primary) 35%, transparent)" }} />
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── documents

function Documents() {
  const tx = useTax();
  const groups = useMemo(() => {
    const m = new Map<string, DocRow[]>();
    for (const d of tx.docs) {
      const k = d.status === "na" ? "Not needed" : d.status === "expected" ? "Waiting for" : "In hand";
      const list = m.get(k) ?? [];
      list.push(d);
      m.set(k, list);
    }
    return ["Waiting for", "In hand", "Not needed"].filter((k) => m.has(k)).map((k) => [k, m.get(k)!] as const);
  }, [tx.docs]);
  if (!tx.schemas.documents) return <Skeleton height={360} radius={14} />;
  return (
    <div className="flex flex-col gap-4">
      {groups.map(([g, list]) => (
        <Section key={g} title={g} subtitle={g === "Waiting for" ? "Click a status to move it along." : undefined} pad={false}>
          <AnimatePresence initial={false}>
            {list.map((d) => {
              const late = d.status === "expected" && d.expected && daysBetween(d.expected, todayIso()) > 14;
              const idx = DOC_FLOW.indexOf(d.status);
              return (
                <m.div key={d.id} layout className="tx-doc" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <span className="tx-doc-icon" data-status={d.status}>{d.status === "expected" ? <FileText size={16} /> : <FileCheck2 size={16} />}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-body font-semibold">{d.name}</span>
                      <span className="text-body-sm text-secondary truncate">{d.issuer}</span>
                      {late ? <Badge tone="warning" icon={AlertTriangle}>Late</Badge> : null}
                    </div>
                    <div className="text-caption text-tertiary truncate" style={{ fontWeight: 400 }}>
                      {d.purpose}
                      {d.expected ? ` · expected by ${dayLabel(d.expected, true)}` : ""}
                      {d.notes ? ` · ${d.notes}` : ""}
                    </div>
                  </div>
                  <div className="tx-steps" role="group" aria-label={`Status of ${d.name}`}>
                    {DOC_FLOW.map((s, i) => (
                      <Tooltip key={s} content={DOC_LABEL[s]}>
                        <button type="button" className={cn("tx-step", i <= idx && "is-done", i === idx && "is-current")} onClick={() => void tx.setDocStatus(d.id, s)} aria-pressed={i === idx} aria-label={DOC_LABEL[s]}>
                          <span />
                        </button>
                      </Tooltip>
                    ))}
                    <span className="tx-step-label">{DOC_LABEL[d.status] ?? d.status}</span>
                  </div>
                  <Button size="xs" variant="ghost" title={d.status === "na" ? "Move back to the checklist" : "This form doesn't apply to me this year"} onClick={() => void tx.setDocStatus(d.id, d.status === "na" ? "expected" : "na")}>
                    {d.status === "na" ? "Needed after all" : "Not needed"}
                  </Button>
                </m.div>
              );
            })}
          </AnimatePresence>
        </Section>
      ))}
      {tx.schemas.documents ? (
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" iconRight={ChevronRight} onClick={() => navigate({ t: "db", id: tx.schemas.documents!.database.id })}>
            Open the checklist database
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── deductions

const DED_CATS = [
  { value: "charity", label: "Charitable gifts" },
  { value: "medical", label: "Medical & dental" },
  { value: "salt", label: "State & local taxes" },
  { value: "mortgage", label: "Mortgage interest" },
  { value: "home_office", label: "Home office" },
  { value: "business", label: "Business expense" },
  { value: "education", label: "Education" },
  { value: "hsa", label: "HSA contribution" },
  { value: "ira", label: "IRA contribution" },
];

function Deductions() {
  const tx = useTax();
  const [adding, setAdding] = useState(false);
  const byCat = useMemo(() => {
    const m = new Map<string, { name: string; total: number; n: number }>();
    for (const d of tx.deductions) {
      const e = m.get(d.category) ?? { name: d.categoryName, total: 0, n: 0 };
      e.total += d.amount * d.pct;
      e.n++;
      m.set(d.category, e);
    }
    return [...m.entries()].sort((a, b) => b[1].total - a[1].total);
  }, [tx.deductions]);
  const total = tx.deductions.reduce((a, d) => a + d.amount * d.pct, 0);
  return (
    <div className="fh-grid">
      <Section className="fh-span-4" title="By category" subtitle={<>Total logged <Sensitive>{fmtMoney(total, "USD", { noCents: true })}</Sensitive></>}>
        <div className="flex flex-col gap-3">
          {byCat.map(([k, v]) => (
            <div key={k}>
              <div className="flex justify-between text-body-sm mb-1">
                <span className="text-secondary">{v.name}</span>
                <span className="tabular font-semibold"><Sensitive>{fmtMoney(v.total, "USD", { noCents: true })}</Sensitive></span>
              </div>
              <div className="fh-meter"><i style={{ transform: `scaleX(${total ? v.total / total : 0})` }} /></div>
            </div>
          ))}
          <div className="text-caption text-tertiary mt-1" style={{ fontWeight: 400 }}>
            Business and home-office costs reduce self-employment income; HSA and IRA lower AGI; charity, medical, state taxes and mortgage interest count only if you itemise.
          </div>
        </div>
      </Section>
      <Section className="fh-span-8" title="Deductions & credits" actions={<Button size="xs" variant="primary" icon={Plus} onClick={() => setAdding(true)}>Log deduction</Button>} pad={false}>
        {tx.deductions.length ? (
          <table className="fh-table">
            <thead>
              <tr>
                <th>Description</th>
                <th>Category</th>
                <th>Date</th>
                <th>Receipt</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {tx.deductions.map((d) => (
                <tr key={d.id}>
                  <td>
                    <div className="font-medium">{d.desc}</div>
                    <div className="text-caption text-tertiary" style={{ fontWeight: 400 }}>{d.payee}</div>
                  </td>
                  <td><Badge tone="outline">{d.categoryName}</Badge></td>
                  <td className="text-secondary">{d.date ? dayLabel(d.date, true) : "—"}</td>
                  <td>{d.receipt ? <span className="inline-flex items-center gap-1 text-caption text-gain-text"><Check size={13} /> Kept</span> : d.amount > 250 ? <Badge tone="warning">Missing</Badge> : <span className="text-caption text-tertiary">—</span>}</td>
                  <td className="num font-medium"><Sensitive align="end">{fmtMoney(d.amount * d.pct)}</Sensitive></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Quiet icon={ReceiptText} title="No deductions yet" body="Log gifts, medical bills and business costs as they happen — it's much easier than in April." action={<Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Log deduction</Button>} />
        )}
      </Section>
      {adding ? <AddDeduction onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

function AddDeduction({ onClose }: { onClose: () => void }) {
  const tx = useTax();
  const [desc, setDesc] = useState("");
  const [cat, setCat] = useState<string | null>("charity");
  const [amount, setAmount] = useState<string | null>(null);
  const [date, setDate] = useState(todayIso());
  const [payee, setPayee] = useState("");
  const [receipt, setReceipt] = useState(true);
  const valid = desc.trim() && cat && num(amount) > 0;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Log a deduction"
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} onClick={() => void tx.addDeduction({ desc: desc.trim(), date, category: cat!, amount: num(amount), payee, receipt }).then(onClose)}>
            Log it
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input label="What was it?" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="e.g. Year-end gift to the food bank" autoFocus />
        <div className="grid grid-cols-2 gap-3">
          <Select label="Category" value={cat} onValueChange={setCat} options={DED_CATS} />
          <MoneyField label="Amount" value={amount} onChange={setAmount} />
          <Input label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <Input label="Paid to" value={payee} onChange={(e) => setPayee(e.target.value)} />
        </div>
        <Checkbox checked={receipt} onCheckedChange={(v) => setReceipt(!!v)} label="I have a receipt" description="Keep receipts for gifts of $250 or more." />
      </div>
    </Dialog>
  );
}

