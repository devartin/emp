/** Money HQ overview: net-worth hero with scrub readout, key metrics, budget envelopes, spending donut, cash-flow
 * Sankey, recent transactions, upcoming bills and insights. */
import { ArrowRight, CalendarClock, CheckCircle2, Repeat, Sparkles } from "lucide-react";
import { m } from "motion/react";
import { useMemo, useState } from "react";
import { api } from "@/backend";
import type { Insight } from "@/backend/types";
import { LineChart } from "@/charts/Line";
import { Sankey } from "@/charts/Sankey";
import { useChartTheme, seriesColor } from "@/charts/theme";
import type { SankeyData } from "@/backend/types";
import { Amount } from "@/ui/Amount";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { DeltaPill } from "@/ui/DeltaPill";
import { EdgeLight } from "@/ui/motion/EdgeLight";
import { RollingNumber } from "@/ui/motion/RollingNumber";
import { staggerItem, staggerList } from "@/ui/motion/presets";
import { Segmented } from "@/ui/Segmented";
import { Sensitive } from "@/ui/Sensitive";
import { Skeleton } from "@/ui/Skeleton";
import { addMonths, assignColors, dayLabel, fmtMoney, fmtPct, monthLabel, num, relDays, toMoney, todayIso } from "../shared/format";
import { isIncomeGroup, isSavingGroup, spendingBudget } from "../shared/figures";
import { useAsync, useDbChanged, useScrubIdx, useScrubStore, type ScrubStore } from "../shared/hooks";
import { InsightCard, Quiet, Section } from "../shared/ui";
import { SpendWheel, WheelLegendRow } from "../shared/SpendWheel";
import { localInsights } from "./insights";
import { debtInputs, useLedgerCtx } from "./ledger";
import { useMoney } from "./MoneyHQ";
import { BudgetRing, Envelope, HeroMoney, MetricCard, TxnLine, type EnvelopeData } from "./widgets";
import { DetailBars, KpiDetail, KpiMorphStage, KpiMorphTile } from "./KpiMorph";

type Range = "6m" | "1y" | "3y" | "5y";

export function Overview() {
  return (
    <KpiMorphStage details={(id, close) => <MetricDetail id={id} onClose={close} />}>
    <m.div className="fh-grid" variants={staggerList(0.04)} initial="hidden" animate="show">
      <m.div variants={staggerItem} className="fh-span-8">
        <NetWorthHero />
      </m.div>
      <m.div variants={staggerItem} className="fh-span-4">
        <SideMetrics />
      </m.div>
      <m.div variants={staggerItem} className="fh-span-7">
        <Envelopes />
      </m.div>
      <m.div variants={staggerItem} className="fh-span-5">
        <SpendingDonut />
      </m.div>
      <m.div variants={staggerItem} className="fh-span-12">
        <CashFlow />
      </m.div>
      <m.div variants={staggerItem} className="fh-span-7">
        <Recent />
      </m.div>
      <m.div variants={staggerItem} className="fh-span-5">
        <Upcoming />
      </m.div>
      <m.div variants={staggerItem} className="fh-span-12">
        <Insights />
      </m.div>
    </m.div>
    </KpiMorphStage>
  );
}

// ───────────────────────────────────────────────────────────────────────────── net worth hero

const NW_SERIES = [{ key: "net", label: "Net worth" }];
const xfShort = (v: unknown) => monthLabel(String(v).slice(0, 7), true);
const xfLong = (v: unknown) => {
  const d = String(v);
  return `${monthLabel(d.slice(0, 7), true)} '${d.slice(2, 4)}`;
};
const PERIOD_LABEL: Record<Range, string> = { "6m": "past 6 months", "1y": "past year", "3y": "past 3 years", "5y": "past 5 years" };

type NwPoint = { t: string; net: number; assets: number; liabilities: number };

