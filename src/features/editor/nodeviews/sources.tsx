/**
 * Data sources for chart / KPI blocks (§7.1): `{kind:'db', databaseId, viewId?}`, `{kind:'sheet', workbookId, range}`,
 * `{kind:'metric', instanceId, metric}`. Loading helpers plus the setup form shared by both blocks.
 */
import { BarChart3, Database, LineChart as LineIcon, PieChart, Sheet, Sparkles, AreaChart as AreaIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/backend';
import type { AggFn, ChartData, ChartSpec, ChartType, DbSchema, Id, LifeAppMetric, Property } from '@/backend/types';
import { cn } from '@/lib/cn';
import { useWorkspace } from '@/stores/workspace';
import { Button } from '@/ui/Button';
import { Segmented } from '@/ui/Segmented';
import { PagePicker } from '../menus/PagePicker';

export type BlockSource =
  | { kind: 'db'; databaseId: Id; viewId?: Id }
  | { kind: 'sheet'; workbookId: Id; range: string }
  | { kind: 'metric'; instanceId: Id; metric: string };

export function isSource(v: unknown): v is BlockSource {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return (s.kind === 'db' && typeof s.databaseId === 'string') || (s.kind === 'sheet' && typeof s.workbookId === 'string') || (s.kind === 'metric' && typeof s.instanceId === 'string' && typeof s.metric === 'string');
}

const schemaCache = new Map<Id, Promise<DbSchema>>();
export function loadSchema(id: Id): Promise<DbSchema> {
  let p = schemaCache.get(id);
  if (!p) {
    p = api.db.getSchema({ id });
    p.catch(() => schemaCache.delete(id));
    schemaCache.set(id, p);
  }
  return p;
}

export const NUMERIC: Property['type'][] = ['number', 'money', 'rating', 'progress', 'formula', 'rollup'];
export const GROUPABLE: Property['type'][] = ['select', 'status', 'multi_select', 'date', 'checkbox', 'created_time', 'title', 'text'];

export function defaultSpec(schema: DbSchema, type: ChartType = 'bar'): ChartSpec {
  const x = schema.properties.find((p) => p.type === 'select' || p.type === 'status') ?? schema.properties.find((p) => p.type === 'date');
  const num = schema.properties.find((p) => NUMERIC.includes(p.type));
  return {
    type,
    x: x ? { prop: x.id, ...(x.type === 'date' ? { bucket: 'month' as const } : {}) } : { prop: '$created', bucket: 'month' },
    y: [num ? { agg: 'sum', prop: num.id } : { agg: 'count' }],
  };
}

export interface MetricOption {
  instanceId: Id;
  appTitle: string;
  metric: string;
}

export function useMetricOptions(enabled: boolean): MetricOption[] | null {
  const instances = useWorkspace((s) => s.lifeapps);
  const [opts, setOpts] = useState<MetricOption[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void Promise.all(
      instances.map((i) =>
        api.lifeapp
          .manifest({ id: i.appId })
          .then((m) => m.metrics.map((x) => ({ instanceId: i.id, appTitle: m.title, metric: x.name })))
          .catch(() => [] as MetricOption[]),
      ),
    ).then((all) => live && setOpts(all.flat()));
    return () => {
      live = false;
    };
  }, [enabled, instances]);
  return opts;
}

export async function loadMetric(src: Extract<BlockSource, { kind: 'metric' }>): Promise<LifeAppMetric | null> {
  const res = await api.lifeapp.metrics({ instanceId: src.instanceId, names: [src.metric] });
  return res[src.metric] ?? null;
}

