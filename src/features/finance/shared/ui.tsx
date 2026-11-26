/**
 * Shared building blocks for the finance hubs (Money HQ, Portfolio, Markets, Taxes): hub page frame with header and
 * underline tabs, section cards, glyph tiles, freshness chips, insight cards and the persistent disclaimer.
 */
import {
  AlertTriangle, ArrowLeftRight, Banknote, BellRing, Briefcase, Calculator, CandlestickChart, Car, CircleDollarSign, Clapperboard,
  CreditCard, Fuel, Gift, GraduationCap, HandCoins, HeartPulse, Home, Info, Landmark, Laptop, LifeBuoy, Lightbulb, LineChart as LineIcon, Palette,
  Palmtree, PiggyBank, Plane, Percent, Receipt, ReceiptText, Repeat, Shield, ShoppingBag, ShoppingBasket, Sofa, Sparkle, Sparkles, Target,
  TrainFront, TrendingUp, Umbrella, Utensils, Wallet, Wifi, Zap, ChevronRight, X,
} from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useState, type ReactNode } from "react";
import type { Freshness, Insight, MarketState } from "@/backend/types";
import { navigate } from "@/app/router";
import { cn } from "@/lib/cn";
import { Badge } from "@/ui/Badge";
import { Button, type IconComponent } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { Tabs, type TabItem } from "@/ui/Tabs";
import { Tooltip } from "@/ui/Tooltip";
import { spring } from "@/ui/motion/tokens";
import { blockBg, blockText } from "./format";
import "./finance.css";

// ───────────────────────────────────────────────────────────────────────────── glyphs

const GLYPHS: Record<string, IconComponent> = {
  briefcase: Briefcase, sparkles: Sparkles, percent: Percent, home: Home, zap: Zap, wifi: Wifi, shield: Shield, repeat: Repeat,
  "train-front": TrainFront, "shopping-basket": ShoppingBasket, utensils: Utensils, fuel: Fuel, sofa: Sofa, "heart-pulse": HeartPulse,
  sparkle: Sparkle, clapperboard: Clapperboard, "shopping-bag": ShoppingBag, plane: Plane, gift: Gift, palette: Palette, "life-buoy": LifeBuoy,
  palmtree: Palmtree, car: Car, umbrella: Umbrella, "trending-up": TrendingUp, landmark: Landmark, laptop: Laptop, wallet: Wallet,
  "credit-card": CreditCard, "piggy-bank": PiggyBank, banknote: Banknote, "graduation-cap": GraduationCap, target: Target, receipt: Receipt,
  "receipt-text": ReceiptText, "candlestick-chart": CandlestickChart, "line-chart": LineIcon, "arrow-left-right": ArrowLeftRight,
  calculator: Calculator, "hand-coins": HandCoins, "circle-dollar-sign": CircleDollarSign,
};

export function glyphFor(name: string | undefined): IconComponent {
  return (name && GLYPHS[name]) || CircleDollarSign;
}

export const ACCOUNT_GLYPH: Record<string, string> = {
  checking: "wallet",
  savings: "piggy-bank",
  credit_card: "credit-card",
  student_loan: "graduation-cap",
  auto_loan: "car",
  mortgage: "home",
  personal_loan: "hand-coins",
  investment: "line-chart",
  cash: "banknote",
  other_asset: "circle-dollar-sign",
  other_liability: "receipt",
};

/** Rounded glyph tile tinted with a block colour (§3.4). */
export function Glyph({ name, color = "gray", size = 28, className }: { name?: string; color?: string; size?: number; className?: string }) {
  const I = glyphFor(name);
  return (
    <span className={cn("fh-glyph", className)} style={{ width: size, height: size, color: blockText(color), background: blockBg(color), borderRadius: Math.round(size * 0.3) }} aria-hidden>
      <I size={Math.round(size * 0.55)} strokeWidth={1.75} />
    </span>
  );
}

// ───────────────────────────────────────────────────────────────────────────── hub page

