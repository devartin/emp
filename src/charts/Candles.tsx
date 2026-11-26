import {
  AreaSeries, CandlestickSeries, ColorType, createChart, CrosshairMode, HistogramSeries, LineSeries, LineStyle,
  type IChartApi, type ISeriesApi, type MouseEventParams, type SeriesType, type Time, type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { summarizeSeries } from "./a11y";
import { MASK, valueFormatter, withAlpha, type ValueFormat } from "./axis";
import { ChartFrame } from "./ChartFrame";
import { useChartTheme, type ChartTheme } from "./theme";

export interface Ohlcv {
  /** Unix seconds (UTC) or 'YYYY-MM-DD'. */
  time: number | string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type CandleMode = "candles" | "line" | "area";

export interface CandleChartProps {
  data: Ohlcv[];
  mode?: CandleMode;
  /** SMA periods to overlay (default 20/50/200 in categorical colours 2/4/6, §13.5). */
  sma?: number[];
  volume?: boolean;
  height?: number;
  format?: ValueFormat;
  currency?: string;
  /** Crosshair readout: the hovered bar or null on leave. */
  onCrosshair?: (bar: Ohlcv | null) => void;
  header?: ReactNode;
  loading?: boolean;
  cached?: boolean | string;
  summaryLabel?: string;
  className?: string;
}

const SMA_COLORS = [1, 3, 5]; // categorical indices 2, 4, 6

export function sma(data: readonly Ohlcv[], period: number): { time: Time; value: number }[] {
  const out: { time: Time; value: number }[] = [];
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i].close;
    if (i >= period) sum -= data[i - period].close;
    if (i >= period - 1) out.push({ time: toTime(data[i].time), value: sum / period });
  }
  return out;
}

function toTime(t: number | string): Time {
  return (typeof t === "number" ? (t as UTCTimestamp) : t) as Time;
}

function chartOptions(t: ChartTheme, fmt: (n: number) => string) {
  const cross = withAlpha(t.textTertiary, 0.5);
  return {
    layout: {
      background: { type: ColorType.Solid, color: "transparent" },
      textColor: t.textTertiary,
      fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif",
      fontSize: 11,
      attributionLogo: false,
    },
    grid: { vertLines: { visible: false }, horzLines: { color: t.borderSubtle } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.24 } },
    timeScale: { borderVisible: false, rightOffset: 6, barSpacing: 8, minBarSpacing: 2, fixLeftEdge: true },
    crosshair: {
      mode: CrosshairMode.Magnet,
      vertLine: { color: cross, style: LineStyle.Dashed, width: 1 as const, labelBackgroundColor: t.text },
      horzLine: { color: cross, style: LineStyle.Dashed, width: 1 as const, labelBackgroundColor: t.text },
    },
    localization: { priceFormatter: (p: number) => (t.privacy ? MASK : fmt(p)) },
    handleScale: { axisPressedMouseMove: { time: true, price: false } },
  };
}

/**
 * lightweight-charts v5 wrapper (§13.5): transparent layout, tertiary Inter 11 text, horizontal gridlines only,
 * magnet dashed crosshair, gain/loss candles without borders, volume histogram on its own scale (alpha .35),
 * Line/Area/Candles modes and SMA overlays. Theme changes call applyOptions — the chart is never recreated.
 */
