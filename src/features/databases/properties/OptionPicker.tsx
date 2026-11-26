/**
 * Select / multi-select / status picker (§5.3): typeahead, keyboard highlight, "Create '…'" with the next seeded
 * colour, and per-option edit (rename, colour, status group, delete). Edits go straight to the schema.
 */
import { Check, GripVertical, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '@/backend';
import type { BlockColor, Id, Property } from '@/backend/types';
import { cn } from '@/lib/cn';
import { notify } from '@/stores/toasts';
import { BLOCK_COLORS } from '@/lib/hash';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/Popover';
import { nextTagColor, Tag } from '@/ui/Tag';
import { optionsOf, STATUS_GROUPS, type SelectOption } from '../engine/values';
import { useSchemas } from '../store';
import { OptionTag } from './CellView';

export interface OptionPickerProps {
  databaseId: Id;
  prop: Property;
  value: Id[];
  multi: boolean;
  onChange: (ids: Id[]) => void;
  onDone?: () => void;
  autoFocus?: boolean;
}

export async function upsertOption(databaseId: Id, prop: Property, option: { id?: Id; name: string; color: BlockColor; group?: SelectOption['group'] }): Promise<Property | null> {
  try {
    const p = await api.db.selectOptionUpsert({ propertyId: prop.id, option });
    useSchemas.getState().patchProp(databaseId, prop.id, p);
    return p;
  } catch (e) {
    notify.fromError(e, "Couldn't save the option");
    return null;
  }
}

const COLOR_LABEL: Record<string, string> = { gray: 'Gray', brown: 'Brown', orange: 'Orange', yellow: 'Yellow', green: 'Green', blue: 'Blue', purple: 'Purple', pink: 'Pink', red: 'Red' };

export function OptionEditMenu({ databaseId, prop, opt, onDeleted }: { databaseId: Id; prop: Property; opt: SelectOption; onDeleted?: () => void }) {
  const [name, setName] = useState(opt.name);
  useEffect(() => setName(opt.name), [opt.name]);
  const save = (patch: Partial<SelectOption>) => void upsertOption(databaseId, prop, { id: opt.id, name: patch.name ?? opt.name, color: patch.color ?? opt.color, group: patch.group ?? opt.group });
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="edb-opt-more" aria-label={`Edit ${opt.name}`} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          <MoreHorizontal size={14} aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" className="edb-opt-menu" inDialog>
        <input
          className="edb-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && name.trim()) save({ name: name.trim() });
          }}
          onBlur={() => name.trim() && name.trim() !== opt.name && save({ name: name.trim() })}
          aria-label="Option name"
        />
        {prop.type === 'status' ? (
          <>
            <div className="emp-menu-header">Group</div>
            {STATUS_GROUPS.map((g) => (
              <button key={g.id} type="button" className="emp-menu-item w-full" onClick={() => save({ group: g.id })}>
                <span className="emp-menu-label">{g.name}</span>
                {(opt.group ?? 'todo') === g.id ? <Check size={14} className="text-accent-text" aria-hidden /> : null}
              </button>
            ))}
          </>
        ) : null}
        <div className="emp-menu-header">Colour</div>
        {BLOCK_COLORS.map((c) => (
          <button key={c} type="button" className="emp-menu-item w-full" onClick={() => save({ color: c })}>
            <span className="edb-swatch" style={{ background: `var(--block-${c}-bg)`, borderColor: `var(--block-${c}-text)` }} />
            <span className="emp-menu-label">{COLOR_LABEL[c]}</span>
            {opt.color === c ? <Check size={14} className="text-accent-text" aria-hidden /> : null}
          </button>
        ))}
        <div className="emp-menu-sep" />
        <button
          type="button"
          className="emp-menu-item w-full"
          data-destructive=""
          onClick={async () => {
            try {
              const p = await api.db.selectOptionDelete({ propertyId: prop.id, optionId: opt.id });
              useSchemas.getState().patchProp(databaseId, prop.id, p);
              onDeleted?.();
            } catch (e) {
              notify.fromError(e, "Couldn't delete the option");
            }
          }}
        >
          <span className="emp-menu-icon">
            <Trash2 size={16} aria-hidden />
          </span>
          <span className="emp-menu-label">Delete option</span>
        </button>
      </PopoverContent>
    </Popover>
  );
}

