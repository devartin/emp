/** Money HQ overview: net-worth hero with scrub readout, key metrics, budget envelopes, spending donut, cash-flow
 * Sankey, recent transactions, upcoming bills and insights. */
import { ArrowRight, CalendarClock, CheckCircle2, Repeat, Sparkles } from "lucide-react";
import { m } from "motion/react";
import { useMemo, useState } from "react";
import { api } from "@/backend";
import type { Insight } from "@/backend/types";
import { Donut } from "@/charts/Donut";
import { LineChart } from "@/charts/Line";
import { Sankey } from "@/charts/Sankey";
import { useChartTheme, seriesColor } from "@/charts/theme";
import { Amount } from "@/ui/Amount";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { DeltaPill } from "@/ui/DeltaPill";
import { RollingNumber } from "@/ui/motion/RollingNumber";
import { staggerItem, staggerList } from "@/ui/motion/presets";
import { Segmented } from "@/ui/Segmented";
import { Sensitive } from "@/ui/Sensitive";
import { Skeleton } from "@/ui/Skeleton";
import { addMonths, dayLabel, fmtMoney, fmtPct, monthLabel, num, relDays, toMoney, todayIso } from "../shared/format";
import { useAsync, useDbChanged } from "../shared/hooks";
import { InsightCard, Quiet, Section } from "../shared/ui";
import { localInsights } from "./insights";
import { useLedgerCtx } from "./ledger";
import { useMoney } from "./MoneyHQ";
import { BudgetRing, Envelope, HeroMoney, MetricCard, TxnLine, type EnvelopeData } from "./widgets";

type Range = "6m" | "1y" | "3y" | "5y";

export function Overview() {
  return (
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
  );
}

// ───────────────────────────────────────────────────────────────────────────── net worth hero

