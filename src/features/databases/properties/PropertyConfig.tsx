/**
 * Property settings (§8.1 configs) for every type: number/money formats, select options with colours, date formats,
 * relation target + two-way + limit, rollup (relation → property → function), formula (opens the FormulaEditor),
 * unique-id prefix, rating, progress, ticker. Used both for editing and for creating properties that need config.
 */
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '@/backend';
import type { BlockColor, DbSchema, Id, Property, PropType } from '@/backend/types';
import { notify } from '@/stores/toasts';
import { useTree } from '@/stores/tree';
import { Button } from '@/ui/Button';
import { Select } from '@/ui/Select';
import { Segmented } from '@/ui/Segmented';
import { Switch } from '@/ui/Switch';
import { Tag, nextTagColor } from '@/ui/Tag';
import { FormulaEditor } from '../FormulaEditor';
import { toDisplay } from '../engine/formula';
import { formatNumberValue } from '../engine/format';
import { familyOf, ROLLUP_FNS, TYPE_META } from '../engine/schema';
import { optionsOf, STATUS_GROUPS, type SelectOption } from '../engine/values';
import { useSchema, useSchemas } from '../store';
import { OptionEditMenu, upsertOption } from './OptionPicker';
import { TypeIcon } from './meta';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'SEK', 'NOK', 'INR', 'BTC', 'ETH'];

export interface PropertyConfigProps {
  schema: DbSchema;
  prop: Property;
  /** Persist a config patch (edit mode) or collect it (create mode). */
  onConfig: (patch: Record<string, unknown>) => void;
  /** Create mode: the property doesn't exist yet. */
  draft?: boolean;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="edb-cfg-row">
      <span className="edb-cfg-label">{label}</span>
      <div className="edb-cfg-control">{children}</div>
    </div>
  );
}

export async function savePropConfig(schema: DbSchema, prop: Property, patch: Record<string, unknown>): Promise<void> {
  const dbId = schema.database.id;
  useSchemas.getState().patchProp(dbId, prop.id, { config: { ...prop.config, ...patch } });
  try {
    const p = await api.db.propertyUpdate({ id: prop.id, patch: { config: patch } });
    useSchemas.getState().patchProp(dbId, prop.id, p);
  } catch (e) {
    useSchemas.getState().patchProp(dbId, prop.id, { config: prop.config });
    notify.fromError(e, "Couldn't update the property");
  }
}

function NumberConfig({ prop, onConfig }: PropertyConfigProps) {
  const c = prop.config;
  const fmt = (c.format as string) ?? 'number';
  const sample = formatNumberValue(fmt === 'percent' ? 0.4275 : 4275.5, { format: fmt as 'number', decimals: typeof c.decimals === 'number' ? c.decimals : undefined });
  return (
    <>
      <Row label="Format">
        <Select size="sm" value={fmt} onValueChange={(v) => onConfig({ format: v })} options={[{ value: 'number', label: 'Number' }, { value: 'comma', label: 'Number with commas' }, { value: 'percent', label: 'Percent' }]} />
      </Row>
      <Row label="Decimals">
        <Select size="sm" value={typeof c.decimals === 'number' ? String(c.decimals) : 'auto'} onValueChange={(v) => onConfig({ decimals: v === 'auto' ? undefined : Number(v) })} options={[{ value: 'auto', label: 'Automatic' }, ...[0, 1, 2, 3, 4, 6, 8].map((n) => ({ value: String(n), label: String(n) }))]} />
      </Row>
      <Row label="Show as">
        <Segmented size="sm" value={(c.display as string) ?? 'number'} onValueChange={(v) => onConfig({ display: v })} options={[{ value: 'number', label: 'Number' }, { value: 'bar', label: 'Bar' }, { value: 'ring', label: 'Ring' }]} aria-label="Show as" />
      </Row>
      {c.display === 'bar' || c.display === 'ring' ? (
        <Row label="Out of">
          <input className="edb-input w-24" type="number" defaultValue={typeof c.divideBy === 'number' ? c.divideBy : fmt === 'percent' ? 1 : 100} onBlur={(e) => onConfig({ divideBy: Math.max(0.0001, Number(e.target.value) || 100) })} />
        </Row>
      ) : null}
      <div className="edb-hint">Preview: <span className="tabular-nums text-primary">{sample}</span></div>
    </>
  );
}

