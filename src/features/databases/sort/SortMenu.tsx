/** Multi-level sorts (§8.5): property + direction per level, reorder, add, delete all. */
import { m, Reorder } from 'motion/react';
import { GripVertical, Plus, Trash2, X } from 'lucide-react';
import type { DbSchema, Sort } from '@/backend/types';
import { IconButton } from '@/ui/IconButton';
import { Segmented } from '@/ui/Segmented';
import { Select } from '@/ui/Select';
import { spring } from '@/ui/motion/tokens';
import { TypeIcon } from '../properties/meta';

export interface SortMenuProps {
  schema: DbSchema;
  sorts: Sort[];
  onChange: (s: Sort[]) => void;
}

export function SortMenu({ schema, sorts, onChange }: SortMenuProps) {
  const options = [
    ...schema.properties.filter((p) => p.type !== 'secret' && p.type !== 'files').map((p) => ({ value: p.id, label: p.name, icon: <TypeIcon type={p.type} /> })),
    { value: '$created', label: 'Created time', icon: <TypeIcon type="created_time" /> },
    { value: '$updated', label: 'Last edited time', icon: <TypeIcon type="updated_time" /> },
  ];
  const unused = options.filter((o) => !sorts.some((s) => s.prop === o.value));
  const keyed = sorts.map((s) => ({ ...s, key: s.prop }));
  return (
    <div className="edb-sort">
      {sorts.length === 0 ? <div className="edb-f-empty">No sorts. Rows follow their manual order; drag to rearrange.</div> : null}
      <Reorder.Group axis="y" values={keyed} onReorder={(next) => onChange(next.map(({ key: _k, ...s }) => s))} className="edb-sort-list">
        {keyed.map((s, i) => (
          <Reorder.Item key={s.key} value={s} className="edb-sort-row" transition={spring.layout} whileDrag={{ scale: 1.02, boxShadow: 'var(--elev-2)' }}>
            <span className="edb-grip-handle" aria-hidden>
              <GripVertical size={14} />
            </span>
            <Select size="sm" searchable value={s.prop} onValueChange={(v) => onChange(sorts.map((x, j) => (j === i ? { ...x, prop: v as Sort['prop'] } : x)))} options={options.filter((o) => o.value === s.prop || !sorts.some((x) => x.prop === o.value))} className="edb-sort-prop" listWidth={240} />
            <Segmented size="sm" value={s.dir} onValueChange={(dir) => onChange(sorts.map((x, j) => (j === i ? { ...x, dir } : x)))} options={[{ value: 'asc', label: 'Ascending' }, { value: 'desc', label: 'Descending' }]} aria-label="Direction" />
            <IconButton size="xs" icon={X} label="Remove sort" onClick={() => onChange(sorts.filter((_, j) => j !== i))} />
          </Reorder.Item>
        ))}
      </Reorder.Group>
      <div className="edb-f-actions">
        {unused.length ? (
          <m.button type="button" className="edb-f-add" onClick={() => onChange([...sorts, { prop: unused[0].value as Sort['prop'], dir: 'asc' }])}>
            <Plus size={14} aria-hidden /> Add sort
          </m.button>
        ) : null}
        {sorts.length ? (
          <button type="button" className="edb-f-add ml-auto" data-destructive="" onClick={() => onChange([])}>
            <Trash2 size={14} aria-hidden /> Delete sorts
          </button>
        ) : null}
      </div>
    </div>
  );
}
