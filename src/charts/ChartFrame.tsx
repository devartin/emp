import { CloudOff, Table2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Badge } from "@/ui/Badge";
import { IconButton } from "@/ui/IconButton";
import { isReducedMotion } from "@/ui/motion/useReducedEffects";
import { Skeleton } from "@/ui/Skeleton";
import { MASK } from "./axis";
import { useChartTheme } from "./theme";

export interface ChartTable {
  columns: string[];
  rows: (string | number)[][];
  /** Columns that hold sensitive numbers (masked under Hide numbers). */
  sensitiveCols?: number[];
}

export interface ChartFrameProps {
  height: number;
  /** Accessible summary (required: every chart is described, §13.5). */
  summary: string;
  loading?: boolean;
  /** Insufficient data: true or custom copy. */
  empty?: boolean | string;
  /** Cached/offline chip: true or custom copy. */
  cached?: boolean | string;
  /** Data for "View as table" — pass a thunk so the rows are only built when the table is opened. */
  table?: ChartTable | (() => ChartTable);
  /** Chart name used for the accessible summary while Hide numbers is on (default: the summary's leading words). */
  title?: string;
  /** Header row above the plot (hero readouts, legends). */
  header?: ReactNode;
  footer?: ReactNode;
  className?: string;
  /** Hero chart (220px, the one per view). The entry is the same 220ms first-load reveal as every chart. */
  hero?: boolean;
  children: (size: { width: number; height: number }) => ReactNode;
}

/** A summary with every figure removed, for Hide numbers (the chart's name survives, its values don't). */
export function privateSummary(summary: string, title?: string): string {
  const base = (title ?? summary.split(/[:\d$€£¥₹−+%]/)[0]).replace(/[\s,;–—-]+$/, "").replace(/\s+(from|to|of|at|by|up|down)$/i, "").trim();
  return `${base || "Chart"}: values hidden`;
}

const DEFAULT_EMPTY = "Add 2+ transactions to see your trend";

/**
 * Chart wrapper (§13.5): measures its box, runs the entry animation once when ≥30% is in view, and provides the
 * shared states — loading skeleton, insufficient data (ghost dashed line + copy), cached/offline chip, aria summary,
 * "View as table" toggle.
 */
export function ChartFrame({ height, summary: rawSummary, title, loading, empty, cached, table: tableProp, header, footer, className, hero, children }: ChartFrameProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [phase, setPhase] = useState<"pending" | "entering" | "done">(() => (isReducedMotion() ? "done" : "pending"));
  const [asTable, setAsTable] = useState(false);
  const t = useChartTheme();
  // Hide numbers must also hide them from assistive tech (the visual mask alone leaks the figures).
  const summary = t.privacy ? privateSummary(rawSummary, title) : rawSummary;
  const table = asTable && typeof tableProp === "function" ? tableProp() : typeof tableProp === "function" ? undefined : tableProp;
  const hasTable = !!tableProp;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      setWidth((prev) => (prev === w ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (phase !== "pending" || loading || empty) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          setPhase("entering");
        }
      },
      { threshold: 0.3 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [phase, loading, empty]);

  // First data load only: the line reveals in 220ms (CSS on [data-entering]); then the chart is still. No pen dot.
  useEffect(() => {
    if (phase !== "entering") return;
    const id = window.setTimeout(() => setPhase("done"), 280);
    return () => window.clearTimeout(id);
  }, [phase]);

  const emptyText = typeof empty === "string" ? empty : DEFAULT_EMPTY;
  const cachedText = typeof cached === "string" ? cached : "Cached";

  return (
    <figure className={cn("emp-chart group/chart m-0", className)} data-hero={hero ? "" : undefined} aria-busy={loading || undefined} aria-label={summary}>
      <figcaption className="sr-only">{summary}</figcaption>
      {header}
      {cached ? (
        <div className="flex justify-end mb-1.5">
          <Badge tone="outline" icon={CloudOff}>
            {cachedText}
          </Badge>
        </div>
      ) : null}
      <div
        ref={ref}
        className="relative"
        style={{ height: asTable ? undefined : height, minHeight: asTable ? height : undefined }}
        data-entering={phase === "entering" ? "" : undefined}
      >
        {hasTable ? (
          <div className="emp-chart-chip flex items-center gap-1">
            {hasTable ? (
              <span className="opacity-0 group-hover/chart:opacity-100 focus-within:opacity-100 transition-opacity duration-150">
                <IconButton size="xs" icon={Table2} label={asTable ? "View as chart" : "View as table"} active={asTable} onClick={() => setAsTable((v) => !v)} />
              </span>
            ) : null}
          </div>
        ) : null}
        {loading ? (
          <div className="absolute inset-0 flex flex-col justify-end gap-2 pb-6">
            <Skeleton height="100%" radius={10} />
          </div>
        ) : empty ? (
          <div className="absolute inset-0">
            <svg width="100%" height="100%" aria-hidden>
              <path
                d={`M0 ${height * 0.72} C ${width * 0.25} ${height * 0.62}, ${width * 0.45} ${height * 0.78}, ${width * 0.7} ${height * 0.5} S ${width} ${height * 0.38}, ${width} ${height * 0.38}`}
                fill="none"
                stroke={t.border}
                strokeWidth={1.5}
                strokeDasharray="4 4"
              />
            </svg>
            <div className="emp-chart-empty">
              <span className="px-3 py-1.5 rounded-lg glass-faux">
                {emptyText}
              </span>
            </div>
          </div>
        ) : asTable && table ? (
          <div className="overflow-auto" style={{ maxHeight: height * 1.6 }}>
            <table className="emp-chart-table">
              <thead>
                <tr>
                  {table.columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((r, i) => (
                  <tr key={i}>
                    {r.map((c, j) => (
                      <td key={j}>{t.privacy && table.sensitiveCols?.includes(j) ? MASK : c}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : width > 0 ? (
          <div style={{ visibility: phase === "pending" ? "hidden" : undefined, height: "100%" }}>
            {children({ width, height })}
          </div>
        ) : null}
      </div>
      {footer}
    </figure>
  );
}