function MoneyConfig({ prop, onConfig }: PropertyConfigProps) {
  const c = prop.config;
  return (
    <>
      <Row label="Currency">
        <Select size="sm" searchable value={String(c.currency ?? 'USD')} onValueChange={(v) => onConfig({ currency: v })} options={CURRENCIES.map((x) => ({ value: x, label: x }))} />
      </Row>
      <Row label="Decimals">
        <Select size="sm" value={String(c.decimals ?? 2)} onValueChange={(v) => onConfig({ decimals: Number(v) })} options={[0, 2, 4, 8].map((n) => ({ value: String(n), label: String(n) }))} />
      </Row>
      <Switch size="sm" label="Currency per row" description="Each row can use its own currency" checked={!!c.perRowCurrency} onCheckedChange={(v) => onConfig({ perRowCurrency: v })} />
    </>
  );
}

function OptionsConfig({ schema, prop, onConfig, draft }: PropertyConfigProps) {
  const live = useSchemas((s) => s.schemas[schema.database.id]?.properties.find((p) => p.id === prop.id)) ?? prop;
  const opts = optionsOf(draft ? prop : live);
  const [name, setName] = useState('');
  const add = async () => {
    const n = name.trim();
    if (!n) return;
    const color = nextTagColor(n, opts.map((o) => o.color));
    if (draft) onConfig({ options: [...opts, { name: n, color, ...(prop.type === 'status' ? { group: 'todo' } : {}) }] });
    else await upsertOption(schema.database.id, live, { name: n, color, group: prop.type === 'status' ? 'todo' : undefined });
    setName('');
  };
  const move = (i: number, d: -1 | 1) => {
    const next = [...opts];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    onConfig({ options: next });
  };
  const sections = prop.type === 'status' ? STATUS_GROUPS.map((g) => ({ label: g.name, items: opts.map((o, i) => [o, i] as const).filter(([o]) => (o.group ?? 'todo') === g.id) })) : [{ label: 'Options', items: opts.map((o, i) => [o, i] as const) }];
  return (
    <>
      <Row label="Sort">
        <Segmented size="sm" value={(prop.config.sort as string) ?? 'manual'} onValueChange={(v) => onConfig({ sort: v })} options={[{ value: 'manual', label: 'Manual' }, { value: 'alpha', label: 'A → Z' }]} aria-label="Option order" />
      </Row>
      {sections.map((s) => (
        <div key={s.label} className="edb-cfg-options">
          <div className="emp-menu-header !px-0">{s.label}</div>
          {s.items.length === 0 ? <div className="edb-hint">No options</div> : null}
          {s.items.map(([o, i]) => (
            <div key={o.id ?? o.name} className="edb-cfg-option">
              <Tag color={o.color as BlockColor}>{o.name}</Tag>
              <span className="flex-1" />
              <button type="button" className="edb-opt-more" aria-label="Move up" onClick={() => move(i, -1)}>
                <ArrowUp size={12} aria-hidden />
              </button>
              <button type="button" className="edb-opt-more" aria-label="Move down" onClick={() => move(i, 1)}>
                <ArrowDown size={12} aria-hidden />
              </button>
              {draft ? (
                <button type="button" className="edb-opt-more" aria-label="Remove" onClick={() => onConfig({ options: opts.filter((_, k) => k !== i) })}>
                  <Trash2 size={12} aria-hidden />
                </button>
              ) : (
                <OptionEditMenu databaseId={schema.database.id} prop={live} opt={o as SelectOption} />
              )}
            </div>
          ))}
        </div>
      ))}
      <form className="flex gap-2" onSubmit={(e) => (e.preventDefault(), void add())}>
        <input className="edb-input flex-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="Add an option" aria-label="New option" />
        <Button size="sm" variant="secondary" type="submit" icon={Plus} disabled={!name.trim()}>
          Add
        </Button>
      </form>
    </>
  );
}

