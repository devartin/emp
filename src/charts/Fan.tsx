import { useMemo, type ReactNode } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { MARGIN, X_AXIS_HEIGHT, edgeAwareTick, niceDomain, tickFormatter, tickStyle, valueFormatter, type ValueFormat } from "./axis";
import { ChartFrame } from "./ChartFrame";
import { useChartTheme } from "./theme";
import { ChartTooltip } from "./Tooltip";

export interface FanPoint {
  x: string | number;
  /** Historical actual (solid line). */
  actual?: number;
  p10?: number;
  p25?: number;
  p50?: number;
  p75?: number;
  p90?: number;
}

export interface FanChartProps {
  data: FanPoint[];
  height?: number;
  format?: ValueFormat;
  currency?: string;
  xFormat?: (v: unknown) => string;
  /** Goal / target line. */
  target?: { value: number; label: string };
  summaryLabel?: string;
  loading?: boolean;
  header?: ReactNode;
  className?: string;
}

/**
 * Fan chart for projections (§13.5): history solid; median dashed 4 4; p10–p90 band at .08 and p25–p75 at .14;
 * monotoneX curves; y-axis on the right.
 */
export function FanChart({ data, height = 260, format = "money", currency = "USD", xFormat = (v) => String(v), target, summaryLabel = "Projection", loading, header, className }: FanChartProps) {
  const t = useChartTheme();
  const fmt = valueFormatter(format, currency);
  const animate = false;
  const rows = useMemo(
    () =>
      data.map((d) => ({
        ...d,
        outer: d.p10 !== undefined && d.p90 !== undefined ? [d.p10, d.p90] : undefined,
        inner: d.p25 !== undefined && d.p75 !== undefined ? [d.p25, d.p75] : undefined,
      })),
    [data],
  );
  const lastActual = [...data].reverse().find((d) => d.actual !== undefined);
  const lastProj = data[data.length - 1];
  const summary = `${summaryLabel}: from ${lastActual ? fmt(lastActual.actual ?? 0) : "—"} today to a median of ${fmt(lastProj?.p50 ?? 0)} (range ${fmt(lastProj?.p10 ?? 0)} to ${fmt(lastProj?.p90 ?? 0)}) by ${xFormat(lastProj?.x)}.`;
  return (
    <ChartFrame
      height={height}
      summary={summary}
      loading={loading}
      empty={data.length < 2}
      header={header}
      className={className}
      table={{ columns: ["Period", "Actual", "P10", "Median", "P90"], rows: data.map((d) => [xFormat(d.x), d.actual !== undefined ? fmt(d.actual) : "—", d.p10 !== undefined ? fmt(d.p10) : "—", d.p50 !== undefined ? fmt(d.p50) : "—", d.p90 !== undefined ? fmt(d.p90) : "—"]), sensitiveCols: [1, 2, 3, 4] }}
    >
      {(size) => {
        const vals = data.flatMap((d) => [d.actual, d.p10, d.p90, d.p50].filter((v): v is number => v !== undefined));
        if (target) vals.push(target.value);
        const { domain, ticks } = niceDomain(vals);
        const tf = tickFormatter(format, currency, t.privacy);
        const yW = Math.max(28, Math.max(...ticks.map((v) => tf(v).length)) * 6.6 + 10);
        return (
          <ComposedChart width={size.width} height={size.height} data={rows} margin={MARGIN} accessibilityLayer>
            <CartesianGrid vertical={false} stroke={t.grid} />
            <XAxis dataKey="x" tickLine={false} axisLine={false} tick={edgeAwareTick(t, xFormat, size.width)} tickFormatter={(v) => xFormat(v)} height={X_AXIS_HEIGHT} tickMargin={8} minTickGap={28} interval="preserveStartEnd" />
            <YAxis orientation="right" width={yW} axisLine={false} tickLine={false} tick={tickStyle(t)} ticks={ticks} domain={domain} tickFormatter={tf} />
            {target ? (
              <ReferenceLine
                y={target.value}
                stroke={t.textSecondary}
                strokeOpacity={0.6}
                strokeDasharray="2 3"
                label={{ value: target.label, position: "insideTopLeft", fontSize: 11, fill: t.textSecondary, fontFamily: t.fontFamily }}
              />
            ) : null}
            <Area type="monotoneX" dataKey="outer" stroke="none" fill={t.accent} fillOpacity={0.08} isAnimationActive={animate} activeDot={false} connectNulls={false} />
            <Area type="monotoneX" dataKey="inner" stroke="none" fill={t.accent} fillOpacity={0.14} isAnimationActive={animate} activeDot={false} connectNulls={false} />
            <Line type="monotoneX" dataKey="p50" stroke={t.accent} strokeWidth={2} strokeDasharray="4 4" dot={false} isAnimationActive={animate} activeDot={{ r: 4, fill: t.accent, stroke: t.canvas, strokeWidth: 2 }} />
            <Line type="monotoneX" dataKey="actual" stroke={t.text} strokeWidth={2} dot={false} isAnimationActive={animate} activeDot={{ r: 4, fill: t.text, stroke: t.canvas, strokeWidth: 2 }} connectNulls={false} />
            <Tooltip
              cursor={{ stroke: t.textTertiary, strokeOpacity: 0.5, strokeDasharray: "3 3" }}
              isAnimationActive={false}
              offset={14}
              content={(p) => {
                const pp = p as unknown as { active?: boolean; payload?: { payload?: FanPoint }[]; label?: unknown };
                const d = pp.payload?.[0]?.payload;
                if (!pp.active || !d) return null;
                const rowsT = [
                  ...(d.actual !== undefined ? [{ key: "a", label: "Actual", value: fmt(d.actual), color: t.text }] : []),
                  ...(d.p50 !== undefined ? [{ key: "m", label: "Median", value: fmt(d.p50), color: t.accent, dashed: true }] : []),
                  ...(d.p90 !== undefined ? [{ key: "h", label: "Optimistic (p90)", value: fmt(d.p90), muted: true }] : []),
                  ...(d.p10 !== undefined ? [{ key: "l", label: "Cautious (p10)", value: fmt(d.p10), muted: true }] : []),
                ];
                return <ChartTooltip privacy={t.privacy} title={xFormat(pp.label)} rows={rowsT} />;
              }}
            />
          </ComposedChart>
        );
      }}
    </ChartFrame>
  );
}
