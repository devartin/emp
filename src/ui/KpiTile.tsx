import { Clock, Info } from "lucide-react";
import type { ReactNode } from "react";
import { Sparkline } from "@/charts/Sparkline";
import { cn } from "@/lib/cn";
import { formatNumber, formatPercent } from "@/lib/format";
import { currencyDecimals, moneyParts, toNumber, type Money } from "@/lib/money";
import { Card } from "./Card";
import { Delta } from "./Delta";
import { RollingNumber } from "./motion/RollingNumber";
import { Skeleton } from "./Skeleton";
import { Tooltip } from "./Tooltip";

export interface KpiTileProps {
  label: ReactNode;
  /** Money (symbol at full size) or a plain number. */
  value: Money | number | null;
  /** Format for numeric values. */
  format?: (n: number) => string;
  /** Drop cents for large money values. */
  noCents?: boolean;
  delta?: { value: number; label?: ReactNode; invert?: boolean; format?: "percent" | ((v: number) => string) };
  spark?: readonly number[];
  /** Sparkline colour: "ink" (default, §5.6 single-series trend lines are ink), "trend", "accent" or any CSS colour. */
  sparkColor?: "ink" | "trend" | "accent" | string;
  /** @deprecated count-up is retired; ignored. */
  countUpKey?: string;
  info?: ReactNode;
  stale?: boolean | string;
  loading?: boolean;
  size?: "md" | "xl";
  /** @deprecated count-up is retired; ignored. */
  from?: number;
  /** Treat as sensitive (default true for Money). */
  sensitive?: boolean;
  footer?: ReactNode;
  onClick?: () => void;
  className?: string;
}

/**
 * KPI figure (docs/DESIGN.md §6.3): a labelled figure, not a tile — label 12/16 secondary in sentence case, value
 * num-lg 20/26 w500 (xl = the one hero, 32/38 w600), the currency symbol at full size, a text delta, an optional ink
 * sparkline. The value is in the DOM from the first frame (no count-up); stale → secondary value + clock.
 */
export function KpiTile({ label, value, format, noCents, delta, spark, sparkColor = "ink", info, stale, loading, size = "md", sensitive, footer, onClick, className }: KpiTileProps) {
  const isMoney = value !== null && typeof value === "object";
  const sens = sensitive ?? isMoney;
  let body: ReactNode;
  if (loading || value === null) {
    body = <Skeleton width="62%" height={size === "xl" ? 32 : 22} radius={4} />;
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
        <RollingNumber value={n} format={fmt} sensitive={sens} />
        {parts.symbolPosition === "suffix" ? (
          <span className="emp-kpi-sym" data-pos="suffix">
            {parts.symbol.trim()}
          </span>
        ) : null}
      </>
    );
  } else {
    body = <RollingNumber value={value as number} format={format} sensitive={sens} />;
  }

  const staleText = typeof stale === "string" ? stale : "Showing cached data";
  return (
    <Card
      className={cn("emp-kpi", className)}
      data-spark={spark ? "" : undefined}
      interactive={!!onClick}
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
          {delta && !loading ? (
            <Delta
              text={typeof delta.format === "function" ? delta.format(delta.value) : formatPercent(Math.abs(delta.value), { digits: 1 })}
              dir={!Number.isFinite(delta.value) || Math.abs(delta.value) < 1e-12 ? "flat" : delta.value > 0 ? "up" : "down"}
              invert={delta.invert}
              label={delta.label ?? "vs last month"}
            />
          ) : null}
          {loading && delta ? <Skeleton width={110} height={14} radius={4} /> : null}
          {footer}
        </div>
      ) : null}
      {spark ? <div className="emp-kpi-spark">{loading ? <Skeleton height={24} /> : <Sparkline data={spark} height={32} color={sparkColor === "ink" ? "var(--chart-line)" : sparkColor} />}</div> : null}
    </Card>
  );
}