export function CandleChart({ data, mode = "candles", sma: smaPeriods = [20, 50, 200], volume = true, height = 320, format = "money", currency = "USD", onCrosshair, header, loading, cached, summaryLabel = "Price", className }: CandleChartProps) {
  const t = useChartTheme();
  const fmt = useMemo(() => valueFormatter(format, currency), [format, currency]);
  const host = useRef<HTMLDivElement | null>(null);
  const chart = useRef<IChartApi | null>(null);
  const main = useRef<ISeriesApi<SeriesType> | null>(null);
  const vol = useRef<ISeriesApi<"Histogram"> | null>(null);
  const smaSeries = useRef<ISeriesApi<"Line">[]>([]);
  const [ready, setReady] = useState(false);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const cb = useRef(onCrosshair);
  cb.current = onCrosshair;
  const dataRef = useRef(data);
  dataRef.current = data;

  // Create once per host element.
  useEffect(() => {
    if (!el) return;
    host.current = el;
    const c = createChart(el, { ...chartOptions(t, fmt), autoSize: true });
    chart.current = c;
    const onMove = (p: MouseEventParams<Time>) => {
      if (!cb.current) return;
      if (!p.time || !p.point || p.point.x < 0) return cb.current(null);
      const bar = dataRef.current.find((d) => String(toTime(d.time)) === String(p.time));
      cb.current(bar ?? null);
    };
    c.subscribeCrosshairMove(onMove);
    setReady(true);
    return () => {
      c.unsubscribeCrosshairMove(onMove);
      c.remove();
      chart.current = null;
      main.current = null;
      vol.current = null;
      smaSeries.current = [];
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el]);

  // Theme → applyOptions (never recreate).
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    c.applyOptions(chartOptions(t, fmt));
    if (main.current) main.current.applyOptions(mainOptions(mode, t) as never);
    vol.current?.applyOptions({ color: withAlpha(t.textTertiary, 0.35) });
    smaSeries.current.forEach((s, i) => s.applyOptions({ color: t.categorical[SMA_COLORS[i % 3]] }));
    if (vol.current) vol.current.setData(volumeData(data, t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, fmt, ready]);

  // Main series by mode.
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    if (main.current) {
      c.removeSeries(main.current);
      main.current = null;
    }
    const opts = mainOptions(mode, t);
    if (mode === "candles") {
      const s = c.addSeries(CandlestickSeries, opts as never);
      s.setData(data.map((d) => ({ time: toTime(d.time), open: d.open, high: d.high, low: d.low, close: d.close })));
      main.current = s as unknown as ISeriesApi<SeriesType>;
    } else if (mode === "area") {
      const s = c.addSeries(AreaSeries, opts as never);
      s.setData(data.map((d) => ({ time: toTime(d.time), value: d.close })));
      main.current = s as unknown as ISeriesApi<SeriesType>;
    } else {
      const s = c.addSeries(LineSeries, opts as never);
      s.setData(data.map((d) => ({ time: toTime(d.time), value: d.close })));
      main.current = s as unknown as ISeriesApi<SeriesType>;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, data, ready]);

  // Volume.
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    if (!volume) {
      if (vol.current) c.removeSeries(vol.current);
      vol.current = null;
      return;
    }
    if (!vol.current) {
      vol.current = c.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
      c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 }, visible: false });
    }
    vol.current.setData(volumeData(data, t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volume, data, ready]);

  // SMA overlays.
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    smaSeries.current.forEach((s) => c.removeSeries(s));
    smaSeries.current = smaPeriods
      .filter((p) => data.length >= p)
      .map((p, i) => {
        const s = c.addSeries(LineSeries, { color: t.categorical[SMA_COLORS[i % 3]], lineWidth: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false, title: "" });
        s.applyOptions({ lineWidth: 1.25 as never });
        s.setData(sma(data, p));
        return s;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [smaPeriods.join(","), data, ready]);

  useEffect(() => {
    chart.current?.timeScale().fitContent();
  }, [data, ready]);

  const summary = summarizeSeries(summaryLabel, data.map((d) => d.close), fmt);
  return (
    <ChartFrame
      height={height}
      summary={summary}
      loading={loading}
      empty={data.length < 2 ? "Not enough price history yet" : false}
      cached={cached}
      header={header}
      className={className}
      footer={
        <div className="flex items-center gap-3 mt-1.5 text-tertiary" style={{ fontSize: 11 }}>
          {mode !== "line" && smaPeriods.length
            ? smaPeriods.map((p, i) => (
                <span key={p} className="inline-flex items-center gap-1.5">
                  <span style={{ width: 10, height: 2, borderRadius: 1, background: t.categorical[SMA_COLORS[i % 3]] }} />
                  SMA {p}
                </span>
              ))
            : null}
          <span className="ml-auto">Charts by TradingView Lightweight Charts™</span>
        </div>
      }
    >
      {() => <div ref={setEl} className={cn("w-full h-full")} style={{ animation: t.reducedMotion ? undefined : "emp-fade-in 200ms cubic-bezier(.2,0,0,1) both" }} />}
    </ChartFrame>
  );
}

function mainOptions(mode: CandleMode, t: ChartTheme) {
  if (mode === "candles") {
    return { upColor: t.gain, downColor: t.loss, wickUpColor: t.gain, wickDownColor: t.loss, borderVisible: false, priceLineColor: t.textTertiary, priceLineStyle: LineStyle.Dotted };
  }
  if (mode === "area") {
    return {
      lineColor: t.accent,
      topColor: withAlpha(t.accent, t.dark ? 0.3 : 0.22),
      bottomColor: withAlpha(t.accent, 0),
      lineWidth: 2,
      priceLineColor: t.textTertiary,
      priceLineStyle: LineStyle.Dotted,
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderColor: t.canvas,
      crosshairMarkerBackgroundColor: t.accent,
    };
  }
  return { color: t.accent, lineWidth: 2, priceLineColor: t.textTertiary, priceLineStyle: LineStyle.Dotted, crosshairMarkerRadius: 4, crosshairMarkerBorderColor: t.canvas, crosshairMarkerBackgroundColor: t.accent };
}

function volumeData(data: readonly Ohlcv[], t: ChartTheme) {
  return data.map((d) => ({ time: toTime(d.time), value: d.volume ?? 0, color: withAlpha(d.close >= d.open ? t.gain : t.loss, 0.35) }));
}
