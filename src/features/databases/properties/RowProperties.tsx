/**
 * The properties block at the top of a row page (§8.6) — also used by the template editor. Each property is a
 * label + value; clicking the value opens its editor. "Hide empty properties" is a per-database setting.
 */
import { AnimatePresence, m } from 'motion/react';
import { ChevronDown, Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { api } from '@/backend';
import type { CellValue, DbSchema, Id, Property, RowDTO, View } from '@/backend/types';
import { cn } from '@/lib/cn';
import { notify } from '@/stores/toasts';
import { transitions } from '@/ui/motion/presets';
import { cellFor } from '../engine/filter';
import { isEmptyCell, isReadOnlyType } from '../engine/values';
import { reloadSchema, useSchemas } from '../store';
import { CellEditor, CellEditorPopover, editorKind } from './CellEditor';
import { CellView } from './CellView';
import { TypeIcon } from './meta';
import { AddPropertyMenu, PropertyMenu } from './PropertyMenu';

export interface RowPropertiesProps {
  schema: DbSchema;
  row: RowDTO | null;
  values: Record<Id, CellValue>;
  onChange: (propId: Id, v: CellValue | null) => void;
  readOnly?: boolean;
  /** Template mode: computed properties are hidden, nothing is "empty". */
  template?: boolean;
}

const dummyView = (schema: DbSchema): View => schema.views[0] ?? ({ id: '', name: '', layout: 'table', sorts: [], visibleProps: [], propWidths: {}, wrap: {}, footerAggs: {}, collapsedGroups: [], openIn: 'side_peek', sortKey: '' } as View);

export function RowProperties({ schema, row, values, onChange, readOnly, template }: RowPropertiesProps) {
  const [editing, setEditing] = useState<{ prop: Property; rect: DOMRect } | null>(null);
  const [menu, setMenu] = useState<{ prop: Property; el: HTMLElement } | null>(null);
  const [adding, setAdding] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const [showHidden, setShowHidden] = useState(false);
  const hideEmpty = schema.database.hideEmptyProps && !template;
  const props = schema.properties.filter((p) => p.id !== schema.database.primaryPropId && (!template || !isReadOnlyType(p.type)));
  const cellOf = (p: Property) => (row ? cellFor({ ...row, values }, p.type === 'created_time' ? '$created' : p.type === 'updated_time' ? '$updated' : p.id) : values[p.id]);
  const visible = props.filter((p) => !p.hidden && (!hideEmpty || showHidden || !isEmptyCell(cellOf(p)) || p.type === 'checkbox'));
  const hiddenCount = props.length - visible.length;

  const open = (p: Property, el: HTMLElement) => {
    if (readOnly || isReadOnlyType(p.type)) return;
    if (p.type === 'checkbox') {
      const c = cellOf(p);
      onChange(p.id, { t: 'check', v: !(c?.t === 'check' && c.v) });
      return;
    }
    if (editorKind(p) === 'none') return;
    setEditing({ prop: p, rect: el.getBoundingClientRect() });
  };

  const toggleHideEmpty = async () => {
    try {
      const s = await api.db.update({ id: schema.database.id, patch: { hideEmptyProps: !schema.database.hideEmptyProps } });
      useSchemas.getState().set(s);
    } catch (e) {
      notify.fromError(e, "Couldn't update");
    }
  };

  return (
    <div className="edb-rowprops">
      <AnimatePresence initial={false}>
        {visible.map((p) => {
          const c = cellOf(p);
          const ro = readOnly || isReadOnlyType(p.type);
          return (
            <m.div key={p.id} className="edb-rowprop" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: transitions.crossfade }} exit={{ opacity: 0, transition: transitions.menuOut }}>
              <button type="button" className="edb-rowprop-label" onClick={(e) => !template && setMenu({ prop: p, el: e.currentTarget })} title={p.description || p.name}>
                <TypeIcon type={p.type} size={14} />
                <span className="truncate">{p.name}</span>
              </button>
              <div
                className={cn('edb-rowprop-value', ro && 'is-ro', isEmptyCell(c) && p.type !== 'checkbox' && p.type !== 'rating' && 'is-empty')}
                role={ro ? undefined : 'button'}
                tabIndex={ro ? -1 : 0}
                onClick={(e) => open(p, e.currentTarget)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    open(p, e.currentTarget);
                  }
                }}
              >
                {isEmptyCell(c) && p.type !== 'checkbox' && p.type !== 'rating' ? (
                  <span className="edb-empty-hint">{ro ? '—' : 'Empty'}</span>
                ) : (
                  <CellView prop={p} cell={c} variant="page" wrap onChange={ro ? undefined : (v) => onChange(p.id, v)} readOnly={ro} />
                )}
              </div>
            </m.div>
          );
        })}
      </AnimatePresence>
      <div className="edb-rowprops-foot">
        {hideEmpty && hiddenCount > 0 ? (
          <button type="button" className="edb-f-add" onClick={() => setShowHidden((s) => !s)}>
            <ChevronDown size={14} className={cn('transition-transform', showHidden && 'rotate-180')} aria-hidden />
            {showHidden ? 'Hide empty properties' : `${hiddenCount} empty ${hiddenCount === 1 ? 'property' : 'properties'}`}
          </button>
        ) : null}
        {!readOnly && !template ? (
          <>
            <button ref={addRef} type="button" className="edb-f-add" onClick={() => setAdding(true)}>
              <Plus size={14} aria-hidden /> Add a property
            </button>
            <button type="button" className="edb-f-add ml-auto" onClick={() => void toggleHideEmpty()}>
              {schema.database.hideEmptyProps ? 'Show empty properties' : 'Hide empty properties'}
            </button>
          </>
        ) : null}
      </div>
      {editing ? (
        <CellEditorPopover anchor={editing.rect} overlay={editorKind(editing.prop) === 'overlay'} width={Math.max(editing.rect.width, editorKind(editing.prop) === 'overlay' ? 280 : 0)} onOutside={() => setEditing(null)}>
          <CellEditor
            databaseId={schema.database.id}
            prop={editing.prop}
            row={row}
            cell={cellOf(editing.prop)}
            onCommit={(v) => onChange(editing.prop.id, v)}
            onClose={() => setEditing(null)}
          />
        </CellEditorPopover>
      ) : null}
      {menu ? (
        <PropertyMenu
          schema={schema}
          view={dummyView(schema)}
          prop={menu.prop}
          anchor={menu.el}
          open
          onOpenChange={(o) => !o && setMenu(null)}
          patchView={(patch) => schema.views[0] && void useSchemas.getState().patchView(schema.database.id, schema.views[0].id, patch)}
          startPage="edit"
          readOnly={readOnly}
        />
      ) : null}
      {adding ? (
        <AddPropertyMenu
          schema={schema}
          view={dummyView(schema)}
          anchor={addRef.current}
          open
          onOpenChange={(o) => !o && setAdding(false)}
          patchView={(patch) => {
            for (const v of schema.views) if (v.layout === 'table' && patch.visibleProps) void useSchemas.getState().patchView(schema.database.id, v.id, { visibleProps: [...v.visibleProps, ...patch.visibleProps.filter((id) => !v.visibleProps.includes(id))] });
          }}
          onCreated={() => void reloadSchema(schema.database.id)}
        />
      ) : null}
    </div>
  );
}
