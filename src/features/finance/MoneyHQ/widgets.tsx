/** Money HQ widgets: budget ring + envelope, metric card, hero money, transaction row. */
import { ArrowLeftRight, Split } from "lucide-react";
import { m } from "motion/react";
import { useMemo, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { currencyDecimals, moneyParts } from "@/lib/money";
import { Amount } from "@/ui/Amount";
import { EdgeLight } from "@/ui/motion/EdgeLight";
import { RollingNumber } from "@/ui/motion/RollingNumber";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { Sensitive } from "@/ui/Sensitive";
import { Tooltip } from "@/ui/Tooltip";
import { formatNumber } from "@/lib/format";
import { dayLabel, toMoney, fmtWhole } from "../shared/format";
import { baseCurrency } from "../shared/currency";
import { Glyph } from "../shared/ui";
import type { Category, Txn } from "./ledger";

/** Budget colour by ratio (§5.10): accent < 75%, warning 75–100%, loss over. */
export function budgetTone(ratio: number): string {
  return ratio > 1 ? "var(--loss)" : ratio >= 0.75 ? "var(--warning)" : "var(--accent-solid)";
}

/**
 * Progress ring with a pace tick and an overflow "second lap" at .5 (§5.10 budget bar, as a ring). Draws in with
 * pathLength on mount; reduced motion shows the final state.
 */
export function BudgetRing({ ratio, pace, size = 44, stroke = 4, color, children, delay = 0, className }: { ratio: number; pace?: number | null; size?: number; stroke?: number; color?: string; children?: ReactNode; delay?: number; className?: string }) {
  const reduced = useReducedMotionPref();
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const first = Math.max(0, Math.min(1, ratio));
  const lap = ratio > 1 ? Math.min(1, ratio - 1) : 0;
  const tone = color ?? budgetTone(ratio);
  const theta = pace !== undefined && pace !== null ? Math.max(0, Math.min(1, pace)) * Math.PI * 2 : null;
    return (
    <span className={cn("fh-ring-wrap relative inline-flex items-center justify-center flex-none", className)} style={{ width: size, height: size }} role="img" aria-label={`${Math.round(ratio * 100)}% used`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden style={{ transform: "rotate(-90deg)", overflow: "visible" }}>
        {/* engraved groove track: dark inner edge + light lower lip */}
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke + 1} style={{ stroke: "var(--well-bg)" }} />
        <circle cx={size / 2} cy={size / 2} r={r - stroke / 2 - 0.25} fill="none" strokeWidth={0.75} style={{ stroke: "var(--groove-dark)" }} />
        <circle cx={size / 2} cy={size / 2} r={r + stroke / 2 + 0.25} fill="none" strokeWidth={0.75} style={{ stroke: "var(--groove-lite)" }} />
        <m.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          style={{ stroke: tone }}
          strokeDasharray={c}
          initial={reduced ? false : { strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - first) }}
          transition={{ duration: 0.9, delay, ease: [0.16, 1, 0.3, 1] }}
        />
        {lap > 0 ? (
          <m.circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} strokeLinecap="round" style={{ stroke: tone, opacity: 0.5 }} strokeDasharray={c} initial={reduced ? false : { strokeDashoffset: c }} animate={{ strokeDashoffset: c * (1 - lap) }} transition={{ duration: 0.7, delay: delay + 0.6, ease: [0.16, 1, 0.3, 1] }} />
        ) : null}
        {theta !== null ? (
          /* pace marker: a small ink dome sitting on the track centre-line, not a line crossing the stroke */
          <m.circle cx={size / 2 + r * Math.cos(theta)} cy={size / 2 + r * Math.sin(theta)} r={Math.max(1.75, stroke / 2)} style={{ fill: "var(--text-primary)", stroke: "var(--bg-surface-1)", strokeWidth: 1 }} initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2, delay: delay + 0.7 }} />
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

export function Envelope({ e, onClick, index = 0 }: { e: EnvelopeData; onClick?: () => void; index?: number }) {
  const ratio = e.assigned > 0 ? e.spent / e.assigned : e.spent > 0 ? 2 : 0;
  const over = e.available < -0.005;
  return (
    <button type="button" className="fh-envelope" onClick={onClick} data-over={over ? "" : undefined}>
      <BudgetRing ratio={ratio} pace={e.pace} size={46} stroke={4} delay={0.12 + Math.min(index, 8) * 0.05}>
        <Glyph name={e.category.icon} color={e.category.color} size={26} />
      </BudgetRing>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-body-sm font-medium text-primary">{e.category.name}</span>
        <span className={cn("block text-caption tabular", over ? "text-loss-text" : "text-tertiary")} style={{ fontWeight: 500 }}>
          <Sensitive>{over ? `${fmtWhole(-e.available)} over` : `${fmtWhole(e.available)} left`}</Sensitive>
          <span className="text-tertiary"> · of <Sensitive>{fmtWhole(e.assigned)}</Sensitive></span>
        </span>
      </span>
    </button>
  );
}

/** Large money figure with the currency symbol at 0.6× and dimmed cents; digits roll on change (count up once per session with `countUpKey`). */
export function HeroMoney({ value, currency = baseCurrency(), cents = true, className, countUpKey, scrubbing }: { value: number; currency?: string; cents?: boolean; className?: string; countUpKey?: string; scrubbing?: boolean }) {
  // Symbol, its position, the decimal mark and the minus glyph depend on the currency only — resolve them once, not
  // on every scrub frame (moneyParts builds Intl formatters).
  const shape = useMemo(() => ({ ...moneyParts(toMoney(-1.5, currency)), digits: currencyDecimals(currency) }), [currency]);
  // Without cents the figure rounds like fmtMoney(…, { noCents }) does, so the hero and any legend agree to the dollar.
  const [intPart, fraction = ""] = Math.abs(value).toFixed(cents ? shape.digits : 0).split(".");
  const n = Number(intPart);
  const negative = value < 0 && (n > 0 || /[1-9]/.test(fraction));
  const intFmt = (x: number) => formatNumber(Math.round(x), { maximumFractionDigits: 0 });
  return (
    <span className={cn("fh-hero-value", className)} data-sensitive="">
      {negative ? <span>{shape.sign}</span> : null}
      {shape.symbolPosition === "prefix" ? <span className="fh-sym">{shape.symbol}</span> : null}
      <RollingNumber value={n} format={intFmt} countUpKey={countUpKey} countUpDuration={countUpKey ? 1.3 : undefined} scrubbing={scrubbing} />
      {fraction ? (
        <span className="fh-cents">
          {shape.decimal}
          {fraction}
        </span>
      ) : null}
      {shape.symbolPosition === "suffix" ? <span className="fh-sym">{shape.symbol}</span> : null}
    </span>
  );
}

/** KPI plate: a machined panel; clickable ones lift, catch the pointer light and tilt ≤ 3° (§4.5). */
export function MetricCard({ label, value, sub, visual, onClick, tone, className }: { label: ReactNode; value: ReactNode; sub?: ReactNode; visual?: ReactNode; onClick?: () => void; tone?: "warn" | "good"; className?: string }) {
  const El = onClick ? "button" : "div";
  return (
    <El
      type={onClick ? "button" : undefined}
      className={cn("fh-metric panel", className)}
      onClick={onClick}
      data-tone={tone}
      data-raise={onClick ? "" : undefined}
      data-light=""
      data-tilt={onClick ? "3" : undefined}
    >
      <EdgeLight specular={!!onClick} />
      <span className="min-w-0 flex-1 text-left">
        <span className="block text-caption text-secondary" style={{ fontWeight: 500 }}>
          {label}
        </span>
        <span className="block fh-metric-value tabular">{value}</span>
        {sub ? <span className="block text-caption text-tertiary truncate" style={{ fontWeight: 400 }}>{sub}</span> : null}
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
        <span className="fh-glyph" style={{ width: 30, height: 30, borderRadius: 9, background: "var(--bg-surface-2)", color: "var(--text-secondary)" }}>
          <ArrowLeftRight size={15} />
        </span>
      ) : split ? (
        <span className="fh-glyph" style={{ width: 30, height: 30, borderRadius: 9, background: "var(--bg-surface-2)", color: "var(--text-secondary)" }}>
          <Split size={15} />
        </span>
      ) : category ? (
        <Glyph name={category.icon} color={category.color} size={30} />
      ) : (
        <span className="fh-glyph fh-glyph-unknown" style={{ width: 30, height: 30, borderRadius: 9 }} aria-hidden>
          ?
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body-sm font-medium text-primary">{t.payee || "Unknown payee"}</span>
        <span className="block truncate text-caption text-tertiary" style={{ fontWeight: 400 }}>
          {transfer ? "Transfer" : split ? `Split · ${t.splits.length} categories` : (category?.name ?? <span className="text-warning-text">Uncategorised</span>)}
          {accountName ? ` · ${accountName}` : ""}
        </span>
      </span>
      <span className="flex flex-col items-end flex-none">
        <Amount value={toMoney(t.amount)} colored={t.amount > 0} className="text-body-sm font-medium" align="end" signed={t.amount > 0} />
        <span className="text-caption text-tertiary" style={{ fontWeight: 400 }}>
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
