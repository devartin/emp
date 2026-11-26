import { Clock, Info } from "lucide-react";
import type { ReactNode } from "react";
import { Sparkline } from "@/charts/Sparkline";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { currencyDecimals, moneyParts, toNumber, type Money } from "@/lib/money";
import { Card } from "./Card";
import { DeltaPill } from "./DeltaPill";
import { RollingNumber } from "./motion/RollingNumber";
import { Skeleton } from "./Skeleton";
import { Tooltip } from "./Tooltip";

export interface KpiTileProps {
  label: ReactNode;
  /** Money (symbol rendered at 0.7×) or a plain number. */
  value: Money | number | null;
  /** Format for numeric values. */
  format?: (n: number) => string;
  /** Drop cents for large money values. */
  noCents?: boolean;
  delta?: { value: number; label?: ReactNode; invert?: boolean; format?: "percent" | ((v: number) => string) };
  spark?: readonly number[];
  /** Sparkline colour: "ink" (default, §5.6 single-series trend lines are ink), "trend", "accent" or any CSS colour. */
  sparkColor?: "ink" | "trend" | "accent" | string;
  /** Count up only once per session for this key (hero numbers). */
  countUpKey?: string;
  info?: ReactNode;
  stale?: boolean | string;
  loading?: boolean;
  size?: "md" | "xl";
  /** Cached value to count up from on first mount. */
  from?: number;
  /** Treat as sensitive (default true for Money). */
  sensitive?: boolean;
  footer?: ReactNode;
  onClick?: () => void;
  className?: string;
}

/**
 * KPI tile (docs/DESIGN.md §6.3): a machined panel; when clickable it lifts, catches the pointer light (edge + specular)
 * and tilts ≤ 3°. Value is a RollingNumber (count-up once, then rolls); delta pill; 32px ink sparkline; stale →
 * secondary value + clock. Min 200×112 (128 with sparkline).
 */
export function KpiTile({ label, value, format, noCents, delta, spark, sparkColor = "ink", countUpKey, info, stale, loading, size = "md", from, sensitive, footer, onClick, className }: KpiTileProps) {
  const isMoney = value !== null && typeof value === "object";
  const sens = sensitive ?? isMoney;
  let body: ReactNode;
  if (loading || value === null) {
    body = <Skeleton width="62%" height={size === "xl" ? 40 : 28} radius={6} />;
  } else if (isMoney) {
    const m = value as Money;
    const digits = noCents ? 0 : currencyDecimals(m.currency);
    const parts = moneyParts(m, { noCents });
    const n = Math.abs(toNumber(m));
    const fmt = (x: number) => formatNumber(x, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    body = (
      <>
        {parts.sign ? <span>{parts.sign}</span> : null}
        {parts.symbolPosition === "prefix" ? <span className="emp-kpi-sym">{parts.symbol}</span> : null}
        <RollingNumber value={n} format={fmt} from={from} countUpKey={countUpKey} sensitive={sens} />
        {parts.symbolPosition === "suffix" ? (
          <span className="emp-kpi-sym" data-pos="suffix">
            {parts.symbol.trim()}
          </span>
        ) : null}
      </>
    );
  } else {
    body = <RollingNumber value={value as number} format={format} from={from} countUpKey={countUpKey} sensitive={sens} />;
  }

  const staleText = typeof stale === "string" ? stale : "Showing cached data";
  return (
    <Card
      className={cn("emp-kpi", className)}
      data-spark={spark ? "" : undefined}
      interactive={!!onClick}
      light={!!onClick}
      specular={!!onClick}
      tilt={!!onClick}
      onClick={onClick}
    >
      <div>
        <div className="emp-kpi-label">
          <span className="truncate">{label}</span>
          {info ? (
            <Tooltip content={info}>
              <span tabIndex={0} className="inline-flex" aria-label="More info">
                <Info aria-hidden />
              </span>
            </Tooltip>
          ) : null}
          {stale ? (
            <Tooltip content={staleText}>
              <span tabIndex={0} className="inline-flex ml-auto" aria-label={staleText}>
                <Clock aria-hidden />
              </span>
            </Tooltip>
          ) : null}
        </div>
        <div className="emp-kpi-value" data-size={size === "xl" ? "xl" : undefined} data-stale={stale ? "" : undefined} data-sensitive={sens && !loading ? "" : undefined}>
          {body}
        </div>
      </div>
      {delta || footer ? (
        <div className="emp-kpi-foot">
          {delta && !loading ? <DeltaPill value={delta.value} invert={delta.invert} label={delta.label ?? "vs last month"} format={delta.format} /> : null}
          {loading && delta ? <Skeleton width={110} height={16} radius={9999} /> : null}
          {footer}
        </div>
      ) : null}
      {spark ? <div className="emp-kpi-spark">{loading ? <Skeleton height={24} /> : <Sparkline data={spark} height={32} color={sparkColor === "ink" ? "var(--chart-line)" : sparkColor} />}</div> : null}
    </Card>
  );
}
