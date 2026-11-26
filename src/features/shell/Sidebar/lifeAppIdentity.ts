/** Identity of the v1 life apps (§16): name and monochrome Lucide glyph for sidebar rows and breadcrumbs (no tiles). */
import { CandlestickChart, HeartPulse, Kanban, ReceiptText, LayoutGrid, Sheet, Wallet, type LucideIcon } from "lucide-react";

export interface LifeAppIdentity {
  name: string;
  icon: LucideIcon;
}

const IDS: Record<string, LifeAppIdentity> = {
  "money-hq": { name: "Money HQ", icon: Wallet },
  portfolio: { name: "Portfolio", icon: CandlestickChart },
  "tax-organizer": { name: "Tax Organizer", icon: ReceiptText },
  "spreadsheet-studio": { name: "Spreadsheet Studio", icon: Sheet },
  "life-os": { name: "Life OS", icon: Kanban },
  habits: { name: "Habits", icon: HeartPulse },
};

export function lifeAppIdentity(appId: string): LifeAppIdentity {
  return IDS[appId] ?? { name: appId.replace(/(^|-)(\w)/g, (_m, s: string, c: string) => (s ? " " : "") + c.toUpperCase()), icon: LayoutGrid };
}
