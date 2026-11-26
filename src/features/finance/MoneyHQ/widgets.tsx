/** Money HQ widgets: budget ring + envelope, metric card, hero money, transaction row. */
import { Split } from "lucide-react";
import { m } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Amount } from "@/ui/Amount";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { Sensitive } from "@/ui/Sensitive";
import { Tooltip } from "@/ui/Tooltip";
import { dayLabel, toMoney, fmtWhole } from "../shared/format";
import { baseCurrency } from "../shared/currency";
import { Glyph } from "../shared/ui";
import type { Category, Txn } from "./ledger";

/** Budget colour by ratio (§5.10): accent < 75%, warning 75–100%, loss over. */
export function budgetTone(ratio: number): string {
  return ratio > 1 ? "var(--loss)" : ratio >= 0.75 ? "var(--warning)" : "var(--accent-solid)";
}

/**
 * Progress ring with a pace tick and an overflow "second lap" at .5 (§5.10 budget bar, as a ring). Final from the
 * first frame (K3: no draw-in on arrival); a change while mounted (your own edit) eases over 240 ms.
 */
export function BudgetRing({ ratio, pace, size = 44, stroke = 4, color, children, className }: { ratio: number; pace?: number | null; size?: number; stroke?: number; color?: string; children?: ReactNode; delay?: number; className?: string }) {
  const reduced = useReducedMotionPref();
  const change = reduced ? { duration: 0 } : { duration: 0.24, ease: [0.2, 0, 0, 1] as const };
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const first = Math.max(0, Math.min(1, ratio));
  const lap = ratio > 1 ? Math.min(1, ratio - 1) : 0;
  const tone = color ?? budgetTone(ratio);
  const theta = pace !== undefined && pace !== null ? Math.max(0, Math.min(1, pace)) * Math.PI * 2 : null;
    return (
    <span className={cn("fh-ring-wrap relative inline-flex items-center justify-center flex-none", className)} style={{ width: size, height: size }} role="img" aria-label={`${Math.round(ratio * 100)}% used`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden style={{ transform: "rotate(-90deg)", overflow: "visible" }}>
        {/* flat track (v3: no engraved groove) */}
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} style={{ stroke: "var(--bg-surface-3)" }} />
        <m.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          style={{ stroke: tone }}
          strokeDasharray={c}
          initial={false}
          animate={{ strokeDashoffset: c * (1 - first) }}
          transition={change}
        />
        {lap > 0 ? (
          <m.circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} strokeLinecap="round" style={{ stroke: tone, opacity: 0.5 }} strokeDasharray={c} initial={false} animate={{ strokeDashoffset: c * (1 - lap) }} transition={change} />
        ) : null}
        {theta !== null ? (
          /* pace marker: a small ink dome sitting on the track centre-line, not a line crossing the stroke */
          <m.circle cx={size / 2 + r * Math.cos(theta)} cy={size / 2 + r * Math.sin(theta)} r={Math.max(1.75, stroke / 2)} style={{ fill: "var(--text-primary)", stroke: "var(--bg-surface-1)", strokeWidth: 1 }} initial={false} animate={{ opacity: 1 }} transition={change} />
        ) : null}
      </svg>
      {children ? <span className="absolute inset-0 inline-flex items-center justify-center">{children}</span> : null}
    </span>
  );
}

export interface EnvelopeData {
  category: Category;
  assigned: number;
  spent: number;
  available: number;
  pace: number;
}

/** A budget envelope as a ruled row: glyph, name, "left · of", and a 4px ink bar (v3: no rings on Money). */
export function Envelope({ e, onClick }: { e: EnvelopeData; onClick?: () => void; index?: number }) {
  const ratio = e.assigned > 0 ? e.spent / e.assigned : e.spent > 0 ? 2 : 0;
  const over = e.available < -0.005;
  return (
    <button type="button" className="fh-envelope" onClick={onClick} data-over={over ? "" : undefined} aria-label={`${e.category.name}: ${Math.round(ratio * 100)}% used`}>
      <Glyph name={e.category.icon} size={20} />
      <span className="min-w-0 flex-1 text-left">
        <span className="flex items-baseline gap-2">
          <span className="truncate text-body-sm text-primary flex-1">{e.category.name}</span>
          <span className={cn("text-caption tabular flex-none", over ? "text-loss-text" : "text-secondary")}>
            <Sensitive>{over ? `${fmtWhole(-e.available)} over` : `${fmtWhole(e.available)} left`}</Sensitive>
            <span className="text-tertiary"> of <Sensitive>{fmtWhole(e.assigned)}</Sensitive></span>
          </span>
        </span>
        <span className="fh-env-bar" aria-hidden>
          <i data-tone={over ? "over" : undefined} style={{ transform: `scaleX(${Math.max(0, Math.min(1, ratio))})` }} />
        </span>
      </span>
    </button>
  );
}

