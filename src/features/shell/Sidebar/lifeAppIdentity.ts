/** Identity of the v1 life apps (§16): name, accent colour and lucide icon, used for the 18px sidebar tiles. */
import { CandlestickChart, HeartPulse, Kanban, ReceiptText, Sheet, Sparkles, Wallet, type LucideIcon } from "lucide-react";

export interface LifeAppIdentity {
  name: string;
  /** Tile fill (accent solids from §3.2; blue from the categorical palette). */
  color: string;
  icon: LucideIcon;
}

const IDS: Record<string, LifeAppIdentity> = {
  "money-hq": { name: "Money HQ", color: "#0C7D56", icon: Wallet },
  portfolio: { name: "Portfolio", color: "#0B6BDF", icon: CandlestickChart },
  "tax-organizer": { name: "Tax Organizer", color: "#C77A00", icon: ReceiptText },
  "spreadsheet-studio": { name: "Spreadsheet Studio", color: "#5E5CE6", icon: Sheet },
  "life-os": { name: "Life OS", color: "#1F6FD1", icon: Kanban },
  habits: { name: "Habits", color: "#CC3344", icon: HeartPulse },
};

export function lifeAppIdentity(appId: string): LifeAppIdentity {
  return IDS[appId] ?? { name: appId.replace(/(^|-)(\w)/g, (_m, s: string, c: string) => (s ? " " : "") + c.toUpperCase()), color: "#52525B", icon: Sparkles };
}
