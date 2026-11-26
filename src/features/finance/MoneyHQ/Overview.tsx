/**
 * Money HQ overview: net-worth hero with scrub readout, key figures, budget envelopes, spending by category, cash
 * flow, recent transactions, upcoming bills and insights. Every headline number is a `<Figure>` (shared/Figure.tsx):
 * one label and one definition from shared/definitions.ts, with its inputs one click away. Numbers are final from the
 * first frame (K3: no count-up on arrival).
 */
import { ArrowRight, CalendarClock, CheckCircle2, Repeat } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/backend";
import type { FinanceOverview, Insight } from "@/backend/types";
import { LineChart } from "@/charts/Line";
import { Sankey } from "@/charts/Sankey";
import { useChartTheme, seriesColor } from "@/charts/theme";
import type { SankeyData } from "@/backend/types";
import { Amount } from "@/ui/Amount";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { Delta } from "@/ui/Delta";
import { RollingNumber } from "@/ui/motion/RollingNumber";
import { Segmented } from "@/ui/Segmented";
import { Sensitive } from "@/ui/Sensitive";
import { Skeleton } from "@/ui/Skeleton";
import { addMonths, assignColors, dayLabel, fmtPct, monthLabel, num, relDays, toMoney, todayIso, fmtWhole } from "../shared/format";
import { allSpending, budgetLeft, budgetSpent, keptFromSankey } from "../shared/definitions";
import { isSavingGroup, spendingBudget } from "../shared/figures";
import { Figure } from "../shared/Figure";
import { loadDebtPlanChoice, STRATEGY_LABEL, useDebtPlanChoice } from "../shared/debtPlanChoice";
import { useAsync, useDbChanged, useScrubIdx, useScrubStore, type ScrubStore } from "../shared/hooks";
import { InsightCard, Quiet, Section } from "../shared/ui";
import { localInsights } from "./insights";
import { debtInputs, debtPlanStart, useLedgerCtx } from "./ledger";
import { useMoney } from "./MoneyHQ";
import { Envelope, HeroMoney, MetricCard, TxnLine, type EnvelopeData } from "./widgets";

type Range = "6m" | "1y" | "3y" | "5y";

