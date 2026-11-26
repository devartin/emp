/**
 * SpendWheel — the finance donut (§5.6 "Donut and Ring"): segments sweep in order (dashoffset, 700ms expo, 40ms
 * stagger) over an engraved groove; hovering a segment (or its legend row, via `active`) slides it 4px outward along
 * its bisector (transform only), dims the rest and rolls the centre figure to that slice. When `data` changes the
 * segments morph — lengths and start angles interpolate together on the `morph` spring — which is how Portfolio's
 * "now ⇄ target" allocation toggles.
 */
import { m } from "motion/react";
import { useMemo, type ReactNode } from "react";
import { RollingNumber } from "@/ui/motion/RollingNumber";
import { spring } from "@/ui/motion/tokens";
import { useReducedMotionPref, usePrivacy } from "@/ui/motion/useReducedEffects";

export interface WheelSlice {
  id: string;
  label: string;
  value: number;
  color: string;
}

export interface SpendWheelProps {
  data: WheelSlice[];
  size?: number;
  thickness?: number;
  active?: string | null;
  onActive?: (id: string | null) => void;
  onSelect?: (id: string) => void;
  centerLabel: ReactNode;
  /** Formats the centre value (money, percent…). */
  format: (n: number) => string;
  /** Override the centre total (defaults to the sum). */
  total?: number;
  /** Shown in the centre while nothing is hovered (instead of the rolling total). */
  centerValue?: ReactNode;
  /** Optional ghost ring (e.g. the target allocation) drawn thin outside the wheel. */
  ghost?: WheelSlice[];
  summary: string;
}

const GAP_DEG = 2.2;

