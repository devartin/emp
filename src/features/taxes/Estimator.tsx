/**
 * Tax estimator (§15.6, §16.4): inputs with source chips for figures pulled from Money HQ and Portfolio, the
 * estimated balance due / refund (≈ range when answers are uncertain), bracket visualisation, "Show math" lines,
 * standard vs itemised, and scenario toggles with deltas. Never "you owe" — always an estimate.
 */
import { appName } from "@/features/lifeapps/identity";
import { Calculator, Link2, Plus, X } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/backend";
import type { TaxEstimate, TaxInput } from "@/backend/types";
import { cn } from "@/lib/cn";
import { Badge } from "@/ui/Badge";
import { Delta } from "@/ui/Delta";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { MoneyField } from "@/ui/MoneyField";
import { RollingNumber } from "@/ui/motion/RollingNumber";
import { spring } from "@/ui/motion/tokens";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { NumberField } from "@/ui/NumberField";
import { Segmented } from "@/ui/Segmented";
import { Select } from "@/ui/Select";
import { Sensitive } from "@/ui/Sensitive";
import { Skeleton } from "@/ui/Skeleton";
import { Slider } from "@/ui/Slider";
import { Switch } from "@/ui/Switch";
import { fmtPct, num } from "../finance/shared/format";
import { useAsync } from "../finance/shared/hooks";
import { disclose, Section } from "../finance/shared/ui";
import { STATUS_LABEL, taxCurrency, taxMoney, useTax } from "./data";
import { Figure } from "../finance/shared/Figure";
import type { FigureId } from "../finance/shared/definitions";

const INCOME_KINDS: { value: TaxInput["incomes"][number]["kind"]; label: string }[] = [
  { value: "wages", label: "Wages (W-2)" },
  { value: "self_employment", label: "Self-employment (net)" },
  { value: "interest", label: "Interest" },
  { value: "ordinary_dividends", label: "Ordinary dividends" },
  { value: "qualified_dividends", label: "Qualified dividends" },
  { value: "stcg", label: "Short-term gains" },
  { value: "ltcg", label: "Long-term gains" },
  { value: "retirement", label: "Retirement distributions" },
  { value: "social_security", label: "Social Security" },
  { value: "unemployment", label: "Unemployment" },
  { value: "rental", label: "Rental (net)" },
  { value: "other", label: "Other income" },
];
const ADJ_KINDS: { value: TaxInput["adjustments"][number]["kind"]; label: string }[] = [
  { value: "ira", label: "Traditional IRA" },
  { value: "hsa", label: "HSA" },
  { value: "student_loan_interest", label: "Student loan interest" },
  { value: "se_health", label: "Self-employed health insurance" },
  { value: "other", label: "Other adjustment" },
];

