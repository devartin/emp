import { useMemo, useRef } from "react";
import { Bar, BarChart, CartesianGrid, Rectangle, Tooltip, XAxis, YAxis } from "recharts";
import { MARGIN, X_AXIS_HEIGHT, niceDomain, tickFormatter, tickStyle, valueFormatter, type ValueFormat } from "./axis";
import { ChartFrame } from "./ChartFrame";
import { useChartTheme } from "./theme";
import { ChartTooltip } from "./Tooltip";

export interface WaterfallStep {
  label: string;
  /** Delta for steps; ignored for totals (computed). */
  value: number;
  /** Render a total bar from zero to the running sum. */
  total?: boolean;
}

export interface WaterfallProps {
  steps: WaterfallStep[];
  height?: number;
  format?: ValueFormat;
  currency?: string;
  /** Up is bad (expense bridges). */
  invert?: boolean;
  summaryLabel?: string;
  loading?: boolean;
  className?: string;
}

interface Row {
  label: string;
  base: number;
  size: number;
  delta: number;
  end: number;
  total: boolean;
}

/** Waterfall / bridge chart: floating deltas (gain/loss), neutral totals, dashed connectors between steps. */
export function Waterfall({ steps, height = 240, format = "money", currency = "USD", invert, summaryLabel = "Waterfall", loading, className }: WaterfallProps) {
  const t = useChartTheme();
  const fmt = valueFormatter(format, currency);
  const rows: Row[] = useMemo(() => {
    let run = 0;
    return steps.map((s) => {
      if (s.total) return { label: s.label, base: Math.min(0, run), size: Math.abs(run), delta: run, end: run, total: true };
      const start = run;
      run += s.value;
      return { label: s.label, base: Math.min(start, run), size: Math.abs(s.value), delta: s.value, end: run, total: false };
    });
  }, [steps]);
  const geo = useRef<{ right: number; endY: number }[]>([]);
  const summary = `${summaryLabel}: ${rows.map((r) => `${r.label} ${r.total ? "" : r.delta >= 0 ? "+" : "−"}${fmt(Math.abs(r.delta))}`).join(", ")}.`;

  return (
    <ChartFrame
      height={height}
      summary={summary}
      loading={loading}
      empty={steps.length === 0}
      className={className}
      table={{ columns: ["Step", "Change", "Running total"], rows: rows.map((r) => [r.label, r.total ? "—" : fmt(r.delta), fmt(r.end)]), sensitiveCols: [1, 2] }}
    >
      {(size) => {
        const { domain, ticks } = niceDomain(rows.flatMap((r) => [r.base, r.base + r.size]), { includeZero: true });
        const tf = tickFormatter(format, currency, t.privacy);
        const yW = Math.max(28, Math.max(...ticks.map((v) => tf(v).length)) * 6.6 + 10);
        geo.current = [];
        return (
          <BarChart width={size.width} height={size.height} data={rows} margin={MARGIN} barCategoryGap="30%" maxBarSize={44} accessibilityLayer>
            <CartesianGrid vertical={false} stroke={t.grid} />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tick={tickStyle(t)}
              height={X_AXIS_HEIGHT}
              tickMargin={8}
              interval={0}
              tickFormatter={(v: string) => {
                const max = Math.max(3, Math.floor((size.width - yW) / rows.length / 6.4));
                return v.length > max ? v.slice(0, max - 1) + "…" : v;
              }}
            />
            <YAxis width={yW} axisLine={false} tickLine={false} tick={tickStyle(t)} ticks={ticks} domain={domain} tickFormatter={tf} />
            <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} activeBar={false} />
            <Bar
              dataKey="size"
              stackId="w"
              isAnimationActive={false}
              activeBar={false}
              shape={(p: unknown) => {
                const props = p as { index: number; x: number; y: number; width: number; height: number; payload: Row };
                const r = props.payload;
                const up = r.delta >= 0;
                const good = up !== !!invert;
                const fill = r.total ? t.textSecondary : good ? t.gain : t.loss;
                const endY = r.total ? props.y : up ? props.y : props.y + props.height;
                const prev = geo.current[props.index - 1];
                geo.current[props.index] = { right: props.x + props.width, endY };
                const startY = r.total ? props.y : up ? props.y + props.height : props.y;
                return (
                  <g>
                    {prev ? (
                      <line x1={prev.right} x2={props.x} y1={prev.endY} y2={r.total ? prev.endY : startY} stroke={t.textTertiary} strokeOpacity={0.6} strokeDasharray="2 2" className="emp-fade-enter" />
                    ) : null}
                    <Rectangle
                      {...(props as object)}
                      height={Math.max(1, props.height)}
                      radius={4}
                      fill={fill}
                      fillOpacity={r.total ? 0.55 : 1}
                      className="emp-grow"
                      style={{ ["--i" as string]: props.index }}
                    />
                  </g>
                );
              }}
            />
            <Tooltip
              cursor={{ fill: t.grid }}
              isAnimationActive={false}
              content={(p) => {
                const pp = p as unknown as { active?: boolean; payload?: { payload?: Row }[] };
                const r = pp.payload?.[0]?.payload;
                if (!pp.active || !r) return null;
                return (
                  <ChartTooltip
                    privacy={t.privacy}
                    title={r.label}
                    rows={[
                      ...(r.total ? [] : [{ key: "d", label: "Change", value: (r.delta >= 0 ? "+" : "") + fmt(r.delta), color: (r.delta >= 0) !== !!invert ? t.gain : t.loss }]),
                      { key: "e", label: r.total ? "Total" : "Running total", value: fmt(r.end) },
                    ]}
                  />
                );
              }}
            />
          </BarChart>
        );
      }}
    </ChartFrame>
  );
}
