/**
 * Quarterly estimated payments (§15.6): safe harbor / 90% of this year / even split, a four-period timeline with
 * due dates and status, and recording a payment into the Estimated payments database.
 */
import { CalendarCheck, Check, Clock, Info } from "lucide-react";
import { m } from "motion/react";
import { useState } from "react";
import { api } from "@/backend";
import type { QuarterlyPlan as Plan } from "@/backend/types";
import { cn } from "@/lib/cn";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { Dialog } from "@/ui/Dialog";
import { Input } from "@/ui/Input";
import { MoneyField } from "@/ui/MoneyField";
import { Segmented } from "@/ui/Segmented";
import { Sensitive } from "@/ui/Sensitive";
import { Skeleton } from "@/ui/Skeleton";
import { daysBetween, dayLabel, fmtMoney, num, todayIso } from "../finance/shared/format";
import { useAsync } from "../finance/shared/hooks";
import { Section } from "../finance/shared/ui";
import { useTax } from "./data";

const METHODS = [
  { value: "safe_harbor", label: "Safe harbor", help: "Pay 100% of last year's tax (110% above $150k AGI) — no underpayment penalty even if this year is higher." },
  { value: "current_90", label: "90% of this year", help: "Pay 90% of this year's estimated tax. Lower if income fell, but relies on the estimate." },
  { value: "even_split", label: "Even split", help: "Spread the estimated balance due evenly over the remaining periods." },
] as const;

export function useQuarterly() {
  const tx = useTax();
  const p = tx.profile;
  const est = tx.estimate;
  const paid = tx.payments.filter((x) => x.paidOn && x.amount).map((x) => ({ date: x.paidOn!, amount: x.amount.toFixed(2) }));
  return useAsync(
    () => (p && est ? api.tax.quarterlyPlan({ packId: p.packId, year: p.year, method: p.method, estimate: est, priorYearTax: p.priorYearTax, priorYearAgi: p.priorYearAgi, paid }) : Promise.resolve(null as Plan | null)),
    [p?.method, p?.priorYearTax, p?.priorYearAgi, JSON.stringify(est?.totalTax), JSON.stringify(paid)],
  );
}

export default function QuarterlyPlan() {
  const tx = useTax();
  const p = tx.profile;
  const plan = useQuarterly();
  const [recording, setRecording] = useState<{ period: string; suggested: string } | null>(null);
  if (!p) return <Skeleton height={360} radius={14} />;
  const method = METHODS.find((x) => x.value === p.method) ?? METHODS[0];
  const next = plan.data?.due.find((d) => d.status !== "paid" && d.date >= todayIso());
  return (
    <div className="flex flex-col gap-4">
      <Section title="How to size payments" subtitle={method.help} actions={<Segmented size="sm" value={p.method} onValueChange={(v) => tx.setProfile({ method: v })} options={METHODS.map(({ value, label }) => ({ value, label }))} aria-label="Method" />}>
        <div className="grid grid-cols-3 gap-3">
          <MoneyField label="Last year's total tax" value={p.priorYearTax} onChange={(v) => tx.setProfile({ priorYearTax: v ?? "0" })} helper="From your prior-year return" />
          <MoneyField label="Last year's AGI" value={p.priorYearAgi} onChange={(v) => tx.setProfile({ priorYearAgi: v ?? "0" })} />
          <div className="tx-next">
            <span className="text-caption text-secondary" style={{ fontWeight: 500 }}>Next payment</span>
            {next ? (
              <>
                <span className="tabular" style={{ fontSize: 22, fontWeight: 640 }}>{num(next.suggested) === 0 ? <span className="text-gain-text">Covered</span> : <Sensitive>{fmtMoney(next.suggested, "USD", { noCents: true })}</Sensitive>}</span>
                <span className="text-caption text-tertiary">{next.period} · due {dayLabel(next.date, true)} · in {daysBetween(todayIso(), next.date)} days</span>
              </>
            ) : (
              <span className="text-body-sm text-tertiary">Nothing left this year</span>
            )}
          </div>
        </div>
      </Section>
      <Section title={`Estimated payments · ${p.year}`} subtitle={plan.data?.note}>
        {!plan.data ? (
          <Skeleton height={150} />
        ) : (
          <div className="tx-timeline">
            {plan.data.due.map((d, i) => {
              const paidRow = tx.payments.find((x) => x.period === d.period);
              const isPaid = d.status === "paid";
              return (
                <m.div key={d.period} className={cn("tx-q", isPaid && "is-paid")} data-status={d.status} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05, type: "spring", stiffness: 260, damping: 30 }}>
                  <div className="tx-q-dot">{isPaid ? <Check size={12} strokeWidth={3} /> : d.status === "late" ? "!" : i + 1}</div>
                  <div className="text-body font-semibold">{d.period}</div>
                  <div className="text-caption text-tertiary" style={{ fontWeight: 400 }}>Due {dayLabel(d.date, true)}</div>
                  <div className="tabular mt-2" style={{ fontSize: 18, fontWeight: 620 }}>
                    <Sensitive>{isPaid ? fmtMoney(d.paid, "USD", { noCents: true }) : fmtMoney(d.suggested, "USD", { noCents: true })}</Sensitive>
                  </div>
                  <div className="mt-1">
                    {isPaid ? (
                      <Badge tone="gain" icon={Check}>Paid {paidRow?.paidOn ? dayLabel(paidRow.paidOn) : ""}</Badge>
                    ) : d.status === "late" ? (
                      <Badge tone="danger">Past due</Badge>
                    ) : d.status === "due_soon" ? (
                      <Badge tone="warning" icon={Clock}>Due soon</Badge>
                    ) : num(d.suggested) === 0 ? (
                      <Badge tone="gain">Covered — nothing more needed</Badge>
                    ) : (
                      <Badge tone="neutral">Suggested</Badge>
                    )}
                  </div>
                  {!isPaid && num(d.suggested) > 0 ? (
                    <Button size="xs" variant={d.status === "due_soon" ? "primary" : "secondary"} className="mt-3" icon={CalendarCheck} onClick={() => setRecording({ period: d.period, suggested: d.suggested })}>
                      Record payment
                    </Button>
                  ) : null}
                </m.div>
              );
            })}
          </div>
        )}
      </Section>
      <div className="fh-alert" data-tone="info">
        <Info size={16} />
        <span className="text-body-sm">Pay through IRS Direct Pay or EFTPS. EMP never makes payments — record them here so the plan and reminders stay accurate.</span>
      </div>
      {recording ? <RecordDialog period={recording.period} suggested={recording.suggested} onClose={() => setRecording(null)} /> : null}
    </div>
  );
}

function RecordDialog({ period, suggested, onClose }: { period: string; suggested: string; onClose: () => void }) {
  const tx = useTax();
  const [amount, setAmount] = useState<string | null>(num(suggested) ? num(suggested).toFixed(2) : null);
  const [date, setDate] = useState(todayIso());
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Record ${period} payment`}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!amount || num(amount) <= 0} onClick={() => void tx.recordPayment(period, num(amount), date).then(onClose)}>
            Record
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <MoneyField label="Amount paid" value={amount} onChange={setAmount} autoFocus />
        <Input label="Paid on" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
    </Dialog>
  );
}
