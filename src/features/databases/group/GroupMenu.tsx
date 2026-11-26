/** Group-by settings (§8.5): property, date bucket, status by group/option, hide empty groups, per-group visibility. */
import { Eye, EyeOff, X } from 'lucide-react';
import type { DbQueryGroup, DbSchema, GroupBy, Layout } from '@/backend/types';
import { Button } from '@/ui/Button';
import { Segmented } from '@/ui/Segmented';
import { Select } from '@/ui/Select';
import { Switch } from '@/ui/Switch';
import { Tag } from '@/ui/Tag';
import { isBoardGroupable, isDateLike, isGroupable } from '../engine/schema';
import { TypeIcon } from '../properties/meta';

export interface GroupMenuProps {
  schema: DbSchema;
  layout: Layout;
  groupBy: GroupBy | undefined;
  groups: DbQueryGroup[] | null;
  hidden: string[];
  onChange: (g: GroupBy | undefined) => void;
  onHidden: (keys: string[]) => void;
}

export function GroupMenu({ schema, layout, groupBy, groups, hidden, onChange, onHidden }: GroupMenuProps) {
  const candidates = schema.properties.filter((p) => (layout === 'board' ? isBoardGroupable(p) : isGroupable(p)));
  const prop = groupBy ? schema.properties.find((p) => p.id === groupBy.prop) : undefined;
  return (
    <div className="edb-group">
      <div className="edb-cfg-row">
        <span className="edb-cfg-label">Group by</span>
        <div className="edb-cfg-control">
          <Select
            size="sm"
            searchable
            placeholder="None"
            value={groupBy?.prop ?? null}
            onValueChange={(v) => onChange({ prop: v })}
            options={candidates.map((p) => ({ value: p.id, label: p.name, icon: <TypeIcon type={p.type} /> }))}
          />
        </div>
      </div>
      {prop && isDateLike(prop) ? (
        <div className="edb-cfg-row">
          <span className="edb-cfg-label">Date by</span>
          <div className="edb-cfg-control">
            <Select size="sm" value={groupBy?.dateBucket ?? 'relative'} onValueChange={(v) => onChange({ ...groupBy!, dateBucket: v })} options={[{ value: 'relative', label: 'Relative' }, { value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'year', label: 'Year' }]} />
          </div>
        </div>
      ) : null}
      {prop?.type === 'status' ? (
        <div className="edb-cfg-row">
          <span className="edb-cfg-label">Show</span>
          <div className="edb-cfg-control">
            <Segmented size="sm" value={groupBy?.byStatusGroup ? 'group' : 'option'} onValueChange={(v) => onChange({ ...groupBy!, byStatusGroup: v === 'group' })} options={[{ value: 'option', label: 'Options' }, { value: 'group', label: 'Groups' }]} aria-label="Group status by" />
          </div>
        </div>
      ) : null}
      {groupBy ? <Switch size="sm" label="Hide empty groups" checked={!!groupBy.hideEmpty} onCheckedChange={(v) => onChange({ ...groupBy, hideEmpty: v })} /> : null}
      {groupBy && groups?.length ? (
        <div className="edb-group-list">
          <div className="emp-menu-header !px-0 flex items-center">
            <span className="flex-1">Groups</span>
            <button type="button" className="edb-link-btn" onClick={() => onHidden(hidden.length ? [] : groups.map((g) => g.key))}>
              {hidden.length ? 'Show all' : 'Hide all'}
            </button>
          </div>
          {groups.map((g) => {
            const off = hidden.includes(g.key);
            return (
              <button key={g.key} type="button" className="emp-menu-item w-full" onClick={() => onHidden(off ? hidden.filter((k) => k !== g.key) : [...hidden, g.key])}>
                <span className="emp-menu-label text-left">{g.color ? <Tag color={g.color}>{g.label}</Tag> : g.label}</span>
                <span className="emp-menu-trail tabular-nums">{g.count}</span>
                <span className="emp-menu-icon">{off ? <EyeOff size={14} /> : <Eye size={14} />}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {groupBy && layout !== 'board' ? (
        <Button size="sm" variant="ghost" icon={X} onClick={() => onChange(undefined)}>
          Remove grouping
        </Button>
      ) : null}
      {!candidates.length ? <div className="edb-hint">{layout === 'board' ? 'Boards group by select, status or checkbox. Add one of those properties first.' : 'No groupable properties yet.'}</div> : null}
    </div>
  );
}
