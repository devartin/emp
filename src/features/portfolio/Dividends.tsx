/** Dividends: monthly calendar (paid vs projected), TTM / forward 12 months and yield by holding. */
import { useState } from "react";
import { api } from "@/backend";
import type { Id, PortfolioSummary } from "@/backend/types";
import { BarChart } from "@/charts/Bar";
import { Segmented } from "@/ui/Segmented";
import { Sensitive } from "@/ui/Sensitive";
import { fmtMoney, fmtPct, monthLabel, num } from "../finance/shared/format";
import { useAsync } from "../finance/shared/hooks";
import { Section, Stat } from "../finance/shared/ui";

export default function Dividends({ instanceId, summary: s }: { instanceId: Id; summary?: PortfolioSummary }) {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(String(thisYear));
  const d = useAsync(() => api.portfolio.dividends({ instanceId, year: Number(year) }), [instanceId, year]);
  const rows = (d.data ?? []).map((x) => ({ m: monthLabel(x.month, true), paid: num(x.paid), projected: num(x.projected) }));
  const paid = rows.reduce((a, r) => a + r.paid, 0);
  const proj = rows.reduce((a, r) => a + r.projected, 0);
  const value = s ? num(s.totalValue.amount) : 0;
  return (
    <div className="flex flex-col gap-4">
      <div className="fh-kpis">
        {[
          { l: "Last 12 months", v: s ? fmtMoney(s.divTtm.amount, "USD", { noCents: true }) : "—", sub: s && value ? `${fmtPct(num(s.divTtm.amount) / value, 2)} trailing yield` : "" },
          { l: "Next 12 months", v: s ? fmtMoney(s.divFwd12m.amount, "USD", { noCents: true }) : "—", sub: "last regular dividend × frequency" },
          { l: `Paid in ${year}`, v: fmtMoney(paid, "USD", { noCents: true }), sub: `${rows.filter((r) => r.paid > 0).length} months with payouts` },
          { l: `Still expected in ${year}`, v: fmtMoney(proj, "USD", { noCents: true }), sub: "based on last year's calendar" },
        ].map((k) => (
          <div key={k.l} className="fh-card" style={{ padding: "14px 16px" }}>
            <Stat label={k.l} value={<Sensitive>{k.v}</Sensitive>} sub={k.sub} size="lg" />
          </div>
        ))}
      </div>
      <Section
        title="Dividend calendar"
        subtitle="Paid and projected by month"
        actions={<Segmented size="sm" value={year} onValueChange={setYear} aria-label="Year" options={[thisYear - 2, thisYear - 1, thisYear].map((y) => ({ value: String(y), label: String(y) }))} />}
      >
        <BarChart data={rows} x="m" series={[{ key: "paid", label: "Paid", color: "var(--accent-solid)" }, { key: "projected", label: "Projected", color: "color-mix(in oklab, var(--accent-solid) 30%, transparent)" }]} stacked height={260} yAxis="right" loading={d.loading && !d.data} summaryLabel={`Dividends by month, ${year}`} />
      </Section>
    </div>
  );
}
