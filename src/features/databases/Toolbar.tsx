/**
 * View toolbar: filter, sort, group, properties, search within the database, view settings (layout, cards,
 * calendar, open-in), "New ▾" with row templates, and the import / export menu.
 */
import { AnimatePresence, m, Reorder } from 'motion/react';
import {
  ArrowDownUp, ChevronDown, Download, Eye, EyeOff, FileSpreadsheet, GripVertical, Group as GroupIcon,
  LayoutTemplate, ListFilter, MoreHorizontal, PanelRight, Plus, Search, Settings2, SlidersHorizontal, Star, Upload, X,
  Maximize2,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '@/backend';
import type { Layout } from '@/backend/types';
import { navigate } from '@/app/router';
import { cn } from '@/lib/cn';
import { notify } from '@/stores/toasts';
import { Button } from '@/ui/Button';
import { IconButton } from '@/ui/IconButton';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/ui/Menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/Popover';
import { Segmented } from '@/ui/Segmented';
import { Select } from '@/ui/Select';
import { Switch } from '@/ui/Switch';
import { spring } from '@/ui/motion/tokens';
import { useReducedMotionPref } from '@/ui/motion/useReducedEffects';
import { useDbView } from './context';
import { countConditions } from './engine/filter';
import { isDateLike } from './engine/schema';
import { FilterBuilder } from './filter/FilterBuilder';
import { GroupMenu } from './group/GroupMenu';
import { TypeIcon } from './properties/meta';
import { SortMenu } from './sort/SortMenu';
import { ImportDialog } from './ImportDialog';
import { TemplatesDialog } from './TemplatesDialog';
import { LAYOUT_ICON, LAYOUT_LABEL } from './ViewTabs';
import { useController } from './ViewController';
import { RollingNumber } from '@/ui/motion/RollingNumber';
import { PageGlyph } from '@/ui/icons/Icon';

function ToolButton({ icon, label, active, count, children, onClick }: { icon: ReactNode; label: string; active?: boolean; count?: number; children?: ReactNode; onClick?: () => void }) {
  return (
    // idle = a ghost icon button; active = an ink wash with its label and count
    <button
      type="button"
      className={cn('edb-tool', active && 'is-active edb-tool-chip')}
      data-icon-only={active ? undefined : ''}
      aria-pressed={!!active}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      {icon}
      {active ? <span className="edb-tool-label">{children ?? label}</span> : null}
      {count ? (
        <span className="edb-tool-count">
          <RollingNumber value={count} />
        </span>
      ) : null}
    </button>
  );
}

export function FilterButton({ openSignal }: { openSignal: number }) {
  const { schema, view, patchView } = useDbView();
  const [open, setOpen] = useState(false);
  const [local, setLocal] = useState(view.filter);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => setLocal(view.filter), [view.filter]);
  useEffect(() => {
    if (openSignal) setOpen(true);
  }, [openSignal]);
  const n = countConditions(view.filter);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <span>
          <ToolButton icon={<ListFilter size={16} aria-hidden />} label="Filter" active={n > 0} count={n > 1 ? n : undefined}>
            {n === 1 ? 'Filter' : 'Filters'}
          </ToolButton>
        </span>
      </PopoverTrigger>
      <PopoverContent align="end" className="edb-panel edb-filter-panel">
        <FilterBuilder
          schema={schema}
          filter={local}
          onChange={(f) => {
            setLocal(f);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => patchView({ filter: f }), 220);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

function SortButton() {
  const { schema, view, patchView } = useDbView();
  const n = view.sorts.filter((s) => s.prop !== '$manual').length;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <span>
          <ToolButton icon={<ArrowDownUp size={16} aria-hidden />} label="Sort" active={n > 0} count={n > 1 ? n : undefined}>
            {n === 1 ? schema.properties.find((p) => p.id === view.sorts[0]?.prop)?.name ?? 'Sort' : 'Sorts'}
          </ToolButton>
        </span>
      </PopoverTrigger>
      <PopoverContent align="end" className="edb-panel">
        <SortMenu schema={schema} sorts={view.sorts} onChange={(sorts) => patchView({ sorts })} />
      </PopoverContent>
    </Popover>
  );
}

function GroupButton() {
  const { schema, view, patchView, controller } = useDbView();
  const snap = useController(controller);
  const hidden = view.collapsedGroups.filter((k) => k.startsWith('h:')).map((k) => k.slice(2));
  const prop = view.groupBy ? schema.properties.find((p) => p.id === view.groupBy!.prop) : undefined;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <span>
          <ToolButton icon={<GroupIcon size={16} aria-hidden />} label="Group" active={!!prop && view.layout !== 'board'}>
            {prop?.name ?? 'Group'}
          </ToolButton>
        </span>
      </PopoverTrigger>
      <PopoverContent align="end" className="edb-panel">
        <GroupMenu
          schema={schema}
          layout={view.layout}
          groupBy={view.groupBy}
          groups={snap.groups}
          hidden={hidden}
          onChange={(g) => patchView({ groupBy: g })}
          onHidden={(keys) => patchView({ collapsedGroups: [...view.collapsedGroups.filter((k) => !k.startsWith('h:')), ...keys.map((k) => 'h:' + k)] })}
        />
      </PopoverContent>
    </Popover>
  );
}

