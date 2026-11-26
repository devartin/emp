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
import { staggerItem, staggerList } from "@/ui/motion/presets";
import { PriceFlash } from "@/ui/PriceFlash";
import { Segmented } from "@/ui/Segmented";
import { Sensitive } from "@/ui/Sensitive";
import { Skeleton } from "@/ui/Skeleton";
import type { TabItem } from "@/ui/Tabs";
import { DivergingBars } from "../finance/shared/charts";
import { assignColors, dayLabel, fmtMoney, fmtPct, fmtPp, fmtPrice, fmtQty, num, toMoney } from "../finance/shared/format";
import { useAsync } from "../finance/shared/hooks";
import { Disclaimer, HubPage, InsightCard, Quiet, Section } from "../finance/shared/ui";
import { HeroMoney } from "../finance/MoneyHQ/widgets";
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
        <Kpi label="Unrealised gain" value={s ? <GainLoss value={num(s.unrealized.amount)}><Sensitive>{fmtMoney(s.unrealized.amount, "USD", { noCents: true, signed: true })}</Sensitive></GainLoss> : null} sub={s ? `${fmtPct(s.unrealizedPct, 1, true)} on cost` : ""} />
        <Kpi label="Money-weighted return" value={s ? <span>{s.xirrAll !== undefined ? fmtPct(s.xirrAll, 1, true) : "—"}<span className="text-tertiary text-body-sm font-medium"> /yr</span></span> : null} sub={s?.xirrYtd !== undefined ? `${fmtPct(s.xirrYtd, 1, true)} year to date (XIRR)` : ""} />
        <Kpi label="Dividends" value={s ? <Sensitive>{fmtMoney(s.divTtm.amount, "USD", { noCents: true })}</Sensitive> : null} sub={s ? <>last 12 months · <Sensitive>{fmtMoney(s.divFwd12m.amount, "USD", { noCents: true })}</Sensitive> expected next 12</> : ""} onClick={() => go("dividends")} />
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
  const El = onClick ? "button" : "div";
  return (
    <El type={onClick ? "button" : undefined} className="fh-metric" onClick={onClick}>
      <span className="min-w-0 flex-1 text-left">
        <span className="block text-caption text-secondary" style={{ fontWeight: 500 }}>
          {label}
        </span>
        <span className="block fh-metric-value tabular">{value ?? <Skeleton width={110} height={20} />}</span>
        {sub ? <span className="block text-caption text-tertiary truncate" style={{ fontWeight: 400 }}>{sub}</span> : null}
      </span>
    </El>
  );
}

const RANGES: { value: PerfRange; label: string }[] = [
  { value: "1m", label: "1M" },
  { value: "3m", label: "3M" },
  { value: "ytd", label: "YTD" },
  { value: "1y", label: "1Y" },
  { value: "5y", label: "5Y" },
  { value: "all", label: "All" },
];

