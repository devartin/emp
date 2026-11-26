/**
 * Chart view (§8.3): vertical/horizontal bar, line, area, donut and waterfall from grouped data (`db_chart_data`).
 * X is a property (date bucket day/week/month/quarter/year for dates), Y is count or sum/avg/min/max/median of a
 * property, optional series property; stacked, cumulative, smooth and omit-zero options. Rendered via src/charts.
 */
import { AreaChart as AreaIcon, BarChart3, BarChartHorizontal, LineChart as LineIcon, PieChart, Settings2, TrendingUp } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, latestRequest, listen } from '@/backend';
import type { AggFn, ChartData, ChartSpec, ChartType, Id } from '@/backend/types';
import { BarChart } from '@/charts/Bar';
import { Donut } from '@/charts/Donut';
import { AreaChart } from '@/charts/Area';
import { LineChart } from '@/charts/Line';
import { Waterfall } from '@/charts/Waterfall';
import { cn } from '@/lib/cn';
import { formatCompact } from '@/lib/format';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/Popover';
import { Segmented } from '@/ui/Segmented';
import { Select } from '@/ui/Select';
import { Switch } from '@/ui/Switch';
import { useDbView } from '../context';
import { isDateLike, isNumeric } from '../engine/schema';
import { TypeIcon } from '../properties/meta';

const TYPES: { value: ChartType; label: string; icon: typeof BarChart3 }[] = [
  { value: 'bar', label: 'Bar', icon: BarChart3 },
  { value: 'hbar', label: 'Horizontal bar', icon: BarChartHorizontal },
  { value: 'line', label: 'Line', icon: LineIcon },
  { value: 'area', label: 'Area', icon: AreaIcon },
  { value: 'donut', label: 'Donut', icon: PieChart },
  { value: 'waterfall', label: 'Waterfall', icon: TrendingUp },
];
const AGGS: { value: AggFn; label: string }[] = [
  { value: 'count', label: 'Count' },
  { value: 'sum', label: 'Sum' },
  { value: 'avg', label: 'Average' },
  { value: 'median', label: 'Median' },
  { value: 'min', label: 'Min' },
  { value: 'max', label: 'Max' },
];