function PropertiesButton() {
  const { schema, view, patchView } = useDbView();
  const primary = schema.database.primaryPropId;
  const all = schema.properties;
  const [q, setQ] = useState('');
  const shownIds = view.visibleProps.filter((id) => all.some((p) => p.id === id));
  const shown = shownIds.map((id) => all.find((p) => p.id === id)!);
  const hiddenProps = all.filter((p) => !shownIds.includes(p.id));
  const match = (name: string) => !q || name.toLowerCase().includes(q.toLowerCase());
  const setShown = (ids: string[]) => patchView({ visibleProps: view.layout === 'table' && !ids.includes(primary) ? [primary, ...ids] : ids });
  return (
    <Popover>
      <PopoverTrigger asChild>
        <span>
          <ToolButton icon={<SlidersHorizontal size={16} aria-hidden />} label="Properties" />
        </span>
      </PopoverTrigger>
      <PopoverContent align="end" className="edb-panel edb-props-panel">
        <input className="edb-input w-full" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search properties" aria-label="Search properties" />
        <div className="emp-menu-header flex items-center !px-1">
          <span className="flex-1">Shown in {view.layout === 'table' ? 'table' : 'cards'}</span>
          <button type="button" className="edb-link-btn" onClick={() => setShown(view.layout === 'table' ? [primary] : [])}>
            Hide all
          </button>
        </div>
        <Reorder.Group axis="y" values={shownIds} onReorder={setShown} className="edb-props-list">
          {shown.filter((p) => match(p.name)).map((p) => (
            <Reorder.Item key={p.id} value={p.id} className="edb-props-row" transition={spring.layout}>
              <GripVertical size={14} className="edb-grip-handle" aria-hidden />
              <TypeIcon type={p.type} size={14} className="text-tertiary" />
              <span className="flex-1 truncate">{p.name}</span>
              {p.id === primary && view.layout === 'table' ? null : (
                <IconButton size="xs" icon={Eye} label="Hide" onClick={() => setShown(shownIds.filter((x) => x !== p.id))} />
              )}
            </Reorder.Item>
          ))}
        </Reorder.Group>
        {hiddenProps.length ? (
          <>
            <div className="emp-menu-header flex items-center !px-1">
              <span className="flex-1">Hidden</span>
              <button type="button" className="edb-link-btn" onClick={() => setShown([...shownIds, ...hiddenProps.map((p) => p.id)])}>
                Show all
              </button>
            </div>
            {hiddenProps.filter((p) => match(p.name)).map((p) => (
              <div key={p.id} className="edb-props-row is-hidden">
                <span className="w-[14px]" />
                <TypeIcon type={p.type} size={14} className="text-tertiary" />
                <span className="flex-1 truncate text-secondary">{p.name}</span>
                <IconButton size="xs" icon={EyeOff} label="Show" onClick={() => setShown([...shownIds, p.id])} />
              </div>
            ))}
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

const LAYOUTS: Layout[] = ['table', 'board', 'list', 'gallery', 'calendar', 'chart'];

function SettingsButton() {
  const { schema, view, patchView } = useDbView();
  const card = view.card ?? { preview: 'none', size: 'm', fit: false };
  const fileProps = schema.properties.filter((p) => p.type === 'files');
  const dateProps = schema.properties.filter((p) => isDateLike(p));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <span>
          <ToolButton icon={<Settings2 size={16} aria-hidden />} label="View settings" />
        </span>
      </PopoverTrigger>
      <PopoverContent align="end" className="edb-panel edb-settings">
        <div className="emp-menu-header !px-0">Layout</div>
        <div className="edb-layout-grid">
          {LAYOUTS.map((l) => {
            const I = LAYOUT_ICON[l];
            return (
              <button key={l} type="button" className="edb-layout-card" data-on={view.layout === l ? '' : undefined} onClick={() => patchView({ layout: l })}>
                <I size={18} aria-hidden />
                <span>{LAYOUT_LABEL[l]}</span>
              </button>
            );
          })}
        </div>
        {view.layout === 'board' || view.layout === 'gallery' ? (
          <>
            <div className="edb-cfg-row">
              <span className="edb-cfg-label">Card preview</span>
              <div className="edb-cfg-control">
                <Select
                  size="sm"
                  value={card.preview}
                  onValueChange={(v) => patchView({ card: { ...card, preview: v } })}
                  options={[{ value: 'none', label: 'None' }, { value: 'cover', label: 'Page cover' }, { value: 'content', label: 'Page content' }, ...fileProps.map((p) => ({ value: p.id, label: p.name, icon: <TypeIcon type="files" /> }))]}
                />
              </div>
            </div>
            <div className="edb-cfg-row">
              <span className="edb-cfg-label">Card size</span>
              <div className="edb-cfg-control">
                <Segmented size="sm" value={card.size} onValueChange={(v) => patchView({ card: { ...card, size: v } })} options={[{ value: 's', label: 'S' }, { value: 'm', label: 'M' }, { value: 'l', label: 'L' }]} aria-label="Card size" />
              </div>
            </div>
            {card.preview !== 'none' ? <Switch size="sm" label="Fit image" checked={card.fit} onCheckedChange={(fit) => patchView({ card: { ...card, fit } })} /> : null}
          </>
        ) : null}
        {view.layout === 'calendar' ? (
          <>
            <div className="edb-cfg-row">
              <span className="edb-cfg-label">Show by</span>
              <div className="edb-cfg-control">
                <Select size="sm" value={view.calendar?.dateProp ?? null} placeholder="Pick a date property" onValueChange={(v) => patchView({ calendar: { showWeekends: view.calendar?.showWeekends ?? true, dateProp: v } })} options={dateProps.map((p) => ({ value: p.id, label: p.name, icon: <TypeIcon type={p.type} /> }))} />
              </div>
            </div>
            <Switch size="sm" label="Show weekends" checked={view.calendar?.showWeekends ?? true} onCheckedChange={(v) => patchView({ calendar: { dateProp: view.calendar?.dateProp ?? '', showWeekends: v } })} />
          </>
        ) : null}
        <div className="edb-cfg-row">
          <span className="edb-cfg-label">Open rows in</span>
          <div className="edb-cfg-control">
            <Segmented size="sm" value={view.openIn} onValueChange={(v) => patchView({ openIn: v })} options={[{ value: 'side_peek', label: 'Side peek', icon: PanelRight }, { value: 'full_page', label: 'Full page', icon: Maximize2 }]} aria-label="Open rows in" />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * One toolbar key in a FLIP slot (DESIGN §1.6). When the search field opens or closes, the keys left of it glide
 * (transform only) instead of the row relaying out every frame. `layoutDependency` limits measurement to that toggle.
 */
function Slot({ dep, className, children }: { dep: boolean; className?: string; children: ReactNode }) {
  return (
    <m.div className={cn('edb-tool-slot', className)} layout="position" layoutDependency={dep} transition={spring.morph}>
      {children}
    </m.div>
  );
}

// The field keeps its 180px width from the first frame; a clip-path wipe (in px, with a 4px bleed for the focus halo)
// reveals it from the search key's side and folds it back the same way, tracking the keys' glide on the same spring.
const FIELD_W = 180;
const CLIP_SHUT = `inset(-4px -4px -4px ${FIELD_W + 4}px round 11px)`;
const CLIP_OPEN = 'inset(-4px -4px -4px -4px round 11px)';

function SearchBox({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { controller } = useDbView();
  const reduced = useReducedMotionPref();
  const [q, setQ] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const h = setTimeout(() => controller.configure({ override: q.trim() ? { search: q.trim() } : {} }), 180);
    return () => clearTimeout(h);
  }, [q, controller]);
  const shut = reduced ? { opacity: 0 } : { opacity: 0, clipPath: CLIP_SHUT };
  return (
    <>
      <Slot dep={open} className={cn('edb-search', open && 'is-open')}>
        <button
          type="button"
          className="edb-tool"
          data-icon-only=""
          aria-label="Search this database"
          aria-expanded={open}
          title="Search"
          onClick={() => {
            onOpenChange(true);
            requestAnimationFrame(() => ref.current?.focus());
          }}
        >
          <Search size={16} aria-hidden />
        </button>
      </Slot>
      <AnimatePresence initial={false} mode="popLayout">
        {open ? (
          <m.div
            key="field"
            className="edb-search-field"
            initial={shut}
            animate={reduced ? { opacity: 1 } : { opacity: 1, clipPath: CLIP_OPEN }}
            exit={{ ...shut, transition: { clipPath: spring.morph, opacity: { duration: 0.16, delay: 0.08 } } }}
            transition={{ clipPath: spring.morph, opacity: { duration: 0.12 } }}
          >
            <input
              ref={ref}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Type to search…"
              aria-label="Search rows"
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setQ('');
                  onOpenChange(false);
                }
              }}
              onBlur={() => !q && onOpenChange(false)}
            />
            {q ? (
              <button type="button" className="edb-search-clear" aria-label="Clear search" onClick={() => (setQ(''), ref.current?.focus())}>
                <X size={12} aria-hidden />
              </button>
            ) : null}
          </m.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}

function MoreMenu({ onImport }: { onImport: () => void }) {
  const { schema, view, inline, databaseId } = useDbView();
  const exportAs = async (format: 'csv' | 'xlsx') => {
    try {
      const name = `${schema.database.title || 'Database'}${view.name ? ' – ' + view.name : ''}.${format}`;
      const grant = await api.file.saveGrant({ purpose: 'export', suggestedName: name, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
      if (!grant) return;
      const job = await api.db.export({ databaseId, viewId: view.id, format, grantId: grant.grantId });
      const r = await job.result;
      notify.success(`Exported ${r.rows} ${r.rows === 1 ? 'row' : 'rows'}`, { description: name });
    } catch (e) {
      notify.fromError(e, "Couldn't export");
    }
  };
  return (
    <Menu>
      <MenuTrigger asChild>
        <IconButton size="sm" icon={MoreHorizontal} label="More" className="edb-tool-icon" />
      </MenuTrigger>
      <MenuContent align="end" width={240}>
        {inline ? (
          <MenuItem icon={Maximize2} onSelect={() => navigate({ t: 'db', id: databaseId, viewId: view.id })}>
            Open as full page
          </MenuItem>
        ) : null}
        <MenuLabel>Import</MenuLabel>
        <MenuItem icon={Upload} onSelect={onImport}>
          Import CSV or Excel…
        </MenuItem>
        <MenuSeparator />
        <MenuLabel>Export this view</MenuLabel>
        <MenuItem icon={Download} onSelect={() => void exportAs('csv')}>
          Export as CSV
        </MenuItem>
        <MenuItem icon={FileSpreadsheet} onSelect={() => void exportAs('xlsx')}>
          Export as Excel
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function NewButton({ onTemplates }: { onTemplates: () => void }) {
  const { schema, newRow, readOnly } = useDbView();
  const templates = schema.database.templates;
  if (readOnly) return null;
  return (
    <div className="edb-new">
      <Button size="sm" variant="primary" className="edb-new-main" onClick={() => void newRow(undefined, { open: true, templateId: schema.database.defaultTemplateId })} kbd={undefined}>
        New
      </Button>
      <Menu>
        <MenuTrigger asChild>
          <Button size="sm" variant="primary" className="edb-new-more" aria-label="New from template" icon={ChevronDown} />
        </MenuTrigger>
        <MenuContent align="end" width={260}>
          <MenuLabel>Templates</MenuLabel>
          <MenuItem icon={Plus} onSelect={() => void newRow(undefined, { open: true })}>
            Empty row
          </MenuItem>
          {templates.map((t) => (
            <MenuItem key={t.id} icon={t.icon ? <PageGlyph icon={t.icon} context="row" fallback="file" /> : LayoutTemplate} trailing={schema.database.defaultTemplateId === t.id ? <Star size={12} aria-label="Default" /> : undefined} onSelect={() => void newRow(undefined, { open: true, templateId: t.id })}>
              {t.name}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem icon={LayoutTemplate} onSelect={onTemplates}>
            Manage templates…
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}

export function Toolbar({ filterSignal }: { filterSignal: number }) {
  const { view, readOnly } = useDbView();
  const [importOpen, setImportOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  return (
    <div className="edb-toolbar">
      <Slot dep={searchOpen}>
        <FilterButton openSignal={filterSignal} />
      </Slot>
      <Slot dep={searchOpen}>
        <SortButton />
      </Slot>
      {view.layout !== 'calendar' && view.layout !== 'chart' && view.layout !== 'gallery' ? (
        <Slot dep={searchOpen}>
          <GroupButton />
        </Slot>
      ) : null}
      {view.layout !== 'chart' ? (
        <Slot dep={searchOpen}>
          <PropertiesButton />
        </Slot>
      ) : null}
      <SearchBox open={searchOpen} onOpenChange={setSearchOpen} />
      <SettingsButton />
      {!readOnly ? <MoreMenu onImport={() => setImportOpen(true)} /> : null}
      <NewButton onTemplates={() => setTemplatesOpen(true)} />
      {importOpen ? <ImportDialog open onOpenChange={setImportOpen} /> : null}
      {templatesOpen ? <TemplatesDialog open onOpenChange={setTemplatesOpen} /> : null}
    </div>
  );
}