function DateConfig({ prop, onConfig }: PropertyConfigProps) {
  return (
    <>
      <Row label="Date format">
        <Select size="sm" value={String(prop.config.format ?? 'full')} onValueChange={(v) => onConfig({ format: v })} options={[{ value: 'full', label: 'Nov 26, 2026' }, { value: 'mdy', label: '11/26/2026' }, { value: 'dmy', label: '26/11/2026' }, { value: 'ymd', label: '2026-11-26' }, { value: 'relative', label: 'Relative (Today, Tomorrow)' }]} />
      </Row>
      <Row label="Time format">
        <Segmented size="sm" value={String(prop.config.clock ?? 12)} onValueChange={(v) => onConfig({ clock: Number(v) })} options={[{ value: '12', label: '12-hour' }, { value: '24', label: '24-hour' }]} aria-label="Clock" />
      </Row>
    </>
  );
}

function RelationConfig({ schema, prop, onConfig, draft }: PropertyConfigProps) {
  const byId = useTree((s) => s.byId);
  const dbs = useMemo(() => [...byId.values()].filter((p) => p.kind === 'database' && !p.deletedAt), [byId]);
  const target = String(prop.config.targetDatabaseId ?? '');
  const dual = (prop.config.dual as { propertyId?: Id } | null)?.propertyId;
  return (
    <>
      <Row label="Related to">
        <Select
          size="sm"
          searchable
          disabled={!draft}
          placeholder="Choose a database"
          value={target || null}
          onValueChange={(v) => onConfig({ targetDatabaseId: v })}
          options={dbs.map((d) => ({ value: d.id, label: (d.id === schema.database.id ? `${d.title || 'Untitled'} (this database)` : d.title || 'Untitled'), icon: d.icon?.t === 'emoji' ? <span aria-hidden>{d.icon.v}</span> : undefined }))}
        />
      </Row>
      <Row label="Limit">
        <Segmented size="sm" value={String(prop.config.limit ?? 'many')} onValueChange={(v) => onConfig({ limit: v })} options={[{ value: 'many', label: 'No limit' }, { value: 'one', label: '1 row' }]} aria-label="Limit" />
      </Row>
      {draft ? (
        <Switch size="sm" label="Show on the other database" description="Two-way: links appear on both sides and stay in sync" checked={prop.config.twoWay === true} onCheckedChange={(v) => onConfig({ twoWay: v })} />
      ) : (
        <div className="edb-hint">{dual ? 'Two-way relation — edits sync to the linked database.' : 'One-way relation.'}</div>
      )}
    </>
  );
}

function RollupConfig({ schema, prop, onConfig }: PropertyConfigProps) {
  const rels = schema.properties.filter((p) => p.type === 'relation');
  const relId = String(prop.config.relationPropId ?? '');
  const rel = rels.find((r) => r.id === relId);
  const { schema: target } = useSchema(rel ? String(rel.config.targetDatabaseId ?? '') : null);
  const targetProp = target?.properties.find((p) => p.id === prop.config.targetPropId);
  const fam = targetProp ? familyOf(targetProp) : 'text';
  const fns = ROLLUP_FNS.filter((f) => !f.family || f.family.includes(fam));
  return (
    <>
      {!rels.length ? <div className="edb-hint">Add a relation first — rollups summarise the rows it links to.</div> : null}
      <Row label="Relation">
        <Select size="sm" placeholder="Choose a relation" value={relId || null} onValueChange={(v) => onConfig({ relationPropId: v, targetPropId: null })} options={rels.map((r) => ({ value: r.id, label: r.name, icon: <TypeIcon type="relation" /> }))} />
      </Row>
      <Row label="Property">
        <Select size="sm" searchable placeholder={rel ? 'Choose a property' : 'Pick a relation first'} disabled={!target} value={(prop.config.targetPropId as string) ?? null} onValueChange={(v) => onConfig({ targetPropId: v })} options={(target?.properties ?? []).filter((p) => p.type !== 'secret').map((p) => ({ value: p.id, label: p.name, icon: <TypeIcon type={p.type} /> }))} />
      </Row>
      <Row label="Calculate">
        <Select size="sm" value={String(prop.config.fn ?? 'count_all')} onValueChange={(v) => onConfig({ fn: v })} options={fns.map((f) => ({ value: f.fn, label: f.label }))} />
      </Row>
    </>
  );
}

