import { addDays, format as fmtDate, startOfWeek } from "date-fns";
import { useMemo, useState, type KeyboardEvent } from "react";
import { getWeekStart, toDate } from "@/lib/dates";
import { MASK, valueFormatter, type ValueFormat } from "./axis";
import { ChartFrame } from "./ChartFrame";
import { SEQUENTIAL_ALPHAS, useChartTheme } from "./theme";
import { ChartTooltip } from "./Tooltip";

const CELL = 12;
const GAP = 3;
const STEP = CELL + GAP;

export interface HeatmapDay {
  date: string;
  value: number;
}

export interface CalendarHeatmapProps {
  days: HeatmapDay[];
  format?: ValueFormat;
  currency?: string;
  /** Diverging (gain/loss) colouring instead of sequential accent. */
  diverging?: boolean;
  /** Label for values in tooltips ("Spent", "Completed"). */
  valueLabel?: string;
  summaryLabel?: string;
  loading?: boolean;
  className?: string;
}

/** Level 0..5 from quantiles of the non-zero values (sequential palette, §3.5). */
function levels(values: number[]): (v: number) => number {
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!nz.length) return () => 0;
  const q = [0.2, 0.4, 0.6, 0.8].map((p) => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))]);
  return (v) => (v <= 0 ? 0 : 1 + q.filter((x) => v > x).length);
}

/**
 * Calendar heatmap (§13.5): 12px cells, 3px gap, radius 3; sequential accent palette (.12→1, zero = surface-2) or
 * diverging gain/loss. Arrow keys move a focus cell with its tooltip.
 */
export function CalendarHeatmap({ days, format = "money", currency = "USD", diverging, valueLabel = "Value", summaryLabel = "Daily activity", loading, className }: CalendarHeatmapProps) {
  const t = useChartTheme();
  const fmt = valueFormatter(format, currency);
  const [active, setActive] = useState<number | null>(null);

  const model = useMemo(() => {
    if (!days.length) return null;
    const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
    const map = new Map(sorted.map((d) => [d.date, d.value]));
    const first = startOfWeek(toDate(sorted[0].date), { weekStartsOn: getWeekStart() });
    const last = toDate(sorted[sorted.length - 1].date);
    const cells: { date: Date; key: string; value: number | null; col: number; row: number }[] = [];
    for (let d = first, i = 0; d <= last; d = addDays(d, 1), i++) {
      const key = fmtDate(d, "yyyy-MM-dd");
      cells.push({ date: d, key, value: map.has(key) ? (map.get(key) as number) : null, col: Math.floor(i / 7), row: i % 7 });
    }
    const cols = cells.length ? cells[cells.length - 1].col + 1 : 0;
    const months: { col: number; label: string }[] = [];
    let prevMonth = -1;
    for (const c of cells) {
      if (c.row === 0 && c.date.getMonth() !== prevMonth) {
        const prev = months[months.length - 1];
        if (prev && c.col - prev.col < 3) months.pop();
        months.push({ col: c.col, label: fmtDate(c.date, "MMM") });
        prevMonth = c.date.getMonth();
      }
    }
    const vals = cells.map((c) => c.value ?? 0);
    const maxAbs = Math.max(1e-9, ...vals.map(Math.abs));
    return { cells, cols, months, level: levels(vals), maxAbs };
  }, [days]);

  const fill = (v: number | null) => {
    if (!model || v === null) return { fill: "transparent", opacity: 1 };
    if (diverging) {
      if (Math.abs(v) < 1e-9) return { fill: t.surface2, opacity: 1 };
      const x = Math.abs(v) / model.maxAbs;
      return { fill: v > 0 ? t.gain : t.loss, opacity: x > 0.66 ? 1 : x > 0.33 ? 0.6 : 0.3 };
    }
    const l = model.level(v);
    return l === 0 ? { fill: t.surface2, opacity: 1 } : { fill: t.accent, opacity: SEQUENTIAL_ALPHAS[l - 1] };
  };

  const LEFT = 28;
  const TOP = 18;
  const width = model ? LEFT + model.cols * STEP : 0;
  const height = TOP + 7 * STEP;
  const total = days.reduce((s, d) => s + d.value, 0);
  const cur = active !== null && model ? model.cells[active] : null;

  const onKey = (e: KeyboardEvent) => {
    if (!model) return;
    const d = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1, Home: -Infinity, End: Infinity }[e.key];
    if (d === undefined) return;
    e.preventDefault();
    const start = active ?? model.cells.length - 1;
    const next = d === -Infinity ? 0 : d === Infinity ? model.cells.length - 1 : Math.max(0, Math.min(model.cells.length - 1, start + d));
    setActive(next);
  };

  return (
    <ChartFrame
      height={height + 8}
      summary={`${summaryLabel}: ${days.length} days, total ${fmt(total)}.`}
      loading={loading}
      empty={days.length === 0}
      className={className}
      table={{ columns: ["Date", valueLabel], rows: days.map((d) => [d.date, fmt(d.value)]), sensitiveCols: [1] }}
    >
      {() =>
        model ? (
          <div className="relative overflow-x-auto overflow-y-hidden" style={{ height: height + 8 }}>
            <svg
              width={width}
              height={height}
              tabIndex={0}
              role="grid"
              aria-label={summaryLabel}
              onKeyDown={onKey}
              onBlur={() => setActive(null)}
              style={{ outline: "none" }}
              onMouseLeave={() => setActive(null)}
            >
              {model.months.map((m) => (
                <text key={`${m.col}-${m.label}`} x={LEFT + m.col * STEP} y={11} fontSize={11} fill={t.textTertiary} style={{ fontFamily: t.fontFamily }}>
                  {m.label}
                </text>
              ))}
              {[1, 3, 5].map((r) => (
                <text key={r} x={0} y={TOP + r * STEP + CELL - 2} fontSize={10} fill={t.textTertiary} style={{ fontFamily: t.fontFamily }}>
                  {fmtDate(addDays(model.cells[0].date, r), "EEE")}
                </text>
              ))}
              {model.cells.map((c, i) => {
                const f = fill(c.value);
                return (
                  <rect
                    key={c.key}
                    className="emp-pop-enter"
                    x={LEFT + c.col * STEP}
                    y={TOP + c.row * STEP}
                    width={CELL}
                    height={CELL}
                    rx={3}
                    fill={f.fill}
                    fillOpacity={f.opacity}
                    stroke={active === i ? t.text : c.value === null ? "none" : t.borderSubtle}
                    strokeWidth={active === i ? 1.5 : 1}
                    style={{ ["--i" as string]: c.col }}
                    onMouseEnter={() => setActive(i)}
                  />
                );
              })}
            </svg>
            {cur ? (
              <div
                className="absolute pointer-events-none"
                style={{ left: Math.min(LEFT + cur.col * STEP + CELL / 2, width - 90), top: TOP + cur.row * STEP - 6, transform: "translate(-50%, -100%)", zIndex: 5 }}
              >
                <ChartTooltip
                  privacy={t.privacy}
                  title={fmtDate(cur.date, "EEE, MMM d, yyyy")}
                  rows={[{ key: "v", label: valueLabel, value: cur.value === null ? "—" : t.privacy ? MASK : fmt(cur.value) }]}
                />
              </div>
            ) : null}
          </div>
        ) : null
      }
    </ChartFrame>
  );
}