function NetWorthHero() {
  const { instanceId, overview } = useMoney();
  const l = useLedgerCtx();
  const [range, setRange] = useState<Range>("1y");
  const [idx, setIdx] = useState<number | null>(null);
  const s = useAsync(() => api.finance.networthSeries({ instanceId, range }), [instanceId, range]);
  useDbChanged([l.schemas.txns?.database.id], s.reload, 400);
  const data = useMemo(() => (s.data ? s.data.t.map((t, i) => ({ t, net: s.data!.net[i], assets: s.data!.assets[i], liabilities: s.data!.liabilities[i] })) : []), [s.data]);
  const i = idx ?? data.length - 1;
  const cur = data[i];
  const first = data[0];
  const change = cur && first && first.net ? (cur.net - first.net) / Math.abs(first.net) : 0;
  const delta = cur && first ? cur.net - first.net : 0;
  const long = range === "3y" || range === "5y";
  const xf = (v: unknown) => {
    const d = String(v);
    return long ? `${monthLabel(d.slice(0, 7), true)} '${d.slice(2, 4)}` : monthLabel(d.slice(0, 7), true);
  };
  const periodLabel = { "6m": "past 6 months", "1y": "past year", "3y": "past 3 years", "5y": "past 5 years" }[range];
  return (
    <section className="fh-card" style={{ paddingBottom: 10 }}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-caption text-secondary" style={{ fontWeight: 500 }}>
            Net worth
          </div>
          <div className="mt-1 h-[44px] flex items-center">{cur ? <HeroMoney value={cur.net} cents={false} /> : <Skeleton width={220} height={36} radius={8} />}</div>
          <div className="flex items-center gap-2 h-6 mt-1">
            {cur ? (
              <>
                <DeltaPill value={change} />
                <span className="text-caption tabular" style={{ fontWeight: 500, color: delta >= 0 ? "var(--gain-text)" : "var(--loss-text)" }}>
                  <Sensitive>{fmtMoney(delta, "USD", { noCents: true, signed: true })}</Sensitive>
                </span>
                <span className="text-caption text-tertiary" style={{ fontWeight: 400 }}>
                  {idx === null ? periodLabel : dayLabel(cur.t, true)}
                </span>
              </>
            ) : null}
          </div>
        </div>
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
          series={[{ key: "net", label: "Net worth" }]}
          height={208}
          area
          curve="monotoneX"
          xFormat={xf}
          tooltip={false}
          onScrub={setIdx}
          summaryLabel="Net worth"
          loading={s.loading && !s.data}
          live
        />
      </div>
      <div className="flex items-center gap-5 pt-2 mt-1 border-t border-subtle">
        <MiniStat label="Assets" value={cur?.assets} />
        <MiniStat label="Liabilities" value={cur ? -cur.liabilities : undefined} />
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

function MiniStat({ label, value }: { label: string; value: number | undefined }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-caption text-tertiary" style={{ fontWeight: 500 }}>
        {label}
      </span>
      <span className="text-body-sm font-medium tabular">{value === undefined ? "—" : <Sensitive>{fmtMoney(value, "USD", { noCents: true })}</Sensitive>}</span>
    </span>
  );
}

// ───────────────────────────────────────────────────────────────────────────── side metrics

function SideMetrics() {
  const { overview: ov, go } = useMoney();
  if (!ov) {
    return (
      <div className="flex flex-col gap-3 h-full">
        {[0, 1, 2, 3].map((k) => (
          <Skeleton key={k} height={72} radius={14} />
        ))}
      </div>
    );
  }
  const tba = ov.toBeAssigned ? num(ov.toBeAssigned.amount) : null;
  const rate = ov.savingsRate3m;
  return (
    <div className="flex flex-col gap-3 h-full">
      {tba !== null ? (
        <MetricCard
          label="To be assigned"
          tone={tba < 0 ? "warn" : undefined}
          value={<Sensitive>{fmtMoney(tba, "USD")}</Sensitive>}
          sub={tba > 0.005 ? "Give every dollar a job" : tba < -0.005 ? "Assigned more than you have" : "Every dollar has a job"}
          onClick={() => go("budget")}
          visual={tba > 0.005 ? <Badge tone="accent">Assign</Badge> : tba < -0.005 ? <Badge tone="warning">Fix</Badge> : <CheckCircle2 size={18} className="text-gain" />}
        />
      ) : (
        <MetricCard label="Left to spend" value={<Sensitive>{fmtMoney(ov.leftToSpend?.amount ?? 0)}</Sensitive>} onClick={() => go("budget")} />
      )}
      <MetricCard
        label="Savings rate · 3 months"
        value={<RollingNumber value={rate * 100} format={(n) => `${n.toFixed(1)}%`} countUp={false} />}
        sub={rate >= 0.2 ? "Above the common 20% guideline" : "Common guideline: 20% or more"}
        visual={<BudgetRing ratio={Math.max(0, Math.min(1, rate / 0.4))} size={40} stroke={4} color={rate >= 0.2 ? "var(--gain)" : "var(--warning)"} />}
      />
      <MetricCard
        label="Emergency fund"
        value={`${ov.efMonths.toFixed(1)} months`}
        sub={ov.efMonths >= 6 ? "of essentials · fully funded" : "of essentials · goal 6 months"}
        onClick={() => go("goals")}
        visual={<BudgetRing ratio={Math.min(1, ov.efMonths / 6)} size={40} stroke={4} color={ov.efMonths >= 6 ? "var(--gain)" : ov.efMonths >= 3 ? "var(--accent-solid)" : "var(--warning)"} />}
      />
      <MetricCard
        label="Debt-free"
        value={ov.debtFreeDate ? monthLabel(ov.debtFreeDate) : "Debt-free"}
        sub={ov.debtFreeDate ? "at minimum payments · see the planner" : "No balances owed"}
        onClick={() => go("debt")}
        visual={<ArrowRight size={16} className="text-tertiary" />}
      />
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── envelopes

function Envelopes() {
  const { overview: ov, go, month } = useMoney();
  const l = useLedgerCtx();
  const list: EnvelopeData[] = useMemo(() => {
    if (!ov) return [];
    return ov.budget
      .filter((b) => b.group !== "Savings & Debt" && num(b.assigned.amount) > 0)
      .map((b) => ({ category: l.cat.get(b.categoryId) ?? { id: b.categoryId, name: b.name, group: b.group, color: b.color, icon: "circle-dollar-sign", essential: false, rollover: false, target: 0 }, assigned: num(b.assigned.amount), spent: -num(b.activity.amount), available: num(b.available.amount), pace: b.pace }))
      .sort((a, b) => b.spent / Math.max(1, b.assigned) - a.spent / Math.max(1, a.assigned))
      .slice(0, 8);
  }, [ov, l.cat]);
  const totalAssigned = ov?.budget.filter((b) => b.group !== "Savings & Debt").reduce((s, b) => s + num(b.assigned.amount), 0) ?? 0;
  const totalSpent = ov?.budget.filter((b) => b.group !== "Savings & Debt").reduce((s, b) => s - num(b.activity.amount), 0) ?? 0;
  const pace = ov?.budget[0]?.pace ?? 0;
  return (
    <Section
      title="Budget envelopes"
      subtitle={
        ov ? (
          <>
            <Sensitive>{fmtMoney(totalSpent, "USD", { noCents: true })}</Sensitive> of <Sensitive>{fmtMoney(totalAssigned, "USD", { noCents: true })}</Sensitive> spent · {Math.round(pace * 100)}% through {monthLabel(month, true)}
          </>
        ) : null
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
            <Skeleton key={k} height={64} radius={12} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-x-2 gap-y-1 -mx-2">
          {list.map((e) => (
            <Envelope key={e.category.id} e={e} onClick={() => go("budget")} />
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
  const from = `${month}-01`;
  const last = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const to = `${month}-${String(last).padStart(2, "0")}`;
  const s = useAsync(() => api.finance.spendingBreakdown({ instanceId, from, to, by: "category" }), [instanceId, month]);
  useDbChanged([l.schemas.txns?.database.id], s.reload, 400);
  const total = (s.data ?? []).reduce((a, x) => a + num(x.amount), 0);
  const prev = (s.data ?? []).reduce((a, x) => a + (x.deltaPct !== undefined ? num(x.amount) / (1 + x.deltaPct) : num(x.amount)), 0);
  return (
    <Section title="Spending by category" subtitle={s.data ? <>{monthLabel(month)} · {prev > 0 ? <DeltaPill value={(total - prev) / prev} invert plain label="vs last month" /> : null}</> : null}>
      <Donut data={(s.data ?? []).map((x) => ({ id: x.key, label: x.label, value: num(x.amount) }))} size={164} loading={s.loading && !s.data} summaryLabel="Spending by category" centerLabel="Spent" />
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
  const nodes = useMemo(() => {
    if (!s.data) return [];
    const groupColor = new Map<string, string>();
    let gi = 0;
    const incomeNames = new Set<number>();
    for (const lk of s.data.links) if (s.data.nodes[lk.target]?.name === "Income") incomeNames.add(lk.source);
    const hub = s.data.nodes.findIndex((n) => n.name === "Income");
    const parentOf = new Map<number, number>();
    for (const lk of s.data.links) parentOf.set(lk.target, lk.source);
    return s.data.nodes.map((n, i) => {
      if (i === hub || incomeNames.has(i)) return { name: n.name, color: t.gain };
      if (n.name === "Saved & paid down") return { name: n.name, color: t.accent };
      const parent = parentOf.get(i);
      if (parent === hub) {
        const c = seriesColor(t, [1, 3, 4, 5][gi++ % 4]);
        groupColor.set(n.name, c);
        return { name: n.name, color: c };
      }
      const pn = parent !== undefined ? s.data!.nodes[parent]?.name : undefined;
      if (pn === "Saved & paid down") return { name: n.name, color: t.accent };
      return { name: n.name, color: (pn && groupColor.get(pn)) || t.textTertiary };
    });
  }, [s.data, t]);
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
      <Sankey nodes={nodes} links={s.data?.links ?? []} height={300} loading={s.loading && !s.data} summaryLabel={`Cash flow, ${monthLabel(month)}`} />
    </Section>
  );
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
            <Skeleton key={k} height={120} radius={12} />
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
