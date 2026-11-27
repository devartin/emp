/**
 * Portfolio (§16.3): value vs contributions hero with scrub readout, KPIs (today, unrealised, XIRR, dividends,
 * drift, fees), allocation rings vs target with drift bars, holdings heat treemap, holdings table with lots,
 * performance (TWR vs benchmark, realised gains), dividends, the rebalance planner and the IPS.
 * `tab = "holding:<SYMBOL>"` opens a holding page.
 */
import { CandlestickChart, ChevronRight, RefreshCw } from "lucide-react";
import { lazy, Suspense, useMemo, useState } from "react";
import { api } from "@/backend";
import type { Id, Insight, PerfRange, PortfolioSummary } from "@/backend/types";
import { navigate } from "@/app/router";
import { LineChart } from "@/charts/Line";
import { Treemap } from "@/charts/Treemap";
import { notify } from "@/stores/toasts";
import { useQuotes } from "@/stores/market";
import { Amount } from "@/ui/Amount";
import { Button } from "@/ui/Button";
import { Delta } from "@/ui/Delta";
import { RollingNumber } from "@/ui/motion/RollingNumber";
import { PriceFlash } from "@/ui/PriceFlash";
import { Segmented } from "@/ui/Segmented";
import { Sensitive } from "@/ui/Sensitive";
import { Skeleton } from "@/ui/Skeleton";
import type { TabItem } from "@/ui/Tabs";
import { DivergingBars } from "../finance/shared/charts";
import { Figure } from "../finance/shared/Figure";
import { figureLabel, periodReturn, portfolioParts, rangeYears } from "../finance/shared/definitions";
import { fmtPct, fmtPp, fmtPrice, fmtQty, num, toMoney, fmtWhole } from "../finance/shared/format";
import { useAsync, useScrubIdx, useScrubStore, type ScrubStore } from "../finance/shared/hooks";
import { Disclaimer, HubPage, InsightCard, Quiet, Section, Signed } from "../finance/shared/ui";
import { baseCurrency } from "../finance/shared/currency";
import { HeroMoney, MetricCard } from "../finance/MoneyHQ/widgets";
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
      <Suspense fallback={<div className="fh-page"><Skeleton height={420} radius={10} /></div>}>
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
      footer={<Disclaimer>Example starting points, not recommendations. Ultranote never places trades. Only ticker symbols leave this device, never quantities, cost basis, account names or balances.</Disclaimer>}
    >
      <Suspense fallback={<Skeleton height={420} radius={10} />}>
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
  // `pf.mwr.ytd` is the YTD range's money-weighted figure (annualised XIRR from portfolio_performance, the same on both
  // backends) turned into this year's own return — so it equals the hero legend's YTD figure by construction.
  const ytd = useAsync(() => api.portfolio.performance({ instanceId, range: "ytd" }), [instanceId]);
  const ytdMwr = ytd.data?.xirr !== undefined ? periodReturn(ytd.data.xirr, rangeYears(ytd.data.t)) : null;
  const parts = s ? portfolioParts(s) : null;
  return (
    <div className="fh-grid">
      <div className="fh-span-8">
        <ValueHero instanceId={instanceId} summary={s} />
      </div>
      <div className="fh-span-4 flex flex-col gap-3">
        <Kpi
          label="Unrealised gain"
          value={s ? <Signed value={num(s.unrealized.amount)}><Figure id="pf.unrealised" inputs={[{ label: "Holdings value", value: fmtWhole(parts?.holdings ?? 0, { currency: s.totalValue.currency }) }, { label: "Cost basis", value: fmtWhole(parts?.cost ?? 0, { currency: s.totalValue.currency }) }, { label: "Gain on cost", value: fmtPct(s.unrealizedPct, 1, true), sensitive: false }]}><Sensitive>{fmtWhole(s.unrealized.amount, { signed: true, currency: s.unrealized.currency })}</Sensitive></Figure></Signed> : null}
          sub={s ? `${fmtPct(s.unrealizedPct, 1, true)} on cost` : ""}
        />
        {/* Three returns, three names (definitions.ts): since first buy (annualised), this year (not annualised), and
            the chart range's money-weighted figure in the hero legend. */}
        <Kpi
          label={figureLabel("pf.mwr.all")}
          value={s ? s.xirrAll !== undefined ? <Figure id="pf.mwr.all">{fmtPct(s.xirrAll, 1, true)}<span className="text-tertiary text-body-sm font-medium"> a year</span></Figure> : "—" : null}
          sub={ytdMwr ? <>This year <Figure id="pf.mwr.ytd">{fmtPct(ytdMwr.value, 1, true)}</Figure></> : ""}
        />
        <Kpi label="Dividends" value={s ? <span data-sensitive=""><RollingNumber value={num(s.divTtm.amount)} format={(n) => fmtWhole(Math.round(n))} sensitive countUp={false} /></span> : null} sub={s ? <>last 12 months · <Sensitive>{fmtWhole(s.divFwd12m.amount, { currency: s.divFwd12m.currency })}</Sensitive> expected next 12</> : ""} onClick={() => go("dividends")} />
        <Kpi label="Fees" value={s ? <Sensitive>{fmtWhole(s.feesPerYear.amount, { currency: s.feesPerYear.currency })}</Sensitive> : null} sub={s ? `a year · ${fmtPct(num(s.feesPerYear.amount) / Math.max(1, num(s.totalValue.amount)), 2)} of the portfolio` : ""} />
      </div>
      <div className="fh-span-7">
        <Allocation summary={s} onRebalance={() => go("rebalance")} />
      </div>
      <div className="fh-span-5">
        <Section title="Today's heat map" subtitle="Tile size is value · colour is today's move">
          <Treemap data={(s?.holdings ?? []).map((h) => ({ id: h.symbol, label: ticker(h.symbol), value: num(h.value.amount), change: h.dayPct ?? 0, sub: h.dayPct !== undefined ? `${h.dayPct >= 0 ? "+" : "−"}${Math.abs(h.dayPct * 100).toFixed(2)}%` : undefined }))} colorBy="change" changeScale={0.03} height={268} loading={!s} summaryLabel="Holdings by value, coloured by today's change" />
        </Section>
      </div>
      <div className="fh-span-12">
        <TopHoldings instanceId={instanceId} summary={s} />
      </div>
      <div className="fh-span-12">
        <PfInsights instanceId={instanceId} summary={s} />
      </div>
    </div>
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
    <section className="fh-card fh-hero" ref={scrub.hostRef}>
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
      <HeroLegend scrub={scrub} data={data} summary={s} xirr={perf.data?.xirr} years={rangeYears(perf.data?.t)} rangeLabel={RANGES.find((r) => r.value === range)?.label ?? range} />
    </section>
  );
}

