/**
 * Life-app identity (§6.5 table): colour, lucide icon and category for each v1 app, plus a name → icon map for the
 * icons manifests reference in their options. Colours are the accent solids (§3.2) so tiles read well in both themes.
 */
import {
  Ban, Calendar, CalendarClock, CandlestickChart, ChartArea, ChartColumn, ChartLine, ChartPie, Clock, CircleDot, File, FlaskConical, Folders,
  Hammer, HeartPulse, History, Hourglass, Inbox, Kanban, Landmark, List, Lock, Package, Percent, PieChart, ReceiptText,
  Rocket, Scale, Sheet, ShieldCheck, Shuffle, SlidersHorizontal, Snowflake, Split, Sprout, Sun, Table2, Target,
  TrendingDown, TrendingUp, Upload, User, Users, Wallet, type LucideIcon,
} from "lucide-react";

export interface AppIdentity {
  id: string;
  name: string;
  /** Solid colour (tiles, rings, charts). */
  color: string;
  icon: LucideIcon;
  category: string;
}

export const APP_IDENTITY: Record<string, AppIdentity> = {
  "money-hq": { id: "money-hq", name: "Money HQ", color: "#0C7D56", icon: Wallet, category: "finance" },
  portfolio: { id: "portfolio", name: "Portfolio", color: "#0B6BDF", icon: CandlestickChart, category: "investing" },
  "tax-organizer": { id: "tax-organizer", name: "Tax Organizer", color: "#C77A00", icon: ReceiptText, category: "tax" },
  "spreadsheet-studio": { id: "spreadsheet-studio", name: "Spreadsheet Studio", color: "#5E5CE6", icon: Sheet, category: "sheets" },
  "life-os": { id: "life-os", name: "Life OS", color: "#1F6FD1", icon: Kanban, category: "planning" },
  habits: { id: "habits", name: "Habits", color: "#CC3344", icon: HeartPulse, category: "health" },
};

export function identity(appId: string): AppIdentity {
  return APP_IDENTITY[appId] ?? { id: appId, name: appId.replace(/(^|-)(\w)/g, (_m, s: string, c: string) => (s ? " " : "") + c.toUpperCase()), color: "#52525B", icon: CircleDot, category: "other" };
}

export const CATEGORY_LABEL: Record<string, string> = {
  all: "All",
  finance: "Money",
  investing: "Investing",
  tax: "Taxes",
  sheets: "Spreadsheets",
  planning: "Planning",
  health: "Health",
};

const ICONS: Record<string, LucideIcon> = {
  wallet: Wallet, "candlestick-chart": CandlestickChart, "receipt-text": ReceiptText, sheet: Sheet, kanban: Kanban, "heart-pulse": HeartPulse,
  user: User, users: Users, percent: Percent, "pie-chart": PieChart, target: Target, "trending-down": TrendingDown, snowflake: Snowflake,
  upload: Upload, file: File, "flask-conical": FlaskConical, sprout: Sprout, "trending-up": TrendingUp, list: List, history: History, scale: Scale,
  hourglass: Hourglass, rocket: Rocket, "sliders-horizontal": SlidersHorizontal, landmark: Landmark, hammer: Hammer, clock: Clock,
  package: Package, split: Split, "table-2": Table2, ban: Ban, "chart-line": ChartLine, "chart-column": ChartColumn, "chart-area": ChartArea,
  "chart-pie": ChartPie, sun: Sun, inbox: Inbox, "calendar-clock": CalendarClock, folders: Folders, shuffle: Shuffle, lock: Lock,
  "shield-check": ShieldCheck, calendar: Calendar,
};

export function iconByName(name: string | undefined): LucideIcon | undefined {
  return name ? ICONS[name] : undefined;
}

/** Apps whose hub renders this feature's AppHeader (the others are the finance feature's hubs). */
export const OWN_HUBS: ReadonlySet<string> = new Set(["life-os", "habits", "spreadsheet-studio"]);

/** CSS custom properties that tint a subtree with an app's colour. */
export function appVars(appId: string): Record<string, string> {
  const c = identity(appId).color;
  return { "--app": c, "--app-soft": `color-mix(in oklab, ${c} 12%, transparent)`, "--app-softer": `color-mix(in oklab, ${c} 7%, transparent)` } as Record<string, string>;
}