export interface MatrixHeatmapProps {
  rows: string[];
  cols: string[];
  /** values[r][c] */
  values: number[][];
  format?: ValueFormat;
  currency?: string;
  diverging?: boolean;
  summaryLabel?: string;
  className?: string;
}

/** Matrix heatmap (category × month, correlation): same cell grammar, labelled axes. */
export function MatrixHeatmap({ rows, cols, values, format = "money", currency = "USD", diverging, summaryLabel = "Heatmap", className }: MatrixHeatmapProps) {
  const t = useChartTheme();
  const fmt = valueFormatter(format, currency);
  const [hover, setHover] = useState<[number, number] | null>(null);
  const flat = values.flat();
  const level = levels(flat);
  const maxAbs = Math.max(1e-9, ...flat.map(Math.abs));
  const C = 22;
  const G = 3;
  const LEFT = 96;
  const TOP = 18;
  const w = LEFT + cols.length * (C + G);
  const h = TOP + rows.length * (C + G);
  return (
    <ChartFrame
      height={h}
      summary={`${summaryLabel}: ${rows.length} rows by ${cols.length} columns.`}
      className={className}
      table={{ columns: ["", ...cols], rows: rows.map((r, i) => [r, ...values[i].map((v) => fmt(v))]), sensitiveCols: cols.map((_, i) => i + 1) }}
    >
      {() => (
        <div className="relative">
          <svg width={w} height={h} onMouseLeave={() => setHover(null)}>
            {cols.map((c, j) => (
              <text key={c} x={LEFT + j * (C + G) + C / 2} y={11} fontSize={10} textAnchor="middle" fill={t.textTertiary} style={{ fontFamily: t.fontFamily }}>
                {c}
              </text>
            ))}
            {rows.map((r, i) => (
              <g key={r}>
                <text x={LEFT - 8} y={TOP + i * (C + G) + C / 2 + 4} fontSize={11} textAnchor="end" fill={t.textSecondary} style={{ fontFamily: t.fontFamily }}>
                  {r}
                </text>
                {values[i].map((v, j) => {
                  let f: string = t.surface2;
                  let o = 1;
                  if (diverging) {
                    const x = Math.abs(v) / maxAbs;
                    if (Math.abs(v) > 1e-9) {
                      f = v > 0 ? t.gain : t.loss;
                      o = x > 0.66 ? 1 : x > 0.33 ? 0.6 : 0.3;
                    }
                  } else {
                    const l = level(v);
                    if (l > 0) {
                      f = t.accent;
                      o = SEQUENTIAL_ALPHAS[l - 1];
                    }
                  }
                  const on = hover && hover[0] === i && hover[1] === j;
                  return (
                    <rect
                      key={j}
                      className="emp-pop-enter"
                      x={LEFT + j * (C + G)}
                      y={TOP + i * (C + G)}
                      width={C}
                      height={C}
                      rx={4}
                      fill={f}
                      fillOpacity={o}
                      stroke={on ? t.text : "none"}
                      strokeWidth={1.5}
                      style={{ ["--i" as string]: i * cols.length + j }}
                      onMouseEnter={() => setHover([i, j])}
                    />
                  );
                })}
              </g>
            ))}
          </svg>
          {hover ? (
            <div className="absolute pointer-events-none" style={{ left: LEFT + hover[1] * (C + G) + C / 2, top: TOP + hover[0] * (C + G) - 6, transform: "translate(-50%, -100%)", zIndex: 5 }}>
              <ChartTooltip privacy={t.privacy} title={`${rows[hover[0]]} · ${cols[hover[1]]}`} rows={[{ key: "v", label: "Value", value: fmt(values[hover[0]][hover[1]]) }]} />
            </div>
          ) : null}
        </div>
      )}
    </ChartFrame>
  );
}
