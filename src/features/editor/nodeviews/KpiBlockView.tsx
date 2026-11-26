/** KPI block (§7.1, §5.10): one live number (database aggregate, sheet total or life-app metric) as a KPI tile. */
import type { NodeViewProps } from '@tiptap/react';
import { Gauge, Settings2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/backend';
import type { AggFn, ChartSpec } from '@/backend/types';
import { formatNumber } from '@/lib/format';
import { IconButton } from '@/ui/IconButton';
import { KpiTile } from '@/ui/KpiTile';
import { isSource, loadMetric, loadSheetData, SourceSetup, humanMetric, type BlockSource } from './sources';

interface Reading {
  value: number | null;
  display?: string;
  spark?: number[];
  currency?: string;
  delta?: number;
}

const ADDITIVE: AggFn[] = ['count', 'sum', 'count_values', 'not_empty', 'empty', 'checked', 'unchecked'];

function combine(agg: AggFn, values: number[]): number | null {
  if (!values.length) return null;
  if (ADDITIVE.includes(agg)) return values.reduce((s, v) => s + v, 0);
  if (agg === 'min') return Math.min(...values);
  if (agg === 'max') return Math.max(...values);
  return values[values.length - 1];
}

export default function KpiBlockView({ node, updateAttributes, editor }: NodeViewProps) {
  const source = node.attrs.source as BlockSource | null;
  const agg = (node.attrs.agg as AggFn) || 'count';
  const label = String(node.attrs.label || '');
  const [reading, setReading] = useState<Reading | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const key = JSON.stringify([source, agg, node.attrs.format]);

  useEffect(() => {
    if (!isSource(source)) return;
    let live = true;
    setError(null);
    const run = async (): Promise<Reading> => {
      if (source.kind === 'metric') {
        const m = await loadMetric(source);
        if (!m) throw new Error('This metric is not available');
        const n = typeof m.value === 'number' ? m.value : Number((m.value as { amount?: string } | null)?.amount ?? NaN);
        const spark = Array.isArray(m.value) ? (m.value as unknown[]).filter((v): v is number => typeof v === 'number') : undefined;
        return { value: Number.isFinite(n) ? n : null, display: m.display, spark };
      }
      if (source.kind === 'sheet') {
        const d = await loadSheetData(source);
        const vals = (d.series[0]?.values ?? []).filter((v): v is number => v != null);
        return { value: combine('sum', vals), spark: vals };
      }
      const spec: ChartSpec = { type: 'line', x: { prop: '$created', bucket: 'month' }, y: [agg === 'count' ? { agg: 'count' } : { agg, prop: (source as { prop?: string }).prop }] };
      const d = await api.db.chartData({ databaseId: source.databaseId, viewId: source.viewId, spec, maxPoints: 24 });
      const vals = (d.series[0]?.values ?? []).map((v) => v ?? 0);
      const last = vals[vals.length - 1];
      const prev = vals[vals.length - 2];
      return { value: combine(agg, vals), spark: vals, currency: d.currency, delta: prev ? (last - prev) / Math.abs(prev) : undefined };
    };
    run()
      .then((r) => live && setReading(r))
      .catch((e) => live && setError(e instanceof Error ? e.message : 'Unavailable'));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!isSource(source) || editing) {
    return (
      <div className="emp-chart-setup">
        {!editing ? (
          <div className="emp-embed-caption">
            <Gauge size={14} />
            <span>KPI</span>
          </div>
        ) : null}
        {editor.isEditable ? (
          <SourceSetup
            mode="kpi"
            initial={isSource(source) ? { source, agg, prop: (source as { prop?: string }).prop } : null}
            onCancel={editing ? () => setEditing(false) : undefined}
            onDone={(v) => {
              updateAttributes({ source: v.source.kind === 'db' && v.prop ? { ...v.source, prop: v.prop } : v.source, agg: v.agg ?? 'count', label: v.label ?? label, format: 'number' });
              setEditing(false);
            }}
          />
        ) : (
          <div className="emp-source-hint">This KPI has no data source yet.</div>
        )}
      </div>
    );
  }

  const title = label || (source.kind === 'metric' ? humanMetric(source.metric) : 'Value');
  return (
    <div className="emp-kpi-block">
      <KpiTile
        label={title}
        loading={!reading && !error}
        value={reading?.currency && reading.value != null ? { amount: String(reading.value), currency: reading.currency } : reading?.value ?? null}
        format={reading?.display && !reading.currency ? () => reading.display as string : (n) => formatNumber(n, { maximumFractionDigits: 2 })}
        noCents={(reading?.value ?? 0) >= 1000}
        spark={reading?.spark && reading.spark.length > 1 ? reading.spark : undefined}
        delta={reading?.delta != null && Number.isFinite(reading.delta) ? { value: reading.delta, format: 'percent', label: 'vs last month' } : undefined}
        stale={error ?? undefined}
        sensitive={source.kind !== 'sheet'}
      />
      {editor.isEditable ? (
        <span className="emp-kpi-edit">
          <IconButton icon={Settings2} label="Edit KPI" size="xs" onClick={() => setEditing(true)} />
        </span>
      ) : null}
    </div>
  );
}
