/**
 * Rebalance planner (§15.7): new cash first, then trades inside tax-advantaged accounts, taxable sells only when
 * allowed (losses first, then highest basis); minimum trade and whole shares respected. EMP never places trades —
 * the output is a checklist to carry out at your broker.
 */
import { ArrowRight, Check, ClipboardCopy, Info, Scale } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/backend";
import type { Id, PortfolioSummary, RebalancePlan } from "@/backend/types";
import { seriesColor, useChartTheme } from "@/charts/theme";
import { notify } from "@/stores/toasts";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { Checkbox } from "@/ui/Checkbox";
import { MoneyField } from "@/ui/MoneyField";
import { RollingNumber } from "@/ui/motion/RollingNumber";
import { spring } from "@/ui/motion/tokens";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { Sensitive } from "@/ui/Sensitive";
import { Skeleton } from "@/ui/Skeleton";
import { Switch } from "@/ui/Switch";
import { assignColors, fmtPp, fmtQty, num, fmtWhole } from "../finance/shared/format";
import { Quiet, Section } from "../finance/shared/ui";
import { ticker } from "../markets/data";
import { CLASS_ORDER, usePortfolioBook } from "./data";

export default function RebalancePlanner({ instanceId, summary: s }: { instanceId: Id; summary?: PortfolioSummary }) {
  const t = useChartTheme();
  const book = usePortfolioBook(instanceId);
  const [cash, setCash] = useState<string | null>("2500.00");
  const [taxable, setTaxable] = useState(false);
  const [fractional, setFractional] = useState(true);
  const [minTrade, setMinTrade] = useState<string | null>("50.00");
  const [plan, setPlan] = useState<RebalancePlan | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const key = JSON.stringify({ cash, taxable, fractional, minTrade });
  useEffect(() => {
    let live = true;
    const h = setTimeout(() => {
      api.portfolio
        .rebalancePlan({ instanceId, newCash: cash ?? "0", allowTaxableSells: taxable, minTrade: minTrade ?? "0", fractional })
        .then((p) => live && (setPlan(p), setDone(new Set())))
        .catch((e) => notify.fromError(e, "Couldn't plan the rebalance"));
    }, 160);
    return () => {
      live = false;
      clearTimeout(h);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, instanceId]);

  const classes = useMemo(() => {
    if (!s) return [];
    const list = s.allocation.slice().sort((a, b) => CLASS_ORDER.indexOf(a.assetClass) - CLASS_ORDER.indexOf(b.assetClass));
    const colors = assignColors(list.map((x) => x.assetClass));
    return list.map((a) => ({ ...a, after: plan?.after.find((x) => x.assetClass === a.assetClass)?.pct ?? a.current, color: seriesColor(t, colors.get(a.assetClass) ?? 0) }));
  }, [s, plan, t]);
  const buys = plan?.trades.filter((x) => x.side === "buy").reduce((a, x) => a + num(x.amount), 0) ?? 0;
  const sells = plan?.trades.filter((x) => x.side === "sell").reduce((a, x) => a + num(x.amount), 0) ?? 0;
  const copy = async () => {
    if (!plan) return;
    const lines = plan.trades.map((x) => `${x.side.toUpperCase()} ${fmtQty(x.qty)} ${ticker(x.symbol)} (~${fmtWhole(x.amount)}) in ${book.accounts.get(x.accountId)?.name ?? "account"}`);
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      notify.success("Trade list copied", { description: "Paste it next to your broker's order screen." });
    } catch {
      notify.error("Couldn't copy to the clipboard");
    }
  };
  const reduced = useReducedMotionPref();
  // checklist complete → the Copy plate swaps to an "All done" badge that pops
  const allDone = !!plan?.trades.length && plan.trades.every((x) => done.has(`${x.accountId}|${x.symbol}|${x.side}`));
  if (!s) return <Skeleton height={420} radius={10} />;
  return (
    <div className="flex flex-col gap-4">
      <div className="fh-grid">
        <Section className="fh-span-4" title="Plan settings" subtitle="Cash-flow first; avoid taxable sales unless you allow them.">
          <div className="flex flex-col gap-4">
            <MoneyField label="New cash to invest" value={cash} onChange={setCash} />
            <MoneyField label="Smallest trade worth making" value={minTrade} onChange={setMinTrade} />
            <Switch checked={taxable} onCheckedChange={setTaxable} label="Allow sales in taxable accounts" description="Losses are sold first, then the highest-cost lots." />
            <Switch checked={fractional} onCheckedChange={setFractional} label="Fractional shares" description="Off rounds to whole shares (crypto stays fractional)." />
          </div>
        </Section>
        <Section className="fh-span-8" title="Before and after" subtitle={plan ? `${plan.trades.length} trades · buys ${fmtWhole(buys)} · sells ${fmtWhole(sells)}` : null}>
          <div className="pf-ba">
            {classes.map((c) => (
              <div key={c.assetClass} className="pf-ba-row">
                <span className="pf-ba-label">
                  {c.assetClass}
                </span>
                <div className="pf-ba-track">
                  {/* before: a well-tinted ghost of today's weight */}
                  <span className="pf-ba-now" style={{ transform: `scaleX(${Math.min(1, c.current / 70)})` }} />
                  {/* after: a lit bar that springs to the planned weight (settle, 40ms stagger) */}
                  <m.span
                    className="pf-ba-after"
                    style={{ ["--c" as string]: c.color, originX: 0 }}
                    initial={false}
                    animate={{ scaleX: Math.min(1, c.after / 70) }}
                    transition={reduced ? { duration: 0 } : spring.settle}
                  />
                  <span className="pf-ba-target" style={{ left: `${Math.min(100, (c.target / 70) * 100)}%` }} title={`Target ${c.target}%`} />
                </div>
                <span className="pf-ba-vals tabular">
                  {c.current.toFixed(1)}% <ArrowRight size={11} className="inline text-tertiary" />{" "}
                  <b>
                    <RollingNumber value={c.after} format={(n) => `${n.toFixed(1)}%`} countUp={false} />
                  </b>
                </span>
                <span className="pf-ba-drift tabular" data-ok={Math.abs(c.after - c.target) <= 5 ? "" : undefined}>
                  {fmtPp(c.after - c.target)}
                </span>
              </div>
            ))}
            <div className="flex items-center gap-4 mt-2 text-caption text-tertiary" style={{ fontWeight: 400 }}>
              <span className="inline-flex items-center gap-1.5"><i className="pf-key-now" />Now</span>
              <span className="inline-flex items-center gap-1.5"><i className="pf-key-after" />After plan</span>
              <span className="inline-flex items-center gap-1.5"><i className="pf-key-target" />Target</span>
            </div>
          </div>
        </Section>
      </div>
      <Section
        title="Trade checklist"
        subtitle="Ultranote never places trades. Tick each one off as you do it at your broker."
        actions={
          <>
            <AnimatePresence>
              {allDone ? (
                <m.span key="done" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.8, opacity: 0 }} transition={spring.pop} className="fh-balanced">
                  <Check size={12} strokeWidth={3} /> All trades done
                </m.span>
              ) : null}
            </AnimatePresence>
            {plan && num(plan.estRealizedGain) !== 0 ? <Badge tone="warning">Est. realised gain <Sensitive>{fmtWhole(plan.estRealizedGain, { signed: true })}</Sensitive></Badge> : null}
            <Button size="xs" variant="secondary" icon={ClipboardCopy} onClick={copy} disabled={!plan?.trades.length}>
              Copy list
            </Button>
          </>
        }
        pad={false}
      >
        {!plan ? (
          <div className="p-4">
            <Skeleton height={160} />
          </div>
        ) : plan.trades.length === 0 ? (
          <Quiet icon={Scale} title="Nothing to trade" body="Within bands with these settings. Add new cash or allow taxable sales to see more options." />
        ) : (
          <table className="fh-table">
            <thead>
              <tr>
                <th style={{ width: 44 }} />
                <th>Action</th>
                <th>Account</th>
                <th className="num">Quantity</th>
                <th className="num">Approx. amount</th>
                <th className="num">Est. gain</th>
              </tr>
            </thead>
            <tbody>
              <AnimatePresence initial={false}>
                {plan.trades.map((x, i) => {
                  const k = `${x.accountId}|${x.symbol}|${x.side}`;
                  const acct = book.accounts.get(x.accountId);
                  return (
                    <m.tr key={k} initial={{ opacity: 0, y: 4 }} animate={{ opacity: done.has(k) ? 0.45 : 1, y: 0 }} transition={{ duration: 0.2, delay: Math.min(0.2, i * 0.016) }} className="pf-trade" data-done={done.has(k) ? "" : undefined}>
                      <td>
                        <Checkbox celebrate checked={done.has(k)} onCheckedChange={() => setDone((d) => { const n = new Set(d); if (n.has(k)) n.delete(k); else n.add(k); return n; })} aria-label="Done" />
                      </td>
                      <td>
                        <span className="inline-flex items-center gap-2">
                          <span className="pf-side" data-side={x.side}>{x.side === "buy" ? "Buy" : "Sell"}</span>
                          <b className="font-semibold">{ticker(x.symbol)}</b>
                        </span>
                      </td>
                      <td className="text-secondary">
                        {acct?.name ?? "—"}
                        {acct ? <span className="text-caption text-tertiary ml-1.5">{acct.tax === "taxable" ? "taxable" : acct.tax === "deferred" ? "tax-deferred" : "tax-free"}</span> : null}
                      </td>
                      <td className="num"><Sensitive align="end">{fmtQty(x.qty)}</Sensitive></td>
                      <td className="num font-medium" data-sensitive="">
                        <RollingNumber value={num(x.amount)} format={(n) => fmtWhole(Math.round(n))} countUp={false} sensitive />
                      </td>
                      <td className="num text-secondary">{x.estRealizedGain ? <Sensitive align="end">{fmtWhole(x.estRealizedGain, { signed: true })}</Sensitive> : "—"}</td>
                    </m.tr>
                  );
                })}
              </AnimatePresence>
            </tbody>
          </table>
        )}
      </Section>
      <div className="fh-alert" data-tone="info">
        <Info size={16} />
        <span className="text-body-sm">Prices move between planning and trading; amounts are approximate. Selling in a taxable account can create a tax bill; the estimate uses your FIFO lots.</span>
      </div>
    </div>
  );
}
