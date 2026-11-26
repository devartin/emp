/** Performance: time-weighted return vs benchmark, XIRR, and realised gains for the year (short vs long term). */
import { useMemo, useState } from "react";
import { api } from "@/backend";
import type { Id, PerfRange, PortfolioSummary } from "@/backend/types";
import { LineChart } from "@/charts/Line";
import { Badge } from "@/ui/Badge";
import { Segmented } from "@/ui/Segmented";
import { Sensitive } from "@/ui/Sensitive";
import { dayLabel, fmtPct, fmtPp, fmtQty, num, fmtWhole } from "../finance/shared/format";
import { Figure } from "../finance/shared/Figure";
import { figureLabel, periodReturn, rangeYears, twrFigures, vsBenchmarkPts } from "../finance/shared/definitions";
import { useAsync } from "../finance/shared/hooks";
import { Quiet, Section, Signed, Stat } from "../finance/shared/ui";
import { ticker } from "../markets/data";

const BENCHMARK = "EMP500:INDEX";
const PERF_RANGES: { value: PerfRange; label: string }[] = [
  { value: "3m", label: "3M" },
  { value: "ytd", label: "YTD" },
  { value: "1y", label: "1Y" },
  { value: "5y", label: "5Y" },
  { value: "all", label: "All" },
];

export default function Performance({ instanceId, summary: s }: { instanceId: Id; summary?: PortfolioSummary }) {
  const [range, setRange] = useState<PerfRange>("1y");
  const perf = useAsync(() => api.portfolio.performance({ instanceId, range, benchmark: BENCHMARK }), [instanceId, range]);
  const year = new Date().getFullYear();
  const realized = useAsync(() => api.portfolio.realized({ instanceId, year }), [instanceId, year]);
  const data = useMemo(() => (perf.data ? perf.data.t.map((t, i) => ({ t, twr: perf.data!.twr[i], bench: perf.data!.benchmark?.[i] ?? 0 })) : []), [perf.data]);
  const last = data[data.length - 1];
  const long = range === "5y" || range === "all";
  const benchLabel = ticker(BENCHMARK);
  const rangeLabel = PERF_RANGES.find((r) => r.value === range)?.label ?? range;
  // One TWR definition (definitions.ts `pf.twr`): cumulative over the range; annualised beside it only for ≥ 1 year.
  const years = rangeYears(perf.data?.t);
  const twr = twrFigures(perf.data?.twr, years);
  const mwr = perf.data?.xirr !== undefined ? periodReturn(perf.data.xirr, years) : null;
  return (
    <div className="flex flex-col gap-4">
      <Section
        title={`Time-weighted return vs ${benchLabel}`}
        actions={<Segmented size="sm" value={range} onValueChange={setRange} aria-label="Range" options={PERF_RANGES} />}
      >
        <div className="flex gap-8 mb-4">
          <Stat
            label={figureLabel("pf.twr", rangeLabel)}
            value={twr ? <Signed value={twr.cumulative}><Figure id="pf.twr" range={rangeLabel} inputs={twr.annual !== null ? [{ label: "A year", value: fmtPct(twr.annual, 1, true), sensitive: false }] : undefined}>{fmtPct(twr.cumulative, 1, true)}</Figure></Signed> : "—"}
            sub={twr?.annual != null && years > 1.05 ? `${fmtPct(twr.annual, 1, true)} a year` : undefined}
            size="lg"
          />
          <Stat label={`${benchLabel} · ${rangeLabel}`} value={last ? <Signed value={last.bench}>{fmtPct(last.bench, 1, true)}</Signed> : "—"} size="lg" />
          <Stat label={`vs ${benchLabel}`} value={last ? <Signed value={last.twr - last.bench}><Figure id="pf.vsBench" range={rangeLabel}>{fmtPp(vsBenchmarkPts(last.twr, last.bench))}</Figure></Signed> : "—"} size="lg" />
          <Stat
            label={figureLabel("pf.mwr.range", rangeLabel)}
            value={mwr ? <Figure id="pf.mwr.range" range={rangeLabel}>{fmtPct(mwr.value, 1, true)}</Figure> : "—"}
            sub={mwr?.annualised ? "a year" : undefined}
            size="lg"
          />
        </div>
        <LineChart
          data={data}
          x="t"
          series={[
            { key: "twr", label: "Portfolio", color: "var(--accent-solid)", area: true },
            { key: "bench", label: benchLabel, color: "var(--text-tertiary)", dashed: true },
          ]}
          format="percent"
          colorBySign={false}
          startReference={false}
          height={260}
          curve="linear"
          includeZero
          xFormat={(v) => new Date(Number(v)).toLocaleDateString(undefined, long ? { month: "short", year: "2-digit" } : { month: "short", day: "numeric" })}
          xTooltipFormat={(v) => new Date(Number(v)).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
          loading={perf.loading && !perf.data}
          summaryLabel="Cumulative time-weighted return versus benchmark"
        />
      </Section>
      <div className="fh-grid">
        <Section className="fh-span-4" title={`Realised in ${year}`} subtitle="Taxable and sheltered accounts">
          <div className="flex flex-col gap-4">
            <Stat label="Short-term (held ≤ 1 year)" value={realized.data ? <Signed value={num(realized.data.totals.short)}><Sensitive>{fmtWhole(realized.data.totals.short, { signed: true })}</Sensitive></Signed> : "—"} />
            <Stat label="Long-term" value={realized.data ? <Signed value={num(realized.data.totals.long)}><Sensitive>{fmtWhole(realized.data.totals.long, { signed: true })}</Sensitive></Signed> : "—"} />
            <Stat label="Unrealised today" value={s ? <Signed value={num(s.unrealized.amount)}><Sensitive>{fmtWhole(s.unrealized.amount, { signed: true, currency: s.unrealized.currency })}</Sensitive></Signed> : "—"} />
          </div>
        </Section>
        <Section className="fh-span-8" title="Sales this year" pad={false}>
          {realized.data?.lots.length ? (
            <table className="fh-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Acquired</th>
                  <th>Sold</th>
                  <th className="num">Qty</th>
                  <th className="num">Proceeds</th>
                  <th className="num">Basis</th>
                  <th className="num">Gain</th>
                  <th>Term</th>
                </tr>
              </thead>
              <tbody>
                {realized.data.lots.map((l, i) => (
                  <tr key={i}>
                    <td className="font-medium">{ticker(l.symbol)}</td>
                    <td className="text-secondary">{dayLabel(l.acquired, true)}</td>
                    <td className="text-secondary">{dayLabel(l.sold, true)}</td>
                    <td className="num"><Sensitive align="end">{fmtQty(l.qty)}</Sensitive></td>
                    <td className="num"><Sensitive align="end">{fmtWhole(l.proceeds)}</Sensitive></td>
                    <td className="num text-secondary"><Sensitive align="end">{fmtWhole(l.basis)}</Sensitive></td>
                    <td className="num"><Signed value={num(l.gain)}><Sensitive align="end">{fmtWhole(l.gain, { signed: true })}</Sensitive></Signed></td>
                    <td><Badge tone={l.term === "long" ? "neutral" : "warning"}>{l.term === "long" ? "Long" : "Short"}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Quiet title="No sales this year" body="Realised gains and losses appear here when you sell." />
          )}
        </Section>
      </div>
    </div>
  );
}
