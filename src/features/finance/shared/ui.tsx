/**
 * Shared building blocks for the finance hubs (Money HQ, Portfolio, Markets, Taxes): hub page frame with header and
 * underline tabs, section cards, glyph tiles, freshness chips, insight cards and the persistent disclaimer.
 */
import {
  AlertTriangle, ArrowLeftRight, Banknote, BellRing, Briefcase, Calculator, CandlestickChart, Car, CircleDollarSign, Clapperboard,
  CreditCard, Fuel, Gift, GraduationCap, HandCoins, HeartPulse, Home, Info, Landmark, Laptop, LifeBuoy, Lightbulb, LineChart as LineIcon, Palette,
  Palmtree, PiggyBank, Plane, Percent, Receipt, ReceiptText, Repeat, Shield, ShoppingBag, ShoppingBasket, Sofa, Target,
  TrainFront, TrendingUp, Umbrella, Utensils, Wallet, Wifi, Zap, ChevronRight, X,
} from "lucide-react";
import type { ReactNode } from "react";
import type { Freshness, Insight, MarketState } from "@/backend/types";
import { navigate } from "@/app/router";
import { cn } from "@/lib/cn";
import { Badge } from "@/ui/Badge";
import { Button, type IconComponent } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { Tabs, type TabItem } from "@/ui/Tabs";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/Popover";
import { Tooltip } from "@/ui/Tooltip";
import { Glyph as KitGlyph, hasGlyph } from "@/ui/icons/Icon";
import "./finance.css";

// ───────────────────────────────────────────────────────────────────────────── glyphs

