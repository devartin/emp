/**
 * Tax estimator (§15.6, §16.4): inputs with source chips for figures pulled from Money HQ and Portfolio, the
 * estimated balance due / refund (≈ range when answers are uncertain), bracket visualisation, "Show math" lines,
 * standard vs itemised, and scenario toggles with deltas. Never "you owe" — always an estimate.
 */
import { Calculator, ChevronDown, Link2, Plus, Sparkles, X } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/backend";
import type { TaxEstimate, TaxInput } from "@/backend/types";
import { cn } from "@/lib/cn";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { MoneyField } from "@/ui/MoneyField";
import { EdgeLight } from "@/ui/motion/EdgeLight";
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
import { Tooltip } from "@/ui/Tooltip";
import { fmtMoney, fmtPct, num, fmtWhole } from "../finance/shared/format";
import { useAsync } from "../finance/shared/hooks";
import { disclose, Section } from "../finance/shared/ui";
import { STATUS_LABEL, useTax } from "./data";

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
  if (!p) return <Skeleton height={480} radius={14} />;
  const setIncome = (i: number, patch: Partial<TaxInput["incomes"][number]>) => tx.setProfile({ incomes: p.incomes.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const setAdj = (i: number, patch: Partial<TaxInput["adjustments"][number]>) => tx.setProfile({ adjustments: p.adjustments.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  return (
    <div className="fh-grid">
      <div className="fh-span-5 flex flex-col gap-4">
        <Section title="Household" subtitle={`Tax year ${p.year} · ${tx.pack ? `${tx.pack.name} v${tx.pack.version}` : p.packId}`}>
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
                <MoneyField size="sm" value={x.amount} onChange={(v) => setIncome(i, { amount: v ?? "0" })} wrapperClassName="w-[140px]" aria-label="Amount" />
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
                <Switch size="sm" checked={p.pullPortfolio} onCheckedChange={(v) => tx.setProfile({ pullPortfolio: v })} aria-label="Include figures from Portfolio" />
                <span className="text-body-sm font-medium flex-1">Include figures from Portfolio</span>
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
                <MoneyField size="sm" value={x.amount} onChange={(v) => setAdj(i, { amount: v ?? "0" })} wrapperClassName="w-[140px]" aria-label="Amount" />
                <IconButton icon={X} size="sm" label="Remove" onClick={() => tx.setProfile({ adjustments: p.adjustments.filter((_, j) => j !== i) })} />
              </div>
            ))}
            <div className="grid grid-cols-2 gap-3 mt-2">
              <MoneyField label="Withholding (full year)" value={p.withheld} onChange={(v) => tx.setProfile({ withheld: v ?? "0" })} />
              <MoneyField label="Estimated payments made" value={tx.input?.estimatedPaid ?? p.estimatedPaid} onChange={(v) => tx.setProfile({ estimatedPaid: v ?? "0" })} helper="From the Estimated payments database" readOnly />
            </div>
            <div className="mt-2">
              <div className="text-caption text-secondary mb-1.5" style={{ fontWeight: 500 }}>Deductions</div>
              <Segmented block size="sm" value={p.deductions} onValueChange={(v) => tx.setProfile({ deductions: v })} options={[{ value: "auto", label: "Not sure — compare" }, { value: "standard", label: "Standard" }, { value: "itemized", label: "Itemise" }]} aria-label="Deductions" />
            </div>
            <Switch className="mt-2" size="sm" checked={p.unsure} onCheckedChange={(v) => tx.setProfile({ unsure: v })} label="Some of these numbers are guesses (show a range)" />
          </div>
        </Section>
      </div>

      <div className="fh-span-7 flex flex-col gap-4">
        <Result est={shownEst ?? undefined} loading={tx.estimating && !est} unsure={p.unsure} scrubbing={dragging} />
        {shownEst ? <Brackets est={shownEst} scrubbing={dragging} /> : null}
        <Section title={<span className="inline-flex items-center gap-2"><Sparkles size={14} className="text-accent-text" />What if…</span>} subtitle="Toggle a scenario to see how the estimate moves.">
          <div className="flex flex-col gap-3">
            <div className="tx-scrub">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-body-sm font-medium">If your wages change by</span>
                <span className="tabular text-body-sm font-semibold" data-sensitive="">
                  <RollingNumber value={wageDelta} format={(n) => (Math.round(n) === 0 ? "$0" : fmtWhole(Math.round(n), { signed: true }))} scrubbing={dragging} countUp={false} sensitive />
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
                <span>−$30k</span>
                {wageDelta !== 0 ? (
                  <button type="button" className="tx-reset" onClick={() => setWageDelta(0)}>
                    Reset to your figures
                  </button>
                ) : (
                  <span>Drag to see the estimate and brackets move</span>
                )}
                <span>+$30k</span>
              </div>
            </div>
            <div className="fh-groove" />
            <ScenarioRow on={scenario.se} onChange={(v) => setScenario((s) => ({ ...s, se: v }))} label="+$5,000 self-employment income" />
            <div className="flex items-center gap-3">
              <Switch size="sm" checked={scenario.retire} onCheckedChange={(v) => setScenario((s) => ({ ...s, retire: v }))} aria-label="Retirement contribution" />
              <span className="text-body-sm flex-1">Contribute to a traditional IRA</span>
              <MoneyField size="sm" value={scenario.retireAmt} onChange={(v) => setScenario((s) => ({ ...s, retireAmt: v ?? "0" }))} wrapperClassName="w-[120px]" aria-label="Contribution" />
            </div>
            <AnimatePresence initial={false} mode="popLayout">
              {alt.data && est ? (
                <m.div key="delta" {...disclose}>
                  <div className="tx-delta">
                    <span className="text-body-sm text-secondary">With these changes, estimated total tax</span>
                    <span className="tabular font-semibold" style={{ color: num(alt.data.totalTax) > num(est.totalTax) ? "var(--loss-text)" : "var(--gain-text)" }}>
                      <Sensitive>{fmtWhole(num(alt.data.totalTax) - num(est.totalTax), { signed: true })}</Sensitive>
                    </span>
                    <span className="text-caption text-tertiary">→ {num(alt.data.balance) >= 0 ? "balance due" : "refund"} <Sensitive>{fmtWhole(Math.abs(num(alt.data.balance)))}</Sensitive></span>
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

export function Result({ est, loading, unsure, compact, scrubbing }: { est: TaxEstimate | undefined; loading?: boolean; unsure?: boolean; compact?: boolean; scrubbing?: boolean }) {
  const [math, setMath] = useState(false);
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
  if (loading || !est) return <Skeleton height={compact ? 178 : 260} radius={14} />;
  return (
    <section className="fh-card tx-result" data-refund={refund ? "" : undefined} data-light="">
      <EdgeLight specular />
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="tx-flip" data-refund={refund ? "" : undefined}>
              {refund ? "Refund" : "Owe"}
            </span>
            <span className="text-caption text-secondary" style={{ fontWeight: 500 }}>
              {refund ? "Estimated refund" : "Estimated balance due"}
            </span>
            <Badge tone="outline" icon={Calculator}>Estimate</Badge>
            {est.stale ? <Badge tone="warning">Pack may be out of date</Badge> : null}
          </div>
          <m.div key={flips} className="tx-big tabular" data-sensitive="" initial={false} animate={flips && !reduced ? { scale: [1, 1.04, 1] } : undefined} transition={{ duration: 0.42, ease: [0.2, 0, 0, 1] }} style={{ originX: 0 }}>
            {est.range || unsure ? <span className="tx-approx">≈</span> : null}
            <span className="tx-sym">$</span>
            <RollingNumber value={Math.abs(Math.round(bal))} format={(n) => Math.round(n).toLocaleString()} scrubbing={scrubbing} countUpKey="tax:balance" sensitive />
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
          <Fig label="Effective rate" value={fmtPct(est.effectiveRate, 1)} plain />
          <Fig label="Marginal rate" value={fmtPct(est.marginalRate, 0)} plain />
        </div>
      </div>
      {compact ? (
        <div className="tx-deduction">
          <span className="text-body-sm">
            {est.deduction.kind === "itemized" ? "Itemising" : "Standard deduction"} · <b className="tabular"><Sensitive>{fmtWhole(est.deduction.amount)}</Sensitive></b>
          </span>
          <span className="text-caption text-tertiary" style={{ fontWeight: 400 }}>
            AGI <Sensitive>{fmtWhole(est.agi)}</Sensitive> · SE tax <Sensitive>{fmtWhole(est.seTax)}</Sensitive>
          </span>
        </div>
      ) : null}
      {!compact ? (
        <>
          <div className="tx-deduction">
            <span className="text-body-sm">
              {est.deduction.kind === "itemized" ? "Itemising" : "Standard deduction"} · <b className="tabular"><Sensitive>{fmtWhole(est.deduction.amount)}</Sensitive></b>
            </span>
            <span className="text-caption text-tertiary" style={{ fontWeight: 400 }}>
              {est.deduction.kind === "itemized" ? `beats the standard ${fmtWhole(est.deduction.standardWouldBe)}` : `standard ${fmtWhole(est.deduction.standardWouldBe)} is the better choice`}
            </span>
          </div>
          <button type="button" className="tx-math-toggle" onClick={() => setMath((v) => !v)} aria-expanded={math}>
            <ChevronDown size={14} style={{ transform: math ? "rotate(180deg)" : undefined, transition: "transform 160ms" }} />
            {math ? "Hide math" : "Show math"}
          </button>
          <AnimatePresence initial={false} mode="popLayout">
            {math ? (
              <m.dl key="math" {...disclose} className="tx-math">
                {[
                  { label: "Gross income", value: est.gross },
                  { label: "Adjusted gross income (AGI)", value: est.agi },
                  { label: `${est.deduction.kind === "itemized" ? "Itemised" : "Standard"} deduction`, value: String(-num(est.deduction.amount)) },
                  { label: "Taxable income", value: est.taxable, strong: true },
                ].map((l) => (
                  <div key={l.label} className={cn("tx-math-row", l.strong && "is-strong")}>
                    <dt>{l.label}</dt>
                    <dd className="tabular"><Sensitive>{fmtMoney(l.value)}</Sensitive></dd>
                  </div>
                ))}
                <div className="fh-divider" />
                {est.lines.map((l) => (
                  <div key={l.label} className={cn("tx-math-row", /total|balance|refund/i.test(l.label) && "is-strong")}>
                    <dt>
                      {l.label}
                      {l.packRef ? (
                        <Tooltip content={`Pack: ${l.packRef}`}>
                          <span className="tx-ref" tabIndex={0}>{l.packRef.split(".")[0]}</span>
                        </Tooltip>
                      ) : null}
                    </dt>
                    <dd className="tabular"><Sensitive>{fmtMoney(l.value)}</Sensitive></dd>
                  </div>
                ))}
              </m.dl>
            ) : null}
          </AnimatePresence>
        </>
      ) : null}
    </section>
  );
}

function Fig({ label, value, plain }: { label: string; value: string; plain?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="text-caption text-tertiary" style={{ fontWeight: 500 }}>{label}</span>
      <span className="text-body font-semibold tabular">{plain ? value : <Sensitive>{value}</Sensitive>}</span>
    </div>
  );
}

/** Ordinary-income brackets as a staircase: segment width = bracket span, fill = income taxed there. */
export function Brackets({ est, scrubbing }: { est: TaxEstimate; scrubbing?: boolean }) {
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
                <m.i initial={{ scaleX: 0 }} animate={{ scaleX: fill }} transition={scrubbing ? spring.glide : { duration: 0.7, delay: 0.1 + i * 0.05, ease: [0.16, 1, 0.3, 1] }} style={{ ["--a" as string]: Math.min(1, 0.35 + rate * 1.6) }} data-full={fill >= 0.999 ? "" : undefined} />
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
        <span>Each extra dollar is taxed at <b className="text-primary">{fmtPct(est.marginalRate, 0)}</b> — that's your marginal rate, not your average.</span>
      </div>
    </Section>
  );
}

/** "$1.2k" keeps the tax label inside narrow (low-bracket) segments. */
function fmtCompactTax(n: number): string {
  return n >= 1000 ? `$${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : `$${Math.round(n)}`;
}

function fmtCompactK(n: number): string {
  if (n >= 1000) return `$${Math.round(n / 1000)}k`;
  return `$${Math.round(n)}`;
}
