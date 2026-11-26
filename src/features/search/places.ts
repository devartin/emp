/**
 * Places for ⌘K (PROGRAMME-v3 K4 "⌘K hub"): every tab of every installed life app, so "net worth", "estimator" or
 * "check-in" go straight there. Tab ids match each hub's own tab values; the keywords carry the words people use
 * for what moved inside a tab (net worth lives in Accounts; bills, debt, forecast and goals live in Plan).
 */
import type { LifeAppInstance } from "@/backend/types";
import type { AppRoute } from "@/app/router";

export interface Place {
  id: string;
  title: string;
  /** The app it belongs to ("Money HQ"). */
  app: string;
  appId: string;
  keywords: string[];
  route: AppRoute;
}

const TABS: Record<string, { tab: string; title: string; keywords?: string[] }[]> = {
  "money-hq": [
    { tab: "overview", title: "Overview", keywords: ["money", "month", "spending"] },
    { tab: "transactions", title: "Transactions", keywords: ["ledger", "review", "categorise", "categorize", "expenses"] },
    { tab: "budget", title: "Budget", keywords: ["envelopes", "assign", "left this month"] },
    { tab: "accounts", title: "Accounts", keywords: ["net worth", "networth", "balances", "reconcile", "assets", "debts"] },
    { tab: "plan", title: "Plan", keywords: ["recurring", "bills", "subscriptions", "debt", "payoff", "forecast", "goals"] },
  ],
  portfolio: [
    { tab: "overview", title: "Overview", keywords: ["investments", "allocation"] },
    { tab: "holdings", title: "Holdings", keywords: ["positions", "stocks", "lots"] },
    { tab: "performance", title: "Performance", keywords: ["returns", "benchmark"] },
    { tab: "dividends", title: "Dividends", keywords: ["income", "yield"] },
    { tab: "rebalance", title: "Rebalance", keywords: ["drift", "target"] },
    { tab: "ips", title: "Investment policy", keywords: ["ips", "policy"] },
  ],
  "tax-organizer": [
    { tab: "overview", title: "Overview", keywords: ["taxes", "checklist"] },
    { tab: "estimator", title: "Estimator", keywords: ["estimate", "refund", "owe", "tax bill"] },
    { tab: "quarterly", title: "Quarterly payments", keywords: ["estimated payments", "quarterly"] },
    { tab: "documents", title: "Documents", keywords: ["w-2", "1099", "forms"] },
    { tab: "deductions", title: "Deductions", keywords: ["credits", "charity", "itemise", "itemize"] },
  ],
  "life-os": [
    { tab: "tasks", title: "Tasks", keywords: ["inbox", "todo", "to-do", "next"] },
    { tab: "projects", title: "Projects", keywords: ["outcomes"] },
    { tab: "review", title: "Review", keywords: ["weekly review"] },
  ],
  habits: [
    { tab: "checkin", title: "Check-in", keywords: ["habits", "check in", "streaks"] },
    { tab: "habits", title: "Habits", keywords: ["heatmap", "library"] },
    { tab: "stats", title: "Stats", keywords: ["consistency", "streaks"] },
  ],
};

const NAMES: Record<string, string> = {
  "money-hq": "Money HQ",
  portfolio: "Portfolio",
  "tax-organizer": "Tax Organizer",
  "life-os": "Life OS",
  habits: "Habits",
  "spreadsheet-studio": "Spreadsheet Studio",
};

/** Places for the installed apps (`titleOf` gives an instance's own name, e.g. "Tax Year 2026"). */
export function placesFor(apps: readonly LifeAppInstance[], titleOf: (inst: LifeAppInstance) => string | undefined): Place[] {
  const out: Place[] = [];
  for (const inst of apps) {
    if (inst.detached) continue;
    const app = titleOf(inst) || NAMES[inst.appId] || inst.appId;
    for (const t of TABS[inst.appId] ?? []) {
      out.push({ id: `${inst.id}:${t.tab}`, title: t.title, app, appId: inst.appId, keywords: [app, ...(t.keywords ?? [])], route: { t: "app", instanceId: inst.id, tab: t.tab } });
    }
  }
  out.push({ id: "markets:watchlist", title: "Watchlist", app: "Markets", appId: "markets", keywords: ["markets", "quotes", "stocks"], route: { t: "markets" } });
  return out;
}