export function SpendWheel({ data, size = 160, thickness = 16, active = null, onActive, onSelect, centerLabel, centerValue, format, total, ghost, summary }: SpendWheelProps) {
  const reduced = useReducedMotionPref();
  const privacy = usePrivacy();
  const r = (size - thickness) / 2 - 5;
  const c = 2 * Math.PI * r;
  const sum = data.reduce((a, d) => a + Math.max(0, d.value), 0) || 1;
  const segs = useMemo(() => {
    let start = 0;
    const gap = data.length > 1 ? GAP_DEG : 0;
    return data.map((d) => {
      const sweep = (Math.max(0, d.value) / sum) * 360;
      const s = { ...d, start, sweep: Math.max(0, sweep - gap), mid: start + sweep / 2 };
      start += sweep;
      return s;
    });
  }, [data, sum]);
  const ghostSegs = useMemo(() => {
    if (!ghost) return [];
    const gs = ghost.reduce((a, d) => a + Math.max(0, d.value), 0) || 1;
    let start = 0;
    return ghost.map((d) => {
      const sweep = (Math.max(0, d.value) / gs) * 360;
      const s = { ...d, start, sweep: Math.max(0, sweep - 1.2) };
      start += sweep;
      return s;
    });
  }, [ghost]);
  const shown = active ? data.find((d) => d.id === active) : undefined;
  const centre = shown ? shown.value : (total ?? sum);
  const rg = r + thickness / 2 + 6;
  const cg = 2 * Math.PI * rg;
  return (
    <div className="fh-wheel" style={{ width: size, height: size }} role="img" aria-label={summary}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden style={{ overflow: "visible" }}>
        {/* groove bed */}
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={thickness + 4} style={{ stroke: "var(--well-bg)" }} />
        <circle cx={size / 2} cy={size / 2} r={r - thickness / 2 - 2} fill="none" strokeWidth={1} style={{ stroke: "var(--groove-dark)" }} />
        <circle cx={size / 2} cy={size / 2} r={r + thickness / 2 + 2} fill="none" strokeWidth={1} style={{ stroke: "var(--groove-lite)" }} />
        {ghostSegs.map((g) => (
          <m.circle
            key={`g-${g.id}`}
            cx={size / 2}
            cy={size / 2}
            r={rg}
            fill="none"
            strokeWidth={2.5}
            strokeLinecap="round"
            style={{ stroke: g.color, originX: "50%", originY: "50%", opacity: 0.55 }}
            initial={false}
            animate={{ strokeDasharray: `${(g.sweep / 360) * cg} ${cg}`, rotate: g.start - 90 }}
            transition={spring.morph}
          />
        ))}
        {segs.map((sg, i) => {
          const len = (sg.sweep / 360) * c;
          const on = active === sg.id;
          const rad = ((sg.mid - 90) * Math.PI) / 180;
          const push = on && !reduced ? 4 : 0;
          return (
            <m.g
              key={sg.id}
              animate={{ x: Math.cos(rad) * push, y: Math.sin(rad) * push, opacity: active && !on ? 0.42 : 1 }}
              transition={spring.release}
              onMouseEnter={() => onActive?.(sg.id)}
              onMouseLeave={() => onActive?.(null)}
              onClick={onSelect ? () => onSelect(sg.id) : undefined}
              style={{ cursor: onSelect ? "pointer" : undefined }}
            >
              <m.circle
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                strokeWidth={thickness}
                strokeLinecap="butt"
                style={{ stroke: sg.color, originX: "50%", originY: "50%" }}
                initial={reduced ? false : { strokeDasharray: `0 ${c}`, rotate: sg.start - 90 }}
                animate={{ strokeDasharray: `${len} ${c}`, rotate: sg.start - 90 }}
                transition={reduced ? { duration: 0 } : { strokeDasharray: { duration: 0.7, ease: [0.16, 1, 0.3, 1], delay: i * 0.04 }, rotate: spring.morph }}
              />
              {/* lit upper lip on each segment: a thin highlight on the outer edge */}
              <m.circle
                cx={size / 2}
                cy={size / 2}
                r={r + thickness / 2 - 1}
                fill="none"
                strokeWidth={1.25}
                style={{ stroke: "rgba(255,255,255,.38)", originX: "50%", originY: "50%", mixBlendMode: "soft-light" }}
                initial={reduced ? false : { strokeDasharray: `0 ${c}`, rotate: sg.start - 90 }}
                animate={{ strokeDasharray: `${(sg.sweep / 360) * 2 * Math.PI * (r + thickness / 2 - 1)} ${c * 2}`, rotate: sg.start - 90 }}
                transition={reduced ? { duration: 0 } : { strokeDasharray: { duration: 0.7, ease: [0.16, 1, 0.3, 1], delay: i * 0.04 }, rotate: spring.morph }}
              />
            </m.g>
          );
        })}
      </svg>
      <div className="fh-wheel-centre">
        <span className="fh-wheel-label">{shown ? shown.label : centerLabel}</span>
        <span className="fh-wheel-value tabular" data-sensitive="">
          {!shown && centerValue !== undefined ? centerValue : privacy ? "•••" : <RollingNumber value={centre} format={format} countUp={false} />}
        </span>
        <span className="fh-wheel-share tabular" data-on={shown ? "" : undefined}>
          {shown ? `${((shown.value / sum) * 100).toFixed(1)}%` : " "}
        </span>
      </div>
    </div>
  );
}

/** A legend row that drives the wheel's active slice (hover/focus) — a ghost plate with a sliding value. */
export function WheelLegendRow({ slice, active, onActive, onClick, value, extra }: { slice: WheelSlice; active: string | null; onActive: (id: string | null) => void; onClick?: () => void; value: ReactNode; extra?: ReactNode }) {
  const on = active === slice.id;
  return (
    <li>
      <button
        type="button"
        className="fh-legend-row"
        data-on={on ? "" : undefined}
        data-dim={active && !on ? "" : undefined}
        onMouseEnter={() => onActive(slice.id)}
        onMouseLeave={() => onActive(null)}
        onFocus={() => onActive(slice.id)}
        onBlur={() => onActive(null)}
        onClick={onClick}
      >
        <span className="fh-legend-key" style={{ background: slice.color }} />
        <span className="truncate flex-1 text-left">{slice.label}</span>
        {extra}
        <span className="tabular fh-legend-val" data-sensitive="">
          {value}
        </span>
      </button>
    </li>
  );
}
