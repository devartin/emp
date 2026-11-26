/** Performance: time-weighted return vs benchmark, XIRR, and realised gains for the year (short vs long term). */
import { useMemo, useState } from "react";
import { api } from "@/backend";
import type { Id, PerfRange, PortfolioSummary } from "@/backend/types";
import { LineChart } from "@/charts/Line";
import { Badge } from "@/ui/Badge";
import { GainLoss } from "@/ui/DeltaPill";
import { Segmented } from "@/ui/Segmented";
import { Sensitive } from "@/ui/Sensitive";
import { dayLabel, fmtPct, fmtQty, num, fmtWhole } from "../finance/shared/format";
import { useAsync } from "../finance/shared/hooks";
import { Quiet, Section, Stat } from "../finance/shared/ui";
import { ticker } from "../markets/data";

const BENCHMARK = "EMP500:INDEX";

export default function Performance({ instanceId, summary: s }: { instanceId: Id; summary?: PortfolioSummary }) {
  const [range, setRange] = useState<PerfRange>("1y");
  const perf = useAsync(() => api.portfolio.performance({ instanceId, range, benchmark: BENCHMARK }), [instanceId, range]);
  const year = new Date().getFullYear();
  const realized = useAsync(() => api.portfolio.realized({ instanceId, year }), [instanceId, year]);
  const data = useMemo(() => (perf.data ? perf.data.t.map((t, i) => ({ t, twr: perf.data!.twr[i], bench: perf.data!.benchmark?.[i] ?? 0 })) : []), [perf.data]);
  const last = data[data.length - 1];
  const long = range === "5y" || range === "all";
  const benchLabel = ticker(BENCHMARK);
  return (
    <div className="flex flex-col gap-4">
      <Section
        title={`Time-weighted return vs ${benchLabel}`}
        subtitle="TWR removes the effect of when you added money — the fair way to compare with an index."
        actions={<Segmented size="sm" value={range} onValueChange={setRange} aria-label="Range" options={[{ value: "3m", label: "3M" }, { value: "ytd", label: "YTD" }, { value: "1y", label: "1Y" }, { value: "5y", label: "5Y" }, { value: "all", label: "All" }]} />}
      >
        <div className="flex gap-8 mb-4">
          <Stat label="Your portfolio (TWR)" value={last ? <GainLoss value={last.twr}>{fmtPct(last.twr, 1, true)}</GainLoss> : "—"} size="lg" />
          <Stat label={benchLabel} value={last ? <GainLoss value={last.bench}>{fmtPct(last.bench, 1, true)}</GainLoss> : "—"} size="lg" />
          <Stat label="Difference" value={last ? <GainLoss value={last.twr - last.bench}>{fmtPct(last.twr - last.bench, 1, true)}</GainLoss> : "—"} size="lg" />
          <Stat label="Money-weighted (XIRR)" value={perf.data?.xirr !== undefined ? `${fmtPct(perf.data.xirr, 1, true)}/yr` : "—"} size="lg" />
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
            <Stat label="Short-term (held ≤ 1 year)" value={realized.data ? <GainLoss value={num(realized.data.totals.short)}><Sensitive>{fmtWhole(realized.data.totals.short, { signed: true })}</Sensitive></GainLoss> : "—"} />
            <Stat label="Long-term" value={realized.data ? <GainLoss value={num(realized.data.totals.long)}><Sensitive>{fmtWhole(realized.data.totals.long, { signed: true })}</Sensitive></GainLoss> : "—"} />
            <Stat label="Unrealised today" value={s ? <GainLoss value={num(s.unrealized.amount)}><Sensitive>{fmtWhole(s.unrealized.amount, { signed: true, currency: s.unrealized.currency })}</Sensitive></GainLoss> : "—"} />
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
                    <td className="num"><GainLoss value={num(l.gain)}><Sensitive align="end">{fmtWhole(l.gain, { signed: true })}</Sensitive></GainLoss></td>
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
