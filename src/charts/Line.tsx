import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Area, CartesianGrid, ComposedChart, Line, ReferenceLine, Tooltip, XAxis, YAxis, useActiveTooltipDataPoints, useIsTooltipActive,
} from "recharts";
import { lttb } from "@/lib/lttb";
import { summarizeSeries } from "./a11y";
import { MARGIN, X_AXIS_HEIGHT, edgeAwareTick, niceDomain, tickFormatter, tickStyle, valueFormatter, type ValueFormat } from "./axis";
import { ChartFrame, type ChartTable } from "./ChartFrame";
import { defaultSeriesColor, resolveColor, useChartTheme, seriesColor, type ChartTheme } from "./theme";
import { ChartTooltip } from "./Tooltip";

export type Datum = Record<string, unknown>;

export interface SeriesDef {
  key: string;
  label: string;
  color?: string;
  /** Projection style: dasharray 4 4 (§13.5). */
  dashed?: boolean;
  /** Fill this series with the area gradient (defaults to chart-level `area`). */
  area?: boolean;
  /** Render in the tooltip only (no line). */
  hidden?: boolean;
}

export interface LineChartProps<T extends Datum> {
  data: T[];
  x: keyof T & string;
  series: SeriesDef[];
  height?: number;
  /** monotoneX: net worth & projections · linear: prices · stepAfter: balances (§13.5). */
  curve?: "monotoneX" | "linear" | "stepAfter";
  format?: ValueFormat;
  currency?: string;
  /** Formats x values for ticks and tooltip titles. */
  xFormat?: (v: unknown) => string;
  xTooltipFormat?: (v: unknown) => string;
  /** Right for price / net-worth series, left for categories (§13.5). */
  yAxis?: "left" | "right" | "none";
  area?: boolean;
  /**
   * Colour a single series by the sign of last − first. Default: single-series trend lines are ink (--chart-line,
   * §5.6) and direction lives in the DeltaPill and the end-dot halo; pass `true` to colour the line itself.
   */
  colorBySign?: boolean;
  /** Hero treatment (S5): pen draw-in, end-dot keycap pulses. Set by HeroAreaChart. */
  hero?: boolean;
  /** Dashed reference at the first value (default with colorBySign). */
  startReference?: boolean;
  /** Pulsing halo on the last point. */
  live?: boolean;
  includeZero?: boolean;
  tooltip?: boolean;
  /** Fires with the hovered/keyboard-scrubbed index (null on leave) — header readout pattern. */
  onScrub?: (index: number | null) => void;
  summaryLabel?: string;
  loading?: boolean;
  empty?: boolean | string;
  cached?: boolean | string;
  header?: ReactNode;
  footer?: ReactNode;
  className?: string;
  /** Extra Recharts children (reference areas, bands). */
  children?: ReactNode;
  /** Additional values to include when computing the y-domain (bands). */
  extraDomainValues?: number[];
}

interface Layout<T> {
  plotted: T[];
  domain: [number, number];
  ticks: number[];
  yWidth: number;
  xTicks: unknown[];
}

function ScrubReporter<T>({ data, onScrub }: { data: readonly T[]; onScrub: (i: number | null) => void }) {
  const active = useIsTooltipActive();
  const pts = useActiveTooltipDataPoints<T>();
  const last = useRef<number | null>(null);
  useEffect(() => {
    const idx = active && pts && pts.length ? data.indexOf(pts[0]) : null;
    const next = idx === -1 ? null : idx;
    if (next !== last.current) {
      last.current = next;
      onScrub(next);
    }
  });
  return null;
}

/** Scrub dot (§5.6): a 6px keycap dot with a soft glow, on the series. */
function ActiveDot({ cx, cy, color, t }: { cx?: number; cy?: number; color: string; t: ChartTheme }) {
  if (cx === undefined || cy === undefined) return null;
  return (
    <g>
      <circle cx={cx} cy={cy} r={10} fill={color} fillOpacity={0.12} />
      <circle cx={cx} cy={cy + 1} r={4.5} fill="#000" fillOpacity={0.25} />
      <circle cx={cx} cy={cy} r={4.5} fill={color} stroke={t.canvas} strokeWidth={2} />
    </g>
  );
}

