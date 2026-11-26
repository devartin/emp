/**
 * Filter builder (§8.4): AND/OR groups nested up to 3 levels, per-type operators and value inputs (text, numbers,
 * options, status groups, dates with relative `within` ranges, relations). Edits apply live.
 */
import { AnimatePresence, m } from 'motion/react';
import { Copy, Layers, MoreHorizontal, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@/backend';
import type { DbSchema, Filter, FilterOp, Id, Property } from '@/backend/types';
import { cn } from '@/lib/cn';
import { IconButton } from '@/ui/IconButton';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/ui/Menu';
import { Select } from '@/ui/Select';
import { spring } from '@/ui/motion/tokens';
import { WITHIN_OPTIONS, withinLabel } from '../engine/dates';
import { groupChildren, groupKind, isGroup, MAX_FILTER_DEPTH, type Condition } from '../engine/filter';
import { familyOf, OP_LABEL, operatorsFor, opNeedsValue } from '../engine/schema';
import { optionsOf, STATUS_GROUPS } from '../engine/values';
import { OptionTag } from '../properties/CellView';
import { TypeIcon } from '../properties/meta';

type Group = { and: Filter[] } | { or: Filter[] };

export function normalizeRoot(f: Filter | undefined): Group {
  if (!f) return { and: [] };
  if (isGroup(f)) return f;
  return { and: [f] };
}

function mkGroup(kind: 'and' | 'or', children: Filter[]): Group {
  return kind === 'and' ? { and: children } : { or: children };
}

export function defaultCondition(p: Property): Condition {
  const ops = operatorsFor(p);
  const op = ops[0];
  return { prop: p.id, op };
}

function SelectProp({ schema, value, onChange }: { schema: DbSchema; value: Id; onChange: (id: Id) => void }) {
  const opts = [
    ...schema.properties.filter((p) => p.type !== 'secret').map((p) => ({ value: p.id, label: p.name, icon: <TypeIcon type={p.type} /> })),
    { value: '$created', label: 'Created time', icon: <TypeIcon type="created_time" /> },
    { value: '$updated', label: 'Last edited time', icon: <TypeIcon type="updated_time" /> },
  ];
  return <Select size="sm" searchable value={value} onValueChange={onChange} options={opts} className="edb-f-prop" listWidth={240} />;
}

function virtualProp(id: string): Property {
  return { id, name: id === '$created' ? 'Created time' : 'Last edited time', type: id === '$created' ? 'created_time' : 'updated_time', config: {}, hidden: false, sortKey: '' };
}

function DateValueInput({ op, value, onChange }: { op: FilterOp; value: unknown; onChange: (v: unknown) => void }) {
  if (op === 'within') {
    const v = value as { past_days?: number; next_days?: number } | string | undefined;
    const isN = v && typeof v === 'object';
    const kind = isN ? ('past_days' in v ? 'past_days' : 'next_days') : (v as string) ?? 'this_week';
    return (
      <div className="flex gap-1.5 items-center">
        <Select
          size="sm"
          value={kind as string}
          onValueChange={(k) => onChange(k === 'past_days' ? { past_days: 7 } : k === 'next_days' ? { next_days: 7 } : k)}
          options={[...WITHIN_OPTIONS.map((o) => ({ value: o.value, label: o.label })), { value: 'past_days', label: 'Past N days' }, { value: 'next_days', label: 'Next N days' }]}
        />
        {isN ? (
          <input
            className="edb-input w-16"
            type="number"
            min={1}
            max={3650}
            value={(v as { past_days?: number; next_days?: number }).past_days ?? (v as { next_days?: number }).next_days ?? 7}
            onChange={(e) => onChange({ [kind as string]: Math.max(1, Number(e.target.value) || 1) })}
            aria-label="Days"
          />
        ) : null}
      </div>
    );
  }
  if (op === 'between') {
    const arr = Array.isArray(value) ? (value as string[]) : ['', ''];
    return (
      <div className="flex gap-1.5 items-center">
        <input className="edb-input" type="date" value={arr[0] ?? ''} onChange={(e) => onChange([e.target.value, arr[1] ?? ''])} aria-label="From" />
        <span className="text-tertiary">→</span>
        <input className="edb-input" type="date" value={arr[1] ?? ''} onChange={(e) => onChange([arr[0] ?? '', e.target.value])} aria-label="To" />
      </div>
    );
  }
  return <input className="edb-input" type="date" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} aria-label="Date" />;
}

