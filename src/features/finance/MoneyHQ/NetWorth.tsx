/**
 * Net worth (§15.5): assets and liabilities over time, the month-by-month change as a waterfall, and the monthly
 * snapshot table (backfilled before the ledger starts).
 */
import { useMemo, useState } from "react";
import { api } from "@/backend";
import { LineChart } from "@/charts/Line";
import { BarChart } from "@/charts/Bar";
import { Segmented } from "@/ui/Segmented";
import { Sensitive } from "@/ui/Sensitive";
import { DeltaPill } from "@/ui/DeltaPill";
import { monthLabel, fmtWhole } from "../shared/format";
import { useAsync, useDbChanged } from "../shared/hooks";
import { Section } from "../shared/ui";
import { useLedgerCtx } from "./ledger";
import { useMoney } from "./MoneyHQ";

type Range = "1y" | "3y" | "5y" | "all";

export default function NetWorth() {
  const { instanceId } = useMoney();
  const l = useLedgerCtx();
  const [range, setRange] = useState<Range>("3y");
  const s = useAsync(() => api.finance.networthSeries({ instanceId, range }), [instanceId, range]);
  useDbChanged([l.schemas.txns?.database.id], s.reload, 500);
  const data = useMemo(() => (s.data ? s.data.t.map((t, i) => ({ t, net: s.data!.net[i], assets: s.data!.assets[i], liabilities: s.data!.liabilities[i] })) : []), [s.data]);
  // Month-end points for the waterfall + table.
  const monthly = useMemo(() => {
    const byMonth = new Map<string, (typeof data)[number]>();
    for (const d of data) byMonth.set(d.t.slice(0, 7), d);
    return [...byMonth.entries()].map(([m, d]) => ({ m, ...d }));
  }, [data]);
  const last12 = monthly.slice(-13);
  const changes = last12.slice(1).map((d, i) => ({ m: monthLabel(d.m, true), change: d.net - last12[i].net }));
  const first = data[0];
  const lastPt = data[data.length - 1];
  const long = range !== "1y";
  return (
    <div className="flex flex-col gap-4">
      <Section
        title="Net worth history"
        subtitle={first && lastPt ? <span className="inline-flex items-center gap-2"><Sensitive>{fmtWhole(lastPt.net - first.net, { signed: true })}</Sensitive><DeltaPill value={first.net ? (lastPt.net - first.net) / Math.abs(first.net) : 0} plain /> over this period</span> : null}
        actions={<Segmented size="sm" value={range} onValueChange={setRange} aria-label="Range" options={[{ value: "1y", label: "1Y" }, { value: "3y", label: "3Y" }, { value: "5y", label: "5Y" }, { value: "all", label: "All" }]} />}
      >
        <LineChart
          data={data}
          x="t"
          series={[
            { key: "net", label: "Net worth", color: "var(--accent-solid)", area: true },
            { key: "assets", label: "Assets", color: "var(--gain)" },
            { key: "liabilities", label: "Debts", color: "var(--loss)", dashed: true },
          ]}
          colorBySign={false}
          startReference={false}
          height={300}
          xFormat={(v) => (long ? `${monthLabel(String(v).slice(0, 7), true)} '${String(v).slice(2, 4)}` : monthLabel(String(v).slice(0, 7), true))}
          xTooltipFormat={(v) => String(v)}
          summaryLabel="Net worth"
          loading={s.loading && !s.data}
          includeZero
        />
      </Section>
      <div className="fh-grid">
        <Section className="fh-span-7" title="Month by month" subtitle="How net worth moved over the last 12 months">
          <BarChart data={changes} x="m" series={[{ key: "change", label: "Change" }]} colorBySign height={260} yAxis="right" summaryLabel="Net worth change by month" loading={s.loading && !s.data} />
        </Section>
        <Section className="fh-span-5" title="Snapshots" subtitle="Month-end values" pad={false}>
          <div className="max-h-[320px] overflow-auto">
            <table className="fh-table">
              <thead>
                <tr>
                  <th>Month</th>
                  <th className="num">Assets</th>
                  <th className="num">Debts</th>
                  <th className="num">Net</th>
                </tr>
              </thead>
              <tbody>
                {monthly
                  .slice()
                  .reverse()
                  .slice(0, 24)
                  .map((r) => (
                    <tr key={r.m}>
                      <td>{monthLabel(r.m)}</td>
                      <td className="num text-secondary">
                        <Sensitive align="end">{fmtWhole(r.assets)}</Sensitive>
                      </td>
                      <td className="num text-secondary">
                        <Sensitive align="end">{fmtWhole(r.liabilities)}</Sensitive>
                      </td>
                      <td className="num font-medium">
                        <Sensitive align="end">{fmtWhole(r.net)}</Sensitive>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Section>
      </div>
    </div>
  );
}