export default function Estimator() {
  const tx = useTax();
  const { whole: fmtWhole, compact } = taxMoney(tx.currency);
  const p = tx.profile;
  const est = tx.estimate;
  const [scenario, setScenario] = useState<{ se: boolean; retire: boolean; retireAmt: string }>({ se: false, retire: false, retireAmt: "3000" });
  const scenarioInput = useMemo(() => {
    if (!tx.input || (!scenario.se && !scenario.retire)) return null;
    return {
      ...tx.input,
      incomes: scenario.se ? [...tx.input.incomes, { kind: "self_employment" as const, amount: "5000", source: "Scenario" }] : tx.input.incomes,
      adjustments: scenario.retire ? [...tx.input.adjustments, { kind: "ira" as const, amount: scenario.retireAmt || "0" }] : tx.input.adjustments,
    };
  }, [tx.input, scenario]);
  const alt = useAsync(() => (scenarioInput ? api.tax.estimate(scenarioInput) : Promise.resolve(null)), [JSON.stringify(scenarioInput)]);

  // S18 income scrub: dragging the slider re-estimates live; the result rolls in scrub mode and the brackets morph.
  const [wageDelta, setWageDelta] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<TaxEstimate | null>(null);
  const reqId = useRef(0);
  useEffect(() => {
    if (!tx.input || wageDelta === 0) {
      setPreview(null);
      return;
    }
    const id = ++reqId.current;
    const incomes = tx.input.incomes.slice();
    const wi = Math.max(0, incomes.findIndex((x) => x.kind === "wages"));
    if (incomes[wi]) incomes[wi] = { ...incomes[wi], amount: Math.max(0, num(incomes[wi].amount) + wageDelta).toFixed(2) };
    api.tax
      .estimate({ ...tx.input, incomes })
      .then((e) => id === reqId.current && setPreview(e))
      .catch(() => undefined);
  }, [wageDelta, tx.input]);
  const shownEst = preview ?? est;
  if (!p) return <Skeleton height={480} radius={10} />;
  const setIncome = (i: number, patch: Partial<TaxInput["incomes"][number]>) => tx.setProfile({ incomes: p.incomes.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const setAdj = (i: number, patch: Partial<TaxInput["adjustments"][number]>) => tx.setProfile({ adjustments: p.adjustments.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  return (
    <div className="fh-grid">
      <div className="fh-span-5 flex flex-col gap-4">
        <Section title="Household" subtitle={`For ${p.year} · ${tx.pack ? `${tx.pack.name} v${tx.pack.version}` : p.packId}`}>
          <div className="grid grid-cols-2 gap-3">
            <Select label="Filing status" value={p.filingStatus} onValueChange={(v) => tx.setProfile({ filingStatus: v })} options={Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }))} />
            <NumberField label="Dependents under 17" value={p.dependents} onChange={(v) => tx.setProfile({ dependents: Math.max(0, Math.round(v ?? 0)) })} min={0} max={12} />
          </div>
        </Section>
        <Section title="Income" subtitle="Projected for the full year" actions={<Button size="xs" variant="ghost" icon={Plus} onClick={() => tx.setProfile({ incomes: [...p.incomes, { kind: "other", amount: "0" }] })}>Add</Button>}>
          <div className="flex flex-col gap-2">
            {p.incomes.map((x, i) => (
              <div key={i} className="tx-line">
                <Select size="sm" value={x.kind} onValueChange={(v) => setIncome(i, { kind: v })} options={INCOME_KINDS} className="flex-1" aria-label="Income type" />
                <MoneyField size="sm" currency={tx.currency} value={x.amount} onChange={(v) => setIncome(i, { amount: v ?? "0" })} wrapperClassName="w-[140px]" aria-label="Amount" />
                <IconButton icon={X} size="sm" label="Remove" onClick={() => tx.setProfile({ incomes: p.incomes.filter((_, j) => j !== i) })} />
                {x.source ? (
                  <span className="tx-source">
                    <Link2 size={11} /> {x.source}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
          {tx.pulled.length ? (
            <div className="tx-pulled">
              <div className="flex items-center gap-2">
                <Switch size="sm" checked={p.pullPortfolio} onCheckedChange={(v) => tx.setProfile({ pullPortfolio: v })} aria-label={`Include figures from ${appName("portfolio")}`} />
                <span className="text-body-sm font-medium flex-1">Include figures from {appName("portfolio")}</span>
              </div>
              <div className="flex flex-col gap-1 mt-2">
                {tx.pulled.map((x) => (
                  <div key={x.label} className={cn("flex items-center gap-2", !p.pullPortfolio && "opacity-50")}>
                    <Link2 size={12} className="text-tertiary flex-none" />
                    <span className="flex-1 min-w-0">
                      <span className="block text-body-sm text-secondary">{x.label}</span>
                      <span className="block text-caption text-tertiary truncate" style={{ fontWeight: 400 }}>{x.source}</span>
                    </span>
                    <span className="tabular font-medium text-body-sm"><Sensitive>{fmtWhole(x.amount, { signed: x.amount < 0 })}</Sensitive></span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </Section>
        <Section title="Adjustments & payments" actions={<Button size="xs" variant="ghost" icon={Plus} onClick={() => tx.setProfile({ adjustments: [...p.adjustments, { kind: "ira", amount: "0" }] })}>Add</Button>}>
          <div className="flex flex-col gap-2">
            {p.adjustments.map((x, i) => (
              <div key={i} className="tx-line">
                <Select size="sm" value={x.kind} onValueChange={(v) => setAdj(i, { kind: v })} options={ADJ_KINDS} className="flex-1" aria-label="Adjustment" />
                <MoneyField size="sm" currency={tx.currency} value={x.amount} onChange={(v) => setAdj(i, { amount: v ?? "0" })} wrapperClassName="w-[140px]" aria-label="Amount" />
                <IconButton icon={X} size="sm" label="Remove" onClick={() => tx.setProfile({ adjustments: p.adjustments.filter((_, j) => j !== i) })} />
              </div>
            ))}
            <div className="grid grid-cols-2 gap-3 mt-2">
              <MoneyField label="Withholding (full year)" currency={tx.currency} value={p.withheld} onChange={(v) => tx.setProfile({ withheld: v ?? "0" })} />
              <MoneyField label="Estimated payments made" currency={tx.currency} value={tx.input?.estimatedPaid ?? p.estimatedPaid} onChange={(v) => tx.setProfile({ estimatedPaid: v ?? "0" })} helper="From the Estimated payments database" readOnly />
            </div>
            <div className="mt-2">
              <div className="text-caption text-secondary mb-1.5" style={{ fontWeight: 500 }}>Deductions</div>
              <Segmented block size="sm" value={p.deductions} onValueChange={(v) => tx.setProfile({ deductions: v })} options={[{ value: "auto", label: "Not sure, compare" }, { value: "standard", label: "Standard" }, { value: "itemized", label: "Itemise" }]} aria-label="Deductions" />
            </div>
            <Switch className="mt-2" size="sm" checked={p.unsure} onCheckedChange={(v) => tx.setProfile({ unsure: v })} label="Some of these numbers are guesses (show a range)" />
          </div>
        </Section>
      </div>

      <div className="fh-span-7 flex flex-col gap-4">
        <Result est={shownEst ?? undefined} loading={tx.estimating && !est} unsure={p.unsure} scrubbing={dragging} live={dragging || preview !== null} />
        {shownEst ? <Brackets est={shownEst} scrubbing={dragging} /> : null}
        <Section title="What if">
          <div className="flex flex-col gap-3">
            <div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-body-sm font-medium">If your wages change by</span>
                <span className="tabular text-body-sm font-semibold" data-sensitive="">
                  <RollingNumber value={wageDelta} format={(n) => (Math.round(n) === 0 ? fmtWhole(0) : fmtWhole(Math.round(n), { signed: true }))} scrubbing={dragging} countUp={false} sensitive />
                </span>
              </div>
              <div className="mt-3" onPointerUp={() => setDragging(false)} onBlur={() => setDragging(false)}>
                <Slider
                  value={[wageDelta]}
                  min={-30000}
                  max={30000}
                  step={500}
                  onValueChange={(v) => {
                    setDragging(true);
                    setWageDelta(v[0]);
                  }}
                  onValueCommit={() => setDragging(false)}
                  formatValue={(n) => fmtWhole(n, { signed: true })}
                  aria-label="Change in wages"
                />
              </div>
              <div className="flex justify-between text-caption text-tertiary mt-1.5" style={{ fontWeight: 400 }}>
                <span>{compact(-30000)}</span>
                {wageDelta !== 0 ? (
                  <button type="button" className="tx-reset" onClick={() => setWageDelta(0)}>
                    Reset to your figures
                  </button>
                ) : (
                  <span>Drag to see the estimate and brackets move</span>
                )}
                <span>{compact(30000, true)}</span>
              </div>
            </div>
            <div className="fh-groove" />
            <ScenarioRow on={scenario.se} onChange={(v) => setScenario((s) => ({ ...s, se: v }))} label={`+${fmtWhole(5000)} self-employment income`} />
            <div className="flex items-center gap-3">
              <Switch size="sm" checked={scenario.retire} onCheckedChange={(v) => setScenario((s) => ({ ...s, retire: v }))} aria-label="Retirement contribution" />
              <span className="text-body-sm flex-1">Contribute to a traditional IRA</span>
              <MoneyField size="sm" currency={tx.currency} value={scenario.retireAmt} onChange={(v) => setScenario((s) => ({ ...s, retireAmt: v ?? "0" }))} wrapperClassName="w-[120px]" aria-label="Contribution" />
            </div>
            <AnimatePresence initial={false} mode="popLayout">
              {alt.data && est ? (
                <m.div key="delta" {...disclose}>
                  <div className="tx-delta">
                    <span className="text-body-sm text-secondary">With these changes, estimated total tax</span>
                    {/* A change in tax is a delta; up is bad (invert), the arrow stays truthful. */}
                    <Delta money={taxMoneyValue(Math.round(num(alt.data.totalTax) - num(est.totalTax)), tx.currency)} invert className="text-body-sm font-medium" />
                    <span className="text-caption text-tertiary">{num(alt.data.balance) >= 0 ? "Balance due" : "Refund"} <Sensitive>{fmtWhole(Math.abs(num(alt.data.balance)))}</Sensitive></span>
                  </div>
                </m.div>
              ) : null}
            </AnimatePresence>
          </div>
        </Section>
      </div>
    </div>
  );
}

function ScenarioRow({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <Switch size="sm" checked={on} onCheckedChange={onChange} aria-label={label} />
      <span className="text-body-sm flex-1">{label}</span>
    </div>
  );
}

/**
 * The estimate figure. It is set as plain text on arrival and on every refetch; it rolls only while the wage slider
 * is being scrubbed (`live`), where the movement is the point.
 */
export function Result({ est, loading, unsure, compact, scrubbing, live }: { est: TaxEstimate | undefined; loading?: boolean; unsure?: boolean; compact?: boolean; scrubbing?: boolean; live?: boolean }) {
  const { whole: fmtWhole } = taxMoney(taxCurrency(est));
  const bal = est ? num(est.balance) : 0;
  const refund = bal < 0;
  // owe ⇄ refund crossing: the figure does one pop (1 → 1.04 → 1) and the status pill flips colour
  const prevRefund = useRef<boolean | null>(null);
  const [flips, setFlips] = useState(0);
  useEffect(() => {
    if (!est) return;
    if (prevRefund.current !== null && prevRefund.current !== refund) setFlips((n) => n + 1);
    prevRefund.current = refund;
  }, [refund, est]);
  const reduced = useReducedMotionPref();
  if (loading || !est) return <Skeleton height={compact ? 178 : 260} radius={10} />;
  return (
    <section className="fh-card tx-result" data-refund={refund ? "" : undefined}>
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="tx-status" data-refund={refund ? "" : undefined}>
              {refund ? "Estimated refund" : "Estimated balance due"}
            </span>
            <Badge tone="outline" icon={Calculator}>Estimate</Badge>
            {est.stale ? <Badge tone="warning">Pack may be out of date</Badge> : null}
          </div>
          <m.div key={flips} className="tx-big tabular" data-sensitive="" initial={false} animate={flips && !reduced ? { scale: [1, 1.04, 1] } : undefined} transition={{ duration: 0.42, ease: [0.2, 0, 0, 1] }} style={{ originX: 0 }}>
            {est.range || unsure ? <span className="tx-approx">≈</span> : null}
            {/* The figure discloses its own working (N-MO3): AGI, deduction, taxable income and the engine's lines. */}
            <Figure id="tax.due" block inputs={taxWorking(est)}>
              {live ? <RollingNumber value={Math.abs(Math.round(bal))} format={(n) => fmtWhole(n)} scrubbing={scrubbing} sensitive countUp={false} /> : <span>{fmtWhole(Math.abs(Math.round(bal)))}</span>}
            </Figure>
          </m.div>
          {est.range ? (
            <div className="text-body-sm text-secondary">
              Likely between <Sensitive>{fmtWhole(est.range.low)}</Sensitive> and <Sensitive>{fmtWhole(est.range.high)}</Sensitive> (±10% income)
            </div>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 flex-none">
          <Fig label="Total tax" value={fmtWhole(est.totalTax)} />
          <Fig label="Taxable income" value={fmtWhole(est.taxable)} />
          <Fig label="Effective rate" value={fmtPct(est.effectiveRate, 1)} plain figure="tax.effective" inputs={[{ label: "Total tax", value: fmtWhole(est.totalTax) }, { label: "AGI", value: fmtWhole(est.agi) }]} />
          <Fig label="Marginal rate" value={fmtPct(est.marginalRate, 0)} plain figure="tax.marginal" />
        </div>
      </div>
      {compact ? (
        <div className="tx-deduction">
          <DeductionLine est={est} />
          <span className="text-caption text-tertiary" style={{ fontWeight: 400 }}>
            AGI <Sensitive>{fmtWhole(est.agi)}</Sensitive> · SE tax <Sensitive>{fmtWhole(est.seTax)}</Sensitive>
          </span>
        </div>
      ) : null}
      {!compact ? (
        <>
          <div className="tx-deduction">
            <DeductionLine est={est} />
            <span className="text-caption text-tertiary tabular" style={{ fontWeight: 400 }}>
              {est.deduction.kind === "itemized" ? (
                <>Standard deduction would be <Sensitive>{fmtWhole(est.deduction.standardWouldBe)}</Sensitive></>
              ) : est.deduction.itemizedWouldBe !== undefined ? (
                <>Itemised would be <Sensitive>{fmtWhole(est.deduction.itemizedWouldBe)}</Sensitive></>
              ) : null}
            </span>
          </div>
        </>
      ) : null}
    </section>
  );
}

/**
 * The deduction the estimate uses, named for what it is. With the standard deduction the engine adds the 2026
 * non-itemiser cash charity deduction on top, so the amount is shown as its two parts rather than as a "standard
 * deduction" that disagrees with the pack's standard figure.
 */
function DeductionLine({ est }: { est: TaxEstimate }) {
  const { whole: fmtWhole } = taxMoney(taxCurrency(est));
  const amount = num(est.deduction.amount);
  const std = num(est.deduction.standardWouldBe);
  const extra = est.deduction.kind === "standard" ? Math.round(amount - std) : 0;
  return (
    <span className="text-body-sm">
      {est.deduction.kind === "itemized" ? "Itemised deductions" : "Standard deduction"} ·{" "}
      <b className="tabular">
        <Sensitive>{fmtWhole(est.deduction.kind === "itemized" ? amount : std)}</Sensitive>
      </b>
      {extra > 0 ? (
        <span className="text-secondary">
          {" "}
          + <Sensitive>{fmtWhole(extra)}</Sensitive> cash gifts (non-itemiser deduction)
        </span>
      ) : null}
    </span>
  );
}

/** The working behind the estimate, as popover rows (replaces the old "Show math" toggle). */
function taxWorking(est: TaxEstimate) {
  const { whole: fmtWhole, money: fmtMoney } = taxMoney(taxCurrency(est));
  return [
    { label: "Gross income", value: fmtWhole(est.gross) },
    { label: "Adjusted gross income", value: fmtWhole(est.agi) },
    { label: est.deduction.kind === "itemized" ? "Itemised deductions" : "Standard deduction and cash gifts", value: fmtWhole(-num(est.deduction.amount)) },
    { label: "Taxable income", value: fmtWhole(est.taxable) },
    ...est.lines.map((l) => ({ label: l.packRef ? `${l.label} (${l.packRef.split(".")[0]})` : l.label, value: fmtMoney(l.value) })),
  ];
}

function Fig({ label, value, plain, figure, inputs }: { label: string; value: string; plain?: boolean; figure?: FigureId; inputs?: { label: string; value: string }[] }) {
  const v = plain ? value : <Sensitive>{value}</Sensitive>;
  return (
    <div className="flex flex-col">
      <span className="text-caption text-tertiary" style={{ fontWeight: 500 }}>{label}</span>
      <span className="text-body font-semibold tabular">{figure ? <Figure id={figure} inputs={inputs}>{v}</Figure> : v}</span>
    </div>
  );
}

/** Ordinary-income brackets as a staircase: segment width = bracket span, fill = income taxed there. */
export function Brackets({ est, scrubbing }: { est: TaxEstimate; scrubbing?: boolean }) {
  const { whole: fmtWhole, compact } = taxMoney(taxCurrency(est));
  // Compact labels keep the tax figure inside narrow (low-bracket) segments.
  const fmtCompactTax = (n: number) => compact(n);
  const fmtCompactK = (n: number) => compact(n >= 1000 ? Math.round(n / 1000) * 1000 : Math.round(n));
  const taxable = num(est.taxable);
  const pref = num(est.preferentialTax) > 0;
  const bands = est.brackets.filter((b, i) => num(b.taxed) > 0 || i === 0 || num(b.from) <= taxable * 1.25);
  const lastShown = bands[bands.length - 1];
  const cap = Math.max(taxable * 1.15, lastShown?.to ? num(lastShown.to) : taxable * 1.3);
  const span = (b: TaxEstimate["brackets"][number]) => (b.to === null ? cap : Math.min(num(b.to), cap)) - num(b.from);
  const total = bands.reduce((a, b) => a + Math.max(0, span(b)), 0) || 1;
  const ordinaryTaxable = bands.reduce((a, b) => a + num(b.taxed), 0);
  return (
    <Section title="Where your income lands" subtitle={`Ordinary taxable income across the ${bands.length} lowest brackets${pref ? " · qualified dividends and long-term gains are stacked on top at lower rates" : ""}`}>
      <div className="tx-brackets" role="img" aria-label={`Taxable income of ${fmtWhole(taxable)} reaches the ${fmtPct(est.marginalRate, 0)} bracket`}>
        {bands.map((b, i) => {
          const w = (Math.max(0, span(b)) / total) * 100;
          const fill = span(b) > 0 ? Math.min(1, num(b.taxed) / span(b)) : 0;
          const rate = Number(b.rate);
          return (
            <div key={i} className="tx-br" style={{ flex: `${w} 1 0%` }}>
              <span className="tx-br-rate" data-active={num(b.taxed) > 0 ? "" : undefined}>{Math.round(rate * 100)}%</span>
              <div className="tx-br-bar" style={{ height: 14 + rate * 120 }}>
                <m.i initial={false} animate={{ scaleX: fill }} transition={scrubbing ? spring.glide : { duration: 0.24, ease: [0.2, 0, 0, 1] }} style={{ ["--a" as string]: Math.min(1, 0.35 + rate * 1.6) }} data-full={fill >= 0.999 ? "" : undefined} />
              </div>
              <span className="tx-br-range tabular">{fmtCompactK(num(b.from))}</span>
              {num(b.taxed) > 0 ? (
                <span className="tx-br-taxed tabular">
                  <Sensitive>{w < 18 ? fmtCompactTax(num(b.taxed) * rate) : fmtWhole(num(b.taxed) * rate)}</Sensitive> tax
                </span>
              ) : (
                <span className="tx-br-taxed" />
              )}
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between mt-3 text-caption text-tertiary" style={{ fontWeight: 400 }}>
        <span>Taxable ordinary income <b className="text-primary tabular"><Sensitive>{fmtWhole(ordinaryTaxable)}</Sensitive></b></span>
        <span>Each extra dollar is taxed at <b className="text-primary">{fmtPct(est.marginalRate, 0)}</b>: the marginal rate, not the average.</span>
      </div>
    </Section>
  );
}

/** A whole-unit tax figure as `Money` in the tax year's currency (for `<Delta>`). */
function taxMoneyValue(amount: number, currency: string) {
  return { amount: String(amount), currency };
}
