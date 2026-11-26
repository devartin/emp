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
  /** Hero treatment (S5): the first line is drawn by a pen dot (1100ms expo), the area fades in at 650ms. */
  hero?: boolean;
  children: (size: { width: number; height: number }) => ReactNode;
}

/**
 * Vertices of an SVG path's `d` (the end point of every command), used to ride the pen dot along a Recharts curve
 * without `getTotalLength()` / `getPointAtLength()` — both are slow on long paths (up to ~300ms at 4× CPU).
 */
function pathVertices(d: string): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const re = /([MLCSQTHVZmlcsqthvz])([^MLCSQTHVZmlcsqthvz]*)/g;
  let cx = 0;
  let cy = 0;
  for (let m = re.exec(d); m; m = re.exec(d)) {
    const cmd = m[1];
    const nums = (m[2].match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
    if (cmd === "H") cx = nums[nums.length - 1] ?? cx;
    else if (cmd === "V") cy = nums[nums.length - 1] ?? cy;
    else if (cmd === "Z" || cmd === "z" || nums.length < 2) continue;
    else if (cmd === cmd.toLowerCase()) {
      cx += nums[nums.length - 2];
      cy += nums[nums.length - 1];
    } else {
      cx = nums[nums.length - 2];
      cy = nums[nums.length - 1];
    }
    out.push({ x: cx, y: cy });
  }
  return out;
}

/** Draw the first `.recharts-line-curve` with a riding pen dot (JS rAF, hero charts only — §5.6). */
function penDraw(host: HTMLElement): () => void {
  const path = host.querySelector<SVGPathElement>(".recharts-line-curve");
  const svg = path?.ownerSVGElement;
  if (!path || !svg) return () => undefined;
  const pts = pathVertices(path.getAttribute("d") ?? "");
  if (pts.length < 2) return () => undefined;
  // Cumulative chord length ≈ arc length for dense data: maps dash progress to a vertex segment.
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = cum[cum.length - 1];
  if (!total) return () => undefined;
  const dur = 1100;
  const easing = "cubic-bezier(.16,1,.3,1)";
  // pathLength=1 normalises the dash so no length measurement is needed.
  path.setAttribute("pathLength", "1");
  path.style.strokeDasharray = "1";
  const anim = path.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: dur, easing, fill: "none" });
  const pen = document.createElement("span");
  pen.className = "emp-pen";
  pen.setAttribute("aria-hidden", "true");
  pen.style.background = path.getAttribute("stroke") || "";
  host.appendChild(pen);
  const hr = host.getBoundingClientRect();
  const sr = svg.getBoundingClientRect();
  const ox = sr.left - hr.left;
  const oy = sr.top - hr.top;
  const expo = (x: number) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x));
  const t0 = performance.now();
  let raf = 0;
  let seg = 1;
  const cleanup = () => {
    path.style.strokeDasharray = "";
    path.removeAttribute("pathLength");
  };
  const tick = () => {
    const k = Math.min(1, (performance.now() - t0) / dur);
    const at = total * expo(k);
    while (seg < cum.length - 1 && cum[seg] < at) seg++;
    const a = pts[seg - 1];
    const b = pts[seg];
    const span = cum[seg] - cum[seg - 1] || 1;
    const f = Math.max(0, Math.min(1, (at - cum[seg - 1]) / span));
    pen.style.transform = `translate(${ox + a.x + (b.x - a.x) * f}px, ${oy + a.y + (b.y - a.y) * f}px)`;
    if (k < 1) raf = requestAnimationFrame(tick);
    else {
      pen.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: "forwards" }).finished.then(() => pen.remove(), () => pen.remove());
      cleanup();
    }
  };
  tick();
  return () => {
    cancelAnimationFrame(raf);
    anim.cancel();
    pen.remove();
    cleanup();
  };
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

  useEffect(() => {
    if (phase !== "entering") return;
    const id = window.setTimeout(() => setPhase("done"), hero ? 2800 : 1000);
    let stop: (() => void) | undefined;
    let r1 = 0;
    let r2 = 0;
    if (hero && ref.current) {
      const host = ref.current;
      r1 = requestAnimationFrame(() => {
        r2 = requestAnimationFrame(() => {
          stop = penDraw(host);
        });
      });
    }
    return () => {
      window.clearTimeout(id);
      cancelAnimationFrame(r1);
      cancelAnimationFrame(r2);
      stop?.();
    };
  }, [phase, hero]);

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