function NetWorthHero() {
  const { instanceId, overview } = useMoney();
  const l = useLedgerCtx();
  const [range, setRange] = useState<Range>("1y");
  const s = useAsync(() => api.finance.networthSeries({ instanceId, range }), [instanceId, range]);
  useDbChanged([l.schemas.txns?.database.id], s.reload, 400);
  const data = useMemo<NwPoint[]>(() => (s.data ? s.data.t.map((t, i) => ({ t, net: s.data!.net[i], assets: s.data!.assets[i], liabilities: s.data!.liabilities[i] })) : []), [s.data]);
  const long = range === "3y" || range === "5y";
  // The scrub index lives outside this component's state: only the readouts re-render while scrubbing, not the chart.
  const scrub = useScrubStore();
  return (
    <section className="fh-card fh-hero" data-light="" ref={scrub.hostRef} style={{ paddingBottom: 10 }}>
      <EdgeLight specular />
      <div className="flex items-start justify-between gap-4">
        <NetWorthReadout scrub={scrub} data={data} periodLabel={PERIOD_LABEL[range]} />
        <Segmented
          size="sm"
          value={range}
          onValueChange={(v) => setRange(v)}
          aria-label="Range"
          options={[
            { value: "6m", label: "6M" },
            { value: "1y", label: "1Y" },
            { value: "3y", label: "3Y" },
            { value: "5y", label: "5Y" },
          ]}
        />
      </div>
      <div className="mt-3">
        <LineChart
          data={data}
          x="t"
          series={NW_SERIES}
          height={208}
          area
          curve="monotoneX"
          xFormat={long ? xfLong : xfShort}
          tooltip={false}
          onScrub={scrub.set}
          summaryLabel="Net worth"
          loading={s.loading && !s.data}
          hero
        />
      </div>
      <div className="fh-groove -mx-5 mt-1" />
      <div className="flex items-center gap-5 pt-2.5">
        <NetWorthMinis scrub={scrub} data={data} />
        <span className="ml-auto text-caption text-tertiary" style={{ fontWeight: 400 }}>
          {overview ? (
            <>
              <Sensitive>{fmtMoney(overview.netWorthDelta30d.amount, "USD", { noCents: true, signed: true })}</Sensitive> in the last 30 days
            </>
          ) : null}
        </span>
      </div>
    </section>
  );
}

function NetWorthReadout({ scrub, data, periodLabel }: { scrub: ScrubStore; data: NwPoint[]; periodLabel: string }) {
  const idx = useScrubIdx(scrub);
  const cur = data[idx ?? data.length - 1];
  const first = data[0];
  const change = cur && first && first.net ? (cur.net - first.net) / Math.abs(first.net) : 0;
  const delta = cur && first ? cur.net - first.net : 0;
  const scrubbing = idx !== null;
  return (
    <div className="min-w-0">
      <div className="text-caption text-secondary" style={{ fontWeight: 500 }}>
        Net worth
      </div>
      <div className="mt-1 h-[48px] flex items-center">{cur ? <HeroMoney value={cur.net} cents={false} countUpKey="money:networth" scrubbing={scrubbing} /> : <Skeleton width={220} height={38} radius={8} />}</div>
      <div className="flex items-center gap-2 h-6 mt-1">
        {cur ? (
          <>
            <DeltaPill value={change} />
            <span className="text-caption tabular" style={{ fontWeight: 560, color: delta >= 0 ? "var(--gain-text)" : "var(--loss-text)", transition: "color 200ms var(--ease-out)" }} data-sensitive="">
              <RollingNumber value={delta} format={(n) => fmtMoney(Math.round(n), "USD", { noCents: true, signed: true })} scrubbing={scrubbing} countUp={false} sensitive />
            </span>
            <span className="text-caption text-tertiary" style={{ fontWeight: 400 }}>
              {scrubbing ? dayLabel(cur.t, true) : periodLabel}
            </span>
          </>
        ) : null}
      </div>
    </div>
  );
}

function NetWorthMinis({ scrub, data }: { scrub: ScrubStore; data: NwPoint[] }) {
  const idx = useScrubIdx(scrub);
  const cur = data[idx ?? data.length - 1];
  const scrubbing = idx !== null;
  return (
    <>
      <MiniStat label="Assets" value={cur?.assets} scrubbing={scrubbing} />
      <MiniStat label="Liabilities" value={cur ? -cur.liabilities : undefined} scrubbing={scrubbing} />
    </>
  );
}

function MiniStat({ label, value, scrubbing }: { label: string; value: number | undefined; scrubbing?: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-caption text-tertiary" style={{ fontWeight: 500 }}>
        {label}
      </span>
      <span className="text-body-sm font-medium tabular" data-sensitive="">
        {value === undefined ? "—" : <RollingNumber value={value} format={(n) => fmtMoney(Math.round(n), "USD", { noCents: true })} scrubbing={scrubbing} countUp={false} sensitive />}
      </span>
    </span>
  );
}