export type HubTone = "jade" | "ocean" | "amber" | "iris";
const TONE: Record<HubTone, string> = { jade: "green", ocean: "blue", amber: "yellow", iris: "purple" };

export interface HubPageProps<T extends string> {
  icon: IconComponent;
  tone: HubTone;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  tabs?: TabItem<T>[];
  tab?: T;
  onTab?: (t: T) => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}

export function HubPage<T extends string>({ icon: I, tone, title, subtitle, actions, tabs, tab, onTab, children, footer, wide }: HubPageProps<T>) {
  const c = TONE[tone];
  return (
    <div className={cn("fh-page", wide && "fh-page-wide")}>
      <header className="fh-head">
        <span className="fh-head-icon" style={{ color: blockText(c), background: blockBg(c) }} aria-hidden>
          <I size={20} strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="fh-title">{title}</h1>
          {subtitle ? <div className="fh-subtitle">{subtitle}</div> : null}
        </div>
        {actions ? <div className="fh-head-actions">{actions}</div> : null}
      </header>
      {tabs && tab !== undefined && onTab ? <Tabs value={tab} onValueChange={onTab} items={tabs} className="fh-tabs" aria-label="Sections" /> : null}
      <AnimatePresence mode="wait" initial={false}>
        <m.div key={String(tab ?? "")} className="fh-body" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0, transition: { duration: 0.18, ease: [0.2, 0, 0, 1] } }} exit={{ opacity: 0, transition: { duration: 0.08 } }}>
          {children}
        </m.div>
      </AnimatePresence>
      {footer}
    </div>
  );
}