/**
 * The view's hero figure: kit `<Amount role="hero">` (32/38 600, symbol at full size). `cents` = an exact balance
 * (superscript cents); without it the figure rounds to whole units. Final from the first frame; scrubbing rewrites it
 * in place (no roll).
 */
export function HeroMoney({ value, currency = baseCurrency(), cents = true, className }: { value: number; currency?: string; cents?: boolean; className?: string; scrubbing?: boolean }) {
  return <Amount value={toMoney(value, currency)} role="hero" exact={cents} noCents={cents ? undefined : true} className={cn("fh-hero-amount", className)} />;
}

/** A labelled secondary figure (v3: label 12/16 secondary, value 20/26 500, no plate). Ruled when stacked in `.fh-metrics`. */
export function MetricCard({ label, value, sub, visual, onClick, tone, className }: { label: ReactNode; value: ReactNode; sub?: ReactNode; visual?: ReactNode; onClick?: () => void; tone?: "warn" | "good"; className?: string }) {
  const El = onClick ? "button" : "div";
  return (
    <El
      type={onClick ? "button" : undefined}
      className={cn("fh-metric", className)}
      onClick={onClick}
      data-tone={tone}
    >
      <span className="min-w-0 flex-1 text-left">
        <span className="block text-caption text-secondary">
          {label}
        </span>
        <span className="block fh-metric-value tabular">{value}</span>
        {sub ? <span className="block text-caption text-tertiary truncate">{sub}</span> : null}
      </span>
      {visual ? <span className="flex-none">{visual}</span> : null}
    </El>
  );
}

/** One transaction line (dashboard lists). */
export function TxnLine({ t, category, accountName, onClick }: { t: Txn; category?: Category; accountName?: string; onClick?: () => void }) {
  const transfer = !!t.transferId;
  const split = t.splits.length > 0;
  return (
    <button type="button" className="fh-row w-full text-left" onClick={onClick}>
      {transfer ? (
        <Glyph name="arrow-left-right" size={24} />
      ) : split ? (
        <span className="fh-glyph text-secondary" style={{ width: 24, height: 24 }} aria-hidden>
          <Split size={16} strokeWidth={1.25} absoluteStrokeWidth />
        </span>
      ) : category ? (
        <Glyph name={category.icon} size={24} />
      ) : (
        /* Uncategorised: a neutral tag glyph in tertiary ink (never a "?" placeholder). */
        <Glyph name="tag" size={24} className="fh-glyph-unknown" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body-sm text-primary">{t.payee || "Unknown payee"}</span>
        <span className="block truncate text-caption text-tertiary">
          {transfer ? "Transfer" : split ? `Split · ${t.splits.length} categories` : (category?.name ?? <span className="text-warning-text">Uncategorised</span>)}
          {accountName ? ` · ${accountName}` : ""}
        </span>
      </span>
      <span className="flex flex-col items-end flex-none">
        <Amount value={toMoney(t.amount)} role="row" className="text-body-sm" align="end" signed={t.amount > 0} />
        <span className="text-caption text-tertiary">
          {dayLabel(t.date)}
        </span>
      </span>
    </button>
  );
}

export function InfoTip({ children, content }: { children: ReactNode; content: ReactNode }) {
  return (
    <Tooltip content={content}>
      <span tabIndex={0} className="underline decoration-dotted underline-offset-4 decoration-[color:var(--border-strong)]">
        {children}
      </span>
    </Tooltip>
  );
}
