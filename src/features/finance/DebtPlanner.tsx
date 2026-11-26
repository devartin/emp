/**
 * Debt planner (§15.5): avalanche vs snowball vs hybrid with an extra-payment slider, a comparison chart of total
 * balance over time against minimum payments, a per-debt payoff stack for the chosen strategy, and the payoff
 * order. Debts start from Money HQ's loan and card accounts and can be edited as a what-if.
 */
import { Blend, Check, Plus, Snowflake, TrendingDown, Trophy, X, Zap } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "@/backend";
import type { DebtPlan, DebtStrategy } from "@/backend/types";
import { LineChart } from "@/charts/Line";
import { cn } from "@/lib/cn";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { Input } from "@/ui/Input";
import { MoneyField } from "@/ui/MoneyField";
import { NumberField } from "@/ui/NumberField";
import { RollingNumber } from "@/ui/motion/RollingNumber";
import { spring } from "@/ui/motion/tokens";
import { Sensitive } from "@/ui/Sensitive";
import { Slider } from "@/ui/Slider";
import { Skeleton } from "@/ui/Skeleton";
import { DebtRace } from "./DebtRace";
import { StackedAreaChart } from "./shared/charts";
import { addMonths, monthLabel, num, fmtWhole } from "./shared/format";
import { Quiet, Section } from "./shared/ui";
import { debtInputs, debtPlanStart, useLedgerCtx } from "./MoneyHQ/ledger";
import { useMoney } from "./MoneyHQ/MoneyHQ";
import { Figure } from "./shared/Figure";
import { loadDebtPlanChoice, saveDebtPlanChoice, useDebtPlanChoice } from "./shared/debtPlanChoice";

interface DebtRow {
  key: string;
  name: string;
  balance: string;
  aprPct: string;
  minPayment: string;
}

const STRATS: { id: DebtStrategy; title: string; blurb: string; icon: typeof Zap }[] = [
  { id: "avalanche", title: "Avalanche", blurb: "Highest APR first. Least interest", icon: Zap },
  { id: "snowball", title: "Snowball", blurb: "Smallest balance first", icon: Snowflake },
  { id: "hybrid", title: "Hybrid", blurb: "Two quick wins, then avalanche", icon: Blend },
];

