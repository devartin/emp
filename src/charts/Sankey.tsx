import { useMemo, useState } from "react";
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
      table={{ columns: ["From", "To", "Amount"], rows: links.map((l) => [nodes[l.source]?.name ?? "", nodes[l.target]?.name ?? "", fmt(l.value)]), sensitiveCols: [2] }}
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
            return (
              <g
                className="emp-fade-enter"
                onMouseEnter={() => setHoverNode(n.index)}
                onMouseLeave={() => setHoverNode(null)}
                style={{ opacity: dim ? 0.55 : 1, transition: "opacity 160ms cubic-bezier(.2,0,0,1)" }}
              >
                <rect x={n.x} y={n.y} width={n.width} height={Math.max(2, n.height)} rx={3} fill={colorOf(n.index)} />
                <text x={lx} y={n.y + n.height / 2 - 1} textAnchor={anchor} fontSize={12} fontWeight={500} fill={t.text} style={{ fontFamily: t.fontFamily }}>
                  {n.payload.name}
                </text>
                <text x={lx} y={n.y + n.height / 2 + 13} textAnchor={anchor} fontSize={11} fill={t.textTertiary} style={{ fontFamily: t.fontFamily, fontVariantNumeric: "tabular-nums" }}>
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
