import { useMemo, useState, type ReactNode } from "react";
import { Cell, Pie, PieChart, Sector } from "recharts";
import { assignCategorical } from "@/lib/hash";
import { summarizeParts } from "./a11y";
import { MASK, valueFormatter, type ValueFormat } from "./axis";
import { ChartFrame } from "./ChartFrame";
import { resolveColor, seriesColor, useChartTheme } from "./theme";

export interface DonutSlice {
  id: string;
  label: string;
  value: number;
  color?: string;
}

export interface DonutProps {
  data: DonutSlice[];
  size?: number;
  format?: ValueFormat;
  currency?: string;
  /** Centre caption under the total. */
  centerLabel?: ReactNode;
  /** Legend beside the ring. */
  legend?: boolean | "right" | "bottom";
  summaryLabel?: string;
  loading?: boolean;
  className?: string;
  onSliceClick?: (s: DonutSlice) => void;
}

/** Collapse to top 7 + "Other" beyond 8 categories (§3.5). */
export function topSlices(data: DonutSlice[]): DonutSlice[] {
  const sorted = [...data].filter((d) => d.value > 0).sort((a, b) => b.value - a.value);
  if (sorted.length <= 8) return sorted;
  const top = sorted.slice(0, 7);
  const rest = sorted.slice(7).reduce((s, d) => s + d.value, 0);
  return [...top, { id: "__other", label: "Other", value: rest }];
}

/**
 * Donut (§13.5): inner radius 68%, padding angle 1.5°, corner radius 4, total in the centre (22/28 600);
 * hovering a slice grows it by 4px; 700ms sweep entry.
 */
export function Donut({ data, size = 200, format = "money", currency = "USD", centerLabel = "Total", legend = "right", summaryLabel = "Breakdown", loading, className, onSliceClick }: DonutProps) {
  const t = useChartTheme();
  const [active, setActive] = useState<number | null>(null);
  const fmt = valueFormatter(format, currency);
  const slices = useMemo(() => topSlices(data), [data]);
  const colors = useMemo(() => assignCategorical(slices.filter((s) => s.id !== "__other").map((s) => s.id)), [slices]);
  const colorOf = (s: DonutSlice) => resolveColor(s.color) ?? (s.id === "__other" ? t.other : seriesColor(t, colors.get(s.id) ?? 0));
  const total = slices.reduce((s, d) => s + d.value, 0);
  const shown = active !== null ? slices[active] : null;
  const outer = size / 2 - 6;

  const ring = (
    <div className="relative flex-none" style={{ width: size, height: size }}>
      <PieChart width={size} height={size} accessibilityLayer>
        <Pie
          data={slices}
          dataKey="value"
          nameKey="label"
          cx="50%"
          cy="50%"
          innerRadius={outer * 0.68}
          outerRadius={outer}
          paddingAngle={slices.length > 1 ? 1.5 : 0}
          cornerRadius={4}
          startAngle={90}
          endAngle={-270}
          stroke="none"
          isAnimationActive={!t.reducedMotion}
          animationBegin={0}
          animationDuration={700}
          animationEasing="ease-out"
          onMouseEnter={(_, i) => setActive(i)}
          onMouseLeave={() => setActive(null)}
          onClick={onSliceClick ? (_, i) => onSliceClick(slices[i]) : undefined}
          shape={(p: unknown) => {
            const props = p as { index: number; outerRadius: number } & Record<string, unknown>;
            const on = active === props.index;
            return (
              <Sector
                {...(props as object)}
                outerRadius={props.outerRadius + (on ? 4 : 0)}
                fillOpacity={active !== null && !on ? 0.55 : 1}
                style={{ transition: "fill-opacity 160ms cubic-bezier(.2,0,0,1)", cursor: onSliceClick ? "pointer" : undefined }}
              />
            );
          }}
        >
          {slices.map((s) => (
            <Cell key={s.id} fill={colorOf(s)} />
          ))}
        </Pie>
      </PieChart>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none text-center px-6">
        <span className="text-caption text-tertiary truncate max-w-full" style={{ fontWeight: 500 }}>
          {shown ? shown.label : centerLabel}
        </span>
        <span className="tabular" style={{ fontSize: 22, lineHeight: "28px", fontWeight: 600, letterSpacing: "-0.015em" }}>
          {t.privacy ? MASK : fmt(shown ? shown.value : total)}
        </span>
        {shown && total ? <span className="text-caption text-secondary tabular">{((shown.value / total) * 100).toFixed(1)}%</span> : null}
      </div>
    </div>
  );

  const legendEl = legend ? (
    <ul className="flex flex-col gap-1 min-w-0 flex-1 m-0 p-0 list-none">
      {slices.map((s, i) => (
        <li
          key={s.id}
          className="flex items-center gap-2 h-7 px-2 -mx-2 rounded-md text-body-sm transition-[opacity,background-color] duration-150"
          style={{ opacity: active !== null && active !== i ? 0.45 : 1, background: active === i ? "var(--state-hover)" : undefined }}
          onMouseEnter={() => setActive(i)}
          onMouseLeave={() => setActive(null)}
        >
          <span className="w-2 h-2 rounded-[2px] flex-none" style={{ background: colorOf(s) }} />
          <span className="truncate flex-1">{s.label}</span>
          <span className="tabular text-secondary" data-sensitive="" data-align="end">
            {fmt(s.value)}
          </span>
          <span className="tabular text-tertiary w-10 text-right">{total ? Math.round((s.value / total) * 100) : 0}%</span>
        </li>
      ))}
    </ul>
  ) : null;

  return (
    <ChartFrame
      height={legend === "bottom" ? size + slices.length * 28 + 12 : size}
      summary={summarizeParts(summaryLabel, slices.map((s) => ({ name: s.label, value: s.value })), fmt)}
      loading={loading}
      empty={slices.length === 0 ? "No spending yet this month" : false}
      className={className}
      table={{ columns: ["Category", "Amount", "Share"], rows: slices.map((s) => [s.label, fmt(s.value), total ? `${((s.value / total) * 100).toFixed(1)}%` : "0%"]), sensitiveCols: [1] }}
    >
      {() => <div className={legend === "bottom" ? "flex flex-col items-center gap-3" : "flex items-center gap-6 h-full"}>{ring}{legendEl}</div>}
    </ChartFrame>
  );
}