/** The popover inputs for `pf.value`: holdings at market value, uninvested cash when there is any, and the count. */
function valueInputs(s: PortfolioSummary) {
  const p = portfolioParts(s);
  const cur = s.totalValue.currency;
  return [
    { label: "Holdings at market value", value: fmtWhole(p.holdings, { currency: cur }) },
    ...(p.cash !== 0 ? [{ label: "Uninvested cash", value: fmtWhole(p.cash, { currency: cur }) }] : []),
    { label: "Holdings", value: String(s.holdings.length), sensitive: false },
    { label: "As of", value: new Date(s.asOf).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }), sensitive: false },
  ];
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
      <div className="text-caption text-secondary font-medium">
        {figureLabel("pf.value")}
      </div>
      <div className="mt-1 h-[48px] flex items-center">
        {value !== null ? (
          <Figure id="pf.value" block inputs={s ? valueInputs(s) : undefined}>
            <HeroMoney value={value} cents={false} currency={s?.totalValue.currency} scrubbing={idx !== null} />
          </Figure>
        ) : (
          <Skeleton width={220} height={38} />
        )}
      </div>
      <div className="flex items-center gap-2 h-6 mt-1 text-caption whitespace-nowrap">
        {cur && first ? (
          <>
            {/* One sign convention for the whole line: the drawn arrow carries the direction, the figures are unsigned. */}
            <Delta money={{ amount: String(Math.round(growth ?? 0)), currency: s?.totalValue.currency ?? baseCurrency() }} label="market growth" />
            <span className="text-tertiary">
              since {xf(first.t)} · {fmtFull(cur.t)}
            </span>
          </>
        ) : s ? (
          <Delta money={s.dayChange} percent={s.dayChangePct} digits={2} label="today" />
        ) : null}
      </div>
    </div>
  );
}

