/** Chart block (§7.1, §13.5): a live chart over a database, sheet range or life-app metric, built on charts/*. */
import type { NodeViewProps } from '@tiptap/react';
import { Settings2, TrendingUp } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/backend';
import type { ChartData, ChartSpec } from '@/backend/types';
import { AreaChart } from '@/charts/Area';
import { BarChart } from '@/charts/Bar';
import { Donut } from '@/charts/Donut';
import { LineChart } from '@/charts/Line';
import { categoricalVar } from '@/lib/hash';
import { Skeleton } from '@/ui/Skeleton';
import { IconButton } from '@/ui/IconButton';
import { isSource, loadMetric, loadSchema, loadSheetData, SourceSetup, humanMetric, type BlockSource } from './sources';

function metricToData(value: unknown, label: string): ChartData | null {
  if (Array.isArray(value)) {
    const pts = value
      .map((v, i) => (typeof v === 'number' ? { x: String(i + 1), y: v } : v && typeof v === 'object' ? { x: String((v as Record<string, unknown>).x ?? (v as Record<string, unknown>).label ?? i + 1), y: Number((v as Record<string, unknown>).y ?? (v as Record<string, unknown>).value) } : null))
      .filter((p): p is { x: string; y: number } => !!p && Number.isFinite(p.y));
    if (pts.length) return { x: pts.map((p) => p.x), series: [{ key: 'v', label, values: pts.map((p) => p.y) }] };
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => typeof v === 'number') as [string, number][];
    if (entries.length) return { x: entries.map(([k]) => k), series: [{ key: 'v', label, values: entries.map(([, v]) => v) }] };
  }
  return null;
}

export default function ChartBlockView({ node, updateAttributes, editor }: NodeViewProps) {
  const source = node.attrs.source as BlockSource | null;
  const spec = node.attrs.spec as ChartSpec | null;
  const [data, setData] = useState<ChartData | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const key = JSON.stringify([source, spec]);

  useEffect(() => {
    if (!isSource(source)) return;
    let live = true;
    setError(null);
    setData(null);
    const run = async () => {
      if (source.kind === 'db') {
        const [schema, d] = await Promise.all([loadSchema(source.databaseId), api.db.chartData({ databaseId: source.databaseId, viewId: source.viewId, spec: spec ?? { type: 'bar', x: { prop: '$created', bucket: 'month' }, y: [{ agg: 'count' }] }, maxPoints: 120 })]);
        const xProp = schema.properties.find((p) => p.id === spec?.x.prop);
        return { d, t: `${schema.database.title || 'Untitled'}${xProp ? ` · by ${xProp.name}` : ''}` };
      }
      if (source.kind === 'sheet') return { d: await loadSheetData(source), t: `Range ${source.range}` };
      const m = await loadMetric(source);
      const d = m ? metricToData(m.value, humanMetric(source.metric)) : null;
      if (!d) throw new Error('This metric has no series to chart');
      return { d, t: humanMetric(source.metric) };
    };
    run()
      .then(({ d, t }) => {
        if (!live) return;
        setData(d);
        setTitle(t);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : 'This chart’s data isn’t available'));
    const off = source.kind === 'db' ? null : null;
    return () => {
      live = false;
      void off;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const rows = useMemo(() => {
    if (!data) return [];
    return data.x.map((x, i) => {
      const r: Record<string, unknown> = { x: String(x) };
      for (const s of data.series) r[s.key] = s.values[i] ?? null;
      return r;
    });
  }, [data]);

  if (!isSource(source) || editing) {
    return (
      <div className="emp-chart-setup">
        {!editing ? (
          <div className="emp-embed-caption">
            <TrendingUp size={14} />
            <span>Chart</span>
          </div>
        ) : null}
        {editor.isEditable ? (
          <SourceSetup
            mode="chart"
            initial={isSource(source) ? { source, spec: spec ?? undefined } : null}
            onCancel={editing ? () => setEditing(false) : undefined}
            onDone={(v) => {
              updateAttributes({ source: v.source, spec: v.spec ?? null });
              setEditing(false);
            }}
          />
        ) : (
          <div className="emp-source-hint">This chart has no data source yet.</div>
        )}
      </div>
    );
  }

  const type = spec?.type ?? 'bar';
  const series = (data?.series ?? []).map((s, i) => ({ key: s.key, label: s.label, color: s.color ?? categoricalVar(i) }));
  const format = data?.currency ? 'money' : 'number';
  const empty = data && (!data.x.length || data.series.every((s) => s.values.every((v) => v == null))) ? 'Add 2+ rows to see this chart' : undefined;
  return (
    <div className="emp-chart-block">
      <div className="emp-chart-head">
        <span className="emp-chart-title">{title || 'Chart'}</span>
        {editor.isEditable ? <IconButton icon={Settings2} label="Edit chart" size="xs" onClick={() => setEditing(true)} /> : null}
      </div>
      {error ? (
        <div className="emp-embed-error" role="alert">
          <span>{error}</span>
          {editor.isEditable ? (
            <button type="button" className="emp-embed-retry" onClick={() => setEditing(true)}>
              Change source
            </button>
          ) : null}
        </div>
      ) : !data ? (
        <Skeleton height={220} radius={10} />
      ) : type === 'donut' ? (
        <Donut data={(data.x as (string | number)[]).map((x, i) => ({ id: String(x), label: String(x), value: Math.max(0, data.series[0]?.values[i] ?? 0) }))} format={format} currency={data.currency} size={180} summaryLabel={title} />
      ) : type === 'line' ? (
        <LineChart data={rows} x="x" series={series} height={220} format={format} currency={data.currency} yAxis="left" summaryLabel={title} empty={empty} />
      ) : type === 'area' || type === 'stacked_area' ? (
        <AreaChart data={rows} x="x" series={series} height={220} format={format} currency={data.currency} yAxis="left" summaryLabel={title} empty={empty} />
      ) : (
        <BarChart data={rows} x="x" series={series} height={220} format={format} currency={data.currency} horizontal={type === 'hbar'} stacked={!!spec?.stacked} summaryLabel={title} empty={empty} />
      )}
    </div>
  );
}