function OptionsValue({ prop, op, value, onChange }: { prop: Property; op: FilterOp; value: unknown; onChange: (v: unknown) => void }) {
  const opts = optionsOf(prop);
  const multi = op === 'any_of' || op === 'none_of' || op === 'all_of' || prop.type === 'multi_select';
  if (op === 'group_eq') {
    const sel = Array.isArray(value) ? (value as string[]) : value ? [String(value)] : [];
    return (
      <div className="edb-f-chips">
        {STATUS_GROUPS.map((g) => (
          <button key={g.id} type="button" className="edb-quick" data-on={sel.includes(g.id) ? '' : undefined} onClick={() => onChange(sel.includes(g.id) ? sel.filter((x) => x !== g.id) : [...sel, g.id])}>
            {g.name}
          </button>
        ))}
      </div>
    );
  }
  const sel = Array.isArray(value) ? (value as string[]) : value ? [String(value)] : [];
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className="edb-f-value-btn">
          {sel.length ? (
            sel.map((id) => {
              const o = opts.find((x) => x.id === id);
              return o ? <OptionTag key={id} opt={o} status={prop.type === 'status'} /> : null;
            })
          ) : (
            <span className="text-tertiary">Select…</span>
          )}
        </button>
      </MenuTrigger>
      <MenuContent width={240}>
        {opts.map((o) => (
          <MenuItem
            key={o.id}
            keepOpen={multi}
            trailing={sel.includes(o.id) ? '✓' : undefined}
            onSelect={() => onChange(multi ? (sel.includes(o.id) ? sel.filter((x) => x !== o.id) : [...sel, o.id]) : o.id)}
          >
            <OptionTag opt={o} status={prop.type === 'status'} />
          </MenuItem>
        ))}
        {!opts.length ? <div className="edb-picker-empty">No options yet</div> : null}
      </MenuContent>
    </Menu>
  );
}

function RelationValue({ prop, value, onChange }: { prop: Property; value: unknown; onChange: (v: unknown) => void }) {
  const [opts, setOpts] = useState<{ id: Id; title: string }[]>([]);
  useEffect(() => {
    api.db.relationOptions({ propertyId: prop.id, search: '', limit: 200 }).then(setOpts).catch(() => undefined);
  }, [prop.id]);
  const sel = Array.isArray(value) ? (value as string[]) : value ? [String(value)] : [];
  return (
    <Select
      size="sm"
      searchable
      placeholder="Choose a row"
      value={sel[0] ?? null}
      onValueChange={(v) => onChange([v])}
      options={opts.map((o) => ({ value: o.id, label: o.title }))}
    />
  );
}

function ValueInput({ prop, cond, onChange }: { prop: Property; cond: Condition; onChange: (v: unknown) => void }) {
  if (!opNeedsValue(cond.op)) return <span />;
  if (prop.type === 'relation') return <RelationValue prop={prop} value={cond.value} onChange={onChange} />;
  const fam = familyOf(prop);
  if (fam === 'select' || fam === 'status' || fam === 'multi') return <OptionsValue prop={prop} op={cond.op} value={cond.value} onChange={onChange} />;
  if (fam === 'date') return <DateValueInput op={cond.op} value={cond.value} onChange={onChange} />;
  if (fam === 'number') {
    const pct = prop.type === 'progress' || (prop.type === 'number' && prop.config.format === 'percent');
    const shown = typeof cond.value === 'number' ? (pct ? +(cond.value * 100).toFixed(4) : cond.value) : '';
    return (
      <div className="edb-f-num">
        <input
          className="edb-input"
          type="number"
          value={shown}
          onChange={(e) => {
            const n = e.target.value === '' ? undefined : Number(e.target.value);
            onChange(n === undefined ? undefined : pct ? n / 100 : n);
          }}
          placeholder="Value"
          aria-label="Value"
        />
        {pct ? <span className="edb-affix">%</span> : null}
      </div>
    );
  }
  return <input className="edb-input" value={typeof cond.value === 'string' ? cond.value : ''} onChange={(e) => onChange(e.target.value)} placeholder="Value" aria-label="Value" />;
}