function HeroLegend({ scrub, data, summary: s, xirr, years, rangeLabel }: { scrub: ScrubStore; data: HeroPoint[]; summary?: PortfolioSummary; xirr?: number; years: number; rangeLabel: string }) {
  const mwr = xirr !== undefined ? periodReturn(xirr, years) : null;
  const idx = useScrubIdx(scrub);
  const cur = idx !== null ? data[idx] : null;
  return (
    <div className="flex items-center gap-5 pt-2.5 text-caption" style={{ fontWeight: 400 }}>
      <span className="inline-flex items-center gap-1.5 text-tertiary">
        <i className="fh-key" style={{ background: "var(--chart-line)" }} />
        {figureLabel("pf.value")} <b className="text-primary tabular font-medium ml-1"><Sensitive>{cur ? fmtWhole(cur.value) : s ? fmtWhole(num(s.totalValue.amount)) : "—"}</Sensitive></b>
      </span>
      <span className="inline-flex items-center gap-1.5 text-tertiary">
        <i className="fh-key" style={{ background: "var(--text-tertiary)" }} />
        Contributed <b className="text-primary tabular font-medium ml-1"><Sensitive>{cur ? fmtWhole(cur.contributions) : data.length ? fmtWhole(data[data.length - 1].contributions) : "—"}</Sensitive></b>
      </span>
      {mwr ? (
        <span className="ml-auto text-tertiary">
          {figureLabel("pf.mwr.range", rangeLabel)}{" "}
          <Figure id="pf.mwr.range" range={rangeLabel}>
            <b className="text-primary tabular font-medium">{fmtPct(mwr.value, 1, true)}</b>
          </Figure>
          {mwr.annualised ? " a year" : ""}
        </span>
      ) : null}
    </div>
  );
}

