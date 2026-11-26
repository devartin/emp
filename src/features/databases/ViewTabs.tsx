/**
 * Database view tabs (§5.5): underline tabs with a 14px layout icon, rename (double-click / menu), duplicate,
 * delete, drag to reorder, "+" to add a view (layout picker) and an "N more" overflow menu.
 */
import {
  BarChart3, CalendarDays, ChevronDown, Copy, KanbanSquare, LayoutGrid, List, Pencil, Plus, Table2, Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/backend';
import type { DbSchema, Id, Layout, View } from '@/backend/types';
import { cn } from '@/lib/cn';
import { notify } from '@/stores/toasts';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/ui/ContextMenu';
import { IconButton } from '@/ui/IconButton';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from '@/ui/Menu';
import type { IconComponent } from '@/ui/Button';
import { useSchemas } from './store';

export const LAYOUT_ICON: Record<Layout, IconComponent> = {
  table: Table2,
  board: KanbanSquare,
  list: List,
  gallery: LayoutGrid,
  calendar: CalendarDays,
  chart: BarChart3,
};
export const LAYOUT_LABEL: Record<Layout, string> = { table: 'Table', board: 'Board', list: 'List', gallery: 'Gallery', calendar: 'Calendar', chart: 'Chart' };
export const LAYOUT_DESC: Record<Layout, string> = {
  table: 'Rows and columns, spreadsheet-fast',
  board: 'Cards in columns by status',
  list: 'A clean, minimal list',
  gallery: 'Cards with cover images',
  calendar: 'Rows on a month grid',
  chart: 'Bar, line and donut charts',
};
const LAYOUTS: Layout[] = ['table', 'board', 'list', 'gallery', 'calendar', 'chart'];
const MAX_TABS = 6;

export interface ViewTabsProps {
  schema: DbSchema;
  activeId: Id;
  onSelect: (id: Id) => void;
  readOnly?: boolean;
  compact?: boolean;
}

export function ViewTabs({ schema, activeId, onSelect, readOnly, compact }: ViewTabsProps) {
  const dbId = schema.database.id;
  const [renaming, setRenaming] = useState<Id | null>(null);
  const [order, setOrder] = useState<View[]>(schema.views);
  useEffect(() => setOrder(schema.views), [schema.views]);

  // Fit as many tabs as the row allows; the rest collapse into "N more" (§5.5).
  const rootRef = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(800);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth));
    ro.observe(el);
    setAvail(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const est = (v: View) => Math.min(220, 34 + v.name.length * 6.2);
  let fit = 0;
  let used = readOnly ? 8 : 40;
  for (const v of order) {
    const more = fit < order.length - 1 ? 72 : 0;
    if (used + est(v) + more > avail && fit > 0) break;
    used += est(v) + 2;
    fit++;
  }
  fit = Math.max(1, Math.min(fit, MAX_TABS + 4));
  const shown = order.length > fit ? order.slice(0, Math.max(1, fit - 1)) : order;
  const hidden = order.length > fit ? order.slice(Math.max(1, fit - 1)) : [];
  const activeHidden = hidden.some((v) => v.id === activeId);

  const create = async (layout: Layout) => {
    try {
      const v = await api.db.viewCreate({ databaseId: dbId, name: LAYOUT_LABEL[layout], layout });
      const cur = useSchemas.getState().schemas[dbId];
      if (cur) useSchemas.getState().set({ ...cur, views: [...cur.views, v] });
      onSelect(v.id);
    } catch (e) {
      notify.fromError(e, "Couldn't add the view");
    }
  };
  const duplicate = async (v: View) => {
    try {
      const nv = await api.db.viewCreate({ databaseId: dbId, name: `${v.name} copy`, layout: v.layout, fromViewId: v.id });
      const cur = useSchemas.getState().schemas[dbId];
      if (cur) useSchemas.getState().set({ ...cur, views: [...cur.views, nv] });
      onSelect(nv.id);
    } catch (e) {
      notify.fromError(e, "Couldn't duplicate the view");
    }
  };
  const remove = async (v: View) => {
    if (schema.views.length <= 1) return;
    const cur = useSchemas.getState().schemas[dbId];
    const rest = schema.views.filter((x) => x.id !== v.id);
    if (cur) useSchemas.getState().set({ ...cur, views: rest });
    if (activeId === v.id) onSelect(rest[0].id);
    try {
      await api.db.viewDelete({ id: v.id });
      notify.success(`Deleted “${v.name}”`);
    } catch (e) {
      if (cur) useSchemas.getState().set(cur);
      notify.fromError(e, "Couldn't delete the view");
    }
  };
  const rename = async (v: View, name: string) => {
    setRenaming(null);
    const n = name.trim();
    if (!n || n === v.name) return;
    await useSchemas.getState().patchView(dbId, v.id, { name: n });
  };
  const [dragId, setDragId] = useState<Id | null>(null);
  const [dropAt, setDropAt] = useState<{ id: Id; side: 'before' | 'after' } | null>(null);
  const reorder = async (id: Id, targetId: Id, side: 'before' | 'after') => {
    if (id === targetId) return;
    const moving = order.find((v) => v.id === id);
    if (!moving) return;
    const rest = order.filter((v) => v.id !== id);
    const ti = rest.findIndex((v) => v.id === targetId);
    const at = side === 'before' ? ti : ti + 1;
    const next = [...rest.slice(0, at), moving, ...rest.slice(at)];
    setOrder(next);
    const cur = useSchemas.getState().schemas[dbId];
    if (cur) useSchemas.getState().set({ ...cur, views: next });
    try {
      await api.db.viewReorder(side === 'before' ? { id, beforeId: targetId } : { id, afterId: targetId });
    } catch (e) {
      if (cur) useSchemas.getState().set(cur);
      notify.fromError(e, "Couldn't reorder");
    }
  };

  return (
    <div ref={rootRef} className={cn('edb-tabs', compact && 'is-compact')} role="tablist" aria-label="Views">
      <>
        <div className="edb-tabs-list">
          {shown.map((v) => (
            <div
              key={v.id}
              className={cn('edb-tab-wrap', dragId === v.id && 'is-dragging', dropAt?.id === v.id && `drop-${dropAt.side}`)}
              draggable={!readOnly && renaming !== v.id}
              onDragStart={(e) => {
                setDragId(v.id);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', v.name);
              }}
              onDragOver={(e) => {
                if (!dragId || dragId === v.id) return;
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                setDropAt({ id: v.id, side: e.clientX < r.left + r.width / 2 ? 'before' : 'after' });
              }}
              onDragLeave={() => setDropAt((d) => (d?.id === v.id ? null : d))}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId && dropAt) void reorder(dragId, dropAt.id, dropAt.side);
                setDragId(null);
                setDropAt(null);
              }}
              onDragEnd={() => {
                setDragId(null);
                setDropAt(null);
              }}
            >
              <TabButton
                v={v}
                active={v.id === activeId}
                renaming={renaming === v.id}
                readOnly={readOnly}
                compact={compact}
                onSelect={() => onSelect(v.id)}
                onRename={(n) => void rename(v, n)}
                onStartRename={() => !readOnly && setRenaming(v.id)}
                onDuplicate={() => void duplicate(v)}
                onDelete={schema.views.length > 1 ? () => void remove(v) : undefined}
              />
            </div>
          ))}
        </div>
        {hidden.length ? (
          <Menu>
            <MenuTrigger asChild>
              <button type="button" className={cn('emp-tab edb-tab', activeHidden && 'is-active')} data-state={activeHidden ? 'active' : undefined}>
                <span className="emp-tab-hover" />
                {activeHidden ? hidden.find((v) => v.id === activeId)?.name : `${hidden.length} more`}
                <ChevronDown size={12} aria-hidden />
                {activeHidden ? <span className="emp-tab-indicator" /> : null}
              </button>
            </MenuTrigger>
            <MenuContent width={220}>
              {hidden.map((v) => (
                <MenuItem key={v.id} icon={LAYOUT_ICON[v.layout]} onSelect={() => onSelect(v.id)} trailing={v.id === activeId ? '✓' : undefined}>
                  {v.name}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        ) : null}
      </>
      {!readOnly ? (
        <Menu>
          <MenuTrigger asChild>
            <IconButton size="xs" icon={Plus} label="Add a view" className="edb-tab-add" />
          </MenuTrigger>
          <MenuContent width={260}>
            <MenuLabel>New view</MenuLabel>
            {LAYOUTS.map((l) => (
              <MenuItem key={l} icon={LAYOUT_ICON[l]} onSelect={() => void create(l)}>
                <span className="flex flex-col">
                  <span>{LAYOUT_LABEL[l]}</span>
                  <span className="text-caption text-tertiary font-normal">{LAYOUT_DESC[l]}</span>
                </span>
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      ) : null}
    </div>
  );
}

function TabButton({ v, active, renaming, readOnly, compact, onSelect, onRename, onStartRename, onDuplicate, onDelete }: { v: View; active: boolean; renaming: boolean; readOnly?: boolean; compact?: boolean; onSelect: () => void; onRename: (n: string) => void; onStartRename: () => void; onDuplicate: () => void; onDelete?: () => void }) {
  const I = LAYOUT_ICON[v.layout];
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) requestAnimationFrame(() => input.current?.select());
  }, [renaming]);
  const btn = (
    <button type="button" role="tab" aria-selected={active} data-state={active ? 'active' : undefined} className={cn('emp-tab edb-tab', active && 'is-active')} onClick={onSelect} onDoubleClick={onStartRename}>
      <span className="emp-tab-hover" />
      <I aria-hidden />
      {renaming ? (
        <input
          ref={input}
          className="edb-tab-input"
          defaultValue={v.name}
          size={Math.max(4, v.name.length)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') onRename((e.target as HTMLInputElement).value);
            if (e.key === 'Escape') onRename(v.name);
          }}
          onBlur={(e) => onRename(e.target.value)}
          aria-label="View name"
        />
      ) : (
        <span className="truncate">{v.name}</span>
      )}
      {active ? compact ? <span className="emp-tab-indicator" /> : <span className="emp-tab-indicator" /> : null}
    </button>
  );
  if (readOnly) return btn;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{btn}</ContextMenuTrigger>
      <ContextMenuContent width={200}>
        <ContextMenuItem icon={Pencil} onSelect={onStartRename}>
          Rename
        </ContextMenuItem>
        <ContextMenuItem icon={Copy} onSelect={onDuplicate}>
          Duplicate view
        </ContextMenuItem>
        {onDelete ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem icon={Trash2} destructive onSelect={onDelete}>
              Delete view
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