const GLYPHS: Record<string, IconComponent> = {
  briefcase: Briefcase, percent: Percent, home: Home, zap: Zap, wifi: Wifi, shield: Shield, repeat: Repeat,
  "train-front": TrainFront, "shopping-basket": ShoppingBasket, utensils: Utensils, fuel: Fuel, sofa: Sofa, "heart-pulse": HeartPulse,
  clapperboard: Clapperboard, "shopping-bag": ShoppingBag, plane: Plane, gift: Gift, palette: Palette, "life-buoy": LifeBuoy,
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

/** Finance glyph names the kit registry spells differently (seed and stored categories keep their old names). */
const KIT_ALIAS: Record<string, string> = {
  home: "house", palmtree: "tree-palm", "line-chart": "chart-line", "candlestick-chart": "chart-column",
  "receipt-text": "receipt", "circle-dollar-sign": "dollar-sign",
};

/** The kit registry name a finance glyph resolves to, or null when only the local set has it. */
export function kitGlyphName(name: string | undefined): string | null {
  if (!name) return null;
  const n = KIT_ALIAS[name] ?? name;
  return hasGlyph(n) ? n : null;
}

/**
 * A category / account glyph in the one glyph language (DESIGN v3 §1.5, §8): a monochrome Lucide line glyph in
 * secondary ink, absoluteStrokeWidth, from the kit registry first. No tinted tile, never a "?" placeholder. `color` is
 * accepted for API compatibility and ignored (identity colour only appears as a 6px dot in charts).
 */
export function Glyph({ name, size = 28, className }: { name?: string; color?: string; size?: number; className?: string }) {
  const px = Math.max(14, Math.min(20, Math.round(size * 0.55)));
  const kit = kitGlyphName(name);
  const I = kit ? null : glyphFor(name);
  return (
    <span className={cn("fh-glyph text-secondary", className)} style={{ width: size, height: size }} aria-hidden>
      {kit ? <KitGlyph name={kit} size={px} /> : I ? <I size={px} strokeWidth={(1.25 * 24) / px} /> : null}
    </span>
  );
}

// ───────────────────────────────────────────────────────────────────────────── hub page

export type HubTone = "jade" | "ocean" | "amber" | "iris";

export interface HubPageProps<T extends string> {
  /** @deprecated v3 draws no icon beside hub titles (no icons in headings); accepted and ignored. */
  icon?: IconComponent;
  /** @deprecated accepted and ignored. */
  tone?: HubTone;
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

export function HubPage<T extends string>({ title, subtitle, actions, tabs, tab, onTab, children, footer, wide }: HubPageProps<T>) {
  // Tab changes are constant-class (K3 C0): the new panel is present at frame 1, no slide or fade.
  return (
    <div className={cn("fh-page", wide && "fh-page-wide")}>
      <header className="fh-head">
        <div className="min-w-0 flex-1">
          <h1 className="fh-title">{title}</h1>
          {subtitle ? <div className="fh-subtitle">{subtitle}</div> : null}
        </div>
        {actions ? <div className="fh-head-actions">{actions}</div> : null}
      </header>
      {tabs && tab !== undefined && onTab ? <Tabs value={tab} onValueChange={onTab} items={tabs} className="fh-tabs" aria-label="Sections" /> : null}
      <div key={String(tab ?? "")} className="fh-body">
        {children}
      </div>
      {footer}
    </div>
  );
}

export function Section({ title, subtitle, actions, children, className, pad = true, id }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean; id?: string }) {
  return (
    <section className={cn("fh-card", !pad && "fh-card-flush", className)} id={id}>
      {title || actions ? (
        <div className="fh-card-head">
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
      <span>{children ?? "Figures are calculated on this device from your own records. They are estimates for planning, not financial advice."}</span>
    </footer>
  );
}

// ───────────────────────────────────────────────────────────────────────────── market chips

const FRESH_LABEL: Record<Freshness, string> = { live: "Live", delayed: "15m delayed", eod: "EOD" };

export function FreshnessBadge({ freshness, source, delayedMin, cached }: { freshness: Freshness; source: string; delayedMin?: number; cached?: boolean }) {
  const label = cached ? "Cached" : freshness === "delayed" && delayedMin ? `${delayedMin}m delayed` : FRESH_LABEL[freshness];
  return (
    <Tooltip content={cached ? `Offline. Last value from ${providerName(source)}` : `Source: ${providerName(source)}`}>
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

/**
 * Disclosure content (DESIGN §5.4 rule 5): opacity + a 4px rise, never `height`. Exits fade over 120ms; use with
 * `AnimatePresence mode="popLayout"` and a `layout` parent (or `useFlip`) so displaced siblings glide via transforms.
 */
export const disclose = {
  initial: { opacity: 0, y: -4 },
  // a beat late, so siblings gliding out of the way (useFlip / layout) have mostly cleared the space first
  animate: { opacity: 1, y: 0, transition: { duration: 0.18, delay: 0.1, ease: [0.2, 0, 0, 1] as const } },
  exit: { opacity: 0, y: 0, transition: { duration: 0.12, ease: [0.4, 0, 1, 1] as const } },
};

const SEV: Record<Insight["severity"], { icon: IconComponent; tone: "info" | "accent" | "warning" | "loss"; label: string }> = {
  info: { icon: Info, tone: "info", label: "Info" },
  tip: { icon: Lightbulb, tone: "accent", label: "Tip" },
  warn: { icon: AlertTriangle, tone: "warning", label: "Heads up" },
  critical: { icon: BellRing, tone: "loss", label: "Act now" },
};

/**
 * An insight: its title is the fact, and the title itself discloses the "why" (inputs and the reasoning) in a kit
 * Popover — no separate "Show math" button (N-MO3).
 */
export function InsightCard({ insight, onMute, compact }: { insight: Insight; onMute?: (i: Insight) => void; compact?: boolean }) {
  const s = SEV[insight.severity];
  const I = s.icon;
  const hasWhy = !!(insight.math?.length || insight.body);
  return (
    <article className="fh-insight" data-sev={insight.severity} data-compact={compact ? "" : undefined}>
      <span className="fh-insight-icon" aria-hidden>
        <I size={16} strokeWidth={1.875} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <h3 className="fh-insight-title flex-1">
            {hasWhy ? (
              <Popover>
                <PopoverTrigger asChild>
                  <button type="button" className="fh-figure text-left" aria-haspopup="dialog">
                    {insight.title}
                  </button>
                </PopoverTrigger>
                <PopoverContent side="bottom" align="start" className="fh-figure-pop">
                  <div className="fh-figure-title">{insight.title}</div>
                  {insight.body ? <p className="fh-figure-def">{insight.body}</p> : null}
                  {insight.math?.length ? (
                    <dl className="fh-figure-inputs">
                      {insight.math.map((x) => (
                        <div key={x.label}>
                          <dt>{x.label}</dt>
                          <dd className="tabular" data-sensitive="">
                            {x.value}
                            {x.source ? <span className="text-tertiary font-normal ml-1.5">· {x.source}</span> : null}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                </PopoverContent>
              </Popover>
            ) : (
              insight.title
            )}
          </h3>
          {onMute ? <IconButton icon={X} size="xs" label="Hide for 30 days" onClick={() => onMute(insight)} /> : null}
        </div>
        {insight.actions.length ? (
          <div className="flex flex-wrap items-center gap-1.5 mt-2">
            {insight.actions.slice(0, 2).map((a) => (
              <Button key={a.label} size="xs" variant="ghost" iconRight={ChevronRight} onClick={() => navigate(a.route)}>
                {a.label}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    </article>
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
        <I size={24} strokeWidth={1.25} />
      </span>
      <div className="fh-quiet-title">{title}</div>
      {body ? <div className="fh-quiet-body">{body}</div> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
