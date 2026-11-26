import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Area, CartesianGrid, ComposedChart, Line, ReferenceLine, Tooltip, XAxis, YAxis, useActiveTooltipDataPoints, useIsTooltipActive,
} from "recharts";
import { lttb } from "@/lib/lttb";
import { summarizeSeries } from "./a11y";
import { MARGIN, X_AXIS_HEIGHT, edgeAwareTick, niceDomain, tickFormatter, tickStyle, valueFormatter, type ValueFormat } from "./axis";
import { ChartFrame, type ChartTable } from "./ChartFrame";
import { resolveColor, useChartTheme, seriesColor, type ChartTheme } from "./theme";
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
  /** Single-series value charts colour by sign of last − first (default when one series). */
  colorBySign?: boolean;
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

function ActiveDot({ cx, cy, color, t }: { cx?: number; cy?: number; color: string; t: ChartTheme }) {
  if (cx === undefined || cy === undefined) return null;
  return (
    <g>
      <circle cx={cx} cy={cy} r={8} fill={color} fillOpacity={0.2} />
      <circle cx={cx} cy={cy} r={4} fill={color} stroke={t.canvas} strokeWidth={2} />
    </g>
  );
}

function LastDot({ cx, cy, color, live }: { cx?: number; cy?: number; color: string; live?: boolean }) {
  if (cx === undefined || cy === undefined) return null;
  return (
    <g>
      {live ? <circle className="emp-live-halo" cx={cx} cy={cy} r={3} fill={color} /> : null}
      <circle cx={cx} cy={cy} r={3} fill={color} />
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
  const colorOf = (s: SeriesDef, i: number) => resolveColor(s.color) ?? (bySign ? signColor : seriesColor(t, i));

  const isEmpty = empty ?? data.length < 2;
  const fmt = valueFormatter(format, currency);

  const content = (size: { width: number; height: number }) => {
    // Decimate above 2× pixel width (Rust does this for real data; this protects ad-hoc callers).
    const maxPts = Math.max(64, size.width * 2);
    const plotted = data.length > maxPts && visible.length === 1 ? lttb(data, maxPts, (_d, i) => i, (d) => Number(d[visible[0].key])) : data;
    const values: number[] = [];
    for (const d of plotted) for (const s of series) values.push(Number(d[s.key]));
    if (extraDomainValues) values.push(...extraDomainValues);
    const { domain, ticks } = niceDomain(values, { includeZero });
    const tf = tickFormatter(format, currency, t.privacy);
    const yWidth = yAxis === "none" ? 0 : axisWidth(ticks.map(tf));
    const lastIndex = plotted.length - 1;
    const morph = animate && plotted.length <= 500 && !t.reducedMotion;
    const strokeW = visible.length > 2 ? 1.5 : 2;
    // One tick per distinct label (months on daily data), thinned to ≥64px apart (§13.5).
    let xTicks: unknown[] | undefined;
    {
      const firsts: unknown[] = [];
      let prev = "";
      for (const d of plotted) {
        const l = xFormat(d[x]);
        if (l !== prev) firsts.push(d[x]);
        prev = l;
      }
      if (firsts.length < plotted.length) {
        const cap = Math.max(2, Math.floor((size.width - yWidth) / 64));
        const step = Math.ceil(firsts.length / cap);
        xTicks = firsts.filter((_, i) => i % step === 0);
      }
    }

    return (
      <ComposedChart width={size.width} height={size.height} data={plotted} margin={MARGIN} accessibilityLayer>
        <defs>
          {visible.map((s, i) => (
            <linearGradient key={s.key} id={`${gid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colorOf(s, i)} stopOpacity={t.areaTop} />
              <stop offset="100%" stopColor={colorOf(s, i)} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid vertical={false} stroke={t.grid} />
        <XAxis
          dataKey={x as string as never}
          tickLine={false}
          axisLine={false}
          tick={edgeAwareTick(t, xFormat, size.width)}
          tickFormatter={(v) => xFormat(v)}
          height={X_AXIS_HEIGHT}
          tickMargin={8}
          minTickGap={28}
          ticks={xTicks as never}
          interval={xTicks ? 0 : "preserveStartEnd"}
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
              animationDuration={400}
              animationEasing="ease-in-out"
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
              animationDuration={400}
              animationEasing="ease-in-out"
              dot={(p: { cx?: number; cy?: number; index?: number }) =>
                p.index === lastIndex && i === 0 ? <LastDot key="last" cx={p.cx} cy={p.cy} color={c} live={live} /> : <g key={`d${p.index}`} />
              }
              activeDot={(p: { cx?: number; cy?: number }) => <ActiveDot cx={p.cx} cy={p.cy} color={c} t={t} />}
            />
          );
        })}
        {tooltip ? (
          <Tooltip
            cursor={{ stroke: t.textTertiary, strokeOpacity: 0.5, strokeDasharray: "3 3", strokeWidth: 1 }}
            isAnimationActive={false}
            offset={14}
            content={(p) => {
              const payload = ((p as unknown as { payload?: { dataKey?: unknown; value?: unknown }[] }).payload ?? []) as { dataKey?: unknown; value?: unknown }[];
              if (!p.active || !payload.length) return null;
              return (
                <ChartTooltip
                  privacy={t.privacy}
                  title={(xTooltipFormat ?? xFormat)((p as unknown as { label?: unknown }).label)}
                  rows={series.map((s, i) => {
                    const item = payload.find((it) => it.dataKey === s.key);
                    return { key: s.key, label: s.label, value: item ? fmt(Number(item.value)) : "—", color: colorOf(s, Math.max(0, visible.indexOf(s))) ?? seriesColor(t, i), dashed: s.dashed };
                  })}
                />
              );
            }}
          />
        ) : (
          <Tooltip cursor={{ stroke: t.textTertiary, strokeOpacity: 0.5, strokeDasharray: "3 3" }} content={() => null} isAnimationActive={false} />
        )}
        {onScrub ? <ScrubReporter data={plotted} onScrub={(i) => onScrub(i === null ? null : data.indexOf(plotted[i]))} /> : null}
      </ComposedChart>
    );
  };

  const summary = useMemo(() => {
    const s = visible[0];
    if (!s) return summaryLabel;
    return summarizeSeries(summaryLabel, data.map((d) => Number(d[s.key])), fmt, data[0] ? xFormat(data[0][x]) : undefined, data.length ? xFormat(data[data.length - 1][x]) : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, summaryLabel]);

  const table: ChartTable = useMemo(
    () => ({
      columns: [String(x), ...series.map((s) => s.label)],
      rows: data.map((d) => [(xTooltipFormat ?? xFormat)(d[x]), ...series.map((s) => fmt(Number(d[s.key])))]),
      sensitiveCols: series.map((_, i) => i + 1),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, series],
  );

  return (
    <ChartFrame height={height} summary={summary} loading={loading} empty={isEmpty} cached={cached} table={table} header={header} footer={footer} className={className}>
      {content}
    </ChartFrame>
  );
}
