/**
 * Portfolio (§16.3): value vs contributions hero with scrub readout, KPIs (today, unrealised, XIRR, dividends,
 * drift, fees), allocation rings vs target with drift bars, holdings heat treemap, holdings table with lots,
 * performance (TWR vs benchmark, realised gains), dividends, the rebalance planner and the IPS.
 * `tab = "holding:<SYMBOL>"` opens a holding page.
 */
import { CandlestickChart, ChevronRight, RefreshCw } from "lucide-react";
import { m } from "motion/react";
import { lazy, Suspense, useMemo, useState } from "react";
import { api } from "@/backend";
import type { Id, Insight, PerfRange, PortfolioSummary } from "@/backend/types";
import { navigate } from "@/app/router";
import { LineChart } from "@/charts/Line";
import { Treemap } from "@/charts/Treemap";
import { useChartTheme, seriesColor } from "@/charts/theme";
import { notify } from "@/stores/toasts";
import { useQuotes } from "@/stores/market";
import { Amount } from "@/ui/Amount";
import { Button } from "@/ui/Button";
import { DeltaPill, GainLoss } from "@/ui/DeltaPill";
import { EdgeLight } from "@/ui/motion/EdgeLight";
import { staggerItem, staggerList } from "@/ui/motion/presets";
import { RollingNumber } from "@/ui/motion/RollingNumber";
import { PriceFlash } from "@/ui/PriceFlash";
import { Segmented } from "@/ui/Segmented";
import { Sensitive } from "@/ui/Sensitive";
import { Skeleton } from "@/ui/Skeleton";
import type { TabItem } from "@/ui/Tabs";
import { DivergingBars } from "../finance/shared/charts";
import { assignColors, fmtMoney, fmtPct, fmtPp, fmtPrice, fmtQty, num, toMoney } from "../finance/shared/format";
import { useAsync, useScrubIdx, useScrubStore, type ScrubStore } from "../finance/shared/hooks";
import { Disclaimer, HubPage, InsightCard, Quiet, Section } from "../finance/shared/ui";
import { HeroMoney, MetricCard } from "../finance/MoneyHQ/widgets";
import { SpendWheel } from "../finance/shared/SpendWheel";
import { ticker } from "../markets/data";
import { CLASS_ORDER, usePortfolioSummary } from "./data";
import "./portfolio.css";

const HoldingPage = lazy(() => import("./HoldingPage"));
const RebalancePlanner = lazy(() => import("./RebalancePlanner"));
const IPS = lazy(() => import("./IPS"));
const Performance = lazy(() => import("./Performance"));
const Dividends = lazy(() => import("./Dividends"));
const Holdings = lazy(() => import("./Holdings"));

export interface PortfolioDashboardProps {
  instanceId: Id;
  tab?: string;
}

type PTab = "overview" | "holdings" | "performance" | "dividends" | "rebalance" | "ips";
const TABS: PTab[] = ["overview", "holdings", "performance", "dividends", "rebalance", "ips"];