// ───────────────────────────────────────────────────────────────────────────── side metrics

/**
 * The Debt-free tile's month: `FinanceOverview.debtFreeDate` — the one definition (minimum payments only, from next
 * month, the Debt tab's debts) the `debt_free_date` metric and KPI tile show too. `""` with nothing owed, `null`
 * when minimums never clear the debts, undefined while loading.
 */
function useMinimumDebtFree(debtFreeDate: string | undefined, loaded: boolean): string | null | undefined {
  const l = useLedgerCtx();
  if (!loaded || l.loading) return undefined;
  if (debtFreeDate) return debtFreeDate;
  return debtInputs(l.accounts).length ? null : "";
}

function SideMetrics() {
  const { overview: ov, go } = useMoney();
  const debtFree = useMinimumDebtFree(ov?.debtFreeDate, !!ov);
  if (!ov) {
    return (
      <div className="flex flex-col gap-3 h-full">
        {[0, 1, 2, 3].map((k) => (
          <Skeleton key={k} height={90} radius={14} />
        ))}
      </div>
    );
  }
  const tba = ov.toBeAssigned ? num(ov.toBeAssigned.amount) : null;
  // `debtFree`: undefined while loading, "" with nothing owed, null when minimums never clear it, else the month
  const rate = ov.savingsRate3m;
  return (
    <div className="flex flex-col gap-3 h-full">
      {tba !== null ? (
        <MetricCard
          label="To be assigned"
          tone={tba < 0 ? "warn" : undefined}
          value={<RollingNumber value={tba} format={(n) => fmtMoney(n, "USD")} countUpKey="money:tba" sensitive />}
          sub={tba > 0.005 ? "Give every dollar a job" : tba < -0.005 ? "Assigned more than you have" : "Every dollar has a job"}
          onClick={tba > 0.005 ? undefined : () => go("budget")}
          visual={
            tba > 0.005 ? (
              <Button size="sm" variant="primary" onClick={() => go("budget")}>
                Assign
              </Button>
            ) : tba < -0.005 ? (
              <Badge tone="warning">Fix</Badge>
            ) : (
              <CheckCircle2 size={18} className="text-gain" />
            )
          }
        />
      ) : (
        <MetricCard label="Left to spend" value={<Sensitive>{fmtMoney(ov.leftToSpend?.amount ?? 0)}</Sensitive>} onClick={() => go("budget")} />
      )}
      <KpiMorphTile
        id="savings"
        label="Savings rate · 3 months"
        value={<RollingNumber value={rate * 100} format={(n) => `${n.toFixed(1)}%`} countUp={false} />}
        sub={rate >= 0.2 ? "Above the common 20% guideline" : "Common guideline: 20% or more"}
        visual={<BudgetRing ratio={Math.max(0, Math.min(1, rate / 0.4))} size={40} stroke={4} color={rate >= 0.2 ? "var(--gain)" : "var(--warning)"} delay={0.25} />}
      />
      <KpiMorphTile
        id="ef"
        label="Emergency fund"
        value={`${ov.efMonths.toFixed(1)} months`}
        sub={ov.efMonths >= 6 ? "of essentials · fully funded" : "of essentials · goal 6 months"}
        visual={<BudgetRing ratio={Math.min(1, ov.efMonths / 6)} size={40} stroke={4} color={efColor(ov.efMonths)} delay={0.3} />}
      />
      <MetricCard
        label="Debt-free"
        value={debtFree === undefined ? <span className="flex items-center h-[28px]"><Skeleton width={110} height={20} radius={6} /></span> : debtFree ? monthLabel(debtFree) : debtFree === "" ? "Debt-free" : "Not on minimums"}
        sub={debtFree === undefined ? "\u00a0" : debtFree ? "at minimum payments · see the planner" : debtFree === "" ? "No balances owed" : "minimums never clear it · see the planner"}
        onClick={() => go("debt")}
        visual={<ArrowRight size={16} className="text-tertiary fh-nudge-x" />}
      />
    </div>
  );
}

const fmtCompact = (v: number) => (v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : fmtMoney(v, "USD", { noCents: true }));
const efColor = (months: number) => (months >= 6 ? "var(--gain)" : months >= 3 ? "var(--chart-line)" : "var(--warning)");

