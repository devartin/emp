/**
 * Cash-flow forecast (§15.5): scheduled flows plus discretionary spend with a p10–p90 bootstrap band, the
 * low-balance threshold and breach warnings with the outflows that cause them.
 */
import { AlertTriangle, CalendarRange, CheckCircle2, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "@/backend";
import type { Id } from "@/backend/types";
import { FanChart } from "@/charts/Fan";
import { Amount } from "@/ui/Amount";
import { Segmented } from "@/ui/Segmented";
import { RollingNumber } from "@/ui/motion/RollingNumber";
import { Sensitive } from "@/ui/Sensitive";
import { Skeleton } from "@/ui/Skeleton";
import { dayLabel, fmtMoney, todayIso, fmtWhole, toMoney } from "./shared/format";
import { useAsync, useDbChanged } from "./shared/hooks";
import { Section } from "./shared/ui";
import { useLedgerCtx } from "./MoneyHQ/ledger";
import { occurrences } from "./MoneyHQ/recurrence";

export default function Forecast({ instanceId }: { instanceId: Id }) {
  const l = useLedgerCtx();
  const [horizon, setHorizon] = useState<"30" | "60" | "90">("90");
  const fc = useAsync(() => api.finance.forecast({ instanceId, horizonDays: Number(horizon), band: true }), [instanceId, horizon]);
  useDbChanged([l.schemas.txns?.database.id, l.schemas.recurring?.database.id], fc.reload, 500);
  const checking = l.accounts.filter((a) => a.type === "checking").sort((a, b) => (b.lowThreshold ?? 0) - (a.lowThreshold ?? 0))[0];
  const today = todayIso();

  const data = useMemo(() => {
    if (!fc.data || !checking) return [];
    // 30 days of actual history, then the projection (median ≈ deterministic path).
    const hist: { x: string; actual: number }[] = [];
    let bal = checking.balance;
    const txs = l.txns.filter((t) => t.accountId === checking.id);
    let k = 0;
    for (let d = 0; d <= 30; d++) {
      const day = shift(today, -d);
      hist.push({ x: day, actual: bal });
      while (k < txs.length && txs[k].date >= day) {
        bal -= txs[k].amount;
        k++;
      }
    }
    hist.reverse();
    const proj = fc.data.t.map((x, i) => ({ x, p10: fc.data!.p10?.[i], p50: fc.data!.balance[i], p90: fc.data!.p90?.[i] }));
    const joint = { ...hist[hist.length - 1], p10: hist[hist.length - 1].actual, p50: hist[hist.length - 1].actual, p90: hist[hist.length - 1].actual };
    return [...hist.slice(0, -1), joint, ...proj];
  }, [fc.data, checking, l.txns, today]);

  const end = fc.data ? fc.data.balance[fc.data.balance.length - 1] : 0;
  const min = fc.data ? Math.min(...fc.data.balance) : 0;
  const minIdx = fc.data ? fc.data.balance.indexOf(min) : -1;
  const p10min = fc.data?.p10 ? Math.min(...fc.data.p10) : null;
  const breach = fc.data?.breaches[0];
  const flows = useMemo(() => {
    if (!checking) return [];
    const last = shift(today, Number(horizon));
    const list: { day: string; name: string; amount: number }[] = [];
    for (const r of l.recurring) if (r.accountId === checking.id) for (const d of occurrences(r.rrule, r.dtstart, shift(today, 1), last)) list.push({ day: d, name: r.name, amount: r.amount });
    return list.sort((a, b) => (a.day < b.day ? -1 : 1)).slice(0, 14);
  }, [l.recurring, checking, today, horizon]);

  return (
    <div className="flex flex-col gap-4">
      {breach ? (
        <div className="fh-alert" data-tone="warn">
          <AlertTriangle size={18} />
          <div className="flex-1">
            <div className="text-body-sm font-semibold">
              {checking?.name} may dip to <Sensitive>{fmtMoney(breach.amount)}</Sensitive> around {dayLabel(breach.date)}
            </div>
            <div className="text-caption">
              Below your {fmtWhole(fc.data?.threshold ?? 0)} low-balance threshold. Biggest outflows before then: {breach.topOutflows.join(", ")}.
            </div>
          </div>
        </div>
      ) : fc.data ? (
        <div className="fh-alert" data-tone="ok">
          <ShieldCheck size={18} />
          <div className="flex-1 text-body-sm">
            <b>No low-balance risk in the next {horizon} days.</b> <span className="text-secondary">Even the cautious path stays above {fmtWhole(fc.data.threshold ?? 0)}.</span>
          </div>
        </div>
      ) : null}
      <div className="fh-grid">
        <Section
          className="fh-span-8"
          title={checking ? `${checking.name} · projected balance` : "Projected balance"}
          subtitle="Scheduled bills and income, plus your typical everyday spending. The band covers 80% of 1,000 simulated paths."
          actions={<Segmented size="sm" value={horizon} onValueChange={setHorizon} options={[{ value: "30", label: "30d" }, { value: "60", label: "60d" }, { value: "90", label: "90d" }]} aria-label="Horizon" />}
        >
          <div className="fh-fan" key={`${horizon}:${fc.data ? 1 : 0}`} data-reveal="">
          <FanChart data={data} height={300} xFormat={(v) => dayLabel(String(v))} target={fc.data?.threshold !== undefined && p10min !== null && p10min < fc.data.threshold * 4 + 1500 ? { value: fc.data.threshold, label: "Low-balance threshold" } : undefined} loading={fc.loading && !fc.data} summaryLabel="Projected checking balance" />
          </div>
          <div className="flex items-center gap-5 mt-3 text-caption text-tertiary">
            <span className="inline-flex items-center gap-1.5"><i className="fh-key" style={{ background: "var(--text-primary)" }} />Actual</span>
            <span className="inline-flex items-center gap-1.5"><i className="fh-key" style={{ background: "var(--accent-solid)", height: 2 }} />Median projection</span>
            <span className="inline-flex items-center gap-1.5"><i className="fh-key fh-key-band" />Likely range (p10–p90)</span>
          </div>
        </Section>
        <div className="fh-span-4 flex flex-col gap-3">
          <Fact label={`In ${horizon} days`} value={fc.data ? end : null} sub={checking ? `from ${fmtWhole(checking.balance)} today` : ""} />
          <Fact label="Lowest point" value={fc.data ? min : null} sub={minIdx >= 0 && fc.data ? `around ${dayLabel(fc.data.t[minIdx])}` : ""} />
          <Fact label="Cautious low (p10)" value={p10min} sub={p10min !== null && fc.data?.threshold !== undefined ? (p10min > fc.data.threshold ? "stays above your threshold" : "touches your threshold") : ""} icon={p10min !== null && fc.data?.threshold !== undefined && p10min > fc.data.threshold ? <CheckCircle2 size={16} absoluteStrokeWidth strokeWidth={1.25} className="text-secondary" /> : undefined} />
        </div>
      </div>
      <Section title="Scheduled in this window" subtitle={checking ? `From the Recurring database, for ${checking.name}` : undefined} actions={<CalendarRange size={16} className="text-tertiary" />} pad={false}>
        <div className="pb-1">
          {flows.map((f, i) => (
            <div key={i} className="fh-acct" style={{ paddingTop: 8, paddingBottom: 8 }}>
              <span className="fh-date-chip">
                <span>{dayLabel(f.day).split(" ")[0]}</span>
                <b>{Number(f.day.slice(8, 10))}</b>
              </span>
              <span className="flex-1 truncate text-body-sm">{f.name}</span>
              {f.amount > 0 ? <span className="text-caption text-tertiary">Income</span> : null}
              {/* A scheduled flow is a ledger figure: ink, a true minus, cents in tertiary. Not gain/loss colour. */}
              <span className="w-[110px] text-right">
                <Amount value={toMoney(f.amount)} role="row" align="end" />
              </span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

function shift(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function Fact({ label, value, sub, icon }: { label: string; value: number | null; sub?: string; icon?: React.ReactNode }) {
  return (
    <div className="fh-card">
      <div className="flex items-center justify-between">
        <span className="text-caption text-secondary" style={{ fontWeight: 500 }}>
          {label}
        </span>
        {icon}
      </div>
      <div className="tabular mt-1 text-kpi">
        {value === null ? (
          <Skeleton width={120} height={22} />
        ) : (
          <span data-sensitive="">
            <RollingNumber value={value} format={(n) => fmtWhole(Math.round(n))} countUp={false} sensitive />
          </span>
        )}
      </div>
      {sub ? (
        <div className="text-caption text-tertiary" style={{ fontWeight: 400 }}>
          {sub}
        </div>
      ) : null}
    </div>
  );
}
