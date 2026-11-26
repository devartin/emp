/**
 * Holding page (§16.3 template): live quote, candlestick chart (SMA overlays at "Advanced" experience), your
 * position and lots, dividends received, and a research note (thesis, what would change my mind, risks, review
 * date) saved per holding in kv `ui.portfolio`.
 */
import { ArrowLeft, NotebookPen } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/backend";
import type { Id, PortfolioSummary } from "@/backend/types";
import { navigate } from "@/app/router";
import { useQuote } from "@/stores/market";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { GainLoss } from "@/ui/DeltaPill";
import { DeltaPill } from "@/ui/DeltaPill";
import { Input } from "@/ui/Input";
import { PriceFlash } from "@/ui/PriceFlash";
import { Sensitive } from "@/ui/Sensitive";
import { Skeleton } from "@/ui/Skeleton";
import { Textarea } from "@/ui/Textarea";
import { daysBetween, dayLabel, fmtPct, fmtPrice, fmtQty, num, todayIso, fmtWhole } from "../finance/shared/format";
import { Disclaimer, FreshnessBadge, MarketStateChip, Section, Stat } from "../finance/shared/ui";
import PriceChart from "../markets/CandleChart";
import { ticker, useSymbolInfo } from "../markets/data";
import "../markets/markets.css";
import { usePortfolioBook } from "./data";
import "./portfolio.css";

interface Note {
  thesis: string;
  change: string;
  risks: string;
  review: string;
}

