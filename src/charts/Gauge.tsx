import { useEffect, useState, type ReactNode } from "react";
import { MASK, valueFormatter, type ValueFormat } from "./axis";
import { useChartTheme } from "./theme";

export interface GaugeBand {
  /** Upper bound of the band (inclusive), in value units. */
  to: number;
  tone: "gain" | "warning" | "loss" | "accent" | "neutral";
}

export interface GaugeProps {
  value: number;
  min?: number;
  max?: number;
  /** Colour the arc by the band containing the value (e.g. utilisation thresholds). */
  bands?: GaugeBand[];
  target?: number;
  label?: ReactNode;
  format?: ValueFormat;
  currency?: string;
  size?: number;
  /** Caption under the value. */
  caption?: ReactNode;
  className?: string;
}

/**
 * Semicircle gauge (score, utilisation, savings rate). Track rgba(text,.08); value arc sweeps in over 700ms outExpo
 * (instant under reduced motion); optional target tick and min/max labels.
 */
export function Gauge({ value, min = 0, max = 100, bands, target, label, format = "number", currency = "USD", size = 200, caption, className }: GaugeProps) {
  const t = useChartTheme();
  const fmt = valueFormatter(format, currency);
  const [shown, setShown] = useState(t.reducedMotion ? 1 : 0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(1));
    return () => cancelAnimationFrame(id);
  }, []);
  const stroke = Math.round(size * 0.075);
  const r = size / 2 - stroke / 2 - 2;
  const cx = size / 2;
  const cy = size / 2;
  const len = Math.PI * r;
  const frac = Math.max(0, Math.min(1, (value - min) / (max - min || 1)));
  const band = bands?.find((b) => value <= b.to) ?? bands?.[bands.length - 1];
  const toneColor = { gain: t.gain, warning: t.warning, loss: t.loss, accent: t.accent, neutral: t.textSecondary }[band?.tone ?? "accent"];
  const arc = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;
  const tAngle = target !== undefined ? Math.PI * (1 - Math.max(0, Math.min(1, (target - min) / (max - min || 1)))) : null;
  const h = size / 2 + stroke / 2 + 4;
  return (
    <div className={className} style={{ width: size }} role="meter" aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} aria-label={typeof label === "string" ? label : "Gauge"}>
      <div className="relative" style={{ width: size, height: h }}>
        <svg width={size} height={h} aria-hidden style={{ overflow: "visible" }}>
          <path d={arc} fill="none" stroke={t.text} strokeOpacity={0.08} strokeWidth={stroke} strokeLinecap="round" />
          {bands
            ? bands.map((b, i) => {
                const lo = i === 0 ? min : bands[i - 1].to;
                const a0 = (lo - min) / (max - min || 1);
                const a1 = (Math.min(b.to, max) - min) / (max - min || 1);
                return (
                  <path
                    key={i}
                    d={arc}
                    fill="none"
                    stroke={{ gain: t.gain, warning: t.warning, loss: t.loss, accent: t.accent, neutral: t.textSecondary }[b.tone]}
                    strokeOpacity={0.14}
                    strokeWidth={stroke}
                    strokeDasharray={`0 ${len * a0} ${len * (a1 - a0)} ${len}`}
                  />
                );
              })
            : null}
          <path
            d={arc}
            fill="none"
            stroke={toneColor}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={len}
            strokeDashoffset={len * (1 - frac * shown)}
            style={{ transition: t.reducedMotion ? "none" : "stroke-dashoffset 700ms cubic-bezier(.16,1,.3,1), stroke 160ms cubic-bezier(.2,0,0,1)" }}
          />
          {tAngle !== null ? (
            <line
              x1={cx + Math.cos(tAngle) * (r - stroke / 2 - 3)}
              y1={cy - Math.sin(tAngle) * (r - stroke / 2 - 3)}
              x2={cx + Math.cos(tAngle) * (r + stroke / 2 + 3)}
              y2={cy - Math.sin(tAngle) * (r + stroke / 2 + 3)}
              stroke={t.text}
              strokeWidth={2}
              strokeLinecap="round"
            />
          ) : null}
        </svg>
        <div className="absolute inset-x-0 bottom-0 flex flex-col items-center">
          <span className="tabular" style={{ fontSize: Math.round(size * 0.15), lineHeight: 1.1, fontWeight: 600, letterSpacing: "-0.02em" }}>
            {t.privacy ? MASK : fmt(value)}
          </span>
          {label ? <span className="text-caption text-secondary mt-0.5">{label}</span> : null}
        </div>
      </div>
      <div className="flex justify-between text-tertiary tabular" style={{ fontSize: 11, marginTop: 4, paddingInline: 2 }}>
        <span>{fmt(min)}</span>
        {caption ? <span className="text-secondary">{caption}</span> : null}
        <span>{fmt(max)}</span>
      </div>
    </div>
  );
}
