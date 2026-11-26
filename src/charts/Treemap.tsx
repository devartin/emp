import { useMemo } from "react";
import { Tooltip, Treemap as RTreemap } from "recharts";
import { assignCategorical } from "@/lib/hash";
import { formatPercent } from "@/lib/format";
import { summarizeParts } from "./a11y";
import { valueFormatter, type ValueFormat } from "./axis";
import { ChartFrame } from "./ChartFrame";
import { divergingColor, seriesColor, useChartTheme } from "./theme";
import { ChartTooltip } from "./Tooltip";

export interface TreemapItem {
  id: string;
  label: string;
  value: number;
  /** Fractional change; with colorBy="change" tiles use the diverging palette (portfolio heat). */
  change?: number;
  /** Optional secondary caption (ticker, %). */
  sub?: string;
}

export interface TreemapProps {
  data: TreemapItem[];
  height?: number;
  colorBy?: "category" | "change";
  format?: ValueFormat;
  currency?: string;
  /** |change| mapped to full intensity (default 5%). */
  changeScale?: number;
  summaryLabel?: string;
  loading?: boolean;
  className?: string;
}

/** Treemap (allocation / heat): rounded tiles with 2px gutters, labels when they fit, categorical or diverging fill. */
export function Treemap({ data, height = 260, colorBy = "category", format = "money", currency = "USD", changeScale = 0.05, summaryLabel = "Allocation", loading, className }: TreemapProps) {
  const t = useChartTheme();
  const fmt = valueFormatter(format, currency);
  const items = useMemo(() => [...data].filter((d) => d.value > 0).sort((a, b) => b.value - a.value), [data]);
  const cats = useMemo(() => assignCategorical(items.map((d) => d.id)), [items]);
  const total = items.reduce((s, d) => s + d.value, 0);
  const rows = items.map((d) => ({ name: d.label, size: d.value, id: d.id, change: d.change, sub: d.sub }));

  return (
    <ChartFrame
      height={height}
      summary={summarizeParts(summaryLabel, items.map((d) => ({ name: d.label, value: d.value })), fmt)}
      loading={loading}
      empty={items.length === 0}
      className={className}
      table={{ columns: ["Name", "Value", "Share", ...(colorBy === "change" ? ["Change"] : [])], rows: items.map((d) => [d.label, fmt(d.value), total ? `${((d.value / total) * 100).toFixed(1)}%` : "0%", ...(colorBy === "change" ? [formatPercent(d.change ?? 0, { signed: true })] : [])]), sensitiveCols: [1] }}
    >
      {(size) => (
        <RTreemap
          width={size.width}
          height={size.height}
          data={rows}
          dataKey="size"
          nameKey="name"
          isAnimationActive={false}
          aspectRatio={1.4}
          content={((p: unknown) => {
            const n = p as { x: number; y: number; width: number; height: number; index: number; depth: number; name?: string; id?: string; change?: number; sub?: string; size?: number };
            if (n.depth !== 1 || n.width <= 0 || n.height <= 0) return <g />;
            const fill = colorBy === "change" ? divergingColor(t, (n.change ?? 0) / changeScale) : seriesColor(t, cats.get(n.id ?? "") ?? 0);
            const big = n.width > 64 && n.height > 36;
            const pad = 2;
            const strong = colorBy === "change" && Math.abs((n.change ?? 0) / changeScale) > 0.66;
            const textColor = colorBy === "change" ? (strong ? (t.dark ? "#09090b" : "#fff") : t.text) : "#fff";
            return (
              <g>
                <rect x={n.x + pad / 2} y={n.y + pad / 2} width={Math.max(0, n.width - pad)} height={Math.max(0, n.height - pad)} rx={6} style={{ fill }} fillOpacity={colorBy === "change" ? 1 : 0.88} />
                {big ? (
                  <>
                    <text x={n.x + 10} y={n.y + 20} fontSize={12} fontWeight={600} fill={textColor} style={{ fontFamily: t.fontFamily }}>
                      {n.name}
                    </text>
                    <text x={n.x + 10} y={n.y + 36} fontSize={11} fill={textColor} fillOpacity={0.78} style={{ fontFamily: t.fontFamily, fontVariantNumeric: "tabular-nums" }}>
                      {colorBy === "change" ? formatPercent(n.change ?? 0, { signed: true }) : t.privacy ? "•••" : total ? `${(((n.size ?? 0) / total) * 100).toFixed(1)}%` : ""}
                    </text>
                  </>
                ) : null}
              </g>
            );
          }) as never}
        >
          <Tooltip
            isAnimationActive={false}
            content={(p) => {
              const pp = p as unknown as { active?: boolean; payload?: { payload?: { name: string; size: number; change?: number } }[] };
              const d = pp.payload?.[0]?.payload;
              if (!pp.active || !d) return null;
              return (
                <ChartTooltip
                  privacy={t.privacy}
                  title={d.name}
                  rows={[
                    { key: "v", label: "Value", value: fmt(d.size) },
                    { key: "s", label: "Share", value: total ? `${((d.size / total) * 100).toFixed(1)}%` : "—" },
                    ...(d.change !== undefined ? [{ key: "c", label: "Change", value: formatPercent(d.change, { signed: true }) }] : []),
                  ]}
                />
              );
            }}
          />
        </RTreemap>
      )}
    </ChartFrame>
  );
}