/**
 * End-dot keycap (§5.6, S5): an 8px face on a 1px side, tinted halo pulses (3×, 900ms, 300ms apart) after the pen
 * finishes on hero charts; `live` keeps a slow ping (Markets, S16).
 */
function LastDot({ cx, cy, color, live, halo, hero }: { cx?: number; cy?: number; color: string; live?: boolean; halo: string; hero?: boolean }) {
  if (cx === undefined || cy === undefined) return null;
  const delay = hero ? 1150 : 300;
  return (
    <g className="emp-end-dot">
      {live ? <circle className="emp-live-halo" cx={cx} cy={cy} r={4} fill={halo} /> : null}
      {hero ? (
        <>
          <circle className="emp-end-pulse" cx={cx} cy={cy} r={4} fill={halo} style={{ animationDelay: `${delay}ms` }} />
          <circle className="emp-end-pulse" cx={cx} cy={cy} r={4} fill={halo} style={{ animationDelay: `${delay + 300}ms` }} />
          <circle className="emp-end-pulse" cx={cx} cy={cy} r={4} fill={halo} style={{ animationDelay: `${delay + 600}ms` }} />
        </>
      ) : null}
      <circle cx={cx} cy={cy + 1} r={4} fill="#000" fillOpacity={0.3} />
      <circle cx={cx} cy={cy} r={4} fill={color} />
      <circle cx={cx} cy={cy - 1.2} r={1.6} fill="#fff" fillOpacity={0.35} />
    </g>
  );
}

/** Estimate a y-axis width from its tick labels (Recharts can't auto-size). */
function axisWidth(labels: string[]): number {
  const longest = labels.reduce((m, s) => Math.max(m, s.length), 0);
  return Math.max(28, Math.round(longest * 6.6 + 10));
}

/**
 * Time-series line/area chart (§13.5). Horizontal gridlines only, 4–5 nice ticks, compact labels, dashed crosshair,
 * 8px active dot with a 16px halo, 6px last dot (pulsing when live), clip-path draw-in, 400ms morph on data change.
 */
