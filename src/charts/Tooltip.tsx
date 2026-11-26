import type { ReactNode } from "react";
import { MASK } from "./axis";

export interface ChartTooltipRow {
  key: string;
  label: ReactNode;
  value: string;
  color?: string;
  /** Dashed swatch for projections. */
  dashed?: boolean;
  muted?: boolean;
}

/** Chart tooltip card (§13.5): radius 10, elev-2, padding 10×12, min-width 160; masked values under Hide numbers. */
export function ChartTooltip({ title, rows, footer, privacy }: { title?: ReactNode; rows: ChartTooltipRow[]; footer?: ReactNode; privacy?: boolean }) {
  return (
    <div className="emp-chart-tooltip">
      {title ? <div className="emp-chart-tooltip-title">{title}</div> : null}
      <div className="flex flex-col gap-1">
        {rows.map((r) => (
          <div key={r.key} className="emp-chart-tooltip-row" style={r.muted ? { opacity: 0.6 } : undefined}>
            <span className="emp-chart-tooltip-key">
              {r.color ? (
                <span
                  className="emp-chart-tooltip-swatch"
                  style={r.dashed ? { background: "transparent", border: `1.5px dashed ${r.color}`, width: 10, height: 2, borderRadius: 0, borderWidth: "1.5px 0 0" } : { background: r.color }}
                />
              ) : null}
              {r.label}
            </span>
            <span className="emp-chart-tooltip-val">{privacy ? MASK : r.value}</span>
          </div>
        ))}
      </div>
      {footer ? <div className="mt-1.5 pt-1.5 text-tertiary" style={{ borderTop: "1px solid var(--border-subtle)" }}>{footer}</div> : null}
    </div>
  );
}
