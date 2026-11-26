import { useMemo, useState, type ReactNode } from "react";
import { Bar, BarChart as RBarChart, CartesianGrid, Rectangle, Tooltip, XAxis, YAxis } from "recharts";
import { summarizeParts } from "./a11y";
import { MARGIN, X_AXIS_HEIGHT, niceDomain, tickFormatter, tickStyle, valueFormatter, type ValueFormat } from "./axis";
import { ChartFrame } from "./ChartFrame";
import { defaultSeriesColor, resolveColor, useChartTheme } from "./theme";
import { ChartTooltip } from "./Tooltip";
import type { Datum } from "./Line";

export interface BarSeries {
  key: string;
  label: string;
  color?: string;
  /** Expenses render in --text-secondary at .5 (§13.5). */
  kind?: "default" | "expense";
}

export interface BarChartProps<T extends Datum> {
  data: T[];
  x: keyof T & string;
  series: BarSeries[];
  height?: number;
  stacked?: boolean;
  /** Horizontal bars (ranked lists). */
  horizontal?: boolean;
  format?: ValueFormat;
  currency?: string;
  xFormat?: (v: unknown) => string;
  yAxis?: "left" | "right" | "none";
  /** Colour each bar by its sign (gain/loss) — single series only. */
  colorBySign?: boolean;
  summaryLabel?: string;
  loading?: boolean;
  empty?: boolean | string;
  cached?: boolean | string;
  header?: ReactNode;
  className?: string;
  onBarClick?: (row: T, index: number) => void;
}

/**
 * Bar chart (§13.5): radius [4,4,0,0], max width 28, category gap 30%, bar gap 4; scaleY entry staggered 25ms
 * (≤300ms total); hovering a group dims the others to .35.
 */