export default function PortfolioDashboard({ instanceId, tab }: PortfolioDashboardProps) {
  const holding = tab?.startsWith("holding:") ? tab.slice(8) : null;
  const current = (TABS.includes(tab as PTab) ? tab : "overview") as PTab;
  const summary = usePortfolioSummary(instanceId);
  const go = (t: PTab) => navigate({ t: "app", instanceId, tab: t === "overview" ? undefined : t });
  const [rebuilding, setRebuilding] = useState(false);
  const rebuild = async () => {
    setRebuilding(true);
    try {
      const job = await api.portfolio.rebuild({ instanceId });
      const r = await job.result;
      notify.success("Lots rebuilt", { description: `${r.lots} open lots · ${r.realizedEvents} realised sales` });
      summary.reload();
    } catch (e) {
      notify.fromError(e, "Couldn't rebuild lots");
    } finally {
      setRebuilding(false);
    }
  };
  if (holding) {
    return (
      <Suspense fallback={<div className="fh-page"><Skeleton height={420} radius={14} /></div>}>
        <HoldingPage instanceId={instanceId} symbol={holding} summary={summary.data} />
      </Suspense>
    );
  }
  const tabs: TabItem<PTab>[] = [
    { value: "overview", label: "Overview" },
    { value: "holdings", label: "Holdings", count: summary.data?.holdings.length },
    { value: "performance", label: "Performance" },
    { value: "dividends", label: "Dividends" },
    { value: "rebalance", label: "Rebalance" },
    { value: "ips", label: "Investment policy" },
  ];
  return (
    <HubPage
      icon={CandlestickChart}
      tone="ocean"
      title="Portfolio"
      subtitle={summary.data ? <>As of {new Date(summary.data.asOf).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} · {summary.data.holdings.length} holdings across your accounts</> : "Loading positions…"}
      actions={
        <>
          <Button size="sm" variant="ghost" icon={RefreshCw} loading={rebuilding} onClick={rebuild}>
            Rebuild lots
          </Button>
          <Button size="sm" variant="secondary" iconRight={ChevronRight} onClick={() => navigate({ t: "markets" })}>
            Markets
          </Button>
        </>
      }
      tabs={tabs}
      tab={current}
      onTab={go}
      footer={<Disclaimer>Example starting points, not recommendations. EMP never places trades. Only ticker symbols leave this device — never quantities, cost basis, account names or balances.</Disclaimer>}
    >
      <Suspense fallback={<Skeleton height={420} radius={14} />}>
        {current === "overview" ? <Overview instanceId={instanceId} summary={summary.data} go={go} /> : null}
        {current === "holdings" ? <Holdings instanceId={instanceId} summary={summary.data} /> : null}
        {current === "performance" ? <Performance instanceId={instanceId} summary={summary.data} /> : null}
        {current === "dividends" ? <Dividends instanceId={instanceId} summary={summary.data} /> : null}
        {current === "rebalance" ? <RebalancePlanner instanceId={instanceId} summary={summary.data} /> : null}
        {current === "ips" ? <IPS instanceId={instanceId} summary={summary.data} /> : null}
      </Suspense>
    </HubPage>
  );
}

// ───────────────────────────────────────────────────────────────────────────── overview

function Overview({ instanceId, summary: s, go }: { instanceId: Id; summary?: PortfolioSummary; go: (t: PTab) => void }) {
  return (
    <m.div className="fh-grid" variants={staggerList(0.04)} initial="hidden" animate="show">
      <m.div variants={staggerItem} className="fh-span-8">
        <ValueHero instanceId={instanceId} summary={s} />
      </m.div>
      <m.div variants={staggerItem} className="fh-span-4 flex flex-col gap-3">
        <Kpi label="Unrealised gain" value={s ? <GainLoss value={num(s.unrealized.amount)}><span data-sensitive=""><RollingNumber value={num(s.unrealized.amount)} format={(n) => fmtMoney(Math.round(n), "USD", { noCents: true, signed: true })} countUpKey="pf:unrealised" sensitive /></span></GainLoss> : null} sub={s ? `${fmtPct(s.unrealizedPct, 1, true)} on cost` : ""} />
        <Kpi label="Money-weighted return" value={s ? <span>{s.xirrAll !== undefined ? fmtPct(s.xirrAll, 1, true) : "—"}<span className="text-tertiary text-body-sm font-medium"> /yr</span></span> : null} sub={s?.xirrYtd !== undefined ? `${fmtPct(s.xirrYtd, 1, true)} year to date (XIRR)` : ""} />
        <Kpi label="Dividends" value={s ? <span data-sensitive=""><RollingNumber value={num(s.divTtm.amount)} format={(n) => fmtMoney(Math.round(n), "USD", { noCents: true })} countUpKey="pf:div" sensitive /></span> : null} sub={s ? <>last 12 months · <Sensitive>{fmtMoney(s.divFwd12m.amount, "USD", { noCents: true })}</Sensitive> expected next 12</> : ""} onClick={() => go("dividends")} />
        <Kpi label="Fees" value={s ? <Sensitive>{fmtMoney(s.feesPerYear.amount, "USD", { noCents: true })}</Sensitive> : null} sub={s ? `a year · ${fmtPct(num(s.feesPerYear.amount) / Math.max(1, num(s.totalValue.amount)), 2)} of the portfolio` : ""} />
      </m.div>
      <m.div variants={staggerItem} className="fh-span-7">
        <Allocation summary={s} onRebalance={() => go("rebalance")} />
      </m.div>
      <m.div variants={staggerItem} className="fh-span-5">
        <Section title="Today's heat map" subtitle="Tile size is value · colour is today's move">
          <Treemap data={(s?.holdings ?? []).map((h) => ({ id: h.symbol, label: ticker(h.symbol), value: num(h.value.amount), change: h.dayPct ?? 0, sub: h.dayPct !== undefined ? `${h.dayPct >= 0 ? "+" : "−"}${Math.abs(h.dayPct * 100).toFixed(2)}%` : undefined }))} colorBy="change" changeScale={0.03} height={268} loading={!s} summaryLabel="Holdings by value, coloured by today's change" />
        </Section>
      </m.div>
      <m.div variants={staggerItem} className="fh-span-12">
        <TopHoldings instanceId={instanceId} summary={s} />
      </m.div>
      <m.div variants={staggerItem} className="fh-span-12">
        <PfInsights instanceId={instanceId} summary={s} />
      </m.div>
    </m.div>
  );
}

