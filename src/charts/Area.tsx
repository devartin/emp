import { useMemo, useState, type ReactNode } from "react";
import { DeltaPill } from "@/ui/DeltaPill";
import { RollingNumber } from "@/ui/motion/RollingNumber";
import { valueFormatter } from "./axis";
import { LineChart, type Datum, type LineChartProps } from "./Line";

/** Area chart: LineChart with the gradient fill (series colour .22 → 0, .30 in dark) (§13.5). */
export function AreaChart<T extends Datum>(props: LineChartProps<T>) {
  return <LineChart {...props} area />;
}

export interface HeroAreaChartProps<T extends Datum> extends Omit<LineChartProps<T>, "series" | "header" | "onScrub" | "tooltip"> {
  /** The plotted value key. */
  y: keyof T & string;
  label: ReactNode;
  /** Formats the x value under the readout while scrubbing. */
  xReadout?: (v: unknown) => string;
  /** Right side of the header (range segmented control). */
  actions?: ReactNode;
  /** Label for the delta while not scrubbing ("past year"). */
  periodLabel?: string;
}

/**
 * Hero chart with the header-readout pattern (§13.5): while scrubbing, the KPI above the chart shows the hovered value
 * (rolling digits) and its change from the start; on leave it reverts.
 */
export function HeroAreaChart<T extends Datum>({ y, label, xReadout, actions, periodLabel = "this period", format = "money", currency = "USD", ...rest }: HeroAreaChartProps<T>) {
  const [idx, setIdx] = useState<number | null>(null);
  const data = rest.data;
  const firstVal = Number(data[0]?.[y] ?? 0);
  const i = idx ?? data.length - 1;
  const cur = Number(data[i]?.[y] ?? 0);
  const fmt = useMemo(() => valueFormatter(format, currency), [format, currency]);
  const change = firstVal !== 0 ? (cur - firstVal) / Math.abs(firstVal) : 0;
  const xf = xReadout ?? rest.xFormat ?? ((v: unknown) => String(v));
  const header = (
    <div className="flex items-start justify-between gap-4 mb-3">
      <div className="flex flex-col gap-1 min-w-0">
        <span className="text-caption text-secondary">{label}</span>
        <span className="text-kpi tabular" data-sensitive="">
          <RollingNumber value={cur} format={fmt} countUp={false} />
        </span>
        <div className="flex items-center gap-2 h-5">
          <DeltaPill value={change} />
          <span className="text-caption text-tertiary" style={{ fontWeight: 400 }}>
            {idx === null ? periodLabel : xf(data[i]?.[rest.x])}
          </span>
        </div>
      </div>
      {actions}
    </div>
  );
  return (
    <LineChart
      {...rest}
      format={format}
      currency={currency}
      area
      series={[{ key: y, label: typeof label === "string" ? label : "Value" }]}
      header={header}
      tooltip={false}
      onScrub={setIdx}
    />
  );
}
