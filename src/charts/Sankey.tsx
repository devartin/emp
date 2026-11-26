import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Sankey as RSankey, Tooltip } from "recharts";
import { valueFormatter, type ValueFormat } from "./axis";
import { ChartFrame } from "./ChartFrame";
import { seriesColor, useChartTheme } from "./theme";
import { ChartTooltip } from "./Tooltip";

export interface SankeyNode {
  name: string;
  color?: string;
}
export interface SankeyLink {
  source: number;
  target: number;
  value: number;
}

export interface SankeyProps {
  nodes: SankeyNode[];
  links: SankeyLink[];
  height?: number;
  format?: ValueFormat;
  currency?: string;
  summaryLabel?: string;
  loading?: boolean;
  className?: string;
}

/** Cash-flow Sankey (§13.5): nodes 10px wide, radius 3; links in the source colour at .28 (.5 on hover). */
export function Sankey({ nodes, links, height = 300, format = "money", currency = "USD", summaryLabel = "Cash flow", loading, className }: SankeyProps) {
  const t = useChartTheme();
  const [hoverLink, setHoverLink] = useState<number | null>(null);
  const [hoverNode, setHoverNode] = useState<number | null>(null);
  const fmt = valueFormatter(format, currency);
  const colorOf = (i: number) => nodes[i]?.color ?? seriesColor(t, i);
  const data = useMemo(() => ({ nodes: nodes.map((n) => ({ name: n.name })), links: links.map((l) => ({ ...l })) }), [nodes, links]);
  const inflow = (i: number) => links.filter((l) => l.target === i).reduce((s, l) => s + l.value, 0);
  const outflow = (i: number) => links.filter((l) => l.source === i).reduce((s, l) => s + l.value, 0);
  // Collision-aware labels: the node pass records each label's natural centre; a layout effect then spreads labels in
  // the same column at least LABEL_GAP apart (top-down, then pulled back up from the bottom edge) and re-renders once.
  const natural = useRef(new Map<number, { col: number; cy: number }>());
  const [labelY, setLabelY] = useState<ReadonlyMap<number, number>>(() => new Map());
  natural.current = new Map();
  useLayoutEffect(() => {
    const next = spreadLabels(natural.current, height);
    let same = next.size === labelY.size;
    if (same) for (const [k, v] of next) if (Math.abs((labelY.get(k) ?? NaN) - v) > 0.5) same = false;
    if (!same) setLabelY(next);
  });
  const summary = `${summaryLabel}: ${links
    .slice(0, 8)
    .map((l) => `${nodes[l.source]?.name} to ${nodes[l.target]?.name} ${fmt(l.value)}`)
    .join("; ")}.`;

  return (
    <ChartFrame
      height={height}
      summary={summary}
      loading={loading}
      empty={links.length === 0}
      className={className}
      title={summaryLabel}
      table={() => ({ columns: ["From", "To", "Amount"], rows: links.map((l) => [nodes[l.source]?.name ?? "", nodes[l.target]?.name ?? "", fmt(l.value)]), sensitiveCols: [2] })}
    >
      {(size) => (
        <RSankey
          width={size.width}
          height={size.height}
          data={data}
          nodeWidth={10}
          nodePadding={18}
          linkCurvature={0.5}
          iterations={48}
          margin={{ top: 6, right: 96, bottom: 6, left: 96 }}
          node={(p: unknown) => {
            const n = p as { x: number; y: number; width: number; height: number; index: number; payload: { name: string; value: number; sourceLinks?: unknown[] } };
            const value = Number.isFinite(n.payload.value) ? n.payload.value : Math.max(inflow(n.index), outflow(n.index));
            const isSource = !(n.payload as { targetLinks?: unknown[] }).targetLinks?.length;
            const lx = isSource ? n.x - 8 : n.x + n.width + 8;
            const anchor = isSource ? "end" : "start";
            const dim = hoverNode !== null && hoverNode !== n.index;
            const cy0 = n.y + n.height / 2;
            natural.current.set(n.index, { col: Math.round(isSource ? n.x : n.x + n.width) * (isSource ? -1 : 1), cy: cy0 });
            const cy = labelY.get(n.index) ?? cy0;
            return (
              <g
                className="emp-fade-enter"
                onMouseEnter={() => setHoverNode(n.index)}
                onMouseLeave={() => setHoverNode(null)}
                style={{ opacity: dim ? 0.55 : 1, transition: "opacity 160ms cubic-bezier(.2,0,0,1)" }}
              >
                <rect x={n.x} y={n.y} width={n.width} height={Math.max(2, n.height)} rx={3} fill={colorOf(n.index)} />
                <text x={lx} y={cy - 1} textAnchor={anchor} fontSize={12} fontWeight={500} fill={t.text} style={{ fontFamily: t.fontFamily }}>
                  {n.payload.name}
                </text>
                <text x={lx} y={cy + 13} textAnchor={anchor} fontSize={11} fill={t.textTertiary} style={{ fontFamily: t.fontFamily, fontVariantNumeric: "tabular-nums" }}>
                  {t.privacy ? "•••" : fmt(value)}
                </text>
              </g>
            );
          }}
          link={(p: unknown) => {
            const l = p as { sourceX: number; targetX: number; sourceY: number; targetY: number; sourceControlX: number; targetControlX: number; linkWidth: number; index: number; payload: { source: { index?: number } | number } };
            const srcIdx = typeof l.payload.source === "number" ? l.payload.source : (links[l.index]?.source ?? 0);
            const on = hoverLink === l.index || (hoverNode !== null && (links[l.index]?.source === hoverNode || links[l.index]?.target === hoverNode));
            return (
              <path
                className="emp-fade-enter"
                d={`M${l.sourceX},${l.sourceY} C${l.sourceControlX},${l.sourceY} ${l.targetControlX},${l.targetY} ${l.targetX},${l.targetY}`}
                fill="none"
                stroke={colorOf(srcIdx)}
                strokeOpacity={on ? 0.5 : 0.28}
                strokeWidth={Math.max(1, l.linkWidth)}
                onMouseEnter={() => setHoverLink(l.index)}
                onMouseLeave={() => setHoverLink(null)}
                style={{ transition: "stroke-opacity 160ms cubic-bezier(.2,0,0,1)" }}
              />
            );
          }}
        >
          <Tooltip
            isAnimationActive={false}
            content={(p) => {
              const pp = p as unknown as { active?: boolean; payload?: { payload?: { source?: { name: string }; target?: { name: string }; value?: number; name?: string } }[] };
              const d = pp.payload?.[0]?.payload;
              if (!pp.active || !d) return null;
              if (d.source && d.target)
                return <ChartTooltip privacy={t.privacy} title={`${d.source.name} → ${d.target.name}`} rows={[{ key: "v", label: "Amount", value: fmt(Number(d.value)) }]} />;
              return <ChartTooltip privacy={t.privacy} title={d.name} rows={[{ key: "v", label: "Total", value: fmt(Number(d.value)) }]} />;
            }}
          />
        </RSankey>
      )}
    </ChartFrame>
  );
}

/** Two-line label block (name + amount) needs this much vertical room. */
const LABEL_GAP = 30;

function spreadLabels(natural: ReadonlyMap<number, { col: number; cy: number }>, height: number): Map<number, number> {
  const cols = new Map<number, { i: number; cy: number }[]>();
  for (const [i, v] of natural) {
    const arr = cols.get(v.col) ?? [];
    arr.push({ i, cy: v.cy });
    cols.set(v.col, arr);
  }
  const out = new Map<number, number>();
  const top = 13;
  const bottom = height - 17;
  for (const arr of cols.values()) {
    arr.sort((a, b) => a.cy - b.cy);
    const ys = arr.map((a) => a.cy);
    for (let k = 0; k < ys.length; k++) ys[k] = Math.max(ys[k], k ? ys[k - 1] + LABEL_GAP : top);
    if (ys.length && ys[ys.length - 1] > bottom) {
      ys[ys.length - 1] = bottom;
      for (let k = ys.length - 2; k >= 0; k--) ys[k] = Math.min(ys[k], ys[k + 1] - LABEL_GAP);
    }
    arr.forEach((a, k) => {
      if (Math.abs(ys[k] - a.cy) > 0.5) out.set(a.i, ys[k]);
    });
  }
  return out;
}