/** Sheet range → ChartData: first column labels, other columns numeric series, first row headers. */
export async function loadSheetData(src: Extract<BlockSource, { kind: 'sheet' }>): Promise<ChartData> {
  const wb = await api.sheet.workbookGet({ id: src.workbookId });
  const sheet = wb.sheets[0];
  if (!sheet) return { x: [], series: [] };
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(src.range.trim());
  const col = (s: string) => s.toUpperCase().split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const rect = m ? { r0: Number(m[2]) - 1, c0: col(m[1]), r1: Number(m[4]) - 1, c1: col(m[3]) } : { r0: 0, c0: 0, r1: 24, c1: 4 };
  const capped = { r0: rect.r0, c0: rect.c0, r1: Math.min(rect.r1, rect.r0 + 200), c1: Math.min(rect.c1, rect.c0 + 12) };
  const res = await api.sheet.getRange({ sheetId: sheet.id, rect: capped });
  const rows = capped.r1 - capped.r0 + 1;
  const cols = capped.c1 - capped.c0 + 1;
  const grid: { display: string }[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ display: '' })));
  res.cells.r.forEach((r, i) => {
    const row = grid[r - capped.r0];
    const c = res.cells.c[i] - capped.c0;
    if (row && c >= 0 && c < cols) row[c] = { display: res.cells.d[i] ?? '' };
  });
  const cells = grid.filter((row) => row.some((x) => x.display));
  if (cells.length < 2) return { x: [], series: [] };
  const header = cells[0];
  const body = cells.slice(1);
  const num = (s: string) => {
    const n = Number(s.replace(/[^0-9.\-−]/g, '').replace('−', '-'));
    return Number.isFinite(n) ? n : null;
  };
  return {
    x: body.map((r) => r[0]?.display ?? ''),
    series: header.slice(1).map((h, i) => ({ key: `s${i}`, label: h.display || `Series ${i + 1}`, values: body.map((r) => num(r[i + 1]?.display ?? '')) })),
  };
}

// ───────────────────────────────────────────────────────────────────────────── setup form

const TYPES: { value: ChartType; label: string; icon: typeof BarChart3 }[] = [
  { value: 'bar', label: 'Bar', icon: BarChart3 },
  { value: 'line', label: 'Line', icon: LineIcon },
  { value: 'area', label: 'Area', icon: AreaIcon },
  { value: 'donut', label: 'Donut', icon: PieChart },
];

const AGGS: { value: AggFn; label: string; numeric: boolean }[] = [
  { value: 'count', label: 'Count', numeric: false },
  { value: 'sum', label: 'Sum', numeric: true },
  { value: 'avg', label: 'Average', numeric: true },
  { value: 'min', label: 'Min', numeric: true },
  { value: 'max', label: 'Max', numeric: true },
  { value: 'median', label: 'Median', numeric: true },
];

export interface SetupValue {
  source: BlockSource;
  spec?: ChartSpec;
  agg?: AggFn;
  prop?: Id;
  label?: string;
}