export function BarChart<T extends Datum>({
  data,
  x,
  series,
  height = 220,
  stacked,
  horizontal,
  format = "money",
  currency = "USD",
  xFormat = (v) => String(v),
  yAxis = "left",
  colorBySign,
  summaryLabel = "Bar chart",
  loading,
  empty,
  cached,
  header,
  className,
  onBarClick,
}: BarChartProps<T>) {
  const t = useChartTheme();
  const [hover, setHover] = useState<number | null>(null);
  const fmt = valueFormatter(format, currency);
  const colorOf = (s: BarSeries, i: number) => (s.kind === "expense" ? t.textSecondary : (resolveColor(s.color) ?? defaultSeriesColor(t, i, series.length)));
  const opacityOf = (s: BarSeries) => (s.kind === "expense" ? 0.5 : 1);

  const summary = useMemo(
    () => summarizeParts(summaryLabel, data.map((d) => ({ name: xFormat(d[x]), value: series.reduce((sum, s) => sum + (Number(d[s.key]) || 0), 0) })), fmt),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, series, summaryLabel],
  );
  const table = useMemo(
    () => () => ({ columns: [String(x), ...series.map((s) => s.label)], rows: data.map((d) => [xFormat(d[x]), ...series.map((s) => fmt(Number(d[s.key])))]), sensitiveCols: series.map((_, i) => i + 1) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, series],
  );

  return (
    <ChartFrame height={height} summary={summary} title={summaryLabel} loading={loading} empty={empty ?? data.length === 0} cached={cached} table={table} header={header} className={className}>
      {(size) => {
        const vals: number[] = [];
        for (const d of data) {
          if (stacked) {
            let pos = 0;
            let neg = 0;
            for (const s of series) {
              const v = Number(d[s.key]) || 0;
              if (v >= 0) pos += v;
              else neg += v;
            }
            vals.push(pos, neg);
          } else for (const s of series) vals.push(Number(d[s.key]) || 0);
        }
        const { domain, ticks } = niceDomain(vals, { includeZero: true });
        const tf = tickFormatter(format, currency, t.privacy);
        const yW = yAxis === "none" ? 0 : Math.max(28, Math.max(...ticks.map((v) => tf(v).length)) * 6.6 + 10);
        const catAxis = (
          <XAxis
            key="cat"
            type="category"
            dataKey={x as string as never}
            tickLine={false}
            axisLine={false}
            tick={tickStyle(t)}
            tickFormatter={(v) => xFormat(v)}
            height={X_AXIS_HEIGHT}
            tickMargin={8}
            interval="preserveStartEnd"
            minTickGap={16}
          />
        );
        const valAxis = (
          <YAxis
            key="val"
            type="number"
            hide={yAxis === "none"}
            orientation={yAxis === "right" ? "right" : "left"}
            width={yW}
            axisLine={false}
            tickLine={false}
            tick={tickStyle(t)}
            ticks={ticks}
            domain={domain}
            tickFormatter={tf}
          />
        );
        return (
          <RBarChart
            width={size.width}
            height={size.height}
            data={data}
            margin={MARGIN}
            layout={horizontal ? "vertical" : "horizontal"}
            barCategoryGap="30%"
            barGap={4}
            maxBarSize={28}
            accessibilityLayer
            onMouseMove={(st) => setHover(st.activeTooltipIndex == null ? null : Number(st.activeTooltipIndex))}
            onMouseLeave={() => setHover(null)}
          >
            <CartesianGrid vertical={!!horizontal} horizontal={!horizontal} stroke={t.grid} />
            {horizontal ? (
              <>
                <XAxis type="number" hide domain={domain} />
                <YAxis type="category" dataKey={x as string as never} width={96} axisLine={false} tickLine={false} tick={tickStyle(t)} tickFormatter={(v) => xFormat(v)} />
              </>
            ) : (
              [catAxis, valAxis]
            )}
            {series.map((s, si) => {
              const top = !stacked || si === series.length - 1;
              const radius: [number, number, number, number] = horizontal ? (top ? [0, 4, 4, 0] : [0, 0, 0, 0]) : top ? [4, 4, 0, 0] : [0, 0, 0, 0];
              return (
                <Bar
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  stackId={stacked ? "s" : undefined}
                  isAnimationActive={false}
                  onClick={onBarClick ? (_: unknown, i: number) => onBarClick(data[i], i) : undefined}
                  shape={(p: unknown) => {
                    const props = p as { index: number; value?: number | number[]; x: number; y: number; width: number; height: number };
                    const v = Array.isArray(props.value) ? props.value[1] - props.value[0] : Number(props.value);
                    const fill = colorBySign ? (v >= 0 ? t.gain : t.loss) : colorOf(s, si);
                    const dim = hover !== null && hover !== props.index;
                    return (
                      <Rectangle
                        {...(props as object)}
                        radius={v < 0 && !horizontal ? [0, 0, 4, 4] : radius}
                        fill={fill}
                        fillOpacity={opacityOf(s) * (dim ? 0.35 : 1)}
                        className={horizontal ? "emp-grow-x" : "emp-grow"}
                        style={{ ["--i" as string]: props.index, transition: "fill-opacity 160ms cubic-bezier(.2,0,0,1)", cursor: onBarClick ? "pointer" : undefined }}
                      />
                    );
                  }}
                  activeBar={false}
                />
              );
            })}
            <Tooltip
              cursor={false}
              isAnimationActive={false}
              offset={14}
              content={(p) => {
                const pp = p as unknown as { active?: boolean; payload?: { dataKey?: unknown; value?: unknown }[]; label?: unknown };
                if (!pp.active || !pp.payload?.length) return null;
                return (
                  <ChartTooltip
                    privacy={t.privacy}
                    title={xFormat(pp.label)}
                    rows={series.map((s, i) => {
                      const it = pp.payload?.find((q) => q.dataKey === s.key);
                      return { key: s.key, label: s.label, value: it ? fmt(Number(it.value)) : "—", color: colorOf(s, i) };
                    })}
                  />
                );
              }}
            />
          </RBarChart>
        );
      }}
    </ChartFrame>
  );
}