function FormulaConfig({ schema, prop, onConfig }: PropertyConfigProps) {
  const [open, setOpen] = useState(false);
  const expr = String(prop.config.expression ?? '');
  return (
    <>
      <button type="button" className="edb-fx-summary" onClick={() => setOpen(true)}>
        {expr ? <code>{toDisplay(expr, schema.properties)}</code> : <span className="text-tertiary">No formula yet</span>}
      </button>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        {expr ? 'Edit formula' : 'Write a formula'}
      </Button>
      <FormulaEditor
        open={open}
        onOpenChange={setOpen}
        databaseId={schema.database.id}
        properties={schema.properties}
        expression={expr}
        propertyId={prop.id}
        title={prop.name || 'Formula'}
        onSave={(e) => {
          onConfig({ expression: e });
          setOpen(false);
        }}
      />
    </>
  );
}

export function PropertyConfig(props: PropertyConfigProps) {
  const { prop, onConfig } = props;
  switch (prop.type) {
    case 'number':
      return <NumberConfig {...props} />;
    case 'money':
      return <MoneyConfig {...props} />;
    case 'select':
    case 'multi_select':
    case 'status':
      return <OptionsConfig {...props} />;
    case 'date':
    case 'created_time':
    case 'updated_time':
      return <DateConfig {...props} />;
    case 'relation':
      return <RelationConfig {...props} />;
    case 'rollup':
      return <RollupConfig {...props} />;
    case 'formula':
      return <FormulaConfig {...props} />;
    case 'unique_id':
      return (
        <Row label="Prefix">
          <input className="edb-input w-28 font-mono" defaultValue={String(prop.config.prefix ?? '')} placeholder="TASK" maxLength={12} onBlur={(e) => onConfig({ prefix: e.target.value.trim().toUpperCase() })} />
        </Row>
      );
    case 'rating':
      return (
        <>
          <Row label="Scale">
            <Segmented size="sm" value={String(prop.config.max ?? 5)} onValueChange={(v) => onConfig({ max: Number(v) })} options={[{ value: '5', label: '5' }, { value: '10', label: '10' }]} aria-label="Scale" />
          </Row>
          <Row label="Icon">
            <Segmented size="sm" value={String(prop.config.icon ?? 'star')} onValueChange={(v) => onConfig({ icon: v })} options={[{ value: 'star', label: 'Stars' }, { value: 'heart', label: 'Hearts' }]} aria-label="Icon" />
          </Row>
        </>
      );
    case 'progress':
      return (
        <Row label="Show as">
          <Segmented size="sm" value={String(prop.config.display ?? 'bar')} onValueChange={(v) => onConfig({ display: v })} options={[{ value: 'bar', label: 'Bar' }, { value: 'ring', label: 'Ring' }]} aria-label="Show as" />
        </Row>
      );
    case 'ticker':
      return <Switch size="sm" label="Show live quote" description="When market data is on and the vault is unlocked" checked={prop.config.showQuote !== false} onCheckedChange={(v) => onConfig({ showQuote: v })} />;
    case 'secret':
      return <div className="edb-hint">Values are encrypted in the secrets table. Only the last 4 characters are ever shown; revealing needs your password.</div>;
    case 'computed':
      return <div className="edb-hint">Maintained by {String(prop.config.owner ?? 'a life app')}. Read-only.</div>;
    default:
      return <div className="edb-hint">{TYPE_META[prop.type as PropType]?.description}</div>;
  }
}

/** Whether a new property of `type` must be configured before it is created. */
export function needsSetup(type: PropType): boolean {
  return type === 'relation' || type === 'rollup' || type === 'formula';
}