function Kpi({ label, value, sub, onClick }: { label: string; value: React.ReactNode; sub?: React.ReactNode; onClick?: () => void }) {
  return <MetricCard label={label} value={value ?? <span className="flex items-center h-[28px]"><Skeleton width={110} height={20} /></span>} sub={sub} onClick={onClick} visual={onClick ? <ChevronRight size={16} className="text-tertiary fh-nudge-x" /> : undefined} />;
}

const RANGES: { value: PerfRange; label: string }[] = [
  { value: "1m", label: "1M" },
  { value: "3m", label: "3M" },
  { value: "ytd", label: "YTD" },
  { value: "1y", label: "1Y" },
  { value: "5y", label: "5Y" },
  { value: "all", label: "All" },
];

// Built once: toLocaleDateString(…, opts) constructs a new Intl.DateTimeFormat on every call, which made scrubbing crawl.
const DAY_FMT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const MONTH_YEAR_FMT = new Intl.DateTimeFormat(undefined, { month: "short", year: "2-digit" });
const FULL_FMT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const fmtDay = (v: unknown) => DAY_FMT.format(new Date(Number(v)));
const fmtMonthYear = (v: unknown) => MONTH_YEAR_FMT.format(new Date(Number(v)));
const fmtFull = (v: unknown) => FULL_FMT.format(new Date(Number(v)));
const HERO_SERIES = [
  { key: "value", label: "Value", color: "var(--chart-line)", area: true },
  { key: "contributions", label: "Contributed", color: "var(--text-tertiary)", dashed: true },
];
const fmtWhole = (n: number) => fmtMoney(Math.round(n), "USD", { noCents: true });

type HeroPoint = { t: number; value: number; contributions: number };

function ValueHero({ instanceId, summary: s }: { instanceId: Id; summary?: PortfolioSummary }) {
  const [range, setRange] = useState<PerfRange>("1y");
  const perf = useAsync(() => api.portfolio.performance({ instanceId, range }), [instanceId, range]);
  const data = useMemo<HeroPoint[]>(() => (perf.data ? perf.data.t.map((t, i) => ({ t: Number(t), value: perf.data!.value[i], contributions: perf.data!.contributions[i] })) : []), [perf.data]);
  const long = range === "5y" || range === "all";
  const xf = long ? fmtMonthYear : fmtDay;
  // The scrub index lives in a tiny store, so only the readouts re-render while scrubbing — never the chart.
  const scrub = useScrubStore();
  return (
    <section className="fh-card fh-hero" data-light="" ref={scrub.hostRef} style={{ paddingBottom: 12 }}>
      <EdgeLight specular />
      <div className="flex items-start justify-between gap-4">
        <HeroReadout scrub={scrub} data={data} summary={s} xf={xf} />
        <Segmented size="sm" value={range} onValueChange={setRange} options={RANGES} aria-label="Range" />
      </div>
      <div className="mt-3">
        <LineChart
          data={data}
          x="t"
          series={HERO_SERIES}
          colorBySign={false}
          startReference={false}
          height={220}
          curve="linear"
          xFormat={xf}
          xTooltipFormat={fmtFull}
          onScrub={scrub.set}
          tooltip={false}
          hero
          loading={perf.loading && !perf.data}
          summaryLabel="Portfolio value versus contributions"
        />
      </div>
      <div className="fh-groove -mx-5 mt-1" />
      <HeroLegend scrub={scrub} data={data} summary={s} xirr={perf.data?.xirr} />
    </section>
  );
}