export function SourceSetup({ mode, initial, onDone, onCancel }: { mode: 'chart' | 'kpi'; initial?: SetupValue | null; onDone: (v: SetupValue) => void; onCancel?: () => void }) {
  const [kind, setKind] = useState<'db' | 'metric' | 'sheet'>(initial?.source.kind ?? 'db');
  const [dbId, setDbId] = useState<Id | null>(initial?.source.kind === 'db' ? initial.source.databaseId : null);
  const [dbTitle, setDbTitle] = useState<string>('');
  const [schema, setSchema] = useState<DbSchema | null>(null);
  const [spec, setSpec] = useState<ChartSpec | null>(initial?.spec ?? null);
  const [agg, setAgg] = useState<AggFn>(initial?.agg ?? 'count');
  const [prop, setProp] = useState<Id | undefined>(initial?.prop);
  const [metric, setMetric] = useState<MetricOption | null>(null);
  const [sheetId, setSheetId] = useState<Id | null>(initial?.source.kind === 'sheet' ? initial.source.workbookId : null);
  const [range, setRange] = useState(initial?.source.kind === 'sheet' ? initial.source.range : 'A1:B13');
  const [picker, setPicker] = useState<null | { kinds: ('database' | 'sheet')[]; anchor: DOMRect }>(null);
  const [error, setError] = useState<string | null>(null);
  const metrics = useMetricOptions(kind === 'metric');

  useEffect(() => {
    if (!dbId) return;
    let live = true;
    setError(null);
    loadSchema(dbId)
      .then((s) => {
        if (!live) return;
        setSchema(s);
        setDbTitle(s.database.title || dbTitle || 'Untitled database');
        if (!spec) setSpec(defaultSpec(s));
      })
      .catch(() => live && setError('That database isn’t available.'));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbId]);

  const groupProps = useMemo(() => schema?.properties.filter((p) => GROUPABLE.includes(p.type)) ?? [], [schema]);
  const numProps = useMemo(() => schema?.properties.filter((p) => NUMERIC.includes(p.type)) ?? [], [schema]);
  const ySpec = spec?.y[0];

  const canSave =
    (kind === 'db' && !!dbId && !!schema && (mode === 'kpi' ? agg === 'count' || !!prop : !!spec)) || (kind === 'metric' && !!metric) || (kind === 'sheet' && !!sheetId && /^[A-Z]+\d+:[A-Z]+\d+$/i.test(range));

  const save = () => {
    if (kind === 'db' && dbId) onDone({ source: { kind: 'db', databaseId: dbId }, spec: spec ?? undefined, agg, prop, label: mode === 'kpi' ? labelFor() : undefined });
    else if (kind === 'metric' && metric) onDone({ source: { kind: 'metric', instanceId: metric.instanceId, metric: metric.metric }, spec: spec ?? { type: 'line', x: { prop: '$created' }, y: [{ agg: 'sum' }] }, label: humanMetric(metric.metric) });
    else if (kind === 'sheet' && sheetId) onDone({ source: { kind: 'sheet', workbookId: sheetId, range: range.toUpperCase() }, spec: spec ?? { type: 'bar', x: { prop: '$created' }, y: [{ agg: 'sum' }] }, agg: 'sum', label: 'Total' });
  };

  const labelFor = () => {
    const p = schema?.properties.find((x) => x.id === prop);
    const a = AGGS.find((x) => x.value === agg)?.label ?? 'Count';
    return agg === 'count' ? `${dbTitle || 'Rows'} count` : `${a} of ${p?.name ?? 'value'}`;
  };

  return (
    <div className="emp-source-setup">
      <div className="emp-source-head">
        <span className="emp-source-title">{mode === 'chart' ? 'Chart data' : 'KPI source'}</span>
        <Segmented
          size="sm"
          value={kind}
          onValueChange={(v) => setKind(v as typeof kind)}
          options={[
            { value: 'db', label: 'Database' },
            { value: 'metric', label: 'Life app' },
            { value: 'sheet', label: 'Sheet' },
          ]}
        />
      </div>
      {kind === 'db' ? (
        <div className="emp-source-body">
          <button type="button" className={cn('emp-source-pick', dbId && 'is-set')} onClick={(e) => setPicker({ kinds: ['database'], anchor: e.currentTarget.getBoundingClientRect() })}>
            <Database size={15} />
            <span>{dbId ? dbTitle || 'Loading…' : 'Choose a database…'}</span>
          </button>
          {error ? <div className="emp-source-error">{error}</div> : null}
          {schema && mode === 'chart' && spec ? (
            <>
              <div className="emp-source-types">
                {TYPES.map((t) => (
                  <button key={t.value} type="button" className="emp-source-type" data-active={spec.type === t.value ? '' : undefined} onClick={() => setSpec({ ...spec, type: t.value })}>
                    <t.icon size={16} />
                    <span>{t.label}</span>
                  </button>
                ))}
              </div>
              <label className="emp-source-row">
                <span>Group by</span>
                <select
                  className="emp-select"
                  value={spec.x.prop}
                  onChange={(e) => {
                    const p = schema.properties.find((x) => x.id === e.target.value);
                    setSpec({ ...spec, x: { prop: e.target.value, ...(p?.type === 'date' || e.target.value === '$created' ? { bucket: 'month' as const } : {}) } });
                  }}
                >
                  <option value="$created">Created (by month)</option>
                  {groupProps.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="emp-source-row">
                <span>Value</span>
                <select
                  className="emp-select"
                  value={ySpec?.agg === 'count' ? 'count' : `${ySpec?.agg}:${ySpec?.prop}`}
                  onChange={(e) => {
                    const [a, p] = e.target.value.split(':');
                    setSpec({ ...spec, y: [a === 'count' ? { agg: 'count' } : { agg: a as AggFn, prop: p }] });
                  }}
                >
                  <option value="count">Count of rows</option>
                  {numProps.flatMap((p) =>
                    AGGS.filter((a) => a.numeric).map((a) => (
                      <option key={`${a.value}:${p.id}`} value={`${a.value}:${p.id}`}>
                        {a.label} of {p.name}
                      </option>
                    )),
                  )}
                </select>
              </label>
            </>
          ) : null}
          {schema && mode === 'kpi' ? (
            <label className="emp-source-row">
              <span>Value</span>
              <select
                className="emp-select"
                value={agg === 'count' ? 'count' : `${agg}:${prop}`}
                onChange={(e) => {
                  const [a, p] = e.target.value.split(':');
                  setAgg(a as AggFn);
                  setProp(a === 'count' ? undefined : p);
                }}
              >
                <option value="count">Count of rows</option>
                {numProps.flatMap((p) =>
                  AGGS.filter((a) => a.numeric).map((a) => (
                    <option key={`${a.value}:${p.id}`} value={`${a.value}:${p.id}`}>
                      {a.label} of {p.name}
                    </option>
                  )),
                )}
              </select>
            </label>
          ) : null}
        </div>
      ) : kind === 'metric' ? (
        <div className="emp-source-body">
          {metrics === null ? <div className="emp-source-hint">Loading life apps…</div> : null}
          {metrics && !metrics.length ? (
            <div className="emp-source-hint">
              <Sparkles size={14} /> Install a life app (Money HQ, Habits…) to use its metrics here.
            </div>
          ) : null}
          <div className="emp-source-metrics">
            {metrics?.map((m) => (
              <button key={`${m.instanceId}:${m.metric}`} type="button" className="emp-source-metric" data-active={metric?.metric === m.metric && metric.instanceId === m.instanceId ? '' : undefined} onClick={() => setMetric(m)}>
                <span className="emp-source-metric-name">{humanMetric(m.metric)}</span>
                <span className="emp-source-metric-app">{m.appTitle}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="emp-source-body">
          <button type="button" className={cn('emp-source-pick', sheetId && 'is-set')} onClick={(e) => setPicker({ kinds: ['sheet'], anchor: e.currentTarget.getBoundingClientRect() })}>
            <Sheet size={15} />
            <span>{sheetId ? 'Workbook selected' : 'Choose a spreadsheet…'}</span>
          </button>
          <label className="emp-source-row">
            <span>Range</span>
            <input className="emp-source-input" value={range} onChange={(e) => setRange(e.target.value)} placeholder="A1:B13" spellCheck={false} />
          </label>
        </div>
      )}
      <div className="emp-source-foot">
        {onCancel ? (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button size="sm" variant="primary" disabled={!canSave} onClick={save}>
          {mode === 'chart' ? 'Show chart' : 'Show KPI'}
        </Button>
      </div>
      <PagePicker
        open={!!picker}
        anchor={picker?.anchor ?? null}
        title={picker?.kinds[0] === 'sheet' ? 'Spreadsheets' : 'Databases'}
        kinds={picker?.kinds ?? ['database']}
        placeholder={picker?.kinds[0] === 'sheet' ? 'Search spreadsheets…' : 'Search databases…'}
        onClose={() => setPicker(null)}
        onPick={(id, hit) => {
          if (picker?.kinds[0] === 'sheet') setSheetId(id);
          else {
            setSpec(null);
            setSchema(null);
            setDbTitle(hit.title);
            setDbId(id);
          }
          setPicker(null);
        }}
      />
    </div>
  );
}

export function humanMetric(name: string): string {
  return name.replace(/[_.-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^\w/, (c) => c.toUpperCase());
}