export default function HoldingPage({ instanceId, symbol, summary }: { instanceId: Id; symbol: string; summary?: PortfolioSummary }) {
  const q = useQuote(symbol);
  const info = useSymbolInfo(symbol);
  const book = usePortfolioBook(instanceId);
  const h = summary?.holdings.find((x) => x.symbol === symbol);
  const lots = useMemo(() => book.lotsFor(symbol), [book, symbol]);
  const sec = book.secByKey.get(symbol);
  const divs = useMemo(() => book.txns.filter((t) => t.secId === sec?.id && t.type === "dividend"), [book.txns, sec]);
  const divTotal = divs.reduce((a, t) => a + Math.abs(t.amount), 0);
  const price = q?.price ?? h?.price ?? 0;
  const value = h ? price * num(h.qty) : 0;
  const [experience, setExperience] = useState<string>("advanced");
  useEffect(() => {
    api.kv.get({ ns: "ui.portfolio", key: "experience" }).then((v) => typeof v === "string" && setExperience(v)).catch(() => undefined);
  }, []);
  return (
    <div className="fh-page">
      <div className="flex items-center gap-2 mb-4">
        <Button size="sm" variant="ghost" icon={ArrowLeft} onClick={() => navigate({ t: "app", instanceId, tab: "holdings" })}>
          Portfolio
        </Button>
      </div>
      <header className="flex items-start gap-4 mb-5">
        <span className="pf-ticker-chip" style={{ width: 48, height: 48, fontSize: 13, borderRadius: 14 }}>
          {ticker(symbol).slice(0, 4)}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="fh-title">{info?.name ?? ticker(symbol)}</h1>
            <Badge tone="outline">{ticker(symbol)}</Badge>
            {h ? <Badge tone="neutral">{h.assetClass}</Badge> : null}
          </div>
          <div className="flex items-baseline gap-3 mt-1">
            {q ? (
              <>
                <span className="mk-price">
                  <PriceFlash value={q.price} symbol={symbol}>{fmtPrice(q.price, q.currency)}</PriceFlash>
                </span>
                <DeltaPill value={q.changePct} digits={2} label="today" />
                <FreshnessBadge freshness={q.freshness} source={q.source} delayedMin={q.delayedMin} />
                <MarketStateChip state={q.marketState} asOf={q.asOf} />
              </>
            ) : (
              <Skeleton width={220} height={30} />
            )}
          </div>
        </div>
        <Button size="sm" variant="secondary" onClick={() => navigate({ t: "markets", symbol })}>
          Open in Markets
        </Button>
      </header>
      <div className="fh-grid">
        <Section className="fh-span-8">
          <PriceChart symbol={symbol} height={320} defaultRange="1y" defaultMode={experience === "advanced" ? "candles" : "area"} indicators={experience === "advanced"} />
        </Section>
        <div className="fh-span-4 flex flex-col gap-3">
          <div className="fh-card">
            <div className="text-caption text-secondary" style={{ fontWeight: 500 }}>Your position</div>
            <div className="tabular mt-1" style={{ fontSize: 26, lineHeight: "32px", fontWeight: 640, letterSpacing: "-0.022em" }}>
              <Sensitive>{h ? fmtWhole(value) : "—"}</Sensitive>
            </div>
            {h ? (
              <div className="text-body-sm text-secondary">
                <Sensitive>{fmtQty(h.qty)} shares</Sensitive> · {(h.weight * 100).toFixed(1)}% of portfolio
              </div>
            ) : (
              <div className="text-body-sm text-tertiary">You don't hold this right now.</div>
            )}
            {h ? (
              <div className="grid grid-cols-2 gap-3 mt-4 pt-3 border-t border-subtle">
                <Stat label="Cost basis" value={<Sensitive>{fmtWhole(h.costBasis.amount, { currency: h.costBasis.currency })}</Sensitive>} size="sm" />
                <Stat label="Unrealised" value={<GainLoss value={value - num(h.costBasis.amount)}><Sensitive>{fmtWhole(value - num(h.costBasis.amount), { signed: true })}</Sensitive></GainLoss>} sub={fmtPct(num(h.costBasis.amount) ? (value - num(h.costBasis.amount)) / num(h.costBasis.amount) : 0, 1, true)} size="sm" />
                <Stat label="Avg cost" value={fmtPrice(num(h.costBasis.amount) / Math.max(1e-9, num(h.qty)))} size="sm" />
                <Stat label="Dividends received" value={<Sensitive>{fmtWhole(divTotal)}</Sensitive>} sub={`${divs.length} payments`} size="sm" />
              </div>
            ) : null}
          </div>
          <ResearchNote symbol={symbol} />
        </div>
        <Section className="fh-span-12" title="Lots" subtitle={`${lots.length} open ${lots.length === 1 ? "lot" : "lots"} · first-in, first-out`} pad={false}>
          {book.loading ? (
            <div className="p-4"><Skeleton height={120} /></div>
          ) : (
            <table className="fh-table">
              <thead>
                <tr>
                  <th>Acquired</th>
                  <th>Account</th>
                  <th className="num">Quantity</th>
                  <th className="num">Cost / share</th>
                  <th className="num">Basis</th>
                  <th className="num">Value</th>
                  <th className="num">Gain</th>
                  <th>Holding period</th>
                </tr>
              </thead>
              <tbody>
                {lots.slice().reverse().map((l, i) => {
                  const g = (price - l.costPerUnit) * l.qty;
                  const days = daysBetween(l.acquired, todayIso());
                  return (
                    <tr key={i}>
                      <td>{dayLabel(l.acquired, true)}</td>
                      <td className="text-secondary">{l.accountName}</td>
                      <td className="num"><Sensitive align="end">{fmtQty(l.qty)}</Sensitive></td>
                      <td className="num text-secondary">{fmtPrice(l.costPerUnit)}</td>
                      <td className="num"><Sensitive align="end">{fmtWhole(l.costPerUnit * l.qty)}</Sensitive></td>
                      <td className="num"><Sensitive align="end">{fmtWhole(price * l.qty)}</Sensitive></td>
                      <td className="num"><GainLoss value={g}><Sensitive align="end">{fmtWhole(g, { signed: true })}</Sensitive></GainLoss></td>
                      <td>
                        {l.taxTreatment !== "taxable" ? (
                          <span className="text-caption text-tertiary">Sheltered account</span>
                        ) : days > 365 ? (
                          <Badge tone="neutral">Long-term</Badge>
                        ) : (
                          <Badge tone="warning">Short-term · long in {365 - days + 1}d</Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Section>
      </div>
      <Disclaimer>For your own records and education. Not investment advice. Ultra Note never places trades.</Disclaimer>
    </div>
  );
}

function ResearchNote({ symbol }: { symbol: string }) {
  const key = `note:${symbol}`;
  const [note, setNote] = useState<Note | null>(null);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    api.kv
      .get({ ns: "ui.portfolio", key })
      .then((v) => setNote({ thesis: "", change: "", risks: "", review: "", ...((v as Partial<Note> | null) ?? {}) }))
      .catch(() => setNote({ thesis: "", change: "", risks: "", review: "" }));
  }, [key]);
  const update = (patch: Partial<Note>) =>
    setNote((n) => {
      const next = { ...(n ?? { thesis: "", change: "", risks: "", review: "" }), ...patch };
      if (t.current) clearTimeout(t.current);
      setState("saving");
      t.current = setTimeout(() => api.kv.set({ ns: "ui.portfolio", key, value: next }).then(() => setState("saved")).catch(() => setState("idle")), 500);
      return next;
    });
  if (!note) return <Skeleton height={240} radius={14} />;
  return (
    <Section title={<span className="inline-flex items-center gap-2"><NotebookPen size={14} />Research note</span>} subtitle={state === "saving" ? "Saving…" : state === "saved" ? "Saved" : "Why you own it — in your own words"}>
      <div className="flex flex-col gap-2.5">
        <Textarea placeholder="Thesis: why I own this" value={note.thesis} onChange={(e) => update({ thesis: e.target.value })} aria-label="Thesis" />
        <Textarea placeholder="What would change my mind" value={note.change} onChange={(e) => update({ change: e.target.value })} aria-label="What would change my mind" />
        <Textarea placeholder="Risks I'm accepting" value={note.risks} onChange={(e) => update({ risks: e.target.value })} aria-label="Risks" />
        <Input type="date" label="Review by" value={note.review} onChange={(e) => update({ review: e.target.value })} />
      </div>
    </Section>
  );
}