export function OptionPicker({ databaseId, prop, value, multi, onChange, onDone, autoFocus = true }: OptionPickerProps) {
  const live = useSchemas((s) => s.schemas[databaseId]?.properties.find((p) => p.id === prop.id)) ?? prop;
  const options = optionsOf(live);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoFocus) requestAnimationFrame(() => inputRef.current?.focus());
  }, [autoFocus]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? options.filter((o) => o.name.toLowerCase().includes(s)) : options;
  }, [options, q]);
  const exact = options.some((o) => o.name.toLowerCase() === q.trim().toLowerCase());
  const canCreate = q.trim().length > 0 && !exact;
  const count = filtered.length + (canCreate ? 1 : 0);
  useEffect(() => setHi(0), [q]);

  const toggle = (id: Id) => {
    if (multi) onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
    else {
      onChange(value[0] === id ? [] : [id]);
      onDone?.();
    }
  };
  const create = async () => {
    const name = q.trim();
    if (!name) return;
    const color = nextTagColor(name, options.map((o) => o.color));
    const p = await upsertOption(databaseId, live, { name, color, group: live.type === 'status' ? 'todo' : undefined });
    const created = p ? optionsOf(p).find((o) => o.name === name) : undefined;
    setQ('');
    if (created) toggle(created.id);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHi((h) => Math.min(count - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHi((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (hi < filtered.length) toggle(filtered[hi].id);
      else if (canCreate) void create();
    } else if (e.key === 'Backspace' && !q && multi && value.length) {
      onChange(value.slice(0, -1));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onDone?.();
    }
  };
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${hi}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [hi]);

  const selected = value.map((id) => options.find((o) => o.id === id)).filter((o): o is SelectOption => !!o);
  const groups = live.type === 'status' ? STATUS_GROUPS.map((g) => ({ g, items: filtered.filter((o) => (o.group ?? 'todo') === g.id) })) : [{ g: null, items: filtered }];
  let idx = -1;

  return (
    <div className="edb-picker" onKeyDown={(e) => e.stopPropagation()}>
      <div className="edb-picker-input" onClick={() => inputRef.current?.focus()}>
        {selected.map((o) => (
          <OptionTag key={o.id} opt={o} status={live.type === 'status'} onRemove={() => onChange(value.filter((x) => x !== o.id))} />
        ))}
        <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder={selected.length ? '' : multi ? 'Search or add options' : 'Search or create an option'} aria-label="Search options" />
      </div>
      <div className="edb-picker-list" ref={listRef} role="listbox" aria-multiselectable={multi || undefined}>
        {options.length === 0 && !canCreate ? <div className="edb-picker-empty">Type to create the first option.</div> : null}
        {groups.map(({ g, items }) => (
          <div key={g?.id ?? 'all'}>
            {g ? <div className="emp-menu-header">{g.name}</div> : options.length ? <div className="emp-menu-header">{multi ? 'Select options' : 'Select an option'}</div> : null}
            {items.map((o) => {
              idx += 1;
              const i = idx;
              const on = value.includes(o.id);
              return (
                <div key={o.id} data-idx={i} role="option" aria-selected={on} className={cn('edb-picker-item', i === hi && 'is-hi')} onMouseEnter={() => setHi(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => toggle(o.id)}>
                  <GripVertical size={12} className="edb-grip" aria-hidden />
                  <OptionTag opt={o} status={live.type === 'status'} />
                  <span className="flex-1" />
                  {on ? <Check size={14} className="text-accent-text" aria-hidden /> : null}
                  <OptionEditMenu databaseId={databaseId} prop={live} opt={o} onDeleted={() => onChange(value.filter((x) => x !== o.id))} />
                </div>
              );
            })}
          </div>
        ))}
        {canCreate ? (
          <div data-idx={filtered.length} className={cn('edb-picker-item', hi === filtered.length && 'is-hi')} onMouseEnter={() => setHi(filtered.length)} onMouseDown={(e) => e.preventDefault()} onClick={() => void create()}>
            <Plus size={14} className="text-tertiary" aria-hidden />
            <span className="text-secondary">Create</span>
            <Tag color={nextTagColor(q.trim(), options.map((o) => o.color))}>{q.trim()}</Tag>
          </div>
        ) : null}
      </div>
    </div>
  );
}
