import { useMemo, useState, type ReactNode } from "react";
import { Delta } from "@/ui/Delta";
import { RollingNumber } from "@/ui/motion/RollingNumber";
import { valueFormatter } from "./axis";
import { LineChart, type Datum, type LineChartProps } from "./Line";

/** Area chart: LineChart with a flat 8% fill for coloured (multi-series) lines; a single ink line has no fill. */
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
  /** @deprecated count-up is retired; ignored. */
  countUpKey?: string;
}

/**
 * Hero chart (docs/DESIGN.md §6.5): label 13/18 secondary, the one hero figure (32/38 w600, tabular), a text delta
 * line, then one ink line on nothing. The figure is final from the first frame; the crosshair rewrites it in place
 * (scrub mode, no roll) together with the delta and the date, and it returns to the latest value on leave.
 */
export function HeroAreaChart<T extends Datum>({ y, label, xReadout, actions, periodLabel = "this period", format = "money", currency = "USD", countUpKey: _k, ...rest }: HeroAreaChartProps<T>) {
  void _k;
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
        <span className="emp-text" data-v="ui" data-tone="secondary">
          {label}
        </span>
        <span className="emp-amount" data-role="hero" data-sensitive="">
          <RollingNumber value={cur} format={fmt} sensitive scrubbing={idx !== null} roll="never" />
        </span>
        <div className="emp-text flex items-center gap-2" data-v="ui">
          <Delta percent={change} />
          <span className="text-secondary">{idx === null ? periodLabel : xf(data[i]?.[rest.x])}</span>
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
      hero
    />
  );
}
