/**
 * Recurring & subscriptions (§15.4, §16.2): a 30-day cash calendar, bills and income on a schedule, subscriptions
 * with annual cost and price-rise flags, and detected recurring payments to accept with one click.
 */
import { ArrowUpRight, CalendarClock, Check, ExternalLink, Plus, Radar, Repeat } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useMemo, useState } from "react";
import { api } from "@/backend";
import type { RecurringCandidate } from "@/backend/types";
import { notify } from "@/stores/toasts";
import { Amount } from "@/ui/Amount";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { Sensitive } from "@/ui/Sensitive";
import { Skeleton } from "@/ui/Skeleton";
import { Delta } from "@/ui/Delta";
import { Tooltip } from "@/ui/Tooltip";
import { dayLabel, fmtMoney, relDays, toMoney, todayIso, fmtWhole } from "../shared/format";
import { useAsync, useDbChanged } from "../shared/hooks";
import { Glyph, Quiet, Section } from "../shared/ui";
import { useLedgerCtx, type RecurringRow } from "./ledger";
import { useMoney } from "./MoneyHQ";
import { cadenceLabel, nextDue, occurrences, perMonth } from "./recurrence";

export default function Recurring() {
  const l = useLedgerCtx();
  const { instanceId } = useMoney();
  const today = todayIso();
  const detected = useAsync(() => api.finance.recurringDetect({ instanceId }), [instanceId]);
  useDbChanged([l.schemas.recurring?.database.id, l.schemas.txns?.database.id], detected.reload, 400);
  const items = useMemo(() => l.recurring.map((r) => ({ r, next: nextDue(r.rrule, r.dtstart, today) })).sort((a, b) => (a.next ?? "9") < (b.next ?? "9") ? -1 : 1), [l.recurring, today]);
  const subs = items.filter((x) => x.r.kind === "subscription");
  const bills = items.filter((x) => x.r.kind === "bill");
  const income = items.filter((x) => x.r.kind === "income");
  const monthlyOut = [...bills, ...subs].reduce((s, x) => s + Math.abs(x.r.amount) * perMonth(x.r.rrule), 0);
  const monthlyIn = income.reduce((s, x) => s + Math.abs(x.r.amount) * perMonth(x.r.rrule), 0);
  const subsYear = subs.reduce((s, x) => s + Math.abs(x.r.amount) * perMonth(x.r.rrule) * 12, 0);
  return (
    <div className="flex flex-col gap-4">
      <div className="fh-kpis">
        <Tile label="Scheduled income" value={fmtWhole(monthlyIn)} sub="per month" />
        <Tile label="Bills & transfers" value={fmtWhole(monthlyOut - subsYear / 12)} sub="per month" />
        <Tile label="Subscriptions" value={fmtWhole(subsYear)} sub={`a year · ${subs.length} active`} />
        <Tile label="Left after schedule" value={fmtWhole(monthlyIn - monthlyOut)} sub="per month, before everyday spending" />
      </div>
      <CashCalendar items={l.recurring} />
      {detected.data?.length ? <Detected list={detected.data} onAccepted={() => { detected.reload(); l.reload(); }} /> : null}
      <div className="fh-grid">
        <div className="fh-span-7 flex flex-col gap-4">
          <Section title="Bills & transfers" subtitle={`${bills.length} scheduled`} pad={false}>
            <List rows={bills} />
          </Section>
          <Section title="Income" pad={false}>
            <List rows={income} />
          </Section>
        </div>
        <div className="fh-span-5">
          <Section title="Subscriptions" subtitle={<><Sensitive>{fmtWhole(subsYear)}</Sensitive> a year</>} pad={false}>
            {subs.length ? (
              <div className="pb-1">
                {subs.map(({ r, next }) => (
                  <SubRow key={r.id} r={r} next={next} share={subsYear ? (Math.abs(r.amount) * perMonth(r.rrule) * 12) / subsYear : 0} />
                ))}
              </div>
            ) : (
              <Quiet icon={Repeat} title="No subscriptions yet" body="Accept a detected subscription or add one to the Recurring database." />
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="fh-card">
      <div className="text-caption text-secondary" style={{ fontWeight: 500 }}>
        {label}
      </div>
      <div className="tabular mt-1 text-kpi">
        <Sensitive>{value}</Sensitive>
      </div>
      <div className="text-caption text-tertiary" style={{ fontWeight: 400 }}>
        {sub}
      </div>
    </div>
  );
}

function List({ rows }: { rows: { r: RecurringRow; next: string | null }[] }) {
  const l = useLedgerCtx();
  if (!rows.length) return <div className="px-5 pb-5 text-body-sm text-tertiary">Nothing scheduled.</div>;
  return (
    <div className="pb-1">
      {rows.map(({ r, next }) => {
        const cat = r.categoryId ? l.cat.get(r.categoryId) : undefined;
        const acct = r.accountId ? l.acct.get(r.accountId) : undefined;
        return (
          <div key={r.id} className="fh-acct" style={{ paddingTop: 10, paddingBottom: 10 }}>
            <Glyph name={cat?.icon ?? "repeat"} color={cat?.color ?? "gray"} size={30} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-body-sm font-medium">{r.name}</div>
              <div className="text-caption text-tertiary truncate" style={{ fontWeight: 400 }}>
                {cadenceLabel(r.rrule)}
                {acct ? ` · ${acct.name}` : ""}
                {r.variable ? " · varies" : ""}
              </div>
            </div>
            {r.autopay ? (
              <Badge tone="neutral" icon={Repeat}>
                Autopay
              </Badge>
            ) : null}
            <div className="w-[92px] text-right">
              <div className="text-caption text-secondary" style={{ fontWeight: 500 }}>
                {next ? relDays(next) : "—"}
              </div>
              <div className="text-caption text-tertiary" style={{ fontWeight: 400 }}>
                {next ? dayLabel(next) : ""}
              </div>
            </div>
            <div className="w-[96px] flex justify-end">
              <Amount value={toMoney(r.amount)} signed={r.amount > 0} className="text-body-sm font-medium" align="end" />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SubRow({ r, next, share }: { r: RecurringRow; next: string | null; share: number }) {
  const rise = r.prevAmount !== null && Math.abs(r.amount) > Math.abs(r.prevAmount) + 0.005;
  const annual = Math.abs(r.amount) * perMonth(r.rrule) * 12;
  return (
    <div className="fh-sub">
      <span className="fh-sub-logo" aria-hidden>
        {r.name.slice(0, 1)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-body-sm font-medium">{r.name}</span>
          {rise ? (
            <Tooltip content={`Was ${fmtMoney(Math.abs(r.prevAmount!))} · +${fmtMoney((Math.abs(r.amount) - Math.abs(r.prevAmount!)) * 12)} a year`}>
              <span className="fh-rise" tabIndex={0}>
                <Delta percent={(Math.abs(r.amount) - Math.abs(r.prevAmount!)) / Math.abs(r.prevAmount!)} digits={0} invert />
              </span>
            </Tooltip>
          ) : null}
        </div>
        <div className="mt-1.5 fh-meter" style={{ height: 4 }}>
          <i style={{ transform: `scaleX(${Math.max(0.02, share)})` }} />
        </div>
      </div>
      <div className="w-[110px] text-right">
        <div className="text-body-sm font-semibold tabular">
          <Sensitive>{fmtMoney(Math.abs(r.amount))}</Sensitive>
          <span className="text-tertiary font-normal">/mo</span>
        </div>
        <div className="text-caption text-tertiary tabular" style={{ fontWeight: 400 }}>
          <Sensitive>{fmtWhole(annual)}</Sensitive>/yr{next ? ` · ${dayLabel(next)}` : ""}
        </div>
      </div>
      {r.cancelUrl ? (
        <Tooltip content="Open the cancellation page">
          <a className="fh-link inline-flex p-1" href={r.cancelUrl} target="_blank" rel="noreferrer noopener" aria-label={`Manage ${r.name}`}>
            <ExternalLink size={14} />
          </a>
        </Tooltip>
      ) : (
        <span className="w-[22px]" />
      )}
    </div>
  );
}

/** 30-day strip: each day with its scheduled in/outflows, cumulative net along the bottom. */
function CashCalendar({ items }: { items: RecurringRow[] }) {
  const today = todayIso();
  const days = useMemo(() => {
    const out: { day: string; flows: { name: string; amount: number }[] }[] = [];
    for (let k = 0; k < 30; k++) {
      const d = new Date(`${today}T12:00:00`);
      d.setDate(d.getDate() + k);
      out.push({ day: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`, flows: [] });
    }
    const last = out[out.length - 1].day;
    for (const r of items) for (const d of occurrences(r.rrule, r.dtstart, today, last)) out.find((x) => x.day === d)?.flows.push({ name: r.name, amount: r.amount });
    return out;
  }, [items, today]);
  const max = Math.max(1, ...days.map((d) => Math.max(d.flows.filter((f) => f.amount < 0).reduce((s, f) => s - f.amount, 0), d.flows.filter((f) => f.amount > 0).reduce((s, f) => s + f.amount, 0))));
  return (
    <Section title="Next 30 days" subtitle="Scheduled money in and out" actions={<CalendarClock size={16} className="text-tertiary" />}>
      <div className="fh-cal">
        {days.map((d, i) => {
          const out = d.flows.filter((f) => f.amount < 0).reduce((s, f) => s - f.amount, 0);
          const inn = d.flows.filter((f) => f.amount > 0).reduce((s, f) => s + f.amount, 0);
          const dt = new Date(`${d.day}T12:00:00`);
          const weekend = dt.getDay() === 0 || dt.getDay() === 6;
          return (
            <Tooltip key={d.day} content={d.flows.length ? <div className="flex flex-col gap-0.5"><b>{dayLabel(d.day)}</b>{d.flows.map((f, k) => <span key={k}>{f.name} · {fmtMoney(f.amount, undefined, { signed: true })}</span>)}</div> : `${dayLabel(d.day)} · nothing scheduled`}>
              <div className="fh-cal-day" data-weekend={weekend ? "" : undefined} data-today={i === 0 ? "" : undefined} tabIndex={0}>
                <div className="fh-cal-bars">
                  {inn ? <span className="fh-cal-in" style={{ height: `${Math.sqrt(inn / max) * 100}%` }} /> : null}
                  {out ? <span className="fh-cal-out" style={{ height: `${Math.sqrt(out / max) * 100}%` }} /> : null}
                </div>
                <span className="fh-cal-num">{dt.getDate()}</span>
              </div>
            </Tooltip>
          );
        })}
      </div>
    </Section>
  );
}

function Detected({ list, onAccepted }: { list: RecurringCandidate[]; onAccepted: () => void }) {
  const { instanceId } = useMoney();
  const [busy, setBusy] = useState<string | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const accept = async (c: RecurringCandidate, kind: "bill" | "subscription" | "income") => {
    setBusy(c.payee);
    try {
      await api.finance.recurringAccept({ instanceId, items: [{ payee: c.payee, cadence: c.cadence, amount: c.amount, nextDue: c.nextDue, kind }] });
      setGone((s) => new Set(s).add(c.payee));
      notify.success(`${c.payee} added to Recurring`);
      onAccepted();
    } catch (e) {
      notify.fromError(e, "Couldn't add it");
    } finally {
      setBusy(null);
    }
  };
  const visible = list.filter((c) => !gone.has(c.payee));
  if (!visible.length) return null;
  return (
    <Section title={<span className="inline-flex items-center gap-2"><Radar size={15} className="text-accent-text" />{visible.length} recurring {visible.length === 1 ? "payment" : "payments"} found in your transactions</span>} subtitle="Add them to include them in the forecast and reminders.">
      <div className="flex flex-col gap-2">
        <AnimatePresence initial={false} mode="popLayout">
          {visible.map((c) => (
            <m.div key={c.payee} layout exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.12, ease: [0.4, 0, 1, 1] } }} className="fh-detect">
              <Repeat size={15} className="text-accent-text flex-none" />
              <div className="flex-1 min-w-0">
                <div className="text-body-sm font-medium truncate">{c.payee}</div>
                <div className="text-caption text-tertiary" style={{ fontWeight: 400 }}>
                  {c.cadence[0].toUpperCase() + c.cadence.slice(1)} · seen {c.rowIds.length}× · next around {dayLabel(c.nextDue)} · {Math.round(c.confidence * 100)}% confident
                  {c.priceChange ? (
                    <span className="text-warning-text">
                      {" "}
                      · price changed {fmtMoney(c.priceChange.from)} → {fmtMoney(c.priceChange.to)} <ArrowUpRight size={11} className="inline" />
                    </span>
                  ) : null}
                </div>
              </div>
              <Amount value={c.amount} signed={Number(c.amount.amount) > 0} className="text-body-sm font-medium w-[90px] text-right" align="end" />
              {Number(c.amount.amount) > 0 ? (
                <Button size="xs" variant="secondary" icon={Plus} loading={busy === c.payee} onClick={() => accept(c, "income")}>
                  Income
                </Button>
              ) : (
                <>
                  <Button size="xs" variant="ghost" loading={busy === c.payee} onClick={() => accept(c, "bill")}>
                    Bill
                  </Button>
                  <Button size="xs" variant="secondary" icon={Check} loading={busy === c.payee} onClick={() => accept(c, "subscription")}>
                    Subscription
                  </Button>
                </>
              )}
            </m.div>
          ))}
        </AnimatePresence>
      </div>
    </Section>
  );
}

export function RecurringSkeleton() {
  return <Skeleton height={300} radius={10} />;
}
