/** Holdings table with expandable FIFO lots (account, acquired, qty, cost, gain, short/long term). */
import { ChevronRight } from "lucide-react";
import { m } from "motion/react";
import { Fragment, useState } from "react";
import type { Id, PortfolioSummary } from "@/backend/types";
import { navigate } from "@/app/router";
import { useQuotes } from "@/stores/market";
import { Badge } from "@/ui/Badge";
import { GainLoss } from "@/ui/DeltaPill";
import { PriceFlash } from "@/ui/PriceFlash";
import { Sensitive } from "@/ui/Sensitive";
import { Skeleton } from "@/ui/Skeleton";
import { daysBetween, dayLabel, fmtMoney, fmtPct, fmtPrice, fmtQty, num, todayIso } from "../finance/shared/format";
import { useFlip } from "../finance/shared/hooks";
import { disclose, Section } from "../finance/shared/ui";
import { ticker } from "../markets/data";
import { usePortfolioBook } from "./data";

export default function Holdings({ instanceId, summary: s }: { instanceId: Id; summary?: PortfolioSummary }) {
  const book = usePortfolioBook(instanceId);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const quotes = useQuotes((s?.holdings ?? []).map((h) => h.symbol));
  // opening/closing lots: the rows below glide (translate FLIP); the lots fade and rise — no height animation
  const bodyRef = useFlip<HTMLTableSectionElement>(open);
  if (!s) return <Skeleton height={420} radius={14} />;
  const totalCost = s.holdings.reduce((a, h) => a + num(h.costBasis.amount), 0);
  return (
    <Section title="All holdings" subtitle={<>Cost basis <Sensitive>{fmtMoney(totalCost, "USD", { noCents: true })}</Sensitive> · lots matched first-in, first-out</>} pad={false}>
      <div className="overflow-x-auto">
        <table className="fh-table" style={{ minWidth: 760 }}>
        <thead>
          <tr>
            <th>Holding</th>
            <th>Class</th>
            <th className="num">Quantity</th>
            <th className="num">Price</th>
            <th className="num">Value</th>
            <th className="num">Cost basis</th>
            <th className="num">Gain</th>
            <th className="num">Weight</th>
          </tr>
        </thead>
        <tbody ref={bodyRef}>
          {s.holdings.map((h, i) => {
            const q = quotes[i];
            const isOpen = open.has(h.symbol);
            const lots = isOpen ? book.lotsFor(h.symbol) : [];
            const price = q?.price ?? h.price ?? 0;
            return (
              <Fragment key={h.symbol}>
                <tr data-clickable onClick={() => setOpen((o) => { const n = new Set(o); if (n.has(h.symbol)) n.delete(h.symbol); else n.add(h.symbol); return n; })} aria-expanded={isOpen}>
                  <td>
                    <div className="flex items-center gap-2.5">
                      <ChevronRight size={14} className="text-tertiary" style={{ transform: isOpen ? "rotate(90deg)" : undefined, transition: "transform 160ms cubic-bezier(.2,0,0,1)" }} />
                      <span className="pf-ticker-chip">{ticker(h.symbol).slice(0, 4)}</span>
                      <span className="min-w-0">
                        <button type="button" className="block font-medium hover:underline underline-offset-4" onClick={(e) => { e.stopPropagation(); navigate({ t: "app", instanceId, tab: `holding:${h.symbol}` }); }}>
                          {ticker(h.symbol)}
                        </button>
                        <span className="block text-caption text-tertiary truncate max-w-[200px]" style={{ fontWeight: 400 }}>
                          {h.name}
                        </span>
                      </span>
                    </div>
                  </td>
                  <td>
                    <Badge tone="outline">{h.assetClass}</Badge>
                  </td>
                  <td className="num"><Sensitive align="end">{fmtQty(h.qty)}</Sensitive></td>
                  <td className="num">
                    <PriceFlash value={price} symbol={h.symbol}>{fmtPrice(price)}</PriceFlash>
                  </td>
                  <td className="num font-medium"><Sensitive align="end">{fmtMoney(q ? q.price * num(h.qty) : h.value.amount, "USD", { noCents: true })}</Sensitive></td>
                  <td className="num text-secondary"><Sensitive align="end">{fmtMoney(h.costBasis.amount, "USD", { noCents: true })}</Sensitive></td>
                  <td className="num">
                    <GainLoss value={num(h.gain.amount)}><Sensitive align="end">{fmtMoney(h.gain.amount, "USD", { noCents: true, signed: true })}</Sensitive></GainLoss>
                    <div className="text-caption text-tertiary">{fmtPct(h.gainPct, 1, true)}</div>
                  </td>
                  <td className="num text-secondary">{(h.weight * 100).toFixed(1)}%</td>
                </tr>
                {isOpen ? (
                  <tr className="pf-lots-row">
                    <td colSpan={8} style={{ padding: 0, height: "auto" }}>
                      <m.div initial={disclose.initial} animate={disclose.animate}>
                        <div className="pf-lots">
                          {book.loading ? (
                            <Skeleton height={60} />
                          ) : (
                            <table className="fh-table pf-lots-table">
                              <thead>
                                <tr>
                                  <th>Account</th>
                                  <th>Acquired</th>
                                  <th className="num">Quantity</th>
                                  <th className="num">Cost / share</th>
                                  <th className="num">Basis</th>
                                  <th className="num">Gain</th>
                                  <th>Term</th>
                                </tr>
                              </thead>
                              <tbody>
                                {lots.slice(-12).reverse().map((l, k) => {
                                  const gain = (price - l.costPerUnit) * l.qty;
                                  const long = daysBetween(l.acquired, todayIso()) > 365;
                                  return (
                                    <tr key={k}>
                                      <td>
                                        {l.accountName}
                                        <span className="text-caption text-tertiary ml-1.5">{l.taxTreatment === "taxable" ? "taxable" : l.taxTreatment === "deferred" ? "tax-deferred" : "tax-free"}</span>
                                      </td>
                                      <td className="text-secondary">{dayLabel(l.acquired, true)}</td>
                                      <td className="num"><Sensitive align="end">{fmtQty(l.qty)}</Sensitive></td>
                                      <td className="num text-secondary">{fmtPrice(l.costPerUnit)}</td>
                                      <td className="num"><Sensitive align="end">{fmtMoney(l.costPerUnit * l.qty, "USD", { noCents: true })}</Sensitive></td>
                                      <td className="num"><GainLoss value={gain}><Sensitive align="end">{fmtMoney(gain, "USD", { noCents: true, signed: true })}</Sensitive></GainLoss></td>
                                      <td>{l.taxTreatment === "taxable" ? <Badge tone={long ? "neutral" : "warning"}>{long ? "Long-term" : "Short-term"}</Badge> : <span className="text-tertiary text-caption">Sheltered</span>}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          )}
                          {lots.length > 12 ? <div className="text-caption text-tertiary px-4 pb-3">Showing the 12 newest of {lots.length} lots.</div> : null}
                        </div>
                      </m.div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
        </table>
      </div>
    </Section>
  );
}