export function Section({ title, subtitle, actions, children, className, pad = true, id }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean; id?: string }) {
  return (
    <section className={cn("fh-card", !pad && "fh-card-flush", className)} id={id}>
      {title || actions ? (
        <div className={cn("fh-card-head", !pad && "px-4 pt-4")}>
          <div className="min-w-0 flex-1">
            {title ? <h2 className="fh-card-title">{title}</h2> : null}
            {subtitle ? <div className="fh-card-sub">{subtitle}</div> : null}
          </div>
          {actions ? <div className="flex items-center gap-1.5 flex-none">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** Label + value block used inside cards. */
export function Stat({ label, value, sub, align = "start", size = "md", className }: { label: ReactNode; value: ReactNode; sub?: ReactNode; align?: "start" | "end"; size?: "sm" | "md" | "lg"; className?: string }) {
  return (
    <div className={cn("fh-stat", className)} data-align={align} data-size={size}>
      <span className="fh-stat-label">{label}</span>
      <span className="fh-stat-value tabular">{value}</span>
      {sub ? <span className="fh-stat-sub">{sub}</span> : null}
    </div>
  );
}

/** Persistent footer disclaimer for finance and tax pages (§16.1 copy rules). */
export function Disclaimer({ children }: { children?: ReactNode }) {
  return (
    <footer className="fh-disclaimer">
      <Info size={13} aria-hidden />
      <span>{children ?? "Figures are calculated on this device from your own records. They are estimates to help you plan — not financial advice."}</span>
    </footer>
  );
}

// ───────────────────────────────────────────────────────────────────────────── market chips

const FRESH_LABEL: Record<Freshness, string> = { live: "Live", delayed: "15m delayed", eod: "EOD" };

export function FreshnessBadge({ freshness, source, delayedMin, cached }: { freshness: Freshness; source: string; delayedMin?: number; cached?: boolean }) {
  const label = cached ? "Cached" : freshness === "delayed" && delayedMin ? `${delayedMin}m delayed` : FRESH_LABEL[freshness];
  return (
    <Tooltip content={cached ? `Offline — last value from ${providerName(source)}` : `Source: ${providerName(source)}`}>
      <span className="fh-fresh" data-fresh={cached ? "cached" : freshness} tabIndex={0}>
        <span className="fh-fresh-dot" aria-hidden />
        {label}
      </span>
    </Tooltip>
  );
}

export function MarketStateChip({ state, asOf }: { state: MarketState; asOf: number }) {
  const t = new Date(asOf).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
  const text = state === "open" ? "Market open" : state === "pre" ? "Pre-market" : state === "post" ? `After hours · as of ${t} ET` : `Closed · as of ${t} ET`;
  return (
    <span className="fh-mstate" data-state={state}>
      <span className="fh-mstate-dot" aria-hidden />
      {text}
    </span>
  );
}

export function providerName(id: string): string {
  return ({ finnhub: "Finnhub", stooq: "Stooq", coingecko: "CoinGecko", tiingo: "Tiingo", frankfurter: "Frankfurter (ECB)", yahoo: "Yahoo (community)" } as Record<string, string>)[id] ?? id;
}

// ───────────────────────────────────────────────────────────────────────────── insights

const SEV: Record<Insight["severity"], { icon: IconComponent; tone: "info" | "accent" | "warning" | "loss"; label: string }> = {
  info: { icon: Info, tone: "info", label: "Info" },
  tip: { icon: Lightbulb, tone: "accent", label: "Tip" },
  warn: { icon: AlertTriangle, tone: "warning", label: "Heads up" },
  critical: { icon: BellRing, tone: "loss", label: "Act now" },
};

export function InsightCard({ insight, onMute, compact }: { insight: Insight; onMute?: (i: Insight) => void; compact?: boolean }) {
  const [math, setMath] = useState(false);
  const s = SEV[insight.severity];
  const I = s.icon;
  return (
    <m.article layout transition={spring.layout} className="fh-insight" data-sev={insight.severity} data-compact={compact ? "" : undefined}>
      <span className="fh-insight-icon" aria-hidden>
        <I size={15} strokeWidth={2} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <h3 className="fh-insight-title flex-1">{insight.title}</h3>
          {onMute ? <IconButton icon={X} size="xs" label="Hide for 30 days" onClick={() => onMute(insight)} /> : null}
        </div>
        <p className="fh-insight-body">{insight.body}</p>
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          {insight.actions.slice(0, 2).map((a) => (
            <Button key={a.label} size="xs" variant="secondary" iconRight={ChevronRight} onClick={() => navigate(a.route)}>
              {a.label}
            </Button>
          ))}
          {insight.math?.length ? (
            <Button size="xs" variant="ghost" onClick={() => setMath((v) => !v)} aria-expanded={math}>
              {math ? "Hide math" : "Show math"}
            </Button>
          ) : null}
        </div>
        <AnimatePresence initial={false}>
          {math && insight.math ? (
            <m.dl className="fh-insight-math" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}>
              {insight.math.map((x) => (
                <div key={x.label} className="flex items-baseline justify-between gap-3 py-1">
                  <dt className="text-secondary">{x.label}</dt>
                  <dd className="tabular font-medium" data-sensitive="">
                    {x.value}
                    {x.source ? <span className="text-tertiary font-normal ml-1.5">· {x.source}</span> : null}
                  </dd>
                </div>
              ))}
            </m.dl>
          ) : null}
        </AnimatePresence>
      </div>
    </m.article>
  );
}

export function SeverityBadge({ severity }: { severity: Insight["severity"] }) {
  const s = SEV[severity];
  return (
    <Badge tone={s.tone === "loss" ? "danger" : s.tone} icon={s.icon}>
      {s.label}
    </Badge>
  );
}

/** Thin inline legend dot. */
export function Dot({ color, className }: { color: string; className?: string }) {
  return <span className={cn("inline-block rounded-full flex-none", className)} style={{ width: 8, height: 8, background: color }} aria-hidden />;
}

/** Empty / error panel inside a card. */
export function Quiet({ icon: I = Info, title, body, action }: { icon?: IconComponent; title: ReactNode; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="fh-quiet">
      <span className="fh-quiet-icon" aria-hidden>
        <I size={18} strokeWidth={1.75} />
      </span>
      <div className="fh-quiet-title">{title}</div>
      {body ? <div className="fh-quiet-body">{body}</div> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