function HeroReadout({ scrub, data, summary: s, xf }: { scrub: ScrubStore; data: HeroPoint[]; summary?: PortfolioSummary; xf: (v: unknown) => string }) {
  const idx = useScrubIdx(scrub);
  const cur = idx !== null ? data[idx] : null;
  const first = data[0];
  // At rest the hero, the legend and the chart's end all read the series' last point (the live total once loaded).
  const value = cur ? cur.value : s ? num(s.totalValue.amount) : null;
  const growth = cur && first ? cur.value - first.value - (cur.contributions - first.contributions) : null;
  return (
    <div>
      <div className="text-caption text-secondary" style={{ fontWeight: 500 }}>
        Total value
      </div>
      <div className="mt-1 h-[48px] flex items-center">{value !== null ? <HeroMoney value={value} cents={false} countUpKey="pf:value" scrubbing={idx !== null} /> : <Skeleton width={220} height={38} />}</div>
      <div className="flex items-center gap-2 h-6 mt-1">
        {cur && first ? (
          <>
            <span className="text-caption tabular font-semibold whitespace-nowrap" style={{ color: (growth ?? 0) >= 0 ? "var(--gain-text)" : "var(--loss-text)" }} data-sensitive="">
              <RollingNumber value={growth ?? 0} format={(n) => fmtMoney(Math.round(n), "USD", { noCents: true, signed: true })} scrubbing countUp={false} sensitive /> market growth
            </span>
            <span className="text-caption text-tertiary whitespace-nowrap" style={{ fontWeight: 400 }}>
              since {xf(first.t)} · {fmtFull(cur.t)}
            </span>
          </>
        ) : s ? (
          <>
            <DeltaPill value={s.dayChangePct} digits={2} />
            <span className="text-caption tabular font-semibold" style={{ color: num(s.dayChange.amount) >= 0 ? "var(--gain-text)" : "var(--loss-text)" }}>
              <Sensitive>{fmtMoney(s.dayChange.amount, "USD", { noCents: true, signed: true })}</Sensitive>
            </span>
            <span className="text-caption text-tertiary" style={{ fontWeight: 400 }}>
              today
            </span>
          </>
        ) : null}
      </div>
    </div>
  );
}

function HeroLegend({ scrub, data, summary: s, xirr }: { scrub: ScrubStore; data: HeroPoint[]; summary?: PortfolioSummary; xirr?: number }) {
  const idx = useScrubIdx(scrub);
  const cur = idx !== null ? data[idx] : null;
  return (
    <div className="flex items-center gap-5 pt-2.5 text-caption" style={{ fontWeight: 400 }}>
      <span className="inline-flex items-center gap-1.5 text-tertiary">
        <i className="fh-key" style={{ background: "var(--chart-line)" }} />
        Value <b className="text-primary tabular font-medium ml-1"><Sensitive>{cur ? fmtWhole(cur.value) : s ? fmtWhole(num(s.totalValue.amount)) : "—"}</Sensitive></b>
      </span>
      <span className="inline-flex items-center gap-1.5 text-tertiary">
        <i className="fh-key" style={{ background: "var(--text-tertiary)" }} />
        Contributed <b className="text-primary tabular font-medium ml-1"><Sensitive>{cur ? fmtWhole(cur.contributions) : data.length ? fmtWhole(data[data.length - 1].contributions) : "—"}</Sensitive></b>
      </span>
      {xirr !== undefined ? <span className="ml-auto text-tertiary">XIRR this period {fmtPct(xirr, 1, true)}/yr</span> : null}
    </div>
  );
}

