/**
 * Column header menu (§8, Notion-style): rename, change type (with the "This may lose data" warning), sort, filter,
 * group, calculate, wrap, hide, insert left/right, duplicate, delete — and a second page with the property's
 * settings. Also the "+ New property" type picker.
 */
import { AnimatePresence, m } from 'motion/react';
import {
  ArrowDownWideNarrow, ArrowLeft, ArrowLeftToLine, ArrowRightToLine, ArrowUpNarrowWide, ChevronRight, Copy, EyeOff, Filter, Group,
  Settings2, Trash2, WrapText,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as RP from '@radix-ui/react-popover';
import { api, runJob } from '@/backend';
import type { DbSchema, Id, Property, PropType, View } from '@/backend/types';
import { cn } from '@/lib/cn';
import { notify } from '@/stores/toasts';
import { AlertDialog } from '@/ui/AlertDialog';
import { Button } from '@/ui/Button';
import { transitions } from '@/ui/motion/presets';
import { CREATE_ORDER, defaultConfig, isGroupable, TYPE_META } from '../engine/schema';
import { reloadSchema, useSchemas } from '../store';
import { needsSetup, PropertyConfig, savePropConfig } from './PropertyConfig';
import { TypeIcon } from './meta';

/** §8.2 conversions that are supported in place (anything else rebuilds the column empty). */
const CONVERTIBLE: Partial<Record<PropType, PropType[]>> = {
  text: ['select', 'multi_select', 'number', 'status', 'url', 'email', 'phone', 'date', 'checkbox'],
  select: ['text', 'multi_select', 'status'],
  multi_select: ['text', 'select'],
  status: ['select', 'text'],
  number: ['text', 'money'],
  money: ['number', 'text'],
  date: ['text'],
  checkbox: ['text'],
  url: ['text'],
  email: ['text'],
  phone: ['text'],
};

function MenuBtn({ icon, children, onClick, destructive, trailing, disabled }: { icon?: ReactNode; children: ReactNode; onClick?: () => void; destructive?: boolean; trailing?: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" className="emp-menu-item w-full" data-destructive={destructive ? '' : undefined} data-disabled={disabled ? '' : undefined} disabled={disabled} onClick={onClick}>
      {icon ? <span className="emp-menu-icon">{icon}</span> : null}
      <span className="emp-menu-label text-left">{children}</span>
      {trailing ? <span className="emp-menu-trail">{trailing}</span> : null}
    </button>
  );
}

export interface PropertyMenuProps {
  schema: DbSchema;
  view: View;
  prop: Property;
  anchor: HTMLElement | DOMRect | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  patchView: (p: Partial<View>) => void;
  openFilter?: (propId: Id) => void;
  startPage?: 'menu' | 'edit';
  readOnly?: boolean;
}

export function PropertyMenu({ schema, view, prop: propIn, anchor, open, onOpenChange, patchView, openFilter, startPage = 'menu', readOnly }: PropertyMenuProps) {
  const prop = schema.properties.find((p) => p.id === propIn.id) ?? propIn;
  const [page, setPage] = useState<'menu' | 'edit' | 'type'>(startPage);
  const [name, setName] = useState(prop.name);
  const [confirm, setConfirm] = useState<null | 'delete' | { to: PropType }>(null);
  const [busy, setBusy] = useState(false);
  const dbId = schema.database.id;
  const isTitle = prop.type === 'title';
  useEffect(() => {
    if (open) {
      setPage(startPage);
      setName(prop.name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prop.id]);

  const rename = async () => {
    const n = name.trim();
    if (!n || n === prop.name) return;
    useSchemas.getState().patchProp(dbId, prop.id, { name: n });
    try {
      await api.db.propertyUpdate({ id: prop.id, patch: { name: n } });
    } catch (e) {
      useSchemas.getState().patchProp(dbId, prop.id, { name: prop.name });
      setName(prop.name);
      notify.fromError(e, "Couldn't rename");
    }
  };
  const sort = (dir: 'asc' | 'desc') => {
    patchView({ sorts: [{ prop: prop.id, dir }, ...view.sorts.filter((s) => s.prop !== prop.id)] });
    onOpenChange(false);
  };
  const hide = () => {
    patchView({ visibleProps: view.visibleProps.filter((id) => id !== prop.id) });
    onOpenChange(false);
  };
  const insert = async (side: 'left' | 'right') => {
    onOpenChange(false);
    try {
      const order = schema.properties;
      const i = order.findIndex((p) => p.id === prop.id);
      const afterId = side === 'right' ? prop.id : order[i - 1]?.id;
      const p = await api.db.propertyCreate({ databaseId: dbId, name: 'Property', type: 'text', ...(afterId ? { afterId } : {}) });
      const vis = [...view.visibleProps];
      const vi = vis.indexOf(prop.id);
      vis.splice(side === 'right' ? vi + 1 : Math.max(0, vi), 0, p.id);
      patchView({ visibleProps: vis });
      await reloadSchema(dbId);
    } catch (e) {
      notify.fromError(e, "Couldn't add the property");
    }
  };
  const duplicate = async () => {
    onOpenChange(false);
    try {
      const cfg = { ...prop.config };
      if (prop.type === 'relation') cfg.twoWay = false;
      const p = await api.db.propertyCreate({ databaseId: dbId, name: `${prop.name} copy`, type: prop.type, config: cfg, afterId: prop.id });
      const vis = [...view.visibleProps];
      vis.splice(vis.indexOf(prop.id) + 1, 0, p.id);
      patchView({ visibleProps: vis });
      await reloadSchema(dbId);
    } catch (e) {
      notify.fromError(e, "Couldn't duplicate the property");
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api.db.propertyDelete({ id: prop.id });
      await reloadSchema(dbId);
      notify.success(`Deleted “${prop.name}”`);
      onOpenChange(false);
    } catch (e) {
      notify.fromError(e, "Couldn't delete the property");
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };
  const convert = async (to: PropType) => {
    setBusy(true);
    try {
      await runJob(api.db.propertyConvert(to === 'select' || to === 'multi_select' || to === 'status' ? { id: prop.id, to } : { id: prop.id, to, config: defaultConfig(to) }));
      await reloadSchema(dbId);
      notify.success(`Changed “${prop.name}” to ${TYPE_META[to].label}`);
      setPage('edit');
    } catch (e) {
      notify.fromError(e, "Couldn't change the type");
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const anchorRef = useMemo(() => {
    if (!anchor) return null;
    const get = () => (anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor);
    return { current: { getBoundingClientRect: get } };
  }, [anchor]);
  const sorted = view.sorts.find((s) => s.prop === prop.id);
  const types = CREATE_ORDER.filter((t) => t !== prop.type);
  const lossless = CONVERTIBLE[prop.type] ?? [];

  return (
    <>
      <RP.Root open={open} onOpenChange={onOpenChange}>
        {anchorRef ? <RP.Anchor virtualRef={anchorRef as never} /> : null}
        <RP.Portal>
          <RP.Content side="bottom" align="start" sideOffset={4} collisionPadding={8} className="emp-popover emp-pop edb-prop-menu" style={{ zIndex: 70 }} onOpenAutoFocus={(e) => e.preventDefault()}>
            <AnimatePresence mode="wait" initial={false}>
              {page === 'menu' ? (
                <m.div key="menu" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0, transition: transitions.menuIn }} exit={{ opacity: 0, x: -8, transition: transitions.menuOut }}>
                  <div className="edb-prop-head">
                    <span className="edb-prop-head-icon">
                      <TypeIcon type={prop.type} size={16} />
                    </span>
                    <input
                      className="edb-input flex-1"
                      value={name}
                      autoFocus
                      disabled={readOnly}
                      onChange={(e) => setName(e.target.value)}
                      onBlur={() => void rename()}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') {
                          void rename();
                          onOpenChange(false);
                        }
                      }}
                      aria-label="Property name"
                    />
                  </div>
                  {!readOnly ? (
                    <>
                      <MenuBtn icon={<Settings2 size={16} />} onClick={() => setPage('edit')} trailing={<ChevronRight size={14} />}>
                        Edit property
                      </MenuBtn>
                      {!isTitle ? (
                        <MenuBtn icon={<TypeIcon type={prop.type} size={16} />} onClick={() => setPage('type')} trailing={<><span>{TYPE_META[prop.type].label}</span><ChevronRight size={14} /></>}>
                          Type
                        </MenuBtn>
                      ) : null}
                      <div className="emp-menu-sep" />
                    </>
                  ) : null}
                  <MenuBtn icon={<ArrowUpNarrowWide size={16} />} onClick={() => sort('asc')} trailing={sorted?.dir === 'asc' ? '✓' : undefined}>
                    Sort ascending
                  </MenuBtn>
                  <MenuBtn icon={<ArrowDownWideNarrow size={16} />} onClick={() => sort('desc')} trailing={sorted?.dir === 'desc' ? '✓' : undefined}>
                    Sort descending
                  </MenuBtn>
                  {openFilter ? (
                    <MenuBtn
                      icon={<Filter size={16} />}
                      onClick={() => {
                        onOpenChange(false);
                        openFilter(prop.id);
                      }}
                    >
                      Filter
                    </MenuBtn>
                  ) : null}
                  {isGroupable(prop) && view.layout !== 'calendar' && view.layout !== 'chart' && view.layout !== 'gallery' ? (
                    <MenuBtn
                      icon={<Group size={16} />}
                      onClick={() => {
                        patchView({ groupBy: view.groupBy?.prop === prop.id ? undefined : { prop: prop.id } });
                        onOpenChange(false);
                      }}
                      trailing={view.groupBy?.prop === prop.id ? '✓' : undefined}
                    >
                      Group by {prop.name}
                    </MenuBtn>
                  ) : null}
                  {view.layout === 'table' ? (
                    <MenuBtn icon={<WrapText size={16} />} onClick={() => patchView({ wrap: { ...view.wrap, [prop.id]: !view.wrap[prop.id] } })} trailing={view.wrap[prop.id] ? '✓' : undefined}>
                      Wrap text
                    </MenuBtn>
                  ) : null}
                  {!isTitle ? (
                    <MenuBtn icon={<EyeOff size={16} />} onClick={hide}>
                      Hide in view
                    </MenuBtn>
                  ) : null}
                  {!readOnly ? (
                    <>
                      <div className="emp-menu-sep" />
                      {view.layout === 'table' ? (
                        <>
                          <MenuBtn icon={<ArrowLeftToLine size={16} />} onClick={() => void insert('left')}>
                            Insert left
                          </MenuBtn>
                          <MenuBtn icon={<ArrowRightToLine size={16} />} onClick={() => void insert('right')}>
                            Insert right
                          </MenuBtn>
                        </>
                      ) : null}
                      {!isTitle ? (
                        <>
                          <MenuBtn icon={<Copy size={16} />} onClick={() => void duplicate()}>
                            Duplicate property
                          </MenuBtn>
                          <MenuBtn icon={<Trash2 size={16} />} destructive onClick={() => setConfirm('delete')}>
                            Delete property
                          </MenuBtn>
                        </>
                      ) : null}
                    </>
                  ) : null}
                </m.div>
              ) : page === 'edit' ? (
                <m.div key="edit" className="edb-prop-edit" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0, transition: transitions.menuIn }} exit={{ opacity: 0, x: 8, transition: transitions.menuOut }}>
                  <div className="edb-prop-back">
                    <button type="button" className="edb-back" onClick={() => setPage('menu')} aria-label="Back">
                      <ArrowLeft size={14} aria-hidden />
                    </button>
                    <span className="font-medium">Edit property</span>
                  </div>
                  <div className="edb-prop-head">
                    <span className="edb-prop-head-icon">
                      <TypeIcon type={prop.type} size={16} />
                    </span>
                    <input className="edb-input flex-1" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => void rename()} onKeyDown={(e) => (e.stopPropagation(), e.key === 'Enter' && void rename())} aria-label="Property name" />
                  </div>
                  <textarea
                    className="edb-input edb-desc"
                    defaultValue={prop.description ?? ''}
                    placeholder="Add a description…"
                    rows={2}
                    onKeyDown={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      const d = e.target.value.trim();
                      if (d !== (prop.description ?? '')) void api.db.propertyUpdate({ id: prop.id, patch: { description: d } }).then((p) => useSchemas.getState().patchProp(dbId, prop.id, p)).catch((err) => notify.fromError(err, "Couldn't save"));
                    }}
                    aria-label="Description"
                  />
                  <div className="edb-cfg">
                    <PropertyConfig schema={schema} prop={prop} onConfig={(patch) => void savePropConfig(schema, prop, patch)} />
                  </div>
                </m.div>
              ) : (
                <m.div key="type" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0, transition: transitions.menuIn }} exit={{ opacity: 0, x: 8, transition: transitions.menuOut }}>
                  <div className="edb-prop-back">
                    <button type="button" className="edb-back" onClick={() => setPage('menu')} aria-label="Back">
                      <ArrowLeft size={14} aria-hidden />
                    </button>
                    <span className="font-medium">Change type</span>
                  </div>
                  <div className="edb-type-list">
                    {types.map((t) => (
                      <MenuBtn key={t} icon={<TypeIcon type={t} size={16} />} onClick={() => setConfirm({ to: t })} trailing={lossless.includes(t) ? <span className="text-tertiary">keeps values</span> : undefined}>
                        {TYPE_META[t].label}
                      </MenuBtn>
                    ))}
                  </div>
                </m.div>
              )}
            </AnimatePresence>
          </RP.Content>
        </RP.Portal>
      </RP.Root>
      <AlertDialog
        open={confirm === 'delete'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Delete “${prop.name}”?`}
        description="The property and its values are removed from every view. You can restore it from Trash."
        tone="danger"
        confirmLabel={busy ? 'Deleting…' : 'Delete property'}
        onConfirm={() => remove()}
      />
      <AlertDialog
        open={!!confirm && confirm !== 'delete'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm && confirm !== 'delete' ? `Change to ${TYPE_META[confirm.to].label}?` : ''}
        description="This may lose data. A schema version is saved first, so you can restore it from history."
        tone="warning"
        confirmLabel={busy ? 'Converting…' : 'Change type'}
        onConfirm={() => confirm && confirm !== 'delete' && convert(confirm.to)}
      />
    </>
  );
}

// ───────────────────────────────────────────────────────────────────────────── new property

export interface AddPropertyProps {
  schema: DbSchema;
  view: View;
  patchView: (p: Partial<View>) => void;
  anchor: HTMLElement | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated?: (p: Property) => void;
}

export function AddPropertyMenu({ schema, view, patchView, anchor, open, onOpenChange, onCreated }: AddPropertyProps) {
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState<Property | null>(null);
  const [busy, setBusy] = useState(false);
  const [hi, setHi] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setQ('');
      setDraft(null);
      setHi(0);
    }
  }, [open]);
  const list = CREATE_ORDER.filter((t) => !q || TYPE_META[t].label.toLowerCase().includes(q.toLowerCase()));
  const create = async (type: PropType, config?: Record<string, unknown>, name?: string) => {
    setBusy(true);
    try {
      const p = await api.db.propertyCreate({ databaseId: schema.database.id, name: name ?? TYPE_META[type].label, type, config: config ?? defaultConfig(type) });
      patchView({ visibleProps: [...view.visibleProps.filter((id) => id !== p.id), p.id] });
      await reloadSchema(schema.database.id);
      onOpenChange(false);
      onCreated?.(p);
    } catch (e) {
      notify.fromError(e, "Couldn't add the property");
    } finally {
      setBusy(false);
    }
  };
  const pick = (type: PropType) => {
    if (needsSetup(type)) {
      setDraft({ id: '__draft', name: TYPE_META[type].label, type, config: { ...defaultConfig(type), ...(type === 'relation' ? { twoWay: true } : {}) }, hidden: false, sortKey: '' });
    } else void create(type);
  };
  const anchorRef = useMemo(() => (anchor ? { current: anchor } : null), [anchor]);
  const ready = draft ? (draft.type === 'relation' ? !!draft.config.targetDatabaseId : draft.type === 'rollup' ? !!draft.config.relationPropId : true) : false;
  return (
    <RP.Root open={open} onOpenChange={onOpenChange}>
      {anchorRef ? <RP.Anchor virtualRef={anchorRef as never} /> : null}
      <RP.Portal>
        <RP.Content side="bottom" align="end" sideOffset={4} collisionPadding={8} className="emp-popover emp-pop edb-prop-menu" style={{ zIndex: 70 }} onOpenAutoFocus={(e) => (e.preventDefault(), inputRef.current?.focus())}>
          {draft ? (
            <div className="edb-prop-edit">
              <div className="edb-prop-back">
                <button type="button" className="edb-back" onClick={() => setDraft(null)} aria-label="Back">
                  <ArrowLeft size={14} aria-hidden />
                </button>
                <span className="font-medium">New {TYPE_META[draft.type].label.toLowerCase()}</span>
              </div>
              <div className="edb-prop-head">
                <span className="edb-prop-head-icon">
                  <TypeIcon type={draft.type} size={16} />
                </span>
                <input className="edb-input flex-1" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label="Property name" onKeyDown={(e) => e.stopPropagation()} />
              </div>
              <div className="edb-cfg">
                <PropertyConfig schema={schema} prop={draft} draft onConfig={(patch) => setDraft((d) => (d ? { ...d, config: { ...d.config, ...patch } } : d))} />
              </div>
              <Button variant="primary" size="sm" block loading={busy} disabled={!ready} onClick={() => void create(draft.type, draft.config, draft.name.trim() || TYPE_META[draft.type].label)}>
                Create property
              </Button>
            </div>
          ) : (
            <>
              <input
                ref={inputRef}
                className="edb-input mb-1 w-full"
                value={q}
                onChange={(e) => (setQ(e.target.value), setHi(0))}
                placeholder="Search for a property type"
                aria-label="Search types"
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'ArrowDown') (e.preventDefault(), setHi((h) => Math.min(list.length - 1, h + 1)));
                  else if (e.key === 'ArrowUp') (e.preventDefault(), setHi((h) => Math.max(0, h - 1)));
                  else if (e.key === 'Enter' && list[hi]) pick(list[hi]);
                }}
              />
              <div className="emp-menu-header">Type</div>
              <div className="edb-type-list">
                {list.map((t, i) => (
                  <button key={t} type="button" className={cn('emp-menu-item w-full edb-type-item', i === hi && 'is-hi')} onMouseEnter={() => setHi(i)} onClick={() => pick(t)} disabled={busy}>
                    <span className="emp-menu-icon">
                      <TypeIcon type={t} size={16} />
                    </span>
                    <span className="emp-menu-label text-left">
                      {TYPE_META[t].label}
                      <span className="edb-type-desc">{TYPE_META[t].description}</span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </RP.Content>
      </RP.Portal>
    </RP.Root>
  );
}