/** Month-by-month figures from the ledger (non-transfer flows; splits counted by their parts). */
function useMonthlyFlows(months = 6) {
  const l = useLedgerCtx();
  return useMemo(() => {
    const cur = todayIso().slice(0, 7);
    const keys = Array.from({ length: months }, (_, i) => addMonths(cur, i - months + 1));
    const acc = new Map(keys.map((k) => [k, { income: 0, spend: 0, essential: 0 }]));
    for (const t of l.txns) {
      const k = t.date.slice(0, 7);
      const row = acc.get(k);
      if (!row || t.transferId) continue;
      const parts = t.splits.length ? t.splits : [t];
      for (const p of parts) {
        // The backend's §15.5 definition (savingsRate3m): income = income categories; savings & debt categories are
        // saving; everything else — uncategorised rows and refunds too — is net spending.
        const c = p.categoryId ? l.cat.get(p.categoryId) : undefined;
        if (c && isIncomeGroup(c.group)) row.income += p.amount;
        else if (c && isSavingGroup(c.group)) continue;
        else {
          row.spend -= p.amount;
          if (c?.essential) row.essential -= p.amount;
        }
      }
    }
    return keys.map((k) => ({ month: k, ...(acc.get(k) ?? { income: 0, spend: 0, essential: 0 }) }));
  }, [l.txns, l.cat, months]);
}

function MetricDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { overview: ov, go } = useMoney();
  // completed months only — the current one is partial
  const flows = useMonthlyFlows(7).slice(0, 6);
  if (!ov) return null;
  if (id === "savings") {
    const rate = ov.savingsRate3m;
    const bars = flows.map((f) => {
      const r = f.income > 0 ? (f.income - f.spend) / f.income : 0;
      return { key: f.month, label: monthLabel(f.month, true), value: Math.max(0, r), display: f.income > 0 ? `${r < 0 ? "\u2212" : ""}${Math.abs(Math.round(r * 100))}%` : "—", tone: (r >= 0.2 ? "ink" : "muted") as "ink" | "muted" };
    });
    const last = flows.slice(-3);
    const inc = last.reduce((a, f) => a + f.income, 0) / Math.max(1, last.length);
    const sp = last.reduce((a, f) => a + f.spend, 0) / Math.max(1, last.length);
    return (
      <KpiDetail
        id="savings"
        label="Savings rate · 3 months"
        value={`${(rate * 100).toFixed(1)}%`}
        visual={<BudgetRing ratio={Math.max(0, Math.min(1, rate / 0.4))} size={40} stroke={4} color={rate >= 0.2 ? "var(--gain)" : "var(--warning)"} />}
        onClose={onClose}
        aside={
          <>
            <div className="fh-kv">Avg income <b data-sensitive="">{fmtMoney(inc, "USD", { noCents: true })}</b></div>
            <div className="fh-kv">Avg spending <b data-sensitive="">{fmtMoney(sp, "USD", { noCents: true })}</b></div>
            <div className="fh-kv">Kept <b data-sensitive="">{fmtMoney(inc - sp, "USD", { noCents: true })}/mo</b></div>
            <Button size="sm" variant="secondary" iconRight={ArrowRight} iconMotion="arrow" className="mt-auto" onClick={() => go("transactions")}>
              See transactions
            </Button>
          </>
        }
      >
        <div className="text-caption text-tertiary mb-3" style={{ fontWeight: 400 }}>
          Share of income kept each month (excluding transfers, savings and debt payments). The dashed line is the common 20% guideline.
        </div>
        <DetailBars bars={bars} guide={0.2} guideLabel="20%" />
      </KpiDetail>
    );
  }
  const months = ov.efMonths;
  // The backend's figures behind efMonths, so "Covered today" is the fund itself, not a re-derivation.
  const ess = ov.essentialMonthly ? num(ov.essentialMonthly.amount) : flows.slice(-3).reduce((a, f) => a + f.essential, 0) / 3;
  const covered = ov.efBalance ? num(ov.efBalance.amount) : ess * months;
  const bars = flows.map((f) => ({ key: f.month, label: monthLabel(f.month, true), value: f.essential, display: fmtCompact(f.essential), tone: "ink" as const }));
  return (
    <KpiDetail
      id="ef"
      label="Emergency fund"
      value={`${months.toFixed(1)} months`}
      visual={<BudgetRing ratio={Math.min(1, months / 6)} size={40} stroke={4} color={efColor(months)} />}
      onClose={onClose}
      aside={
        <>
          <div className="fh-kv">Essentials / month <b data-sensitive="">{fmtMoney(ess, "USD", { noCents: true })}</b></div>
          <div className="fh-kv">Covered today <b data-sensitive="">{fmtMoney(covered, "USD", { noCents: true })}</b></div>
          <div className="fh-kv">To 6 months <b data-sensitive="">{months >= 6 ? "Funded" : fmtMoney(Math.max(0, ess * 6 - covered), "USD", { noCents: true })}</b></div>
          <Button size="sm" variant="secondary" iconRight={ArrowRight} iconMotion="arrow" className="mt-auto" onClick={() => go("goals")}>
            Open goals
          </Button>
        </>
      }
    >
      <div className="text-caption text-tertiary mb-3" style={{ fontWeight: 400 }}>
        Essential spending by month — rent, utilities, groceries, insurance and the like. Your fund is measured against it.
      </div>
      <DetailBars bars={bars} />
    </KpiDetail>
  );
}