export function Overview() {
  return (
    <div className="fh-grid">
      <div className="fh-span-8">
        <NetWorthHero />
      </div>
      <div className="fh-span-4">
        <SideMetrics />
      </div>
      <div className="fh-span-7">
        <Envelopes />
      </div>
      <div className="fh-span-5">
        <SpendingDonut />
      </div>
      <div className="fh-span-12">
        <CashFlow />
      </div>
      <div className="fh-span-7">
        <Recent />
      </div>
      <div className="fh-span-5">
        <Upcoming />
      </div>
      <div className="fh-span-12">
        <Insights />
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── net worth hero

const NW_SERIES = [{ key: "net", label: "Net worth" }];
const xfShort = (v: unknown) => monthLabel(String(v).slice(0, 7), true);
const xfLong = (v: unknown) => {
  const d = String(v);
  return `${monthLabel(d.slice(0, 7), true)} '${d.slice(2, 4)}`;
};
// The change reads "since <first month>": a 1Y range is 12 month-end points, i.e. 11 months of change, so "past year"
// would disagree with the Accounts tab's 12-month figure (networth.change = end of range minus its start).
const sinceLabel = (data: readonly { t: string }[]) => (data[0] ? `since ${xfLong(data[0].t)}` : "");

type NwPoint = { t: string; net: number; assets: number; liabilities: number };

/** The inputs behind net worth, for its popover: assets, debts and the Portfolio share. */
export function netWorthInputs(ov: FinanceOverview | undefined) {
  if (!ov) return undefined;
  return [
    { label: "Assets", value: fmtWhole(ov.assets.amount, { currency: ov.assets.currency }) },
    { label: "Debts", value: fmtWhole(ov.liabilities.amount, { currency: ov.liabilities.currency }) },
    ...(ov.investments ? [{ label: "of which Portfolio", value: fmtWhole(ov.investments.amount, { currency: ov.investments.currency }) }] : []),
  ];
}

function NetWorthHero() {
  const { instanceId, overview, go } = useMoney();
  const l = useLedgerCtx();
  const [range, setRange] = useState<Range>("1y");
  const s = useAsync(() => api.finance.networthSeries({ instanceId, range }), [instanceId, range]);
  useDbChanged([l.schemas.txns?.database.id], s.reload, 400);
  const data = useMemo<NwPoint[]>(() => (s.data ? s.data.t.map((t, i) => ({ t, net: s.data!.net[i], assets: s.data!.assets[i], liabilities: s.data!.liabilities[i] })) : []), [s.data]);
  const long = range === "3y" || range === "5y";
  // The scrub index lives outside this component's state: only the readouts re-render while scrubbing, not the chart.
  const scrub = useScrubStore();
  return (
    <section className="fh-card fh-hero" ref={scrub.hostRef}>
      <div className="flex items-start justify-between gap-4">
        <NetWorthReadout scrub={scrub} data={data} periodLabel={sinceLabel(data)} overview={overview} onAccounts={() => go("accounts")} />
        <Segmented
          size="sm"
          value={range}
          onValueChange={(v) => setRange(v)}
          aria-label="Range"
          options={[
            { value: "6m", label: "6M" },
            { value: "1y", label: "1Y" },
            { value: "3y", label: "3Y" },
            { value: "5y", label: "5Y" },
          ]}
        />
      </div>
      <div className="mt-3">
        <LineChart
          data={data}
          x="t"
          series={NW_SERIES}
          height={208}
          area
          curve="monotoneX"
          xFormat={long ? xfLong : xfShort}
          tooltip={false}
          onScrub={scrub.set}
          summaryLabel="Net worth"
          loading={s.loading && !s.data}
          hero
        />
      </div>
      <div className="fh-groove mt-1" />
      <div className="flex items-center gap-5 pt-2.5">
        <NetWorthMinis scrub={scrub} data={data} />
        <span className="ml-auto text-caption text-tertiary">
          {overview ? (
            <>
              <Figure id="networth.30d">
                <Sensitive>{fmtWhole(overview.netWorthDelta30d.amount, { signed: true, currency: overview.netWorthDelta30d.currency })}</Sensitive>
              </Figure>{" "}
              in the last 30 days
            </>
          ) : null}
        </span>
      </div>
    </section>
  );
}

function NetWorthReadout({ scrub, data, periodLabel, overview, onAccounts }: { scrub: ScrubStore; data: NwPoint[]; periodLabel: string; overview: FinanceOverview | undefined; onAccounts: () => void }) {
  const idx = useScrubIdx(scrub);
  const cur = data[idx ?? data.length - 1];
  const first = data[0];
  const change = cur && first && first.net ? (cur.net - first.net) / Math.abs(first.net) : 0;
  const delta = cur && first ? cur.net - first.net : 0;
  const scrubbing = idx !== null;
  const currency = overview?.netWorth.currency;
  return (
    <div className="min-w-0">
      <div className="text-body-sm text-secondary">Net worth</div>
      <div className="mt-1 h-[40px] flex items-center">
        {cur ? (
          <Figure id="networth" block inputs={netWorthInputs(overview)} action={{ label: "See accounts", onSelect: onAccounts }}>
            <HeroMoney value={cur.net} cents={false} currency={currency} scrubbing={scrubbing} />
          </Figure>
        ) : (
          <Skeleton width={220} height={34} radius={6} />
        )}
      </div>
      <div className="flex items-center gap-2 h-6 mt-1">
        {cur ? (
          <>
            <span className="text-body-sm">
              <Figure id="networth.change" inputs={first ? [{ label: dayLabel(first.t, true), value: fmtWhole(first.net, { currency }) }, { label: dayLabel(cur.t, true), value: fmtWhole(cur.net, { currency }) }] : undefined}>
                <Delta money={toMoney(delta, currency)} percent={change} />
              </Figure>
            </span>
            <span className="text-body-sm text-secondary">{scrubbing ? dayLabel(cur.t, true) : periodLabel}</span>
          </>
        ) : null}
      </div>
    </div>
  );
}

function NetWorthMinis({ scrub, data }: { scrub: ScrubStore; data: NwPoint[] }) {
  const idx = useScrubIdx(scrub);
  const cur = data[idx ?? data.length - 1];
  const scrubbing = idx !== null;
  return (
    <>
      <MiniStat id="assets" label="Assets" value={cur?.assets} scrubbing={scrubbing} />
      {/* Debts are shown positive, as everywhere else (N-MO3 `debts`). */}
      <MiniStat id="debts" label="Debts" value={cur?.liabilities} scrubbing={scrubbing} />
    </>
  );
}

function MiniStat({ id, label, value, scrubbing }: { id: "assets" | "debts"; label: string; value: number | undefined; scrubbing?: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-caption text-secondary">{label}</span>
      <span className="text-body-sm tabular" data-sensitive="">
        {value === undefined ? (
          "—"
        ) : (
          <Figure id={id}>
            <RollingNumber value={value} format={(n) => fmtWhole(n)} scrubbing={scrubbing} countUp={false} sensitive />
          </Figure>
        )}
      </span>
    </span>
  );
}

// ───────────────────────────────────────────────────────────────────────────── side metrics

/**
 * The Debt-free figure, one scenario per label (definitions.ts):
 *   - `debtFree.plan` "Debt-free with your plan" when the Debt planner has a saved choice — computed here with the
 *     same inputs the planner uses (ledger debts, that strategy and extra, from next month);
 *   - otherwise `debtFree.minimum` "Debt-free at minimum payments" — `FinanceOverview.debtFreeDate`, the planner's
 *     "At minimum payments" line.
 * `month`: undefined while loading, "" with nothing owed, null when the scenario never clears the debts.
 */
export function useDebtFree(debtFreeDate: string | undefined, loaded: boolean): { kind: "plan" | "minimum"; month: string | null | undefined; detail: string } {
  const { instanceId } = useMoney();
  const l = useLedgerCtx();
  // `undefined` while the saved choice loads from the vault: the figure waits rather than show the wrong scenario.
  const saved = useDebtPlanChoice(instanceId);
  useEffect(() => void loadDebtPlanChoice(instanceId), [instanceId]);
  const choice = saved ?? undefined;
  const debts = l.loading ? [] : debtInputs(l.accounts);
  const key = JSON.stringify({ debts: debts.map((d) => [d.balance, d.aprPct, d.minPayment]), choice });
  const plan = useAsync(
    async () => {
      if (!choice || !debts.length) return null;
      const res = await api.finance.debtPlan({ debts: debts.map(({ name, balance, aprPct, minPayment }) => ({ name, balance, aprPct, minPayment })), strategy: choice.strategy, extraMonthly: String(choice.extra), startMonth: debtPlanStart() });
      return res.strategies.find((x) => x.strategy === choice.strategy) ?? null;
    },
    [key],
    { enabled: !l.loading },
  );
  if (!loaded || l.loading || saved === undefined) return { kind: choice ? "plan" : "minimum", month: undefined, detail: "" };
  if (!debts.length) return { kind: choice ? "plan" : "minimum", month: "", detail: "" };
  if (choice) {
    const p = plan.data;
    const detail = `${STRATEGY_LABEL[choice.strategy]} · ${choice.extra > 0 ? `${fmtWhole(choice.extra)}/mo extra` : "no extra"}`;
    if (p === undefined || (plan.loading && !p)) return { kind: "plan", month: undefined, detail };
    return { kind: "plan", month: p && p.months < 600 ? p.payoffDate.slice(0, 7) : null, detail };
  }
  return { kind: "minimum", month: debtFreeDate ?? null, detail: "" };
}

function SideMetrics() {
  const { overview: ov, go } = useMoney();
  const debtFree = useDebtFree(ov?.debtFreeDate, !!ov);
  if (!ov) {
    return (
      <div className="flex flex-col gap-3 h-full">
        {[0, 1, 2, 3].map((k) => (
          <Skeleton key={k} height={64} radius={6} />
        ))}
      </div>
    );
  }
  const tba = ov.toBeAssigned ? num(ov.toBeAssigned.amount) : null;
  const rate = ov.savingsRate3m;
  const cur = ov.netWorth.currency;
  // While the scenario is still loading the label names no scenario (it would otherwise guess "at minimum payments").
  const dfLabel = debtFree.month === undefined ? "Debt-free" : debtFree.kind === "plan" ? "Debt-free with your plan" : "Debt-free at minimum payments";
  return (
    <div className="fh-metrics flex flex-col -mt-3">
      {tba !== null ? (
        <MetricCard
          label="To be assigned"
          tone={tba < 0 ? "warn" : undefined}
          value={
            <Figure id="budget.toAssign" action={{ label: "Open budget", onSelect: () => go("budget") }}>
              <Amount value={toMoney(tba, ov.toBeAssigned?.currency ?? cur)} />
            </Figure>
          }
          sub={tba > 0.005 ? "Not in a category yet" : tba < -0.005 ? "More assigned than you have" : "All assigned"}
          visual={
            tba > 0.005 ? (
              <Button size="sm" variant="primary" onClick={() => go("budget")}>
                Assign
              </Button>
            ) : tba < -0.005 ? (
              <Badge tone="warning">Fix</Badge>
            ) : (
              <CheckCircle2 size={16} strokeWidth={1.875} className="text-secondary" />
            )
          }
        />
      ) : (
        <MetricCard
          label="Left this month"
          value={
            <Figure id="budget.left">
              <Amount value={toMoney(budgetLeft(ov.budget), cur)} noCents />
            </Figure>
          }
        />
      )}
      <MetricCard
        label="Kept from income · 3 months"
        value={
          <Figure id="savingsRate3m" action={{ label: "See cash flow by month", onSelect: () => document.getElementById("fh-cashflow")?.scrollIntoView({ block: "start" }) }}>
            {fmtPct(rate, 1)}
          </Figure>
        }
        sub="Income minus spending"
      />
      <MetricCard
        label="Emergency fund"
        value={
          <Figure id="efMonths" inputs={[...(ov.efBalance ? [{ label: "Fund balance", value: fmtWhole(ov.efBalance.amount, { currency: ov.efBalance.currency }) }] : []), ...(ov.essentialMonthly ? [{ label: "Essentials a month", value: fmtWhole(ov.essentialMonthly.amount, { currency: ov.essentialMonthly.currency }) }] : [])]} action={{ label: "Open goals", onSelect: () => go("goals") }}>
            {`${ov.efMonths.toFixed(1)} months`}
          </Figure>
        }
        sub={ov.efMonths >= 6 ? "of essentials · goal reached" : "of essentials · goal 6 months"}
      />
      <MetricCard
        label={dfLabel}
        value={
          debtFree.month === undefined ? (
            <span className="flex items-center h-[28px]">
              <Skeleton width={110} height={20} radius={6} />
            </span>
          ) : (
            <Figure id={debtFree.kind === "plan" ? "debtFree.plan" : "debtFree.minimum"} inputs={debtFree.detail ? [{ label: "Plan", value: debtFree.detail, sensitive: false }] : undefined} action={{ label: "Open the debt planner", onSelect: () => go("debt") }}>
              {debtFree.month ? monthLabel(debtFree.month) : debtFree.month === "" ? "Nothing owed" : "Never"}
            </Figure>
          )
        }
        sub={debtFree.month === undefined ? "\u00a0" : debtFree.month === "" ? "No balances owed" : debtFree.month === null ? "Payments never clear the balance" : debtFree.kind === "plan" ? debtFree.detail : "Paying only the minimums"}
      />
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── envelopes

function Envelopes() {
  const { overview: ov, go, month } = useMoney();
  const l = useLedgerCtx();
  const list: EnvelopeData[] = useMemo(() => {
    if (!ov) return [];
    return ov.budget
      .filter((b) => !isSavingGroup(b.group) && num(b.assigned.amount) > 0)
      .map((b) => ({ category: l.cat.get(b.categoryId) ?? { id: b.categoryId, name: b.name, group: b.group, color: b.color, icon: "circle-dollar-sign", essential: false, rollover: false, target: 0 }, assigned: num(b.assigned.amount), spent: -num(b.activity.amount), available: num(b.available.amount), pace: b.pace }))
      .sort((a, b) => b.spent / Math.max(1, b.assigned) - a.spent / Math.max(1, a.assigned))
      .slice(0, 8);
  }, [ov, l.cat]);
  const sb = spendingBudget(ov?.budget);
  const pace = ov?.budget[0]?.pace ?? 0;
  const cur = ov?.netWorth.currency;
  return (
    <Section
      title="Budget envelopes"
      subtitle={
        ov ? (
          <>
            <Figure id="budget.spent" inputs={[{ label: "Assigned to spending", value: fmtWhole(sb.assigned, { currency: cur }) }, { label: "Spent in budget", value: fmtWhole(sb.spent, { currency: cur }) }]}>
              <Sensitive>{fmtWhole(sb.spent, { currency: cur })}</Sensitive>
            </Figure>{" "}
            spent in budget of <Sensitive>{fmtWhole(sb.assigned, { currency: cur })}</Sensitive> ·{" "}
            <Figure id="budget.left">
              <Sensitive>{fmtWhole(sb.remaining, { currency: cur })}</Sensitive>
            </Figure>{" "}
            left this month · {Math.round(pace * 100)}% through {monthLabel(month, true)}
          </>
        ) : (
          "\u00a0"
        )
      }
      actions={
        <Button size="xs" variant="ghost" iconRight={ArrowRight} onClick={() => go("budget")}>
          Budget
        </Button>
      }
    >
      {!ov ? (
        <div className="grid grid-cols-2 gap-2">
          {Array.from({ length: 8 }, (_, k) => (
            <Skeleton key={k} height={44} radius={6} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-x-6 gap-y-0.5 -mx-2">
          {list.map((e, i) => (
            <Envelope key={e.category.id} e={e} index={i} onClick={() => go("budget")} />
          ))}
        </div>
      )}
    </Section>
  );
}

// ───────────────────────────────────────────────────────────────────────────── spending donut

function SpendingDonut() {
  const { instanceId, month } = useMoney();
  const l = useLedgerCtx();
  const t = useChartTheme();
  const from = `${month}-01`;
  const last = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const to = `${month}-${String(last).padStart(2, "0")}`;
  const s = useAsync(() => api.finance.spendingBreakdown({ instanceId, from, to, by: "category" }), [instanceId, month]);
  useDbChanged([l.schemas.txns?.database.id], s.reload, 400);
  const rows = s.data ?? [];
  // `spending.all` — "All spending" (definitions.ts allSpending): the breakdown's total, uncategorised included.
  const total = allSpending(rows);
  const prev = rows.reduce((a, x) => a + (x.deltaPct !== undefined ? num(x.amount) / (1 + x.deltaPct) : num(x.amount)), 0);
  const slices = useMemo(() => {
    const sorted = rows.map((x) => ({ id: x.key, label: x.label, value: num(x.amount) })).sort((a, b) => b.value - a.value);
    const top = sorted.slice(0, 6);
    const rest = sorted.slice(6).reduce((a, x) => a + x.value, 0);
    const colors = assignColors(top.map((x) => x.id));
    const out = top.map((x) => ({ ...x, color: x.id === "uncategorized" ? t.other : seriesColor(t, colors.get(x.id) ?? 0) }));
    if (rest > 0) out.push({ id: "__other", label: "Everything else", value: rest, color: t.other });
    return out;
  }, [rows, t]);
  const { go, overview: ov } = useMoney();
  const max = slices.reduce((a, x) => Math.max(a, x.value), 0) || 1;
  const open = (id: string) => go("transactions", id === "uncategorized" ? { filter: "uncategorized" } : undefined);
  return (
    <Section
      title="Spending by category"
      subtitle={
        s.data ? (
          <span className="inline-flex items-center gap-2 flex-wrap">
            <span>
              <Figure id="spending.all" inputs={[{ label: "Spent in budget", value: fmtWhole(budgetSpent(ov?.budget)) }, ...rows.filter((x) => x.key === "uncategorized").map((x) => ({ label: "Uncategorised", value: fmtWhole(x.amount) })), { label: "All spending", value: fmtWhole(total) }]}>
                <Sensitive>{fmtWhole(total)}</Sensitive>
              </Figure>{" "}
              all spending in {monthLabel(month, true)}
            </span>
            {prev > 0 ? <Delta percent={(total - prev) / prev} invert label="vs last month" /> : null}
          </span>
        ) : (
          "\u00a0"
        )
      }
    >
      {s.loading && !s.data ? (
        <div className="flex flex-col gap-3 h-[222px]">{[0, 1, 2, 3, 4].map((k) => <Skeleton key={k} height={24} radius={4} />)}</div>
      ) : slices.length === 0 ? (
        <Quiet icon={CheckCircle2} title="No spending yet this month" />
      ) : (
        <ul className="fh-share" aria-label={`Spending by category, ${monthLabel(month)}`}>
          {slices.map((x) => (
            <li key={x.id}>
              <button type="button" className="fh-share-row" onClick={() => open(x.id)}>
                <span className="fh-share-label">
                  <span className="truncate">{x.label}</span>
                </span>
                <span className="fh-share-val" data-sensitive="">
                  {fmtWhole(x.value)}
                </span>
                <span className="fh-share-bar" aria-hidden>
                  <i style={{ transform: `scaleX(${x.value / max})` }} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ───────────────────────────────────────────────────────────────────────────── cash flow

function CashFlow() {
  const { instanceId } = useMoney();
  const l = useLedgerCtx();
  const t = useChartTheme();
  const [month, setMonth] = useState(() => addMonths(todayIso().slice(0, 7), -1));
  const s = useAsync(() => api.finance.cashflowSankey({ instanceId, month }), [instanceId, month]);
  useDbChanged([l.schemas.txns?.database.id], s.reload, 400);
  const data = useMemo(() => (s.data ? simplifySankey(s.data) : undefined), [s.data]);
  const nodes = useMemo(() => {
    if (!data) return [];
    const groupColor = new Map<string, string>();
    let gi = 0;
    const incomeNames = new Set<number>();
    for (const lk of data.links) if (data.nodes[lk.target]?.name === "Income") incomeNames.add(lk.source);
    const hub = data.nodes.findIndex((n) => n.name === "Income");
    const parentOf = new Map<number, number>();
    for (const lk of data.links) parentOf.set(lk.target, lk.source);
    return data.nodes.map((n, i) => {
      if (i === hub || incomeNames.has(i)) return { name: n.name, color: t.gain };
      if (n.name === "Saved & paid down") return { name: n.name, color: t.accent };
      const parent = parentOf.get(i);
      if (parent === hub) {
        const c = seriesColor(t, [1, 3, 4, 5][gi++ % 4]);
        groupColor.set(n.name, c);
        return { name: n.name, color: c };
      }
      const pn = parent !== undefined ? data.nodes[parent]?.name : undefined;
      if (pn === "Saved & paid down") return { name: n.name, color: t.accent };
      return { name: n.name, color: (pn && groupColor.get(pn)) || t.textTertiary };
    });
  }, [data, t]);
  // `cashflow.kept` — the 3-month savings-rate definition for one month (definitions.ts keptFromSankey).
  const kept = keptFromSankey(s.data);
  return (
    <Section
      id="fh-cashflow"
      title="Where the money went"
      subtitle={
        s.data && kept.income ? (
          <>
            In <Sensitive>{fmtWhole(kept.income)}</Sensitive> · Kept{" "}
            <Figure id="cashflow.kept" range={monthLabel(month)} inputs={[{ label: "Income", value: fmtWhole(kept.income) }, { label: "Spending", value: fmtWhole(kept.spending) }, { label: "Kept", value: fmtWhole(kept.kept) }]}>
              <Sensitive>{fmtWhole(kept.kept)}</Sensitive> ({fmtPct(kept.ratio, 0)})
            </Figure>{" "}
            in {monthLabel(month)}
          </>
        ) : (
          monthLabel(month)
        )
      }
      actions={
        <Segmented
          size="sm"
          value={month}
          onValueChange={setMonth}
          aria-label="Month"
          options={[-3, -2, -1, 0].map((k) => {
            const mm = addMonths(todayIso().slice(0, 7), k);
            return { value: mm, label: monthLabel(mm, true) };
          })}
        />
      }
    >
      <Sankey nodes={nodes} links={data?.links ?? []} height={400} loading={s.loading && !s.data} summaryLabel={`Cash flow, ${monthLabel(month)}`} />
    </Section>
  );
}

/** Fold tiny flows so every label has room: small income sources merge, each group keeps its top 3 categories. */
function simplifySankey(d: SankeyData): SankeyData {
  const name = (i: number) => d.nodes[i]?.name ?? "";
  const hub = d.nodes.findIndex((n) => n.name === "Income");
  const income = d.links.filter((l) => l.target === hub).reduce((a, l) => a + l.value, 0) || 1;
  const nodes: SankeyData["nodes"] = [];
  const links: SankeyData["links"] = [];
  const idx = new Map<string, number>();
  const node = (n: string) => {
    if (!idx.has(n)) {
      idx.set(n, nodes.length);
      nodes.push({ name: n });
    }
    return idx.get(n)!;
  };
  const add = (a: string, b: string, v: number) => {
    const s = node(a);
    const t = node(b);
    const ex = links.find((l) => l.source === s && l.target === t);
    if (ex) ex.value += v;
    else links.push({ source: s, target: t, value: v });
  };
  const sources = d.links.filter((l) => l.target === hub).sort((a, b) => b.value - a.value);
  const big = sources.filter((l, i) => i === 0 || l.value / income >= 0.06);
  const smallSum = sources.filter((l) => !big.includes(l)).reduce((a, l) => a + l.value, 0);
  big.forEach((l, i) => {
    const merge = smallSum > 0 && big.length > 1 && i === big.length - 1;
    add(merge ? `${name(l.source)} & other` : name(l.source), "Income", l.value + (merge ? smallSum : 0));
  });
  if (smallSum > 0 && big.length === 1) add("Other income", "Income", smallSum);
  for (const g of d.links.filter((l) => l.source === hub)) {
    const gName = name(g.target);
    add("Income", gName, g.value);
    const kids = d.links.filter((l) => l.source === g.target).sort((a, b) => b.value - a.value);
    // tiny groups (< 4% of income) stay a single node so their leaf labels can't collide at the bottom of the column
    const keep = gName === "Saved & paid down" ? kids : g.value / income < 0.04 ? [] : kids.filter((k, i) => i < 3 && k.value / income >= 0.04);
    const rest = kids.filter((k) => !keep.includes(k)).reduce((a, k) => a + k.value, 0);
    for (const k of keep) add(gName, name(k.target), k.value);
    if (rest > 0 && keep.length) add(gName, gName === "Fun" ? "Other fun" : `Other ${gName.toLowerCase()}`, rest);
  }
  return { nodes, links: links.filter((l) => l.value > 0) };
}

// ───────────────────────────────────────────────────────────────────────────── recent + upcoming

function Recent() {
  const l = useLedgerCtx();
  const { go } = useMoney();
  const recent = l.txns.slice(0, 7);
  return (
    <Section
      title="Recent transactions"
      actions={
        <Button size="xs" variant="ghost" iconRight={ArrowRight} onClick={() => go("transactions")}>
          All transactions
        </Button>
      }
    >
      <div className="-mx-3 -my-1">
        {l.loading && !l.txns.length
          ? Array.from({ length: 6 }, (_, k) => (
              <div key={k} className="flex items-center gap-3 px-3 py-2.5">
                <Skeleton width={24} height={24} radius={6} />
                <div className="flex-1">
                  <Skeleton width="40%" height={11} />
                  <Skeleton width="25%" height={9} className="mt-2" />
                </div>
                <Skeleton width={60} height={11} />
              </div>
            ))
          : recent.map((t) => <TxnLine key={t.id} t={t} category={t.categoryId ? l.cat.get(t.categoryId) : undefined} accountName={t.accountId ? l.acct.get(t.accountId)?.name : undefined} onClick={() => go("transactions")} />)}
      </div>
    </Section>
  );
}

function Upcoming() {
  const { overview: ov, go } = useMoney();
  const l = useLedgerCtx();
  const total = ov?.upcoming.filter((u) => u.due <= addDays7()).reduce((a, u) => a + num(u.amount.amount), 0) ?? 0;
  return (
    <Section
      title="Upcoming bills"
      subtitle={
        ov ? (
          <>
            <Figure id="upcoming.7d">
              <Sensitive>{fmtWhole(-total)}</Sensitive>
            </Figure>{" "}
            due in the next 7 days
          </>
        ) : null
      }
      actions={
        <Button size="xs" variant="ghost" iconRight={ArrowRight} onClick={() => go("recurring")}>
          Recurring
        </Button>
      }
    >
      {!ov ? (
        <Skeleton height={220} radius={10} />
      ) : ov.upcoming.length === 0 ? (
        <Quiet icon={CalendarClock} title="Nothing due in the next two weeks" />
      ) : (
        <ul className="m-0 p-0 list-none -mx-3 -my-1">
          {ov.upcoming.slice(0, 7).map((u) => {
            const rec = l.recurring.find((r) => r.id === u.rowId);
            const cat = rec?.categoryId ? l.cat.get(rec.categoryId) : undefined;
            const soon = relDays(u.due);
            return (
              <li key={u.rowId + u.due} className="fh-row">
                <span className="fh-date-chip" aria-hidden>
                  <span>{dayLabel(u.due).split(" ")[0]}</span>
                  <b>{Number(u.due.slice(8, 10))}</b>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body-sm">{u.name}</span>
                  <span className="block text-caption text-tertiary truncate">
                    {soon}
                    {cat ? ` · ${cat.name}` : ""}
                  </span>
                </span>
                {u.autopay ? (
                  <Badge tone="neutral" icon={Repeat}>
                    Autopay
                  </Badge>
                ) : null}
                <Amount value={toMoney(Math.abs(num(u.amount.amount)))} role="row" className="text-body-sm" align="end" />
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function addDays7(): string {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ───────────────────────────────────────────────────────────────────────────── insights

function Insights() {
  const { instanceId, overview } = useMoney();
  const l = useLedgerCtx();
  const remote = useAsync(() => api.lifeapp.insights({ instanceId }).catch(() => [] as Insight[]), [instanceId]);
  const fc = useAsync(() => api.finance.forecast({ instanceId, horizonDays: 45, band: false }), [instanceId]);
  const [muted, setMuted] = useState<Set<string>>(new Set());
  const list = useMemo(() => {
    const r = (remote.data ?? []).filter((i) => i.appInstanceId === instanceId && !i.mutedUntil);
    return (r.length ? r : localInsights(instanceId, overview, l, fc.data)).filter((i) => !muted.has(i.ruleId));
  }, [remote.data, overview, l, fc.data, muted, instanceId]);
  const mute = (i: Insight) => {
    setMuted((s) => new Set(s).add(i.ruleId));
    api.lifeapp.insightMute({ instanceId, ruleId: i.ruleId, until: Date.now() + 30 * 86_400_000 }).catch(() => undefined);
  };
  return (
    <Section title="Insights">
      {!overview ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((k) => (
            <Skeleton key={k} height={44} radius={6} />
          ))}
        </div>
      ) : list.length === 0 ? (
        <Quiet icon={CheckCircle2} title="Nothing to flag" />
      ) : (
        <div className="fh-insights">
          {list.slice(0, 6).map((i) => (
            <InsightCard key={i.id} insight={i} onMute={mute} />
          ))}
        </div>
      )}
    </Section>
  );
}
