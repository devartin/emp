/**
 * Money HQ advisor (§16.2 rules). The life-apps advisor (`lifeapp_insights`) is authoritative; when it has nothing
 * for this instance the hub derives the same rules locally from the data it already loaded, with their inputs.
 */
import type { FinanceOverview, Forecast, Id, Insight } from "@/backend/types";
import { daysBetween, fmtMoney, fmtPct, num, todayIso, fmtWhole } from "../shared/format";
import { isSavingGroup } from "../shared/figures";
import type { Account, Ledger } from "./ledger";

export function localInsights(instanceId: Id, ov: FinanceOverview | undefined, l: Ledger, fc: Forecast | undefined): Insight[] {
  if (!ov) return [];
  const out: Insight[] = [];
  const today = todayIso();
  const dim = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0).getDate();
  const daysLeft = dim - Number(today.slice(8, 10));
  const tab = (t: string) => ({ t: "app" as const, instanceId, tab: t });
  const add = (i: Omit<Insight, "appInstanceId" | "id">) => out.push({ ...i, id: `${i.ruleId}:${out.length}`, appInstanceId: instanceId });

  for (const b of ov.budget) {
    const assigned = num(b.assigned.amount);
    const spent = -num(b.activity.amount);
    const avail = num(b.available.amount);
    if (isSavingGroup(b.group)) continue;
    if (avail < -0.005 && spent > 0) {
      add({ ruleId: "cat-over", severity: "warn", title: `${b.name} is overspent by ${fmtMoney(-avail)}`, body: "Cover it from a category with money left so the month still balances.", math: [{ label: "Assigned", value: fmtMoney(assigned) }, { label: "Spent", value: fmtMoney(spent) }, { label: "Available", value: fmtMoney(avail) }], actions: [{ label: "Open budget", route: tab("budget") }] });
    } else if (assigned > 0 && spent / assigned >= 0.9 && daysLeft >= 10) {
      add({ ruleId: "cat-90pct", severity: "tip", title: `${b.name} is ${fmtPct(spent / assigned, 0)} spent with ${daysLeft} days to go`, body: "Spent against assigned, with the days left this month.", math: [{ label: "Spent", value: fmtMoney(spent) }, { label: "Assigned", value: fmtMoney(assigned) }, { label: "Days left", value: String(daysLeft) }], actions: [{ label: "Open budget", route: tab("budget") }] });
    }
  }
  const breach = fc?.breaches[0];
  if (breach && daysBetween(today, breach.date) <= 30) {
    const acct = l.acct.get(breach.accountId);
    add({ ruleId: "forecast-breach", severity: "warn", title: `${acct?.name ?? "Checking"} may dip below ${fmtWhole(fc?.threshold ?? 0)} around ${breach.date.slice(5)}`, body: `The biggest outflows before then: ${breach.topOutflows.join(", ")}.`, math: [{ label: "Projected balance", value: fmtMoney(breach.amount) }, { label: "Low-balance threshold", value: fmtMoney(fc?.threshold ?? 0) }], actions: [{ label: "See forecast", route: tab("forecast") }] });
  }
  const ef = l.goals.find((g) => g.kind === "emergency");
  if (ef) {
    const saved = ef.accountId ? (l.acct.get(ef.accountId)?.balance ?? ef.saved) : ef.saved;
    if (saved < ef.target) {
      add({ ruleId: "ef-below-target", severity: "tip", title: `Emergency fund covers ${ov.efMonths.toFixed(1)} months of essentials`, body: `${fmtPct(saved / ef.target, 0)} of the ${fmtWhole(ef.target)} target.`, math: [{ label: "Saved", value: fmtMoney(saved) }, { label: "Target", value: fmtMoney(ef.target) }, { label: "Months of essentials", value: ov.efMonths.toFixed(2) }], actions: [{ label: "Open goals", route: tab("goals") }] });
    }
  }
  for (const r of l.recurring) {
    if (r.kind === "subscription" && r.prevAmount !== null && Math.abs(r.amount) > Math.abs(r.prevAmount) + 0.5) {
      const up = Math.abs(r.amount) - Math.abs(r.prevAmount);
      add({ ruleId: "sub-price-up", severity: "info", title: `${r.name} went up ${fmtMoney(up)} a month`, body: `${fmtMoney(up * 12)} more a year.`, math: [{ label: "Was", value: fmtMoney(Math.abs(r.prevAmount)) }, { label: "Now", value: fmtMoney(Math.abs(r.amount)) }, { label: "Per year", value: fmtMoney(up * 12) }], actions: [{ label: "Review subscriptions", route: tab("recurring") }] });
    }
  }
  if (ov.uncategorized >= 10) {
    add({ ruleId: "uncategorized", severity: "info", title: `${ov.uncategorized} transactions need a category`, body: "Uncategorised rows are not in any budget figure.", actions: [{ label: "Categorise now", route: tab("transactions") }] });
  }
  const checking = l.accounts.find((a: Account) => a.type === "checking");
  if (checking?.reconciled && daysBetween(checking.reconciled, today) > 30) {
    add({ ruleId: "reconcile-30d", severity: "tip", title: `${checking.name} hasn't been reconciled in ${daysBetween(checking.reconciled, today)} days`, body: "The cleared balance has not been checked against a statement since then.", math: [{ label: "Cleared balance", value: fmtMoney(checking.cleared) }], actions: [{ label: "Open accounts", route: tab("accounts") }] });
  }
  for (const a of l.accounts) {
    if (a.type !== "credit_card" || !a.limit) continue;
    const util = Math.max(0, -a.balance) / a.limit;
    if (util > 0.3) add({ ruleId: "util-30", severity: "tip", title: `${a.name} is at ${fmtPct(util, 0)} utilisation`, body: "Balance owed as a share of the card limit.", math: [{ label: "Balance", value: fmtMoney(-a.balance) }, { label: "Limit", value: fmtMoney(a.limit) }], actions: [{ label: "Open accounts", route: tab("accounts") }] });
  }
  const rank = { critical: 0, warn: 1, tip: 2, info: 3 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
