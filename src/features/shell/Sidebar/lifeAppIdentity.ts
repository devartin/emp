/**
 * Identity of the v1 apps (§16) for sidebar rows and breadcrumbs: the display name from the one app identity map
 * (`@/features/lifeapps/identity`, 1.0 brief §1: Tasks, Money, Investments, Taxes, …) and a monochrome Lucide glyph
 * (no tiles). Older workspaces show the new names: nothing here reads a stored page title.
 */
import { CandlestickChart, HeartPulse, Kanban, ReceiptText, LayoutGrid, Sheet, Wallet, type LucideIcon } from "lucide-react";
import { appName } from "@/features/lifeapps/identity";

export interface LifeAppIdentity {
  name: string;
  icon: LucideIcon;
}

const ICONS: Record<string, LucideIcon> = {
  "money-hq": Wallet,
  portfolio: CandlestickChart,
  "tax-organizer": ReceiptText,
  "spreadsheet-studio": Sheet,
  "life-os": Kanban,
  habits: HeartPulse,
};

export function lifeAppIdentity(appId: string): LifeAppIdentity {
  return { name: appName(appId), icon: ICONS[appId] ?? LayoutGrid };
}
