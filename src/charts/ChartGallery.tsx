/* Dev-only: every chart type with realistic sample data (lazy-loaded by src/ui/Gallery.tsx). */
import { addDays, addMonths, format } from "date-fns";
import { useMemo, useState } from "react";
import { Card } from "@/ui/Card";
import { Segmented } from "@/ui/Segmented";
import { AreaChart, HeroAreaChart } from "./Area";
import { BarChart } from "./Bar";
import { CandleChart, type CandleMode, type Ohlcv } from "./Candles";
import { Donut } from "./Donut";
import { FanChart, type FanPoint } from "./Fan";
import { Gauge } from "./Gauge";
import { CalendarHeatmap, MatrixHeatmap } from "./Heatmap";
import { LineChart } from "./Line";
import { Sankey } from "./Sankey";
import { Sparkline } from "./Sparkline";
import { Treemap } from "./Treemap";
import { Waterfall } from "./Waterfall";

/** Deterministic PRNG so screenshots are stable. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());

const START = new Date(2025, 11, 1);

function netWorthSeries(days: number) {
  const r = rng(7);
  let v = 148_000;
  return Array.from({ length: days }, (_, i) => {
    v *= 1 + 0.0009 + gauss(r) * 0.006;
    if (i % 30 === 14) v += 2400;
    return { date: format(addDays(addMonths(START, -11), i), "yyyy-MM-dd"), value: Math.round(v * 100) / 100 };
  });
}

function ohlcv(n: number): Ohlcv[] {
  const r = rng(42);
  let p = 182;
  const out: Ohlcv[] = [];
  let d = new Date(Date.UTC(2025, 5, 2));
  while (out.length < n) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) {
      const open = p;
      const close = Math.max(5, open * (1 + 0.0006 + gauss(r) * 0.016));
      const high = Math.max(open, close) * (1 + r() * 0.009);
      const low = Math.min(open, close) * (1 - r() * 0.009);
      out.push({ time: d.toISOString().slice(0, 10), open: +open.toFixed(2), high: +high.toFixed(2), low: +low.toFixed(2), close: +close.toFixed(2), volume: Math.round(2e6 + r() * 3e6 + Math.abs(close - open) * 4e5) });
      p = close;
    }
    d = new Date(d.getTime() + 86400000);
  }
  return out;
}

export default function ChartGallery() {
  const [range, setRange] = useState("1Y");
  const [mode, setMode] = useState<CandleMode>("candles");
  const nw = useMemo(() => netWorthSeries(366), []);
  const nwView = useMemo(() => (range === "1M" ? nw.slice(-31) : range === "3M" ? nw.slice(-92) : range === "6M" ? nw.slice(-183) : nw), [nw, range]);
  const candles = useMemo(() => ohlcv(260), []);

  const cashflow = useMemo(() => {
    const r = rng(3);
    return Array.from({ length: 6 }, (_, i) => ({
      month: format(addMonths(START, i - 5), "MMM"),
      income: Math.round(7800 + r() * 900),
      expenses: Math.round(5200 + r() * 1600),
    }));
  }, []);
  const netByMonth = cashflow.map((c) => ({ month: c.month, net: c.income - c.expenses - (c.month === "Aug" ? 2600 : 0) }));

  const spending = [
    { id: "housing", label: "Housing", value: 2150 },
    { id: "groceries", label: "Groceries", value: 642.18 },
    { id: "dining", label: "Dining out", value: 318.4 },
    { id: "transport", label: "Transport", value: 286 },
    { id: "utilities", label: "Utilities", value: 214.55 },
    { id: "health", label: "Health", value: 140 },
    { id: "subs", label: "Subscriptions", value: 89.97 },
    { id: "shopping", label: "Shopping", value: 76.2 },
    { id: "gifts", label: "Gifts", value: 45 },
    { id: "misc", label: "Misc", value: 21.3 },
  ];

  const holdings = [
    { id: "EMPX", label: "EMPX", value: 31_200, change: 0.034 },
    { id: "NOVA", label: "NOVA", value: 18_400, change: -0.021 },
    { id: "ORBT", label: "ORBT", value: 12_900, change: 0.012 },
    { id: "KITE", label: "KITE", value: 9_800, change: -0.046 },
    { id: "LUMA", label: "LUMA", value: 8_200, change: 0.006 },
    { id: "VOLT", label: "VOLT", value: 6_100, change: 0.051 },
    { id: "BRIX", label: "BRIX", value: 4_700, change: -0.008 },
    { id: "ZENO", label: "ZENO", value: 3_300, change: 0.019 },
  ];

  const heat = useMemo(() => {
    const r = rng(11);
    return Array.from({ length: 26 * 7 - 3 }, (_, i) => {
      const d = addDays(new Date(2026, 4, 25), i);
      const weekend = d.getDay() === 0 || d.getDay() === 6;
      const v = r() < 0.18 ? 0 : Math.round((weekend ? 60 : 25) + r() * (weekend ? 140 : 70));
      return { date: format(d, "yyyy-MM-dd"), value: v };
    });
  }, []);

  const fan: FanPoint[] = useMemo(() => {
    const out: FanPoint[] = [];
    let v = 82_000;
    const r = rng(5);
    for (let i = 0; i < 12; i++) {
      v += 1500 + gauss(r) * 900;
      out.push({ x: format(addMonths(START, i - 11), "MMM yy"), actual: Math.round(v) });
    }
    const base = v;
    out[out.length - 1] = { ...out[out.length - 1], p10: base, p25: base, p50: base, p75: base, p90: base };
    for (let k = 1; k <= 24; k++) {
      const m = base + k * 1650 + base * (Math.pow(1.005, k) - 1);
      const s = Math.sqrt(k) * 2600;
      out.push({ x: format(addMonths(START, k), "MMM yy"), p10: Math.round(m - 1.28 * s), p25: Math.round(m - 0.67 * s), p50: Math.round(m), p75: Math.round(m + 0.67 * s), p90: Math.round(m + 1.28 * s) });
    }
    return out;
  }, []);

  const monthTick = (v: unknown) => format(new Date(String(v) + "T00:00:00"), range === "1M" ? "MMM d" : "MMM");

  return (
    <div className="flex flex-col gap-4">
      <Card pad="lg">
        <HeroAreaChart
          data={nwView}
          x="date"
          y="value"
          label="Net worth"
          height={260}
          live
          xFormat={monthTick}
          xReadout={(v) => format(new Date(String(v) + "T00:00:00"), "EEE, MMM d, yyyy")}
          periodLabel={`past ${range === "1Y" ? "year" : range}`}
          summaryLabel="Net worth"
          actions={
            <Segmented
              size="sm"
              aria-label="Range"
              value={range}
              onValueChange={setRange}
              options={["1M", "3M", "6M", "1Y"].map((v) => ({ value: v, label: v }))}
            />
          }
        />
      </Card>
      <div className="grid grid-cols-2 gap-4">
        <Card title="Income vs expenses" subtitle="Last 6 months · hover dims other months">
          <BarChart data={cashflow} x="month" series={[{ key: "income", label: "Income", color: "var(--accent-solid)" }, { key: "expenses", label: "Expenses", kind: "expense" }]} height={220} summaryLabel="Income and expenses" />
        </Card>
        <Card title="Spending by category" subtitle="November · top 7 + Other">
          <Donut data={spending} size={196} summaryLabel="Spending by category" centerLabel="Spent" />
        </Card>
        <Card title="Cash flow" subtitle="Where November's income went">
          <Sankey
            height={260}
            nodes={[
              { name: "Salary" },
              { name: "Freelance" },
              { name: "Income" },
              { name: "Housing" },
              { name: "Living" },
              { name: "Savings" },
              { name: "Investing" },
            ]}
            links={[
              { source: 0, target: 2, value: 7200 },
              { source: 1, target: 2, value: 1350 },
              { source: 2, target: 3, value: 2150 },
              { source: 2, target: 4, value: 2840 },
              { source: 2, target: 5, value: 1860 },
              { source: 2, target: 6, value: 1700 },
            ]}
          />
        </Card>
        <Card title="Monthly bridge" subtitle="Checking balance, November">
          <Waterfall
            height={260}
            steps={[
              { label: "Nov 1", value: 4820 },
              { label: "Salary", value: 7200 },
              { label: "Freelance", value: 1350 },
              { label: "Rent", value: -2150 },
              { label: "Bills", value: -640 },
              { label: "Groceries", value: -642 },
              { label: "To savings", value: -1860 },
              { label: "Nov 30", value: 0, total: true },
            ]}
          />
        </Card>
        <Card title="Holdings" subtitle="Allocation · coloured by today's change">
          <Treemap data={holdings} colorBy="change" height={240} summaryLabel="Holdings" />
        </Card>
        <Card title="Allocation" subtitle="Categorical">
          <Treemap data={holdings} height={240} summaryLabel="Allocation" />
        </Card>
      </div>
      <Card
        title="EMPX · Empyrean Systems"
        subtitle="Daily · SMA 20/50/200 · volume"
        actions={
          <Segmented
            size="sm"
            aria-label="Chart mode"
            value={mode}
            onValueChange={(v) => setMode(v as CandleMode)}
            options={[
              { value: "candles", label: "Candles" },
              { value: "line", label: "Line" },
              { value: "area", label: "Area" },
            ]}
          />
        }
      >
        <CandleChart data={candles} mode={mode} height={320} summaryLabel="EMPX price" />
      </Card>
      <div className="grid grid-cols-2 gap-4">
        <Card title="Retirement projection" subtitle="Median with p25–p75 and p10–p90 bands">
          <FanChart reveal data={fan} height={240} target={{ value: 130_000, label: "Goal $130k" }} summaryLabel="Investment projection" />
        </Card>
        <Card title="Monthly net" subtitle="Signed bars">
          <BarChart data={netByMonth} x="month" series={[{ key: "net", label: "Net" }]} colorBySign height={240} summaryLabel="Monthly net" />
        </Card>
        <Card title="Daily spending" subtitle="26 weeks · sequential accent">
          <CalendarHeatmap days={heat} valueLabel="Spent" summaryLabel="Daily spending" />
        </Card>
        <Card title="Category × month" subtitle="Matrix heatmap">
          <MatrixHeatmap
            rows={["Groceries", "Dining", "Transport", "Shopping", "Health"]}
            cols={["Jun", "Jul", "Aug", "Sep", "Oct", "Nov"]}
            values={[
              [520, 610, 580, 640, 600, 642],
              [210, 340, 420, 260, 300, 318],
              [180, 240, 300, 220, 260, 286],
              [90, 60, 340, 120, 80, 76],
              [40, 140, 0, 60, 120, 140],
            ]}
          />
        </Card>
        <Card title="Gauges">
          <div className="flex items-start justify-around gap-4 pt-2">
            <Gauge value={27.4} max={50} label="Savings rate" format={(n) => `${n.toFixed(1)}%`} bands={[{ to: 10, tone: "loss" }, { to: 20, tone: "warning" }, { to: 50, tone: "gain" }]} target={20} size={180} />
            <Gauge value={68} label="Credit utilisation" format={(n) => `${Math.round(n)}%`} bands={[{ to: 30, tone: "gain" }, { to: 60, tone: "warning" }, { to: 100, tone: "loss" }]} size={180} />
          </div>
        </Card>
        <Card title="Multi-series + states">
          <LineChart
            data={cashflow}
            x="month"
            series={[
              { key: "income", label: "Income" },
              { key: "expenses", label: "Expenses" },
            ]}
            yAxis="left"
            height={150}
            summaryLabel="Income and expenses"
          />
          <div className="grid grid-cols-2 gap-3">
            <AreaChart data={[]} x="month" series={[{ key: "v", label: "Balance" }]} height={90} summaryLabel="Empty" />
            <AreaChart data={nw.slice(-40)} x="date" series={[{ key: "value", label: "Balance" }]} height={90} loading summaryLabel="Loading" />
          </div>
        </Card>
      </div>
      <Card title="Sparklines" subtitle="Pure SVG, LTTB above 120 points">
        <div className="grid grid-cols-6 gap-4">
          {["EMPX", "NOVA", "ORBT", "KITE", "LUMA", "VOLT"].map((s, i) => {
            const r = rng(100 + i);
            let v = 100;
            const series = Array.from({ length: 60 }, () => (v *= 1 + gauss(r) * 0.02 + (i % 2 ? -0.001 : 0.002)));
            return (
              <div key={s} className="flex flex-col gap-1">
                <span className="text-caption text-secondary">{s}</span>
                <Sparkline data={series} height={36} live={i === 0} />
              </div>
            );
          })}
        </div>
      </Card>
      <Card title="Cached state">
        <LineChart data={nw.slice(-60)} x="date" series={[{ key: "value", label: "Net worth" }]} height={140} cached="Cached · 14 min" curve="linear" xFormat={(v) => format(new Date(String(v) + "T00:00:00"), "MMM d")} summaryLabel="Net worth" />
      </Card>
    </div>
  );
}
