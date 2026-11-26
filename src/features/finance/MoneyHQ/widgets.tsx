/** Money HQ widgets: budget ring + envelope, metric card, hero money, transaction row. */
import { ArrowLeftRight, Split } from "lucide-react";
import { m } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { moneyParts } from "@/lib/money";
import { Amount } from "@/ui/Amount";
import { RollingNumber } from "@/ui/motion/RollingNumber";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { Sensitive } from "@/ui/Sensitive";
import { Tooltip } from "@/ui/Tooltip";
import { formatNumber } from "@/lib/format";
import { dayLabel, fmtMoney, toMoney } from "../shared/format";
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
export function BudgetRing({ ratio, pace, size = 44, stroke = 4, color, children }: { ratio: number; pace?: number | null; size?: number; stroke?: number; color?: string; children?: ReactNode }) {
  const reduced = useReducedMotionPref();
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const first = Math.max(0, Math.min(1, ratio));
  const lap = ratio > 1 ? Math.min(1, ratio - 1) : 0;
  const tone = color ?? budgetTone(ratio);
  const theta = pace !== undefined && pace !== null ? Math.max(0, Math.min(1, pace)) * Math.PI * 2 : null;
  const ri = r - stroke / 2 - 1.5;
  const ro = r + stroke / 2 + 1.5;
  return (
    <span className="relative inline-flex items-center justify-center flex-none" style={{ width: size, height: size }} role="img" aria-label={`${Math.round(ratio * 100)}% used`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} style={{ stroke: "color-mix(in oklab, var(--text-primary) 8%, transparent)" }} />
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
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
        />
        {lap > 0 ? (
          <m.circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} strokeLinecap="round" style={{ stroke: tone, opacity: 0.5 }} strokeDasharray={c} initial={reduced ? false : { strokeDashoffset: c }} animate={{ strokeDashoffset: c * (1 - lap) }} transition={{ duration: 0.7, delay: 0.5, ease: [0.16, 1, 0.3, 1] }} />
        ) : null}
        {theta !== null ? (
          <line x1={size / 2 + ri * Math.cos(theta)} y1={size / 2 + ri * Math.sin(theta)} x2={size / 2 + ro * Math.cos(theta)} y2={size / 2 + ro * Math.sin(theta)} strokeWidth={2} strokeLinecap="round" style={{ stroke: "var(--text-secondary)" }} />
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

export function Envelope({ e, onClick }: { e: EnvelopeData; onClick?: () => void }) {
  const ratio = e.assigned > 0 ? e.spent / e.assigned : e.spent > 0 ? 2 : 0;
  const over = e.available < -0.005;
  return (
    <button type="button" className="fh-envelope" onClick={onClick} data-over={over ? "" : undefined}>
      <BudgetRing ratio={ratio} pace={e.pace} size={46} stroke={4}>
        <Glyph name={e.category.icon} color={e.category.color} size={26} />
      </BudgetRing>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-body-sm font-medium text-primary">{e.category.name}</span>
        <span className={cn("block text-caption tabular", over ? "text-loss-text" : "text-tertiary")} style={{ fontWeight: 500 }}>
          <Sensitive>{over ? `${fmtMoney(-e.available, "USD", { noCents: true })} over` : `${fmtMoney(e.available, "USD", { noCents: true })} left`}</Sensitive>
          <span className="text-tertiary"> · of <Sensitive>{fmtMoney(e.assigned, "USD", { noCents: true })}</Sensitive></span>
        </span>
      </span>
    </button>
  );
}

/** Large money figure with the currency symbol at 0.6× and dimmed cents; digits roll on change. */
export function HeroMoney({ value, currency = "USD", cents = true, className }: { value: number; currency?: string; cents?: boolean; className?: string }) {
  const p = moneyParts(toMoney(value, currency), { noCents: !cents });
  const n = Math.abs(value);
  const intFmt = (x: number) => formatNumber(Math.trunc(x), { maximumFractionDigits: 0 });
  return (
    <span className={cn("fh-hero-value", className)} data-sensitive="">
      {p.sign ? <span>{p.sign}</span> : null}
      {p.symbolPosition === "prefix" ? <span className="fh-sym">{p.symbol}</span> : null}
      <RollingNumber value={Math.trunc(n)} format={intFmt} />
      {cents && p.fraction ? (
        <span className="fh-cents">
          {p.decimal}
          {p.fraction}
        </span>
      ) : null}
    </span>
  );
}

export function MetricCard({ label, value, sub, visual, onClick, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; visual?: ReactNode; onClick?: () => void; tone?: "warn" | "good" }) {
  const El = onClick ? "button" : "div";
  return (
    <El type={onClick ? "button" : undefined} className="fh-metric" onClick={onClick} data-tone={tone}>
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