function Allocation({ summary: s, onRebalance }: { summary?: PortfolioSummary; onRebalance: () => void }) {
  const rows = useMemo(() => {
    if (!s) return [];
    const list = s.allocation.slice().sort((a, b) => CLASS_ORDER.indexOf(a.assetClass) - CLASS_ORDER.indexOf(b.assetClass));
    return list.map((x) => ({ ...x, cls: x.assetClass }));
  }, [s]);
  // The summary names the classes it counts, so the count can be checked against the coloured rows (some of which can
  // sit below the fold): one rule (`status`, from the backend's band test) drives both.
  const outsideRows = rows.filter((r) => r.status === "outside_band");
  const outside = outsideRows.length;
  const [active, setActive] = useState<string | null>(null);
  return (
    <Section
      title="Allocation vs target"
      subtitle={s ? (outside ? `Outside the band: ${outsideRows.map((r) => r.cls).join(", ")}` : "Every class is within its band") : "\u00a0"}
      actions={
        <Button size="xs" variant={outside ? "primary" : "ghost"} iconRight={ChevronRight} onClick={onRebalance}>
          Rebalance
        </Button>
      }
    >
      {!s ? (
        <Skeleton height={276} radius={10} />
      ) : (
        <div className="min-w-0">
          {/* No ring (DESIGN §6.3): one ruled row per class, drift as a bar from the target line. */}
          <DivergingBars
            rows={rows.map((r) => ({
              key: r.cls,
              label: r.cls,
              value: r.drift,
              outside: r.status === "outside_band",
              note: (
                <span className="tabular">
                  {fmtPct(r.current / 100, 1)} now · {fmtPct(r.target / 100, 1)} target{r.status === "outside_band" ? " · outside the band" : ""}
                </span>
              ),
            }))}
            max={Math.max(6, ...rows.map((r) => Math.abs(r.drift)))}
            format={(v) => fmtPp(v)}
            active={active}
            onActive={setActive}
          />
          <div className="text-caption text-tertiary mt-3">Drift from target in points. A class is outside the band when it drifts more than 5 pts or 25% of its target; those rows are marked.</div>
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
                      <span className="min-w-0">
                        <span className="block font-medium">{ticker(h.symbol)}</span>
                        <span className="block text-caption text-tertiary truncate max-w-[220px]">
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
                  <td className="num">{q ? <Signed value={q.changePct}>{fmtPct(q.changePct, 2, true)}</Signed> : "—"}</td>
                  <td className="num font-medium">
                    <Amount value={toMoney(Math.round((q ? q.price * num(h.qty) : num(h.value.amount)) * 100) / 100)} align="end" noCents />
                  </td>
                  <td className="num">
                    <Signed value={num(h.gain.amount)}>
                      <Sensitive align="end">{fmtWhole(h.gain.amount, { signed: true, currency: h.gain.currency })}</Sensitive>
                    </Signed>
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
      out.push({ id: `drift:${a.assetClass}`, appInstanceId: instanceId, ruleId: "drift-band", severity: "warn", title: `${a.assetClass} is ${fmtPp(a.drift)} from target`, body: `Now ${a.current.toFixed(1)}% against a ${a.target}% target.`, math: [{ label: "Current", value: `${a.current.toFixed(1)}%` }, { label: "Target", value: `${a.target}%` }, { label: "Band", value: "±5 pp or 25% of target" }], actions: [{ label: "Plan a rebalance", route: tab("rebalance") }] });
    }
    for (const h of s.holdings.filter((x) => x.weight > 0.1 && !/ETF|Fund/i.test(x.name)).slice(0, 1)) {
      out.push({ id: `conc:${h.symbol}`, appInstanceId: instanceId, ruleId: "concentration-10", severity: "tip", title: `${ticker(h.symbol)} is ${(h.weight * 100).toFixed(0)}% of the portfolio`, body: "One holding above 10% of the portfolio.", math: [{ label: "Value", value: fmtWhole(h.value.amount, { currency: h.value.currency }) }, { label: "Share", value: fmtPct(h.weight, 1) }], actions: [{ label: "Open holding", route: tab(`holding:${h.symbol}`) }] });
    }
    out.push({ id: "ips", appInstanceId: instanceId, ruleId: "ips-review", severity: "tip", title: "Write down your investment policy", body: "Targets and rebalancing rules, written down.", actions: [{ label: "Open IPS", route: tab("ips") }] });
    if (total > 0 && s.allocation.find((a) => a.assetClass === "Cash" && a.current > 5)) out.push({ id: "cash", appInstanceId: instanceId, ruleId: "cash-drag", severity: "info", title: "Cash is above 5%", body: "Cash above 5% of the portfolio.", actions: [{ label: "Plan a rebalance", route: tab("rebalance") }] });
    return out;
  }, [remote.data, s, instanceId]);
  if (!s) return null;
  return (
    <Section title="Insights">
      {list.length ? (
        <div className="fh-insights">
          {list.slice(0, 6).map((i) => (
            <InsightCard key={i.id} insight={i} />
          ))}
        </div>
      ) : (
        <Quiet title="Nothing to flag" body="Every asset class is within its band." />
      )}
    </Section>
  );
}

