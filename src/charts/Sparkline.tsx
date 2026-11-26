import { useId, useMemo } from "react";
import { lttbValues } from "@/lib/lttb";
import { alpha, useChartTheme } from "./theme";

export interface SparklineProps {
  data: readonly number[];
  width?: number | string;
  height?: number;
  /** "trend" colours by sign of last − first (default); "accent" uses the accent; or any CSS colour. */
  color?: "trend" | "accent" | string;
  /** Show the 4px end dot. */
  endDot?: boolean;
  area?: boolean;
  strokeWidth?: number;
  className?: string;
  /** Pulsing halo on the end dot (live data). */
  live?: boolean;
  "aria-label"?: string;
}

/**
 * Sparkline (§5.10): stroke 1.5, area gradient .16→0, 4px end dot. Pure SVG (no Recharts) so dozens can render in a
 * dashboard cheaply; downsampled with LTTB above 120 points. Uses a 100-wide viewBox stretched to the box.
 */
export function Sparkline({ data, width = "100%", height = 32, color = "trend", endDot = true, area = true, strokeWidth = 1.5, className, live, ...aria }: SparklineProps) {
  const t = useChartTheme();
  const gid = useId().replace(/:/g, "");
  const pts = useMemo(() => (data.length > 120 ? lttbValues(data, 120) : data.slice()), [data]);
  const stroke = color === "trend" ? ((pts[pts.length - 1] ?? 0) >= (pts[0] ?? 0) ? t.gain : t.loss) : color === "accent" ? t.accent : color;
  const geom = useMemo(() => {
    if (pts.length < 2) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const v of pts) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const pad = 3;
    const h = height - pad * 2;
    const span = max - min || 1;
    const W = 100;
    const xy = pts.map((v, i) => [(i / (pts.length - 1)) * W, pad + h - ((v - min) / span) * h] as const);
    const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join("");
    return { line, areaPath: `${line}L${W},${height}L0,${height}Z`, end: xy[xy.length - 1] };
  }, [pts, height]);

  return (
    <div className={className} style={{ width, height, position: "relative" }} role="img" aria-label={aria["aria-label"] ?? "Trend"}>
      {geom ? (
        <>
          <svg width="100%" height={height} viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" aria-hidden style={{ overflow: "visible" }}>
            <defs>
              <linearGradient id={`sg${gid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={stroke} stopOpacity={0.16} />
                <stop offset="1" stopColor={stroke} stopOpacity={0} />
              </linearGradient>
            </defs>
            {area ? <path d={geom.areaPath} fill={`url(#sg${gid})`} /> : null}
            <path d={geom.line} fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </svg>
          {endDot ? (
            // Dot drawn in HTML so it stays round despite the stretched viewBox.
            <span
              aria-hidden
              style={{
                position: "absolute",
                left: `calc(${geom.end[0]}% - 2px)`,
                top: geom.end[1] - 2,
                width: 4,
                height: 4,
                borderRadius: 9999,
                background: stroke,
                boxShadow: `0 0 0 2px ${alpha(stroke, 0.18)}`,
              }}
            >
              {live ? <span className="emp-live-dot" style={{ position: "absolute", inset: -5, borderRadius: 9999, background: stroke, opacity: 0 }} /> : null}
            </span>
          ) : null}
        </>
      ) : (
        <svg width="100%" height={height} aria-hidden>
          <line x1="0" x2="100%" y1={height / 2} y2={height / 2} stroke={t.border} strokeDasharray="3 3" />
        </svg>
      )}
    </div>
  );
}
