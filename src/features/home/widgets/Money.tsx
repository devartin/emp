/** Money snapshot (§6.4 row 2): net worth (+30-day change, 12-month sparkline), spent vs budget ring, bills due in 7
 * days, portfolio today. Every figure is masked under Hide numbers. */
import { ArrowRight, Wallet } from "lucide-react";
import { navigate } from "@/app/router";
import { Sparkline } from "@/charts/Sparkline";
import { cn } from "@/lib/cn";
import { formatCurrency } from "@/lib/format";
import { Amount } from "@/ui/Amount";
import { Button } from "@/ui/Button";
import { DeltaPill } from "@/ui/DeltaPill";
import { Ring } from "@/ui/Ring";
import { Sensitive } from "@/ui/Sensitive";
import { Skeleton } from "@/ui/Skeleton";
import { openWizard } from "@/features/lifeapps/wizardStore";
import { identity } from "@/features/lifeapps/identity";
import { localDay } from "@/features/lifeapps/cells";
import { useMoney } from "./useHomeData";

const n = (m: { amount: string } | undefined) => (m ? Number(m.amount) : 0);

function Cell({ label, children, action }: { label: string; children: React.ReactNode; action?: () => void }) {
  return (
    <div className={cn("hm-money-cell", action && "is-link")} onClick={action} role={action ? "button" : undefined} tabIndex={action ? 0 : undefined} onKeyDown={(e) => action && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), action())}>
      <span className="hm-label">{label}</span>
      {children}
    </div>
  );
}

export function MoneyWidget() {
  const { money, pf, overview, series, portfolio } = useMoney();
  const color = identity("money-hq").color;
  if (!money)
    return (
      <div className="flex h-full items-center gap-4">
        <span className="la-tile la-tile-lg" style={{ background: color }}><Wallet size={20} aria-hidden /></span>
        <div className="flex-1">
          <div className="text-body font-semibold text-primary">See your money at a glance</div>
          <div className="text-body-sm text-secondary">Set up Money HQ for net worth, budget and upcoming bills here.</div>
        </div>
        <Button variant="primary" onClick={() => openWizard("money-hq")}>Set up Money HQ</Button>
      </div>
    );
  const cur = overview?.netWorth.currency ?? "USD";
  const assigned = overview?.budget.reduce((s, b) => s + n(b.assigned), 0) ?? 0;
  const spent = overview?.budget.reduce((s, b) => s + Math.max(0, -n(b.activity)), 0) ?? 0;
  const pct = assigned ? spent / assigned : 0;
  const today = localDay();
  const in7 = new Date();
  in7.setDate(in7.getDate() + 7);
  const bills = (overview?.upcoming ?? []).filter((u) => u.due <= localDay(in7)).slice(0, 3);
  const nw = n(overview?.netWorth);
  const d30 = n(overview?.netWorthDelta30d);
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="hm-title"><Wallet size={15} aria-hidden />Money</h2>
        <Button size="xs" variant="ghost" iconRight={ArrowRight} onClick={() => navigate({ t: "app", instanceId: money.id })}>Money HQ</Button>
      </div>
      <div className="hm-money">
        <Cell label="Net worth" action={() => navigate({ t: "app", instanceId: money.id, tab: "overview" })}>
          {overview === undefined ? (
            <Skeleton height={28} width="70%" />
          ) : overview ? (
            <>
              <Amount className="hm-big" value={overview.netWorth} noCents />
              <DeltaPill value={nw - d30 ? d30 / Math.abs(nw - d30) : 0} label="30 days" />
              {series?.net.length ? <Sparkline className="mt-auto" data={series.net} height={34} color={color} aria-label="Net worth, last 12 months" /> : null}
            </>
          ) : (
            <span className="text-body-sm text-tertiary">Unavailable</span>
          )}
        </Cell>
        <Cell label="Spent vs budget" action={() => navigate({ t: "app", instanceId: money.id, tab: "budget" })}>
          {overview === undefined ? (
            <Skeleton height={64} width={64} shape="circle" />
          ) : (
            <div className="flex items-center gap-3">
              <Ring value={Math.min(1, pct)} size={64} color={pct > 1 ? "var(--loss)" : pct > 0.85 ? "var(--warning)" : color} aria-label={`${Math.round(pct * 100)}% of budget spent`}>
                <span className="text-[13px] font-semibold tabular text-primary">{Math.round(pct * 100)}%</span>
              </Ring>
              <div className="flex min-w-0 flex-col">
                <Sensitive className="text-body font-semibold tabular text-primary">{formatCurrency(Math.max(0, assigned - spent), cur, { maximumFractionDigits: 0 })}</Sensitive>
                <span className="text-caption text-tertiary">left of <Sensitive>{formatCurrency(assigned, cur, { maximumFractionDigits: 0 })}</Sensitive></span>
              </div>
            </div>
          )}
        </Cell>
        <Cell label="Bills · next 7 days" action={() => navigate({ t: "app", instanceId: money.id, tab: "bills" })}>
          {overview === undefined ? (
            <Skeleton height={56} />
          ) : bills.length ? (
            <ul className="flex flex-col gap-1">
              {bills.map((b) => (
                <li key={b.rowId} className="flex items-center gap-2 text-body-sm">
                  <span className="w-[46px] flex-none text-caption tabular text-tertiary">{b.due === today ? "Today" : new Date(`${b.due}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}</span>
                  <span className="min-w-0 flex-1 truncate text-primary">{b.name}</span>
                  <Amount value={{ amount: String(Math.abs(n(b.amount))), currency: b.amount.currency }} noCents className="text-secondary" />
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-body-sm text-tertiary">No bills due this week.</span>
          )}
        </Cell>
        <Cell label="Portfolio today" action={pf ? () => navigate({ t: "app", instanceId: pf.id }) : undefined}>
          {!pf ? (
            <Button size="sm" variant="soft" onClick={(e) => (e.stopPropagation(), openWizard("portfolio"))}>Set up Portfolio</Button>
          ) : portfolio === undefined ? (
            <Skeleton height={28} width="70%" />
          ) : portfolio ? (
            <>
              <Amount className="hm-big" value={portfolio.totalValue} noCents />
              <div className="flex items-center gap-2">
                <DeltaPill value={portfolio.dayChangePct} />
                <Amount value={portfolio.dayChange} colored noCents className="text-caption" />
              </div>
            </>
          ) : (
            <span className="text-body-sm text-tertiary">Unavailable</span>
          )}
        </Cell>
      </div>
    </div>
  );
}