function Allocation({ summary: s, onRebalance }: { summary?: PortfolioSummary; onRebalance: () => void }) {
  const t = useChartTheme();
  const rows = useMemo(() => {
    if (!s) return [];
    const list = s.allocation.slice().sort((a, b) => CLASS_ORDER.indexOf(a.assetClass) - CLASS_ORDER.indexOf(b.assetClass));
    const colors = assignColors(list.map((x) => x.assetClass));
    return list.map((x) => ({ ...x, cls: x.assetClass, color: seriesColor(t, colors.get(x.assetClass) ?? 0) }));
  }, [s, t]);
  const outside = rows.filter((r) => r.status === "outside_band").length;
  const [view, setView] = useState<"current" | "target">("current");
  const [active, setActive] = useState<string | null>(null);
  const now = rows.map((r) => ({ id: r.cls, label: r.cls, value: r.current, color: r.color }));
  const tgt = rows.map((r) => ({ id: r.cls, label: r.cls, value: r.target, color: r.color }));
  return (
    <Section
      title="Allocation vs target"
      subtitle={s ? (outside ? `${outside} ${outside === 1 ? "class is" : "classes are"} outside the band · max drift ${fmtPp(s.maxDrift)}` : "Every class is within its band") : "\u00a0"}
      actions={
        <Button size="xs" variant={outside ? "primary" : "ghost"} iconRight={ChevronRight} onClick={onRebalance}>
          Rebalance
        </Button>
      }
    >
      {!s ? (
        <Skeleton height={276} radius={10} />
      ) : (
        <div className="flex items-center gap-6">
          <div className="flex flex-col items-center gap-3 flex-none">
            <SpendWheel
              data={view === "current" ? now : tgt}
              ghost={view === "current" ? tgt : now}
              size={188}
              thickness={20}
              active={active}
              onActive={setActive}
              centerLabel={view === "current" ? "Max drift" : "Target mix"}
              centerValue={view === "current" ? fmtPp(s.maxDrift) : `${rows.length} classes`}
              format={(n) => `${n.toFixed(1)}%`}
              summary={`Allocation ${view === "current" ? "now" : "at target"}: ${rows.map((r) => `${r.cls} ${(view === "current" ? r.current : r.target).toFixed(1)}%`).join(", ")}`}
            />
            <Segmented size="sm" value={view} onValueChange={setView} aria-label="Show allocation" options={[{ value: "current", label: "Now" }, { value: "target", label: "Target" }]} />
          </div>
          <div className="flex-1 min-w-0">
            <DivergingBars
              rows={rows.map((r) => ({
                key: r.cls,
                label: (
                  <span className="inline-flex items-center gap-2">
                    <span className="w-2 h-2 rounded-[2px]" style={{ background: r.color }} />
                    {r.cls}
                  </span>
                ),
                value: r.drift,
                outside: r.status === "outside_band",
              }))}
              max={Math.max(6, ...rows.map((r) => Math.abs(r.drift)))}
              format={(v) => fmtPp(v)}
              active={active}
              onActive={setActive}
            />
            <div className="text-caption text-tertiary mt-3" style={{ fontWeight: 400 }}>
              Bars show drift from target in percentage points; amber is outside the band (±5 pp or 25% of target). The thin outer ring is the {view === "current" ? "target" : "current mix"}.
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}

function TopHoldings({ instanceId, summary: s }: { instanceId: Id; summary?: PortfolioSummary }) {
  const list = (s?.holdings ?? []).slice(0, 8);
  const quotes = useQuotes(list.map((h) => h.symbol));
  return (
    <Section title="Holdings" subtitle="Live prices · click a holding for lots, chart and research notes" pad={false}>
      {!s ? (
        <div className="p-4">
          <Skeleton height={352} radius={10} />
        </div>
      ) : (
        <table className="fh-table">
          <thead>
            <tr>
              <th>Holding</th>
              <th className="num">Price</th>
              <th className="num">Today</th>
              <th className="num">Value</th>
              <th className="num">Gain</th>
              <th className="num">Weight</th>
            </tr>
          </thead>
          <tbody>
            {list.map((h, i) => {
              const q = quotes[i];
              const price = q?.price ?? h.price ?? 0;
              return (
                <tr key={h.symbol} data-clickable onClick={() => navigate({ t: "app", instanceId, tab: `holding:${h.symbol}` })}>
                  <td>
                    <div className="flex items-center gap-3">
                      <span className="pf-ticker-chip">{ticker(h.symbol).slice(0, 4)}</span>
                      <span className="min-w-0">
                        <span className="block font-medium">{ticker(h.symbol)}</span>
                        <span className="block text-caption text-tertiary truncate max-w-[220px]" style={{ fontWeight: 400 }}>
                          {h.name} · <Sensitive>{fmtQty(h.qty)}</Sensitive> sh
                        </span>
                      </span>
                    </div>
                  </td>
                  <td className="num">
                    <PriceFlash value={price} symbol={h.symbol}>
                      {fmtPrice(price)}
                    </PriceFlash>
                  </td>
                  <td className="num">{q ? <GainLoss value={q.changePct}>{q.changePct >= 0 ? "+" : "−"}{Math.abs(q.changePct * 100).toFixed(2)}%</GainLoss> : "—"}</td>
                  <td className="num font-medium">
                    <Amount value={toMoney(Math.round((q ? q.price * num(h.qty) : num(h.value.amount)) * 100) / 100)} align="end" noCents />
                  </td>
                  <td className="num">
                    <GainLoss value={num(h.gain.amount)}>
                      <Sensitive align="end">{fmtMoney(h.gain.amount, "USD", { noCents: true, signed: true })}</Sensitive>
                    </GainLoss>
                    <span className="text-tertiary text-caption ml-1.5">{fmtPct(h.gainPct, 0, true)}</span>
                  </td>
                  <td className="num">
                    <div className="flex items-center justify-end gap-2">
                      <span className="pf-weight">
                        <i style={{ transform: `scaleX(${Math.min(1, h.weight / 0.5)})` }} />
                      </span>
                      <span className="w-[44px] text-secondary">{(h.weight * 100).toFixed(1)}%</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function PfInsights({ instanceId, summary: s }: { instanceId: Id; summary?: PortfolioSummary }) {
  const remote = useAsync(() => api.lifeapp.insights({ instanceId }).catch(() => [] as Insight[]), [instanceId]);
  const list = useMemo(() => {
    const r = (remote.data ?? []).filter((i) => i.appInstanceId === instanceId && !i.mutedUntil);
    if (r.length || !s) return r;
    const out: Insight[] = [];
    const tab = (t: string) => ({ t: "app" as const, instanceId, tab: t });
    const total = num(s.totalValue.amount);
    for (const a of s.allocation.filter((x) => x.status === "outside_band").slice(0, 2)) {
      out.push({ id: `drift:${a.assetClass}`, appInstanceId: instanceId, ruleId: "drift-band", severity: "warn", title: `${a.assetClass} is ${fmtPp(a.drift)} from target`, body: `Now ${a.current.toFixed(1)}% against a ${a.target}% target. New contributions can close most of the gap without selling.`, math: [{ label: "Current", value: `${a.current.toFixed(1)}%` }, { label: "Target", value: `${a.target}%` }, { label: "Band", value: "±5 pp or 25% of target" }], actions: [{ label: "Plan a rebalance", route: tab("rebalance") }] });
    }
    for (const h of s.holdings.filter((x) => x.weight > 0.1 && !/ETF|Fund/i.test(x.name)).slice(0, 1)) {
      out.push({ id: `conc:${h.symbol}`, appInstanceId: instanceId, ruleId: "concentration-10", severity: "tip", title: `${ticker(h.symbol)} is ${(h.weight * 100).toFixed(0)}% of the portfolio`, body: "A single company above 10% adds risk that diversification usually removes. Consider whether that's intentional.", math: [{ label: "Value", value: fmtMoney(h.value.amount, "USD", { noCents: true }) }, { label: "Share", value: fmtPct(h.weight, 1) }], actions: [{ label: "Open holding", route: tab(`holding:${h.symbol}`) }] });
    }
    out.push({ id: "ips", appInstanceId: instanceId, ruleId: "ips-review", severity: "tip", title: "Write down your investment policy", body: "An IPS records your targets and the rules you follow when markets fall — so decisions in a downturn are already made.", actions: [{ label: "Open IPS", route: tab("ips") }] });
    if (total > 0 && s.allocation.find((a) => a.assetClass === "Cash" && a.current > 5)) out.push({ id: "cash", appInstanceId: instanceId, ruleId: "cash-drag", severity: "info", title: "Cash is above 5%", body: "Uninvested cash earns less over time. Consider putting it to work toward your targets.", actions: [{ label: "Plan a rebalance", route: tab("rebalance") }] });
    return out;
  }, [remote.data, s, instanceId]);
  if (!s) return null;
  return (
    <Section title="Insights" subtitle="Common guidelines applied to your portfolio — education, not advice.">
      {list.length ? (
        <div className="fh-insights">
          {list.slice(0, 6).map((i) => (
            <InsightCard key={i.id} insight={i} />
          ))}
        </div>
      ) : (
        <Quiet title="All clear" body="Allocation is within bands and nothing else needs attention." />
      )}
    </Section>
  );
}