function ValueHero({ instanceId, summary: s }: { instanceId: Id; summary?: PortfolioSummary }) {
  const [range, setRange] = useState<PerfRange>("1y");
  const [idx, setIdx] = useState<number | null>(null);
  const perf = useAsync(() => api.portfolio.performance({ instanceId, range }), [instanceId, range]);
  const data = useMemo(() => (perf.data ? perf.data.t.map((t, i) => ({ t, value: perf.data!.value[i], contributions: perf.data!.contributions[i] })) : []), [perf.data]);
  const cur = idx !== null ? data[idx] : null;
  const first = data[0];
  const value = cur ? cur.value : s ? num(s.totalValue.amount) : null;
  const growth = cur && first ? cur.value - first.value - (cur.contributions - first.contributions) : null;
  const long = range === "5y" || range === "all";
  const xf = (v: unknown) => {
    const d = new Date(Number(v));
    return long ? d.toLocaleDateString(undefined, { month: "short", year: "2-digit" }) : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  return (
    <section className="fh-card" style={{ paddingBottom: 12 }}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-caption text-secondary" style={{ fontWeight: 500 }}>
            Total value
          </div>
          <div className="mt-1 h-[44px] flex items-center">{value !== null ? <HeroMoney value={value} cents={false} /> : <Skeleton width={220} height={36} />}</div>
          <div className="flex items-center gap-2 h-6 mt-1">
            {cur && first ? (
              <>
                <span className="text-caption tabular font-semibold" style={{ color: (growth ?? 0) >= 0 ? "var(--gain-text)" : "var(--loss-text)" }}>
                  <Sensitive>{fmtMoney(growth ?? 0, "USD", { noCents: true, signed: true })}</Sensitive> market growth
                </span>
                <span className="text-caption text-tertiary" style={{ fontWeight: 400 }}>
                  since {xf(first.t)} · {new Date(cur.t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
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
        <Segmented size="sm" value={range} onValueChange={setRange} options={RANGES} aria-label="Range" />
      </div>
      <div className="mt-3">
        <LineChart
          data={data}
          x="t"
          series={[
            { key: "value", label: "Value", color: "var(--accent-solid)", area: true },
            { key: "contributions", label: "Contributed", color: "var(--text-tertiary)", dashed: true },
          ]}
          colorBySign={false}
          startReference={false}
          height={220}
          curve="linear"
          xFormat={xf}
          xTooltipFormat={(v) => new Date(Number(v)).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
          onScrub={setIdx}
          tooltip={false}
          live
          loading={perf.loading && !perf.data}
          summaryLabel="Portfolio value versus contributions"
        />
      </div>
      <div className="flex items-center gap-5 pt-2 mt-1 border-t border-subtle text-caption" style={{ fontWeight: 400 }}>
        <span className="inline-flex items-center gap-1.5 text-tertiary">
          <i className="fh-key" style={{ background: "var(--accent-solid)" }} />
          Value <b className="text-primary tabular font-medium ml-1"><Sensitive>{cur ? fmtMoney(cur.value, "USD", { noCents: true }) : s ? fmtMoney(s.totalValue.amount, "USD", { noCents: true }) : "—"}</Sensitive></b>
        </span>
        <span className="inline-flex items-center gap-1.5 text-tertiary">
          <i className="fh-key" style={{ background: "var(--text-tertiary)" }} />
          Contributed <b className="text-primary tabular font-medium ml-1"><Sensitive>{cur ? fmtMoney(cur.contributions, "USD", { noCents: true }) : data.length ? fmtMoney(data[data.length - 1].contributions, "USD", { noCents: true }) : "—"}</Sensitive></b>
        </span>
        {perf.data?.xirr !== undefined ? <span className="ml-auto text-tertiary">XIRR this period {fmtPct(perf.data.xirr, 1, true)}/yr</span> : null}
      </div>
    </section>
  );
}

/** Concentric rings: outer thin ring = target, inner ring = current allocation (§16.3 "allocation donut with a target ring"). */
function AllocationRings({ rows, size = 196 }: { rows: { cls: string; current: number; target: number; color: string }[]; size?: number }) {
  const [hover, setHover] = useState<string | null>(null);
  const cx = size / 2;
  const arcs = (key: "current" | "target", r: number, w: number) => {
    const total = rows.reduce((a, x) => a + x[key], 0) || 1;
    let a0 = -Math.PI / 2;
    return rows.map((x) => {
      const frac = x[key] / total;
      const a1 = a0 + frac * Math.PI * 2;
      const gap = rows.length > 1 ? 0.012 : 0;
      const s = a0 + gap;
      const e = Math.max(s, a1 - gap);
      a0 = a1;
      const large = e - s > Math.PI ? 1 : 0;
      const p = (ang: number, rr: number) => `${cx + rr * Math.cos(ang)} ${cx + rr * Math.sin(ang)}`;
      const d = `M ${p(s, r)} A ${r} ${r} 0 ${large} 1 ${p(e, r)}`;
      return (
        <m.path
          key={`${key}-${x.cls}`}
          d={d}
          fill="none"
          stroke={x.color}
          strokeWidth={w}
          strokeLinecap="butt"
          style={{ opacity: hover && hover !== x.cls ? 0.3 : key === "target" ? 0.5 : 1, transition: "opacity 160ms cubic-bezier(.2,0,0,1)" }}
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          onMouseEnter={() => setHover(x.cls)}
          onMouseLeave={() => setHover(null)}
        />
      );
    });
  };
  const shown = rows.find((r) => r.cls === hover);
  return (
    <div className="relative flex-none" style={{ width: size, height: size }}>
      <svg width={size} height={size} role="img" aria-label="Current allocation (inner ring) against target (outer ring)">
        {arcs("target", size / 2 - 5, 4)}
        {arcs("current", size / 2 - 22, 22)}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">
        {shown ? (
          <>
            <span className="text-caption text-tertiary" style={{ fontWeight: 500 }}>{shown.cls}</span>
            <span className="tabular" style={{ fontSize: 20, fontWeight: 640 }}>{shown.current.toFixed(1)}%</span>
            <span className="text-caption text-tertiary">target {shown.target.toFixed(0)}%</span>
          </>
        ) : (
          <>
            <span className="text-caption text-tertiary" style={{ fontWeight: 500 }}>Inner: now</span>
            <span className="text-caption text-tertiary" style={{ fontWeight: 500 }}>Outer: target</span>
          </>
        )}
      </div>
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
  return (
    <Section
      title="Allocation vs target"
      subtitle={s ? (outside ? `${outside} ${outside === 1 ? "class is" : "classes are"} outside the band · max drift ${fmtPp(s.maxDrift)}` : "Every class is within its band") : null}
      actions={
        <Button size="xs" variant={outside ? "primary" : "ghost"} iconRight={ChevronRight} onClick={onRebalance}>
          Rebalance
        </Button>
      }
    >
      {!s ? (
        <Skeleton height={220} radius={10} />
      ) : (
        <div className="flex items-center gap-6">
          <AllocationRings rows={rows} />
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
            />
            <div className="text-caption text-tertiary mt-3" style={{ fontWeight: 400 }}>
              Bars show drift from target in percentage points. Amber means outside the band (±5 pp or 25% of target).
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
          <Skeleton height={220} radius={10} />
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
    const high = s.holdings.find((h) => false && h);
    void high;
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

export { dayLabel };