export function LineChart<T extends Datum>({
  data,
  x,
  series,
  height = 240,
  curve = "monotoneX",
  format = "money",
  currency = "USD",
  xFormat = (v) => String(v),
  xTooltipFormat,
  yAxis = "right",
  area = false,
  colorBySign,
  startReference,
  live,
  hero,
  includeZero,
  tooltip = true,
  onScrub,
  summaryLabel = "Chart",
  loading,
  empty,
  cached,
  header,
  footer,
  className,
  children,
  extraDomainValues,
}: LineChartProps<T>) {
  const t = useChartTheme();
  const gid = useId().replace(/:/g, "");
  const [animate, setAnimate] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setAnimate(true), 1100);
    return () => window.clearTimeout(id);
  }, []);

  const visible = series.filter((s) => !s.hidden);
  const bySign = colorBySign ?? visible.length === 1;
  const first = visible[0] ? Number(data[0]?.[visible[0].key]) : NaN;
  const lastV = visible[0] ? Number(data[data.length - 1]?.[visible[0].key]) : NaN;
  const signColor = lastV >= first ? t.gain : t.loss;
  const colorOf = (s: SeriesDef, i: number) =>
    resolveColor(s.color) ?? (colorBySign === true ? signColor : defaultSeriesColor(t, i, visible.length));

  const isEmpty = empty ?? data.length < 2;
  const fmt = valueFormatter(format, currency);
  const tf = tickFormatter(format, currency, t.privacy);

  // Latest formatters by ref: callers pass inline lambdas, which must not bust the layout cache below.
  const fmtRef = useRef({ xFormat, xTooltipFormat, fmt });
  fmtRef.current = { xFormat, xTooltipFormat, fmt };

  // The morph animation only runs on a real data change: an always-active Recharts animation re-measures the
  // path (getTotalLength) on every scrub re-render.
  const prevData = useRef(data);
  const morphUntil = useRef(0);
  if (prevData.current !== data) {
    const p = prevData.current;
    if (p.length !== data.length || p.some((d, i) => d !== data[i])) morphUntil.current = performance.now() + 700;
    prevData.current = data;
  }
  const dataMorph = performance.now() < morphUntil.current;

  // Layout (decimation, y-domain, ticks) depends on data, width and series keys only — cached across scrub renders.
  const seriesKey = series.map((s) => s.key).join("|");
  const layoutCache = useRef<{ key: unknown[]; out: Layout<T> } | null>(null);
  const layout = (width: number): Layout<T> => {
    const key = [data, width, seriesKey, visible.length, includeZero, extraDomainValues?.join(","), yAxis, t.privacy, format, currency, x];
    const c = layoutCache.current;
    if (c && c.key.length === key.length && c.key.every((k, i) => k === key[i])) return c.out;
    // Decimate above 2× pixel width (Rust does this for real data; this protects ad-hoc callers).
    const maxPts = Math.max(64, width * 2);
    const plotted = data.length > maxPts && visible.length === 1 ? lttb(data, maxPts, (_d, i) => i, (d) => Number(d[visible[0].key])) : data;
    const values: number[] = [];
    for (const d of plotted) for (const s of series) values.push(Number(d[s.key]));
    if (extraDomainValues) values.push(...extraDomainValues);
    const { domain, ticks } = niceDomain(values, { includeZero });
    const yWidth = yAxis === "none" ? 0 : axisWidth(ticks.map(tf));
    // One tick per distinct label (months on daily data), thinned to ≥64px apart (§13.5). Ticks are always explicit
    // (interval 0) so Recharts never measures tick text (getStringSize forces layout).
    const xf = fmtRef.current.xFormat;
    const firsts: unknown[] = [];
    let prev = "";
    for (const d of plotted) {
      const l = xf(d[x]);
      if (l !== prev) firsts.push(d[x]);
      prev = l;
    }
    const cap = Math.max(2, Math.floor((width - yWidth) / 64));
    const step = Math.max(1, Math.ceil(firsts.length / cap));
    const xTicks = firsts.filter((_, i) => i % step === 0);
    const out = { plotted, domain, ticks, yWidth, xTicks };
    layoutCache.current = { key, out };
    return out;
  };

  // Latest scrub callback by ref, so the cached chart element below never calls a stale one.
  const onScrubRef = useRef(onScrub);
  onScrubRef.current = onScrub;
  const seriesSig = series.map((s) => [s.key, s.label, s.color, s.dashed, s.area, s.hidden].join("\u0000")).join("\u0001");
  // The chart subtree is cached by identity: a hero readout update (scrub → header re-render) must not re-render the
  // Recharts tree — Recharts' Line calls getTotalLength() on every render, and re-renders re-run tick layout.
  const chartCache = useRef<{ key: unknown[]; el: ReactNode } | null>(null);

  const content = (size: { width: number; height: number }) => {
    const lay = layout(size.width);
    const { plotted, domain, ticks, yWidth, xTicks } = lay;
    const lastIndex = plotted.length - 1;
    const morph = animate && dataMorph && plotted.length <= 500 && !t.reducedMotion;
    const strokeW = visible.length > 2 ? 1.5 : 2;
    const cacheKey = [lay, size.height, t, morph, seriesSig, live, hero, tooltip, !!onScrub, children, startReference, curve, area, yAxis, colorBySign, gid];
    const hit = chartCache.current;
    if (hit && hit.key.length === cacheKey.length && hit.key.every((k, i) => k === cacheKey[i])) return hit.el;

    const el = (
      <ComposedChart width={size.width} height={size.height} data={plotted} margin={MARGIN} accessibilityLayer>
        <defs>
          {visible.map((s, i) => (
            <linearGradient key={s.key} id={`${gid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colorOf(s, i)} stopOpacity={colorOf(s, i) === t.chartLine ? (t.dark ? 0.16 : 0.13) : t.areaTop} />
              <stop offset="100%" stopColor={colorOf(s, i)} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid vertical={false} stroke={t.grid} />
        <XAxis
          dataKey={x as string as never}
          tickLine={false}
          axisLine={false}
          tick={edgeAwareTick(t, (v) => fmtRef.current.xFormat(v), size.width)}
          tickFormatter={(v) => fmtRef.current.xFormat(v)}
          height={X_AXIS_HEIGHT}
          tickMargin={8}
          minTickGap={28}
          ticks={xTicks as never}
          interval={0}
        />
        <YAxis
          hide={yAxis === "none"}
          orientation={yAxis === "left" ? "left" : "right"}
          width={yWidth}
          axisLine={false}
          tickLine={false}
          tick={tickStyle(t)}
          ticks={ticks}
          domain={domain}
          tickFormatter={tf}
          interval={0}
          tickMargin={6}
          allowDataOverflow
        />
        {(startReference ?? bySign) && Number.isFinite(first) ? <ReferenceLine y={first} stroke={t.textTertiary} strokeOpacity={0.5} strokeDasharray="3 3" ifOverflow="hidden" /> : null}
        {children}
        {visible.map((s) =>
          s.area ?? area ? (
            <Area
              key={`a-${s.key}`}
              type={curve}
              dataKey={s.key}
              stroke="none"
              fill={`url(#${gid}-${s.key})`}
              isAnimationActive={morph}
              animationDuration={620}
              animationEasing="ease-out"
              activeDot={false}
              tooltipType="none"
            />
          ) : null,
        )}
        {visible.map((s, i) => {
          const c = colorOf(s, i);
          return (
            <Line
              key={s.key}
              type={curve}
              dataKey={s.key}
              name={s.label}
              stroke={c}
              strokeWidth={strokeW}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={s.dashed ? "4 4" : undefined}
              isAnimationActive={morph}
              animationDuration={620}
              animationEasing="ease-out"
              dot={(p: { cx?: number; cy?: number; index?: number }) =>
                p.index === lastIndex && i === 0 ? <LastDot key="last" cx={p.cx} cy={p.cy} color={c} live={live} hero={hero} halo={c === t.chartLine ? signColor : c} /> : <g key={`d${p.index}`} />
              }
              activeDot={(p: { cx?: number; cy?: number }) => <ActiveDot cx={p.cx} cy={p.cy} color={c} t={t} />}
            />
          );
        })}
        {tooltip ? (
          <Tooltip
            cursor={{ stroke: t.text, strokeOpacity: 0.35, strokeWidth: 1 }}
            isAnimationActive={false}
            offset={14}
            content={(p) => {
              const payload = ((p as unknown as { payload?: { dataKey?: unknown; value?: unknown }[] }).payload ?? []) as { dataKey?: unknown; value?: unknown }[];
              if (!p.active || !payload.length) return null;
              return (
                <ChartTooltip
                  privacy={t.privacy}
                  title={(fmtRef.current.xTooltipFormat ?? fmtRef.current.xFormat)((p as unknown as { label?: unknown }).label)}
                  rows={series.map((s, i) => {
                    const item = payload.find((it) => it.dataKey === s.key);
                    return { key: s.key, label: s.label, value: item ? fmtRef.current.fmt(Number(item.value)) : "—", color: colorOf(s, Math.max(0, visible.indexOf(s))) ?? seriesColor(t, i), dashed: s.dashed };
                  })}
                />
              );
            }}
          />
        ) : (
          <Tooltip cursor={{ stroke: t.text, strokeOpacity: 0.35, strokeWidth: 1 }} content={() => null} isAnimationActive={false} />
        )}
        {onScrub ? <ScrubReporter data={plotted} onScrub={(i) => onScrubRef.current?.(i === null ? null : data.indexOf(plotted[i]))} /> : null}
      </ComposedChart>
    );
    chartCache.current = { key: cacheKey, el };
    return el;
  };

  const summary = useMemo(() => {
    const s = visible[0];
    if (!s) return summaryLabel;
    return summarizeSeries(summaryLabel, data.map((d) => Number(d[s.key])), fmt, data[0] ? xFormat(data[0][x]) : undefined, data.length ? xFormat(data[data.length - 1][x]) : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, summaryLabel]);

  // Built lazily — only when "View as table" is opened (formatting every row × series on each render is costly).
  const seriesLabels = series.map((s) => `${s.key}\u0000${s.label}`).join("\u0001");
  const table = useMemo(
    () => (): ChartTable => {
      const { xFormat: xf, xTooltipFormat: xtf, fmt: f } = fmtRef.current;
      return {
        columns: [String(x), ...series.map((s) => s.label)],
        rows: data.map((d) => [(xtf ?? xf)(d[x]), ...series.map((s) => f(Number(d[s.key])))]),
        sensitiveCols: series.map((_, i) => i + 1),
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, seriesLabels, x],
  );

  return (
    <ChartFrame height={height} summary={summary} title={summaryLabel} loading={loading} empty={isEmpty} cached={cached} table={table} header={header} footer={footer} className={className} hero={hero}>
      {content}
    </ChartFrame>
  );
}