export default function DebtPlanner() {
  const l = useLedgerCtx();
  const { instanceId } = useMoney();
  const saved = useDebtPlanChoice(instanceId);
  useEffect(() => void loadDebtPlanChoice(instanceId), [instanceId]);
  const [debts, setDebts] = useState<DebtRow[] | null>(null);
  const [extra, setExtra] = useState(saved?.extra ?? 200);
  const [strategy, setStrategy] = useState<DebtStrategy>(saved?.strategy ?? "avalanche");
  // The saved choice arrives from the vault: start from it once, unless the user has already changed something.
  const interacted = useRef(false);
  useEffect(() => {
    if (!saved || interacted.current) return;
    setStrategy(saved.strategy);
    setExtra(saved.extra);
  }, [saved]);
  const [plans, setPlans] = useState<Record<string, DebtPlan> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (debts || l.loading) return;
    setDebts(debtInputs(l.accounts));
  }, [l.loading, l.accounts, debts]);

  const startMonth = debtPlanStart();
  const reqKey = JSON.stringify({ debts, extra });
  useEffect(() => {
    if (!debts?.length) return;
    let live = true;
    const t = setTimeout(async () => {
      try {
        const base = { debts: debts.map(({ name, balance, aprPct, minPayment }) => ({ name, balance, aprPct, minPayment })), extraMonthly: String(extra), startMonth };
        const out: Record<string, DebtPlan> = {};
        await Promise.all(STRATS.map(async (s) => (out[s.id] = await api.finance.debtPlan({ ...base, strategy: s.id }))));
        if (live) {
          setPlans(out);
          setError(null);
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "Couldn't compute the plan");
      }
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqKey]);

  // "Your plan" (definitions.ts `debtFree.plan`) is what the user chose here — saved only by a user action (picking a
  // strategy, releasing the slider), never by opening the planner, and only while the debts are the ledger's, not an
  // edited what-if. Until then the Overview keeps `debtFree.minimum`.
  const ledgerDebts = useMemo(() => JSON.stringify(debtInputs(l.accounts).map((d) => [d.name, d.balance, d.aprPct, d.minPayment])), [l.accounts]);
  const isLedger = !!debts && JSON.stringify(debts.map((d) => [d.name, d.balance, d.aprPct, d.minPayment])) === ledgerDebts;
  const choose = (next: { strategy?: DebtStrategy; extra?: number }) => {
    interacted.current = true;
    const st = next.strategy ?? strategy;
    const ex = next.extra ?? extra;
    if (next.strategy) setStrategy(next.strategy);
    if (next.extra !== undefined) setExtra(next.extra);
    if (isLedger && st !== "custom") void saveDebtPlanChoice(instanceId, { strategy: st, extra: ex });
  };
  const isYourPlan = isLedger && !!saved && saved.strategy === strategy && saved.extra === extra;

  const summary = plans?.avalanche.strategies ?? [];
  const byId = Object.fromEntries(summary.map((s) => [s.strategy, s]));
  const best = summary.filter((s) => s.strategy !== "minimum").sort((a, b) => num(a.totalInterest) - num(b.totalInterest))[0]?.strategy;
  const minimum = byId.minimum;
  const sel = byId[strategy];
  const plan = plans?.[strategy];

  const comparison = useMemo(() => {
    if (!plans) return [];
    const len = Math.max(...STRATS.map((s) => plans[s.id].schedule.length));
    const total = (p: DebtPlan, i: number) => {
      const row = p.schedule[Math.min(i, p.schedule.length - 1)];
      return i >= p.schedule.length ? 0 : Object.values(row?.balances ?? {}).reduce((a, v) => a + num(v), 0);
    };
    const start = debts?.reduce((a, d) => a + num(d.balance), 0) ?? 0;
    const pts = [{ m: addMonths(startMonth, -1), avalanche: start, snowball: start, hybrid: start }];
    for (let i = 0; i < len; i++) pts.push({ m: addMonths(startMonth, i), avalanche: total(plans.avalanche, i), snowball: total(plans.snowball, i), hybrid: total(plans.hybrid, i) });
    return pts;
  }, [plans, debts, startMonth]);

  // unselected strategies recede as tertiary dashes; the chosen one renders last (on top) in ink
  const chartSeries = useMemo(
    () => [...STRATS.filter((s) => s.id !== strategy).map((s) => ({ key: s.id, label: s.title, color: "var(--text-tertiary)", dashed: true })), ...STRATS.filter((s) => s.id === strategy).map((s) => ({ key: s.id, label: s.title, color: "var(--chart-line)" }))],
    [strategy],
  );

  const stack = useMemo(() => {
    if (!plan || !debts) return [];
    return plan.schedule.map((row) => ({ m: row.month, ...Object.fromEntries(debts.map((d) => [d.key, num(row.balances[d.name])])) }));
  }, [plan, debts]);

  const order = useMemo(() => {
    if (!plan || !debts) return [];
    return debts
      .map((d) => {
        const idx = plan.schedule.findIndex((r) => num(r.balances[d.name]) <= 0.004);
        return { d, month: idx >= 0 ? plan.schedule[idx].month : null, idx };
      })
      .sort((a, b) => (a.idx < 0 ? 9999 : a.idx) - (b.idx < 0 ? 9999 : b.idx));
  }, [plan, debts]);

  if (l.loading || !debts) return <Skeleton height={420} radius={10} />;
  if (!debts.length)
    return (
      <Section>
        <Quiet icon={Trophy} title="No debts to plan" body="None of your accounts carries a balance owed. If that changes, the planner will compare payoff strategies for you." action={<Button icon={Plus} onClick={() => setDebts([{ key: "new", name: "New debt", balance: "1000", aprPct: "18", minPayment: "35" }])}>Try a what-if</Button>} />
      </Section>
    );

  const totalDebt = debts.reduce((a, d) => a + num(d.balance), 0);
  const totalMin = debts.reduce((a, d) => a + num(d.minPayment), 0);
  return (
    <div className="flex flex-col gap-4">
      <div className="fh-grid">
        <section className="fh-card fh-span-5 flex flex-col gap-4">
          <div>
            <div className="text-caption text-secondary" style={{ fontWeight: 500 }}>
              Extra each month
            </div>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="tabular text-kpi-xl">
                <RollingNumber value={extra} format={(n) => fmtWhole(n)} countUp={false} />
              </span>
              <span className="text-body-sm text-tertiary">
                on top of <Sensitive>{fmtWhole(totalMin)}</Sensitive> in minimums
              </span>
            </div>
            <Slider className="mt-4" value={[extra]} onValueChange={(v) => { interacted.current = true; setExtra(v[0]); }} onValueCommit={(v) => choose({ extra: v[0] })} min={0} max={2000} step={25} formatValue={(n) => fmtWhole(n)} aria-label="Extra monthly payment" />
            <div className="flex justify-between text-caption text-tertiary mt-1.5" style={{ fontWeight: 400 }}>
              <span>{fmtWhole(0)}</span>
              <span>{fmtWhole(2000)}</span>
            </div>
          </div>
          <div className="fh-divider" />
          <div className="flex flex-col gap-2">
            {STRATS.map((s) => {
              const r = byId[s.id];
              const I = s.icon;
              const selected = strategy === s.id;
              return (
                <button key={s.id} type="button" className="fh-strat" data-selected={selected ? "" : undefined} onClick={() => choose({ strategy: s.id })} aria-pressed={selected}>
                  <span className="fh-strat-icon">
                    <I size={15} />
                  </span>
                  <span className="flex-1 min-w-0 text-left">
                    <span className="flex items-center gap-1.5 text-body-sm font-semibold">
                      {s.title}
                      {best === s.id ? <Badge tone="gain">Least interest</Badge> : null}
                    </span>
                    <span className="block text-caption text-tertiary truncate" style={{ fontWeight: 400 }}>
                      {s.blurb}
                    </span>
                  </span>
                  <span className="text-right flex-none">
                    <span className="block text-body-sm font-semibold tabular">{r ? <SlideText text={monthLabel(r.payoffDate)} order={r.months} /> : "—"}</span>
                    <span className="block text-caption text-tertiary tabular" style={{ fontWeight: 400 }}>
                      {r ? (
                        <span data-sensitive="">
                          <RollingNumber value={num(r.totalInterest)} format={(n) => fmtWhole(Math.round(n))} countUp={false} sensitive /> interest
                        </span>
                      ) : (
                        ""
                      )}
                    </span>
                  </span>
                  <AnimatePresence>{selected ? <m.span key="c" className="fh-strat-check" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.1 } }} transition={{ duration: 0.1 }}><Check size={11} strokeWidth={3} /></m.span> : null}</AnimatePresence>
                </button>
              );
            })}
          </div>
        </section>
        <section className="fh-card fh-span-7 flex flex-col">
          <dl className="fh-facts">
            <BigFact
              label={isYourPlan ? "Debt-free with your plan" : isLedger ? "Debt-free with this plan" : "Debt-free in this what-if"}
              value={sel ? isYourPlan ? <Figure id="debtFree.plan" inputs={[{ label: "Strategy", value: STRATS.find((x) => x.id === strategy)?.title ?? strategy, sensitive: false }, { label: "Extra a month", value: fmtWhole(extra) }, { label: "Months", value: String(sel.months), sensitive: false }]}><SlideText text={monthLabel(sel.payoffDate)} order={sel.months} /></Figure> : <SlideText text={monthLabel(sel.payoffDate)} order={sel.months} /> : "—"}
              sub={sel ? `${STRATS.find((x) => x.id === strategy)?.title ?? ""} · ${extra > 0 ? `${fmtWhole(extra)}/mo extra` : "no extra"} · ${sel.months} months` : ""}
            />
            <BigFact label="Interest saved" value={sel ? <RollingNumber value={num(sel.interestSavedVsMin)} format={(n) => fmtWhole(Math.round(n))} countUp={false} sensitive /> : "—"} sub="vs minimums only" good sensitive />
            <BigFact label="Months sooner" value={sel && minimum ? <RollingNumber value={Math.max(0, minimum.months - sel.months)} format={(n) => String(Math.round(n))} countUp={false} /> : "—"} sub={minimum ? `Debt-free at minimum payments: ${minimum.months >= 600 ? "never" : monthLabel(minimum.payoffDate)}` : ""} good />
          </dl>
          {error ? <div className="text-body-sm text-loss-text">{error}</div> : null}
          <LineChart
            // remount on a new pick: recharts layers lines by mount order, and the chosen line must draw on top
            key={strategy}
            data={comparison}
            x="m"
            series={chartSeries}
            colorBySign={false}
            startReference={false}
            height={236}
            includeZero
            xFormat={(v) => monthLabel(String(v), true) + ` '${String(v).slice(2, 4)}`}
            summaryLabel="Total debt by strategy"
            loading={!plans}
          />
          <div className="flex items-center gap-4 mt-2 text-caption text-tertiary" style={{ fontWeight: 400 }}>
            <TrendingDown size={13} /> Total balance over time · <Sensitive>{fmtWhole(totalDebt)}</Sensitive> today
          </div>
        </section>
      </div>

      <Section title="The race" subtitle="Avalanche and snowball on one clock. Each notch is a debt cleared; the ticker is interest paid so far.">
        {plans ? <DebtRace plans={plans} debts={debts} minimumLabel={minimum ? (minimum.months >= 600 ? "never" : monthLabel(minimum.payoffDate)) : undefined} /> : <Skeleton height={150} radius={12} />}
      </Section>

      <div className="fh-grid">
        <Section className="fh-span-7" title={`Payoff by debt · ${STRATS.find((s) => s.id === strategy)?.title}`} subtitle="Each band is one debt; the extra payment rolls to the next as each is cleared.">
          <StackedAreaChart data={stack} x="m" series={debts.map((d) => ({ key: d.key, label: d.name }))} height={230} xFormat={(v) => `${monthLabel(String(v), true)} '${String(v).slice(2, 4)}`} summary="Debt balances over time" loading={!plan} />
        </Section>
        <Section className="fh-span-5" title="Payoff order">
          <ol className="fh-order">
            {order.map(({ d, month }, i) => (
              <m.li key={d.key} layout transition={spring.layout} className="fh-order-item">
                <span className="fh-order-n">{i + 1}</span>
                <span className="flex-1 min-w-0">
                  <span className="block truncate text-body-sm font-medium">{d.name}</span>
                  <span className="block text-caption text-tertiary" style={{ fontWeight: 400 }}>
                    <Sensitive>{fmtWhole(d.balance)}</Sensitive> · {num(d.aprPct).toFixed(2)}% APR
                  </span>
                </span>
                <span className="text-body-sm font-semibold tabular">{month ? monthLabel(month) : "—"}</span>
              </m.li>
            ))}
          </ol>
        </Section>
      </div>

      <Section title="Debts in this plan" subtitle="Edits are a what-if. Your accounts are not changed." pad={false}>
        <div className="fh-debt-head">
          <span className="flex-1">Name</span>
          <span className="w-[150px]">Balance</span>
          <span className="w-[110px]">APR %</span>
          <span className="w-[140px]">Min payment</span>
          <span className="w-8" />
        </div>
        {debts.map((d, i) => (
          <div key={d.key} className="fh-debt-row">
            <Input size="sm" value={d.name} onChange={(e) => setDebts((ds) => ds!.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} wrapperClassName="flex-1" aria-label="Debt name" />
            <MoneyField size="sm" value={d.balance} onChange={noop} onCommit={(v) => setDebts((ds) => ds!.map((x, j) => (j === i ? { ...x, balance: v ?? "0" } : x)))} wrapperClassName="w-[150px]" aria-label="Balance" />
            <NumberField size="sm" value={num(d.aprPct)} onChange={noop} onCommit={(v) => setDebts((ds) => ds!.map((x, j) => (j === i ? { ...x, aprPct: String(v ?? 0) } : x)))} step={0.1} min={0} max={99} suffix="%" wrapperClassName="w-[110px]" aria-label="APR" />
            <MoneyField size="sm" value={d.minPayment} onChange={noop} onCommit={(v) => setDebts((ds) => ds!.map((x, j) => (j === i ? { ...x, minPayment: v ?? "0" } : x)))} wrapperClassName="w-[140px]" aria-label="Minimum payment" />
            <IconButton icon={X} size="sm" label="Remove from plan" disabled={debts.length <= 1} onClick={() => setDebts((ds) => ds!.filter((_, j) => j !== i))} />
          </div>
        ))}
        <div className="px-4 py-3">
          <Button size="sm" variant="ghost" icon={Plus} onClick={() => setDebts((ds) => [...ds!, { key: `w${Date.now()}`, name: "What-if debt", balance: "2500", aprPct: "19.9", minPayment: "50" }])}>
            Add a what-if debt
          </Button>
        </div>
      </Section>
    </div>
  );
}