interface RowProps {
  schema: DbSchema;
  cond: Condition;
  onChange: (c: Filter) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onWrap?: () => void;
}

function ConditionRow({ schema, cond, onChange, onRemove, onDuplicate, onWrap }: RowProps) {
  const prop = cond.prop === '$created' || cond.prop === '$updated' ? virtualProp(cond.prop) : schema.properties.find((p) => p.id === cond.prop);
  if (!prop) return null;
  const ops = operatorsFor(prop);
  return (
    <div className="edb-f-cond">
      <SelectProp
        schema={schema}
        value={cond.prop}
        onChange={(id) => {
          const p = id.startsWith('$') ? virtualProp(id) : schema.properties.find((x) => x.id === id);
          if (p) onChange({ ...defaultCondition(p), prop: id as Id });
        }}
      />
      <Select size="sm" value={cond.op} onValueChange={(op) => onChange({ prop: cond.prop, op, ...(opNeedsValue(op) && familyOf(prop) !== 'date' ? { value: cond.value } : op === 'within' ? { value: 'this_week' } : {}) })} options={ops.map((o) => ({ value: o, label: OP_LABEL[o] }))} className="edb-f-op" />
      <div className="edb-f-value">
        <ValueInput prop={prop} cond={cond} onChange={(value) => onChange(value === undefined ? { prop: cond.prop, op: cond.op } : { ...cond, value })} />
      </div>
      <RowMenu onRemove={onRemove} onDuplicate={onDuplicate} onWrap={onWrap} />
    </div>
  );
}

