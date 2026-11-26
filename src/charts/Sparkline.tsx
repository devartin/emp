import { useMemo } from "react";
import { lttbValues } from "@/lib/lttb";
import { resolveColor, useChartTheme } from "./theme";

export interface SparklineProps {
  data: readonly number[];
  width?: number | string;
  height?: number;
  /** "ink" = --chart-line (default, DESIGN §2.3: single-series trend lines are ink — gain/loss lives on the delta pill); "trend" colours by sign of last − first; "accent"; or any CSS colour / var(). */
  color?: "trend" | "ink" | "accent" | string;
  /** Show the 4px end dot. */
  endDot?: boolean;
  area?: boolean;
  strokeWidth?: number;
  className?: string;
  /** @deprecated live halos are retired; ignored. */
  live?: boolean;
  "aria-label"?: string;
}

/**
 * Sparkline (docs/DESIGN.md §6.5): a 1.5px ink line on nothing, a 4px end dot, no fill, no halo, still at rest. Pure
 * SVG (no Recharts) so dozens can render in a dashboard cheaply; downsampled with LTTB above 120 points. Uses a
 * 100-wide viewBox stretched to the box. `area` draws a flat 6% wash only for coloured (non-ink) lines.
 */
export function Sparkline({ data, width = "100%", height = 32, color = "ink", endDot = true, area = false, strokeWidth = 1.5, className, live: _live, ...aria }: SparklineProps) {
  void _live;
  const t = useChartTheme();
  const pts = useMemo(() => (data.length > 120 ? lttbValues(data, 120) : data.slice()), [data]);
  const stroke =
    color === "trend" ? ((pts[pts.length - 1] ?? 0) >= (pts[0] ?? 0) ? t.gain : t.loss) : color === "accent" ? t.accent : color === "ink" ? t.chartLine : (resolveColor(color) ?? color);
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
            {area && stroke !== t.chartLine ? <path d={geom.areaPath} fill={stroke} fillOpacity={0.06} /> : null}
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
              }}
            />
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