// ───────────────────────────────────────────────────────────────────────────── envelopes

function Envelopes() {
  const { overview: ov, go, month } = useMoney();
  const l = useLedgerCtx();
  const list: EnvelopeData[] = useMemo(() => {
    if (!ov) return [];
    return ov.budget
      .filter((b) => !isSavingGroup(b.group) && num(b.assigned.amount) > 0)
      .map((b) => ({ category: l.cat.get(b.categoryId) ?? { id: b.categoryId, name: b.name, group: b.group, color: b.color, icon: "circle-dollar-sign", essential: false, rollover: false, target: 0 }, assigned: num(b.assigned.amount), spent: -num(b.activity.amount), available: num(b.available.amount), pace: b.pace }))
      .sort((a, b) => b.spent / Math.max(1, b.assigned) - a.spent / Math.max(1, a.assigned))
      .slice(0, 8);
  }, [ov, l.cat]);
  const { assigned: totalAssigned, spent: totalSpent } = spendingBudget(ov?.budget);
  const pace = ov?.budget[0]?.pace ?? 0;
  return (
    <Section
      title="Budget envelopes"
      subtitle={
        ov ? (
          <>
            <Sensitive>{fmtMoney(totalSpent, "USD", { noCents: true })}</Sensitive> of <Sensitive>{fmtMoney(totalAssigned, "USD", { noCents: true })}</Sensitive> spent · {Math.round(pace * 100)}% through {monthLabel(month, true)} · dot = where you should be today
          </>
        ) : (
          "\u00a0"
        )
      }
      actions={
        <Button size="xs" variant="ghost" iconRight={ArrowRight} onClick={() => go("budget")}>
          Budget
        </Button>
      }
    >
      {!ov ? (
        <div className="grid grid-cols-2 gap-2">
          {Array.from({ length: 8 }, (_, k) => (
            <Skeleton key={k} height={63} radius={12} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-x-2 gap-y-1 -mx-2">
          {list.map((e, i) => (
            <Envelope key={e.category.id} e={e} index={i} onClick={() => go("budget")} />
          ))}
        </div>
      )}
    </Section>
  );
}

// ───────────────────────────────────────────────────────────────────────────── spending donut

function SpendingDonut() {
  const { instanceId, month } = useMoney();
  const l = useLedgerCtx();
  const t = useChartTheme();
  const from = `${month}-01`;
  const last = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const to = `${month}-${String(last).padStart(2, "0")}`;
  const s = useAsync(() => api.finance.spendingBreakdown({ instanceId, from, to, by: "category" }), [instanceId, month]);
  useDbChanged([l.schemas.txns?.database.id], s.reload, 400);
  const rows = s.data ?? [];
  const total = rows.reduce((a, x) => a + num(x.amount), 0);
  const prev = rows.reduce((a, x) => a + (x.deltaPct !== undefined ? num(x.amount) / (1 + x.deltaPct) : num(x.amount)), 0);
  const slices = useMemo(() => {
    const sorted = rows.map((x) => ({ id: x.key, label: x.label, value: num(x.amount) })).sort((a, b) => b.value - a.value);
    const top = sorted.slice(0, 6);
    const rest = sorted.slice(6).reduce((a, x) => a + x.value, 0);
    const colors = assignColors(top.map((x) => x.id));
    const out = top.map((x) => ({ ...x, color: x.id === "uncategorized" ? t.other : seriesColor(t, colors.get(x.id) ?? 0) }));
    if (rest > 0) out.push({ id: "__other", label: "Everything else", value: rest, color: t.other });
    return out;
  }, [rows, t]);
  const [active, setActive] = useState<string | null>(null);
  const { go } = useMoney();
  return (
    <Section title="Spending by category" subtitle={s.data ? <span className="inline-flex items-center gap-2">{monthLabel(month)}{prev > 0 ? <DeltaPill value={(total - prev) / prev} invert plain label="vs last month" /> : null}</span> : "\u00a0"}>
      {s.loading && !s.data ? (
        <div className="flex items-center gap-5 h-[222px]">
          <Skeleton width={160} height={160} radius={80} />
          <div className="flex-1 flex flex-col gap-2">{[0, 1, 2, 3, 4].map((k) => <Skeleton key={k} height={14} />)}</div>
        </div>
      ) : slices.length === 0 ? (
        <Quiet icon={CheckCircle2} title="No spending yet this month" />
      ) : (
        <div className="flex items-center gap-5">
          <SpendWheel
            data={slices}
            size={164}
            thickness={17}
            active={active}
            onActive={setActive}
            onSelect={(id) => go("transactions", id === "uncategorized" ? { filter: "uncategorized" } : undefined)}
            centerLabel="Spent"
            format={(n) => fmtMoney(n, "USD", { noCents: true })}
            total={total}
            summary={`Spending by category, ${monthLabel(month)}: ${slices.map((x) => `${x.label} ${fmtMoney(x.value, "USD", { noCents: true })}`).join(", ")}`}
          />
          <ul className="m-0 p-0 list-none flex-1 min-w-0 flex flex-col gap-0.5">
            {slices.map((x) => (
              <WheelLegendRow key={x.id} slice={x} active={active} onActive={setActive} onClick={() => go("transactions", x.id === "uncategorized" ? { filter: "uncategorized" } : undefined)} value={fmtMoney(x.value, "USD", { noCents: true })} />
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

// ───────────────────────────────────────────────────────────────────────────── cash flow

function CashFlow() {
  const { instanceId } = useMoney();
  const l = useLedgerCtx();
  const t = useChartTheme();
  const [month, setMonth] = useState(() => addMonths(todayIso().slice(0, 7), -1));
  const s = useAsync(() => api.finance.cashflowSankey({ instanceId, month }), [instanceId, month]);
  useDbChanged([l.schemas.txns?.database.id], s.reload, 400);
  const data = useMemo(() => (s.data ? simplifySankey(s.data) : undefined), [s.data]);
  const nodes = useMemo(() => {
    if (!data) return [];
    const groupColor = new Map<string, string>();
    let gi = 0;
    const incomeNames = new Set<number>();
    for (const lk of data.links) if (data.nodes[lk.target]?.name === "Income") incomeNames.add(lk.source);
    const hub = data.nodes.findIndex((n) => n.name === "Income");
    const parentOf = new Map<number, number>();
    for (const lk of data.links) parentOf.set(lk.target, lk.source);
    return data.nodes.map((n, i) => {
      if (i === hub || incomeNames.has(i)) return { name: n.name, color: t.gain };
      if (n.name === "Saved & paid down") return { name: n.name, color: t.accent };
      const parent = parentOf.get(i);
      if (parent === hub) {
        const c = seriesColor(t, [1, 3, 4, 5][gi++ % 4]);
        groupColor.set(n.name, c);
        return { name: n.name, color: c };
      }
      const pn = parent !== undefined ? data.nodes[parent]?.name : undefined;
      if (pn === "Saved & paid down") return { name: n.name, color: t.accent };
      return { name: n.name, color: (pn && groupColor.get(pn)) || t.textTertiary };
    });
  }, [data, t]);
  const income = s.data ? s.data.links.filter((lk) => s.data!.nodes[lk.target]?.name === "Income").reduce((a, lk) => a + lk.value, 0) : 0;
  const saved = s.data ? s.data.links.filter((lk) => s.data!.nodes[lk.target]?.name === "Saved & paid down").reduce((a, lk) => a + lk.value, 0) : 0;
  return (
    <Section
      title="Where the money went"
      subtitle={
        s.data && income ? (
          <>
            <Sensitive>{fmtMoney(income, "USD", { noCents: true })}</Sensitive> in · <Sensitive>{fmtMoney(saved, "USD", { noCents: true })}</Sensitive> saved or paid down ({fmtPct(saved / income, 0)})
          </>
        ) : (
          monthLabel(month)
        )
      }
      actions={
        <Segmented
          size="sm"
          value={month}
          onValueChange={setMonth}
          aria-label="Month"
          options={[-3, -2, -1, 0].map((k) => {
            const mm = addMonths(todayIso().slice(0, 7), k);
            return { value: mm, label: monthLabel(mm, true) };
          })}
        />
      }
    >
      <Sankey nodes={nodes} links={data?.links ?? []} height={400} loading={s.loading && !s.data} summaryLabel={`Cash flow, ${monthLabel(month)}`} />
    </Section>
  );
}

/** Fold tiny flows so every label has room: small income sources merge, each group keeps its top 3 categories. */
function simplifySankey(d: SankeyData): SankeyData {
  const name = (i: number) => d.nodes[i]?.name ?? "";
  const hub = d.nodes.findIndex((n) => n.name === "Income");
  const income = d.links.filter((l) => l.target === hub).reduce((a, l) => a + l.value, 0) || 1;
  const nodes: SankeyData["nodes"] = [];
  const links: SankeyData["links"] = [];
  const idx = new Map<string, number>();
  const node = (n: string) => {
    if (!idx.has(n)) {
      idx.set(n, nodes.length);
      nodes.push({ name: n });
    }
    return idx.get(n)!;
  };
  const add = (a: string, b: string, v: number) => {
    const s = node(a);
    const t = node(b);
    const ex = links.find((l) => l.source === s && l.target === t);
    if (ex) ex.value += v;
    else links.push({ source: s, target: t, value: v });
  };
  const sources = d.links.filter((l) => l.target === hub).sort((a, b) => b.value - a.value);
  const big = sources.filter((l, i) => i === 0 || l.value / income >= 0.06);
  const smallSum = sources.filter((l) => !big.includes(l)).reduce((a, l) => a + l.value, 0);
  big.forEach((l, i) => {
    const merge = smallSum > 0 && big.length > 1 && i === big.length - 1;
    add(merge ? `${name(l.source)} & other` : name(l.source), "Income", l.value + (merge ? smallSum : 0));
  });
  if (smallSum > 0 && big.length === 1) add("Other income", "Income", smallSum);
  for (const g of d.links.filter((l) => l.source === hub)) {
    const gName = name(g.target);
    add("Income", gName, g.value);
    const kids = d.links.filter((l) => l.source === g.target).sort((a, b) => b.value - a.value);
    // tiny groups (< 4% of income) stay a single node so their leaf labels can't collide at the bottom of the column
    const keep = gName === "Saved & paid down" ? kids : g.value / income < 0.04 ? [] : kids.filter((k, i) => i < 3 && k.value / income >= 0.04);
    const rest = kids.filter((k) => !keep.includes(k)).reduce((a, k) => a + k.value, 0);
    for (const k of keep) add(gName, name(k.target), k.value);
    if (rest > 0 && keep.length) add(gName, gName === "Fun" ? "Other fun" : `Other ${gName.toLowerCase()}`, rest);
  }
  return { nodes, links: links.filter((l) => l.value > 0) };
}

// ───────────────────────────────────────────────────────────────────────────── recent + upcoming

function Recent() {
  const l = useLedgerCtx();
  const { go } = useMoney();
  const recent = l.txns.slice(0, 7);
  return (
    <Section
      title="Recent transactions"
      actions={
        <Button size="xs" variant="ghost" iconRight={ArrowRight} onClick={() => go("transactions")}>
          All transactions
        </Button>
      }
    >
      <div className="-mx-3 -my-1">
        {l.loading && !l.txns.length
          ? Array.from({ length: 6 }, (_, k) => (
              <div key={k} className="flex items-center gap-3 px-3 py-2.5">
                <Skeleton width={30} height={30} radius={9} />
                <div className="flex-1">
                  <Skeleton width="40%" height={11} />
                  <Skeleton width="25%" height={9} className="mt-2" />
                </div>
                <Skeleton width={60} height={11} />
              </div>
            ))
          : recent.map((t) => <TxnLine key={t.id} t={t} category={t.categoryId ? l.cat.get(t.categoryId) : undefined} accountName={t.accountId ? l.acct.get(t.accountId)?.name : undefined} onClick={() => go("transactions")} />)}
      </div>
    </Section>
  );
}

function Upcoming() {
  const { overview: ov, go } = useMoney();
  const l = useLedgerCtx();
  const total = ov?.upcoming.filter((u) => u.due <= addDays7()).reduce((a, u) => a + num(u.amount.amount), 0) ?? 0;
  return (
    <Section
      title="Upcoming bills"
      subtitle={ov ? <><Sensitive>{fmtMoney(-total, "USD", { noCents: true })}</Sensitive> due in the next 7 days</> : null}
      actions={
        <Button size="xs" variant="ghost" iconRight={ArrowRight} onClick={() => go("recurring")}>
          Recurring
        </Button>
      }
    >
      {!ov ? (
        <Skeleton height={220} radius={10} />
      ) : ov.upcoming.length === 0 ? (
        <Quiet icon={CalendarClock} title="Nothing due in the next two weeks" />
      ) : (
        <ul className="m-0 p-0 list-none -mx-3 -my-1">
          {ov.upcoming.slice(0, 7).map((u) => {
            const rec = l.recurring.find((r) => r.id === u.rowId);
            const cat = rec?.categoryId ? l.cat.get(rec.categoryId) : undefined;
            const soon = relDays(u.due);
            return (
              <li key={u.rowId + u.due} className="fh-row">
                <span className="fh-date-chip" aria-hidden>
                  <span>{dayLabel(u.due).split(" ")[0]}</span>
                  <b>{Number(u.due.slice(8, 10))}</b>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body-sm font-medium">{u.name}</span>
                  <span className="block text-caption text-tertiary truncate" style={{ fontWeight: 400 }}>
                    {soon}
                    {cat ? ` · ${cat.name}` : ""}
                  </span>
                </span>
                {u.autopay ? (
                  <Badge tone="neutral" icon={Repeat}>
                    Autopay
                  </Badge>
                ) : null}
                <Amount value={toMoney(Math.abs(num(u.amount.amount)))} className="text-body-sm font-medium" align="end" />
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function addDays7(): string {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ───────────────────────────────────────────────────────────────────────────── insights

function Insights() {
  const { instanceId, overview } = useMoney();
  const l = useLedgerCtx();
  const remote = useAsync(() => api.lifeapp.insights({ instanceId }).catch(() => [] as Insight[]), [instanceId]);
  const fc = useAsync(() => api.finance.forecast({ instanceId, horizonDays: 45, band: false }), [instanceId]);
  const [muted, setMuted] = useState<Set<string>>(new Set());
  const list = useMemo(() => {
    const r = (remote.data ?? []).filter((i) => i.appInstanceId === instanceId && !i.mutedUntil);
    return (r.length ? r : localInsights(instanceId, overview, l, fc.data)).filter((i) => !muted.has(i.ruleId));
  }, [remote.data, overview, l, fc.data, muted, instanceId]);
  const mute = (i: Insight) => {
    setMuted((s) => new Set(s).add(i.ruleId));
    api.lifeapp.insightMute({ instanceId, ruleId: i.ruleId, until: Date.now() + 30 * 86_400_000 }).catch(() => undefined);
  };
  return (
    <Section title={<span className="inline-flex items-center gap-2"><Sparkles size={15} className="text-accent-text" />Insights</span>} subtitle="Common guidelines applied to your own numbers — consider, not commands.">
      {!overview ? (
        <div className="grid grid-cols-3 gap-3">
          {[0, 1, 2].map((k) => (
            <Skeleton key={k} height={160} radius={12} />
          ))}
        </div>
      ) : list.length === 0 ? (
        <Quiet icon={CheckCircle2} title="Nothing needs your attention" body="Budgets are on pace, bills are covered and your emergency fund is on track." />
      ) : (
        <div className="fh-insights">
          {list.slice(0, 6).map((i) => (
            <InsightCard key={i.id} insight={i} onMute={mute} />
          ))}
        </div>
      )}
    </Section>
  );
}