/** A date (or any label) that rolls in the direction of change, odometer-style: later rolls up, sooner rolls down. */
function SlideText({ text, order }: { text: string; order: number }) {
  const prev = useRef(order);
  const dir = order === prev.current ? 0 : order > prev.current ? 1 : -1;
  useEffect(() => {
    prev.current = order;
  }, [order]);
  return (
    <span className="fh-slide-text">
      <AnimatePresence mode="popLayout" initial={false} custom={dir}>
        <m.span
          key={text}
          custom={dir}
          variants={{ in: (d: number) => ({ y: `${d * 70}%`, opacity: 0 }), at: { y: 0, opacity: 1 }, out: (d: number) => ({ y: `${d * -70}%`, opacity: 0 }) }}
          initial="in"
          animate="at"
          exit="out"
          transition={spring.roll}
          style={{ display: "inline-block" }}
        >
          {text}
        </m.span>
      </AnimatePresence>
    </span>
  );
}

function BigFact({ label, value, sub, good, sensitive }: { label: string; value: ReactNode; sub?: string; good?: boolean; sensitive?: boolean }) {
  return (
    <div className={cn("fh-fact", good && "is-good")}>
      <dt className="min-w-0">
        <span className="block text-body-sm text-secondary">{label}</span>
        {sub ? <span className="block text-caption text-tertiary">{sub}</span> : null}
      </dt>
      <dd className="tabular text-body font-semibold">{sensitive ? <span data-sensitive="">{value}</span> : value}</dd>
    </div>
  );
}

/** Debt rows keep their pre-v3 commit-on-blur behaviour (live field values are not written while typing). */
const noop = () => undefined;