function RowMenu({ onRemove, onDuplicate, onWrap }: { onRemove: () => void; onDuplicate: () => void; onWrap?: () => void }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <IconButton size="xs" icon={MoreHorizontal} label="More" />
      </MenuTrigger>
      <MenuContent align="end" width={200}>
        <MenuItem icon={Copy} onSelect={onDuplicate}>
          Duplicate
        </MenuItem>
        {onWrap ? (
          <MenuItem icon={Layers} onSelect={onWrap}>
            Turn into group
          </MenuItem>
        ) : null}
        <MenuSeparator />
        <MenuItem icon={Trash2} destructive onSelect={onRemove}>
          Remove
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function Combinator({ index, kind, onKind }: { index: number; kind: 'and' | 'or'; onKind: (k: 'and' | 'or') => void }) {
  if (index === 0) return <span className="edb-f-comb">Where</span>;
  if (index === 1)
    return (
      <Select size="sm" value={kind} onValueChange={onKind} options={[{ value: 'and', label: 'And' }, { value: 'or', label: 'Or' }]} className="edb-f-comb-select" />
    );
  return <span className="edb-f-comb">{kind === 'and' ? 'And' : 'Or'}</span>;
}

function GroupEditor({ schema, group, depth, onChange, onRemove }: { schema: DbSchema; group: Group; depth: number; onChange: (g: Group) => void; onRemove?: () => void }) {
  const kind = groupKind(group);
  const kids = groupChildren(group);
  const set = (next: Filter[]) => onChange(mkGroup(kind, next));
  const first = schema.properties.find((p) => p.type !== 'secret')!;
  const addRule = () => set([...kids, defaultCondition(first)]);
  const addGroup = () => set([...kids, { and: [defaultCondition(first)] }]);
  return (
    <div className={cn('edb-f-group', depth > 0 && 'is-nested')} data-depth={depth}>
      <AnimatePresence initial={false}>
        {kids.map((c, i) => (
          <m.div key={i} className="edb-f-line" layout="position" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring.layout}>
            <Combinator index={i} kind={kind} onKind={(k) => onChange(mkGroup(k, kids))} />
            {isGroup(c) ? (
              <div className="flex-1 min-w-0">
                <GroupEditor schema={schema} group={c} depth={depth + 1} onChange={(g) => set(kids.map((x, j) => (j === i ? g : x)))} onRemove={() => set(kids.filter((_, j) => j !== i))} />
              </div>
            ) : (
              <ConditionRow
                schema={schema}
                cond={c}
                onChange={(n) => set(kids.map((x, j) => (j === i ? n : x)))}
                onRemove={() => set(kids.filter((_, j) => j !== i))}
                onDuplicate={() => set([...kids.slice(0, i + 1), structuredClone(c), ...kids.slice(i + 1)])}
                onWrap={depth + 1 < MAX_FILTER_DEPTH ? () => set(kids.map((x, j) => (j === i ? { and: [x] } : x))) : undefined}
              />
            )}
          </m.div>
        ))}
      </AnimatePresence>
      {!kids.length && depth === 0 ? <div className="edb-f-empty">No filters yet. Rows that match every rule will show.</div> : null}
      <div className="edb-f-actions">
        <button type="button" className="edb-f-add" onClick={addRule}>
          <Plus size={14} aria-hidden /> Add filter rule
        </button>
        {depth + 1 < MAX_FILTER_DEPTH ? (
          <button type="button" className="edb-f-add" onClick={addGroup}>
            <Layers size={14} aria-hidden /> Add filter group
          </button>
        ) : null}
        {onRemove ? (
          <button type="button" className="edb-f-add ml-auto" onClick={onRemove}>
            <X size={14} aria-hidden /> Remove group
          </button>
        ) : null}
      </div>
    </div>
  );
}

export interface FilterBuilderProps {
  schema: DbSchema;
  filter: Filter | undefined;
  onChange: (f: Filter | undefined) => void;
  footer?: ReactNode;
}

export function FilterBuilder({ schema, filter, onChange, footer }: FilterBuilderProps) {
  const root = normalizeRoot(filter);
  const write = (g: Group) => onChange(groupChildren(g).length ? g : undefined);
  return (
    <div className="edb-filter">
      <GroupEditor schema={schema} group={root} depth={0} onChange={write} />
      {groupChildren(root).length ? (
        <div className="edb-f-foot">
          <button type="button" className="edb-f-add" data-destructive="" onClick={() => onChange(undefined)}>
            <Trash2 size={14} aria-hidden /> Delete all filters
          </button>
          {footer}
        </div>
      ) : null}
    </div>
  );
}

export function filterSummary(schema: DbSchema, f: Filter | undefined): string {
  if (!f) return '';
  const leaves: Condition[] = [];
  const walk = (x: Filter) => (isGroup(x) ? groupChildren(x).forEach(walk) : leaves.push(x));
  walk(f);
  if (leaves.length === 1) {
    const c = leaves[0];
    const p = schema.properties.find((x) => x.id === c.prop);
    const name = p?.name ?? (c.prop === '$created' ? 'Created' : 'Edited');
    let v = '';
    if (c.op === 'within') v = withinLabel(c.value);
    else if (p && (p.type === 'select' || p.type === 'status' || p.type === 'multi_select')) {
      const ids = Array.isArray(c.value) ? (c.value as string[]) : c.value ? [String(c.value)] : [];
      v = ids.map((id) => optionsOf(p).find((o) => o.id === id)?.name).filter(Boolean).join(', ');
    } else if (c.value !== undefined && typeof c.value !== 'object') v = String(c.value);
    return `${name} ${OP_LABEL[c.op]}${v ? ' ' + v : ''}`;
  }
  return `${leaves.length} rules`;
}
