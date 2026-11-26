/**
 * Price chart for a symbol (§13.5 candlesticks): Line / Area / Candles modes, ranges, SMA 20/50/200 toggles, a
 * crosshair readout in the header (O H L C, change), cached/offline chip and the TradingView attribution.
 */
import { useMemo, useState } from "react";
import type { SymbolKey } from "@/backend/types";
import { CandleChart as LwCandles, type CandleMode, type Ohlcv } from "@/charts/Candles";
import { Delta } from "@/ui/Delta";
import { Segmented } from "@/ui/Segmented";
import { fmtPrice } from "../finance/shared/format";
import { baseCurrency } from "../finance/shared/currency";
import { type ChartRange, useBars } from "./data";

const RANGES: { value: ChartRange; label: string }[] = [
  { value: "1m", label: "1M" },
  { value: "3m", label: "3M" },
  { value: "6m", label: "6M" },
  { value: "ytd", label: "YTD" },
  { value: "1y", label: "1Y" },
  { value: "5y", label: "5Y" },
];

export interface PriceChartProps {
  symbol: SymbolKey;
  currency?: string;
  height?: number;
  defaultRange?: ChartRange;
  defaultMode?: CandleMode;
  /** Show SMA toggles (Portfolio hides them below "Advanced" experience). */
  indicators?: boolean;
  onRangeChange?: (r: ChartRange, bars: Ohlcv[]) => void;
}

export default function PriceChart({ symbol, currency = baseCurrency(), height = 340, defaultRange = "6m", defaultMode = "line", indicators = true }: PriceChartProps) {
  const [range, setRange] = useState<ChartRange>(defaultRange);
  const [mode, setMode] = useState<CandleMode>(defaultMode);
  const [smas, setSmas] = useState<number[]>([20, 50]);
  const [hover, setHover] = useState<Ohlcv | null>(null);
  const { bars, stale, loading } = useBars(symbol, range);
  const first = bars[0];
  const shown = hover ?? bars[bars.length - 1];
  const change = shown && first ? shown.close - first.open : 0;
  const changePct = first && first.open ? change / first.open : 0;
  const header = (
    <div className="mk-chart-head">
      <div className="mk-ohlc tabular" aria-live="off">
        {shown ? (
          <>
            <span>
              <i>O</i>
              {fmtPrice(shown.open, currency)}
            </span>
            <span>
              <i>H</i>
              {fmtPrice(shown.high, currency)}
            </span>
            <span>
              <i>L</i>
              {fmtPrice(shown.low, currency)}
            </span>
            <span>
              <i>C</i>
              {fmtPrice(shown.close, currency)}
            </span>
            {/* A return over the range: one decimal, written as a delta (DESIGN §6.2). */}
            <Delta percent={changePct} label={hover ? new Date(Number(hover.time) * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : `${RANGES.find((r) => r.value === range)?.label} change`} />
          </>
        ) : null}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {indicators && mode !== "line" ? (
          <div className="mk-sma" role="group" aria-label="Moving averages">
            {[20, 50, 200].map((p) => {
              const on = smas.includes(p);
              return (
                <button key={p} type="button" aria-pressed={on} data-on={on ? "" : undefined} onClick={() => setSmas((s) => (on ? s.filter((x) => x !== p) : [...s, p].sort((a, b) => a - b)))}>
                  SMA {p}
                </button>
              );
            })}
          </div>
        ) : null}
        <Segmented size="sm" value={mode} onValueChange={setMode} aria-label="Chart type" options={[{ value: "line", label: "Line" }, { value: "area", label: "Area" }, { value: "candles", label: "Candles" }]} />
        <Segmented size="sm" value={range} onValueChange={setRange} aria-label="Range" options={RANGES} />
      </div>
    </div>
  );
  const sma = useMemo(() => (indicators && mode !== "line" ? smas : []), [indicators, mode, smas]);
  return <LwCandles data={bars} mode={mode} sma={sma} volume height={height} currency={currency} onCrosshair={setHover} header={header} loading={loading && !bars.length} cached={stale ? "Offline · cached prices" : false} summaryLabel={`${symbol} price`} />;
}