export function ChartView() {
  const { schema, view, databaseId, patchView, readOnly, inline } = useDbView();
  const spec: ChartSpec = view.chart ?? { type: 'bar', x: { prop: '$created', bucket: 'month' }, y: [{ agg: 'count' }] };
  const [data, setData] = useState<ChartData | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const latest = useMemo(() => latestRequest(), []);
  const specKey = JSON.stringify(spec) + JSON.stringify(view.filter ?? null);
  useEffect(() => listen('db:changed', (e) => e.databaseId === databaseId && setTick((t) => t + 1)), [databaseId]);
  useEffect(() => {
    const id = latest.next();
    setLoading(true);
    api.db
      .chartData({ databaseId, viewId: view.id, spec, maxPoints: 120 })
      .then((d) => latest.isLatest(id) && setData(d))
      .catch(() => latest.isLatest(id) && setData({ x: [], series: [] }))
      .finally(() => latest.isLatest(id) && setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey, databaseId, view.id, tick]);

  const set = (patch: Partial<ChartSpec>) => patchView({ chart: { ...spec, ...patch } });
  const xProp = spec.x.prop === '$created' ? undefined : schema.properties.find((p) => p.id === spec.x.prop);
  const dateX = spec.x.prop === '$created' || (xProp && isDateLike(xProp));
  const yProp = spec.y[0]?.prop ? schema.properties.find((p) => p.id === spec.y[0].prop) : undefined;
  const format = data?.currency ? 'money' : yProp?.type === 'progress' || (yProp?.type === 'number' && yProp.config.format === 'percent' && spec.y[0]?.agg !== 'sum') ? 'percent' : 'number';

  const rows = useMemo(() => (data ? data.x.map((x, i) => ({ x: String(x), ...Object.fromEntries(data.series.map((s) => [s.key, s.values[i] ?? 0])) })) : []), [data]);
  const series = (data?.series ?? []).map((s) => ({ key: s.key, label: s.label }));
  const total = data ? data.series.reduce((sum, s) => sum + s.values.reduce<number>((a, b) => a + (b ?? 0), 0), 0) : 0;
  const empty = !loading && (!data || !data.x.length || total === 0);
  const groupable = schema.properties.filter((p) => ['select', 'status', 'multi_select', 'checkbox', 'date', 'created_time', 'updated_time', 'relation', 'text', 'title', 'rating'].includes(p.type));
  const numeric = schema.properties.filter((p) => isNumeric(p));
  const yLabel = spec.y[0]?.agg === 'count' || !yProp ? 'Count' : `${AGGS.find((a) => a.value === spec.y[0].agg)?.label ?? ''} of ${yProp.name}`;

  const chart = (() => {
    const h = inline ? 260 : 340;
    if (spec.type === 'donut') {
      const s0 = data?.series[0];
      return (
        <div className="edb-chart-donut">
          <Donut data={(data?.x ?? []).map((x, i) => ({ id: String(x), label: String(x), value: s0?.values[i] ?? 0 }))} size={inline ? 200 : 240} format={format} currency={data?.currency} centerLabel={yLabel} summaryLabel={view.name} loading={loading && !data} />
        </div>
      );
    }
    if (spec.type === 'waterfall') {
      const s0 = data?.series[0];
      const steps = (data?.x ?? []).map((x, i) => ({ label: String(x), value: s0?.values[i] ?? 0 }));
      return <Waterfall steps={[...steps, { label: 'Total', value: 0, total: true }]} height={h} format={format} currency={data?.currency} summaryLabel={view.name} loading={loading && !data} />;
    }
    if (spec.type === 'line' || spec.type === 'area' || spec.type === 'stacked_area') {
      const C = spec.type === 'line' ? LineChart : AreaChart;
      return <C data={rows} x="x" series={series} height={h} curve={spec.smooth ? 'monotoneX' : 'linear'} format={format} currency={data?.currency} yAxis="left" includeZero colorBySign={false} startReference={false} summaryLabel={view.name} loading={loading && !data} empty={empty ? 'Add a few rows with values to see this chart' : false} />;
    }
    return (
      <BarChart
        data={rows}
        x="x"
        series={series}
        height={spec.type === 'hbar' ? Math.max(h, rows.length * 30 + 40) : h}
        horizontal={spec.type === 'hbar'}
        stacked={!!spec.stacked && series.length > 1}
        format={format}
        currency={data?.currency}
        yAxis="left"
        summaryLabel={view.name}
        loading={loading && !data}
        empty={empty ? 'Add a few rows with values to see this chart' : false}
      />
    );
  })();

  return (
    <div className={cn('edb-chart-wrap', inline && 'is-inline')}>
      <div className="edb-chart-head">
        <div className="edb-chart-kpi">
          <span className="edb-chart-kpi-label">{yLabel}{xProp || spec.x.prop === '$created' ? ` by ${xProp?.name ?? 'Created'}` : ''}</span>
          <span className="edb-chart-kpi-value tabular-nums" data-sensitive="">
            {spec.y[0]?.agg === 'avg' || spec.y[0]?.agg === 'median' || spec.y[0]?.agg === 'min' || spec.y[0]?.agg === 'max' ? `${data?.x.length ?? 0} groups` : formatCompact(total, { currency: data?.currency })}
          </span>
        </div>
        <span className="flex-1" />
        <Segmented size="sm" value={spec.type === 'stacked_area' ? 'area' : spec.type === 'combo' ? 'bar' : spec.type} onValueChange={(t) => !readOnly && set({ type: t })} options={TYPES.map((t) => ({ value: t.value, icon: t.icon, label: <span className="sr-only">{t.label}</span> }))} aria-label="Chart type" />
        {!readOnly ? (
          <Popover>
            <PopoverTrigger asChild>
              <button type="button" className="edb-tool slab slab-ghost" data-icon-only="" aria-label="Chart settings" title="Chart settings">
                <Settings2 size={16} aria-hidden />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="edb-panel edb-chart-settings">
              <div className="edb-cfg-row">
                <span className="edb-cfg-label">X axis</span>
                <div className="edb-cfg-control">
                  <Select size="sm" searchable value={spec.x.prop} onValueChange={(v) => {
                    const p = schema.properties.find((x) => x.id === v);
                    set({ x: { prop: v as Id, ...(v === '$created' || (p && isDateLike(p)) ? { bucket: spec.x.bucket ?? 'month' } : {}) } });
                  }} options={[...groupable.map((p) => ({ value: p.id, label: p.name, icon: <TypeIcon type={p.type} /> })), { value: '$created', label: 'Created time', icon: <TypeIcon type="created_time" /> }]} />
                </div>
              </div>
              {dateX ? (
                <div className="edb-cfg-row">
                  <span className="edb-cfg-label">Group dates by</span>
                  <div className="edb-cfg-control">
                    <Segmented size="sm" value={spec.x.bucket ?? 'month'} onValueChange={(b) => set({ x: { ...spec.x, bucket: b } })} options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'quarter', label: 'Qtr' }, { value: 'year', label: 'Year' }]} aria-label="Date bucket" />
                  </div>
                </div>
              ) : null}
              <div className="edb-cfg-row">
                <span className="edb-cfg-label">Y axis</span>
                <div className="edb-cfg-control flex gap-1.5">
                  <Select size="sm" value={spec.y[0]?.agg ?? 'count'} onValueChange={(a) => set({ y: [{ agg: a, ...(a === 'count' ? {} : { prop: spec.y[0]?.prop ?? numeric[0]?.id }) }] })} options={AGGS.filter((a) => a.value === 'count' || numeric.length)} />
                  {spec.y[0]?.agg && spec.y[0].agg !== 'count' ? (
                    <Select size="sm" value={spec.y[0].prop ?? null} placeholder="Property" onValueChange={(p) => set({ y: [{ agg: spec.y[0].agg, prop: p }] })} options={numeric.map((p) => ({ value: p.id, label: p.name, icon: <TypeIcon type={p.type} /> }))} />
                  ) : null}
                </div>
              </div>
              <div className="edb-cfg-row">
                <span className="edb-cfg-label">Series</span>
                <div className="edb-cfg-control">
                  <Select size="sm" value={spec.series?.prop ?? '__none'} onValueChange={(v) => set({ series: v === '__none' ? undefined : { prop: v } })} options={[{ value: '__none', label: 'None' }, ...groupable.filter((p) => p.id !== spec.x.prop && !isDateLike(p)).map((p) => ({ value: p.id, label: p.name, icon: <TypeIcon type={p.type} /> }))]} />
                </div>
              </div>
              <div className="edb-chart-toggles">
                {spec.series ? <Switch size="sm" label="Stacked" checked={!!spec.stacked} onCheckedChange={(v) => set({ stacked: v })} /> : null}
                <Switch size="sm" label="Cumulative" checked={!!spec.cumulative} onCheckedChange={(v) => set({ cumulative: v })} />
                {spec.type === 'line' || spec.type === 'area' ? <Switch size="sm" label="Smooth lines" checked={!!spec.smooth} onCheckedChange={(v) => set({ smooth: v })} /> : null}
                <Switch size="sm" label="Omit empty groups" checked={!!spec.omitZero} onCheckedChange={(v) => set({ omitZero: v })} />
              </div>
            </PopoverContent>
          </Popover>
        ) : null}
      </div>
      <div className="edb-chart-body">
        {chart}
        {series.length > 1 && spec.type !== 'donut' && spec.type !== 'waterfall' ? (
          <div className="edb-chart-legend" aria-hidden>
            {series.map((s0, i) => (
              <span key={s0.key} className="edb-chart-legend-item">
                <span className="edb-chart-legend-dot" style={{ background: i < 8 ? `var(--cat-${i + 1})` : 'var(--cat-other)' }} />
                {s0.label}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
