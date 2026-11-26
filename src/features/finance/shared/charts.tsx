/**
 * Finance-specific chart compositions on the shared chart kit (§13.5 tokens, ChartFrame states, tooltip card):
 * a stacked area (debt payoff, net-worth composition) and a diverging bar list (allocation drift).
 */
import { useId, useMemo, type ReactNode } from "react";
import { Area, AreaChart, CartesianGrid, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { MARGIN, X_AXIS_HEIGHT, niceDomain, tickFormatter, tickStyle, valueFormatter, type ValueFormat } from "@/charts/axis";
import { ChartFrame } from "@/charts/ChartFrame";
import { ChartTooltip } from "@/charts/Tooltip";
import { seriesColor, useChartTheme } from "@/charts/theme";

export interface StackSeries {
  key: string;
  label: string;
  color?: string;
}

export function StackedAreaChart<T extends Record<string, unknown>>({
  data,
  x,
  series,
  height = 240,
  format = "money",
  xFormat = (v) => String(v),
  summary,
  loading,
  header,
  marker,
  curve = "monotoneX",
}: {
  data: T[];
  x: keyof T & string;
  series: StackSeries[];
  height?: number;
  format?: ValueFormat;
  xFormat?: (v: unknown) => string;
  summary: string;
  loading?: boolean;
  header?: ReactNode;
  marker?: { x: unknown; label: string };
  curve?: "monotoneX" | "stepAfter" | "linear";
}) {
  const t = useChartTheme();
  const gid = useId().replace(/:/g, "");
  const fmt = valueFormatter(format);
  const colorOf = (s: StackSeries, i: number) => s.color ?? seriesColor(t, i);
  const totals = useMemo(() => data.map((d) => series.reduce((a, s) => a + (Number(d[s.key]) || 0), 0)), [data, series]);
  return (
    <ChartFrame
      height={height}
      summary={summary}
      loading={loading}
      empty={data.length < 2}
      header={header}
      table={{ columns: [String(x), ...series.map((s) => s.label)], rows: data.map((d) => [xFormat(d[x]), ...series.map((s) => fmt(Number(d[s.key]) || 0))]), sensitiveCols: series.map((_, i) => i + 1) }}
    >
      {(size) => {
        const { domain, ticks } = niceDomain([0, ...totals], { includeZero: true });
        const tf = tickFormatter(format, "USD", t.privacy);
        const yW = Math.max(28, Math.max(...ticks.map((v) => tf(v).length)) * 6.6 + 10);
        return (
          <AreaChart width={size.width} height={size.height} data={data} margin={MARGIN} accessibilityLayer>
            <defs>
              {series.map((s, i) => (
                <linearGradient key={s.key} id={`${gid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={colorOf(s, i)} stopOpacity={t.dark ? 0.55 : 0.45} />
                  <stop offset="100%" stopColor={colorOf(s, i)} stopOpacity={t.dark ? 0.2 : 0.14} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid vertical={false} stroke={t.grid} />
            <XAxis dataKey={x as string} tickLine={false} axisLine={false} tick={tickStyle(t)} tickFormatter={(v) => xFormat(v)} height={X_AXIS_HEIGHT} tickMargin={8} minTickGap={40} interval="preserveStartEnd" />
            <YAxis orientation="right" width={yW} axisLine={false} tickLine={false} tick={tickStyle(t)} ticks={ticks} domain={domain} tickFormatter={tf} />
            {marker ? <ReferenceLine x={marker.x as string} stroke={t.textTertiary} strokeDasharray="3 3" label={{ value: marker.label, position: "insideTopRight", fontSize: 11, fill: t.textSecondary, fontFamily: t.fontFamily }} /> : null}
            {series.map((s, i) => (
              <Area key={s.key} type={curve} dataKey={s.key} name={s.label} stackId="1" stroke={colorOf(s, i)} strokeWidth={1.5} fill={`url(#${gid}-${s.key})`} isAnimationActive={!t.reducedMotion} animationDuration={700} animationEasing="ease-out" activeDot={{ r: 4, fill: colorOf(s, i), stroke: t.canvas, strokeWidth: 2 }} />
            ))}
            <Tooltip
              cursor={{ stroke: t.textTertiary, strokeOpacity: 0.5, strokeDasharray: "3 3" }}
              isAnimationActive={false}
              content={(p) => {
                const pp = p as unknown as { active?: boolean; label?: unknown; payload?: { dataKey?: string; value?: number }[] };
                if (!pp.active || !pp.payload?.length) return null;
                const total = pp.payload.reduce((a, r) => a + (Number(r.value) || 0), 0);
                return (
                  <ChartTooltip
                    privacy={t.privacy}
                    title={xFormat(pp.label)}
                    rows={series
                      .map((s, i) => ({ key: s.key, label: s.label, value: fmt(Number(pp.payload!.find((r) => r.dataKey === s.key)?.value ?? 0)), color: colorOf(s, i) }))
                      .reverse()}
                    footer={<span className="flex justify-between gap-4"><span>Total</span><span className="tabular">{t.privacy ? "•••" : fmt(total)}</span></span>}
                  />
                );
              }}
            />
          </AreaChart>
        );
      }}
    </ChartFrame>
  );
}

/** Horizontal diverging bars around zero (drift in pp, budget variance). */
export function DivergingBars({ rows, max, format }: { rows: { key: string; label: ReactNode; value: number; outside?: boolean; note?: ReactNode }[]; max?: number; format: (v: number) => string }) {
  const m = max ?? Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  return (
    <div className="fh-div" role="list">
      {rows.map((r) => {
        const w = Math.min(1, Math.abs(r.value) / m) * 50;
        return (
          <div key={r.key} className="fh-div-row" role="listitem">
            <span className="fh-div-label">{r.label}</span>
            <span className="fh-div-track">
              <span className="fh-div-mid" />
              <span className="fh-div-bar" data-dir={r.value >= 0 ? "pos" : "neg"} data-out={r.outside ? "" : undefined} style={r.value >= 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }} />
            </span>
            <span className="fh-div-val tabular" data-out={r.outside ? "" : undefined}>
              {format(r.value)}
            </span>
            {r.note ? <span className="fh-div-note">{r.note}</span> : null}
          </div>
        );
      })}
    </div>
  );
}
