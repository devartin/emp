/**
 * The shared database surface used by the full page, inline blocks and linked views: view tabs, toolbar, row
 * counts ("142 rows · 37 shown"), and the active layout. Owns the ViewController for the visible view.
 */
import { AnimatePresence, m } from 'motion/react';
import { Database } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, listen } from '@/backend';
import type { CellValue, DbSchema, Id, Property, View } from '@/backend/types';
import { navigate } from '@/app/router';
import { cn } from '@/lib/cn';
import { useUi } from '@/stores/ui';
import { EmptyState } from '@/ui/EmptyState';
import { Skeleton } from '@/ui/Skeleton';
import { ease } from '@/ui/motion/tokens';
import { DbViewContext, type DbViewCtx } from './context';
import { normalizeRoot, defaultCondition } from './filter/FilterBuilder';
import { groupChildren } from './engine/filter';
import { setPeekOrder, useSchema, useSchemas } from './store';
import { Toolbar } from './Toolbar';
import { ViewController } from './ViewController';
import { ViewTabs } from './ViewTabs';
import { BoardView } from './views/BoardView';
import { CalendarView } from './views/CalendarView';
import { ChartView } from './views/ChartView';
import { GalleryView } from './views/GalleryView';
import { ListView } from './views/ListView';
import { TableView } from './views/TableView';
import './databases.css';

export interface DatabaseViewProps {
  databaseId: Id;
  viewId?: Id;
  inline?: boolean;
  readOnly?: boolean;
  /** Rendered above the tabs (full-page title block). */
  header?: (schema: DbSchema, counts: { total: number; shown: number | null }) => ReactNode;
  /** Inline blocks show the database title in the tab row. */
  titleSlot?: (schema: DbSchema) => ReactNode;
  onViewChange?: (viewId: Id) => void;
}

function isGrouped(v: View): boolean {
  if (v.layout === 'board') return true;
  return !!v.groupBy && (v.layout === 'table' || v.layout === 'list');
}

/** Rows in the database regardless of filters (for "142 rows · 37 shown"). */
function useTotalRows(databaseId: Id, enabled: boolean): number | null {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () =>
      api.db
        .query({ databaseId, window: { offset: 0, limit: 0 }, reqId: Date.now() % 1e9 })
        .then((r) => live && 'total' in r && setN(r.total))
        .catch(() => undefined);
    void load();
    const off = listen('db:changed', (e) => e.databaseId === databaseId && void load());
    return () => {
      live = false;
      off();
    };
  }, [databaseId, enabled]);
  return enabled ? n : null;
}

type Bez = [number, number, number, number];
/** Lateral view switch (S21 / §5.4.3 "lateral"): out −16px·sign in 90ms ease-in, in from +16px·sign over 220ms ease-out. */
const switchVariants = {
  enter: (sign: number) => ({ opacity: 0, x: sign * 16 }),
  center: { opacity: 1, x: 0, transition: { duration: 0.22, ease: [...ease.out] as Bez } },
  exit: (sign: number) => ({ opacity: 0, x: sign * -16, transition: { duration: 0.09, ease: [...ease.in] as Bez } }),
};

function Body({ layout }: { layout: View['layout'] }) {
  switch (layout) {
    case 'board':
      return <BoardView />;
    case 'list':
      return <ListView />;
    case 'gallery':
      return <GalleryView />;
    case 'calendar':
      return <CalendarView />;
    case 'chart':
      return <ChartView />;
    default:
      return <TableView />;
  }
}

export function DatabaseView({ databaseId, viewId, inline = false, readOnly = false, header, titleSlot, onViewChange }: DatabaseViewProps) {
  const { schema, error } = useSchema(databaseId);
  const [activeId, setActiveId] = useState<Id | undefined>(viewId);
  useEffect(() => {
    if (viewId) setActiveId(viewId);
  }, [viewId]);
  const view = schema ? (schema.views.find((v) => v.id === activeId) ?? schema.views[0]) : undefined;

  const [controller] = useState(() => new ViewController({ databaseId, viewId: view?.id, grouped: view ? isGrouped(view) : false, collapsed: view?.collapsedGroups }));
  const started = useRef(false);
  useEffect(() => {
    controller.attach();
    return () => controller.dispose();
  }, [controller]);
  const grouped = view ? isGrouped(view) : false;
  const groupKey = view?.groupBy ? JSON.stringify(view.groupBy) : '';
  useEffect(() => {
    if (!view) return;
    if (!started.current) {
      started.current = true;
      controller.configure({ viewId: view.id, grouped, collapsed: view.collapsedGroups });
      controller.start();
      return;
    }
    controller.configure({ viewId: view.id, grouped, collapsed: view.collapsedGroups });
  }, [view?.id, grouped, controller, view?.collapsedGroups.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (started.current && grouped) controller.reset();
  }, [groupKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const [filterSignal, setFilterSignal] = useState(0);
  const select = (id: Id) => {
    setActiveId(id);
    onViewChange?.(id);
  };

  const propsById = useMemo(() => new Map<Id, Property>((schema?.properties ?? []).map((p) => [p.id, p] as const)), [schema?.properties]);
  const patchView = useCallback((patch: Partial<View>) => {
    if (view) void useSchemas.getState().patchView(databaseId, view.id, patch);
  }, [databaseId, view]);

  const openRow = useCallback(
    (rowId: Id, mode?: 'peek' | 'page') => {
      const m0 = mode ?? (view?.openIn === 'full_page' ? 'page' : 'peek');
      if (m0 === 'page') {
        useUi.getState().closePeek();
        navigate({ t: 'row', id: rowId });
        return;
      }
      setPeekOrder(databaseId, controller.orderedIds());
      useUi.getState().openPeek({ t: 'row', id: rowId });
    },
    [view?.openIn, databaseId, controller],
  );

  const newRow = useCallback(
    async (values?: Record<Id, CellValue>, opts: { group?: string; afterId?: Id; open?: boolean; templateId?: Id } = {}) => {
      const row = await controller.createRow({ values, group: opts.group, afterId: opts.afterId, templateId: opts.templateId });
      if (row && opts.open) openRow(row.id);
      return row?.id ?? null;
    },
    [controller, openRow],
  );

  const openFilter = useCallback(
    (propId?: Id) => {
      if (propId && view && schema) {
        const p = schema.properties.find((x) => x.id === propId);
        if (p) {
          const root = normalizeRoot(view.filter);
          const kids = [...groupChildren(root), defaultCondition(p)];
          patchView({ filter: 'or' in root ? { or: kids } : { and: kids } });
        }
      }
      setFilterSignal((n) => n + 1);
    },
    [view, schema, patchView],
  );

  const total = useTotalRows(databaseId, !!view);
  const [shown, setShown] = useState<number | null>(null);
  useEffect(() => {
    const off = controller.subscribe(() => setShown(controller.getSnapshot().ready ? controller.getSnapshot().total : null));
    return () => void off();
  }, [controller]);

  // S21: the view area switches laterally in the direction of the tab move; rows / cards then rise in (16ms, cap 12)
  const viewIndex = schema && view ? schema.views.findIndex((v) => v.id === view.id) : 0;
  const prevIndex = useRef(viewIndex);
  const navSign = viewIndex === prevIndex.current ? 0 : viewIndex > prevIndex.current ? 1 : -1;
  useEffect(() => {
    prevIndex.current = viewIndex;
  }, [viewIndex]);

  if (error && !schema) {
    return (
      <div className="edb-error-state">
        <EmptyState icon={Database} title="This database couldn't be opened" body="It may have been deleted, or it's still loading from the vault." />
      </div>
    );
  }
  if (!schema || !view) {
    return (
      <div className={cn('edb-root', inline && 'is-inline')} aria-busy>
        <div className="flex items-center gap-3 py-2">
          <Skeleton width={90} height={12} />
          <Skeleton width={70} height={12} />
          <Skeleton width={80} height={12} />
        </div>
        <div className="edb-skel-grid">
          {Array.from({ length: inline ? 4 : 8 }, (_, i) => (
            <div key={i} className="edb-skel-row">
              <Skeleton width={180 - (i % 3) * 30} height={10} />
              <Skeleton width={80} height={10} />
              <Skeleton width={60} height={10} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const ctx: DbViewCtx = {
    databaseId,
    schema,
    view,
    controller,
    propsById,
    inline,
    readOnly,
    patchView,
    openRow,
    openFilter,
    newRow,
    editProperty: () => undefined,
  };

  const filtered = !!view.filter;

  return (
    <DbViewContext.Provider value={ctx}>
      <div
        className={cn('edb-root', inline && 'is-inline')}
        data-layout={view.layout}
        onKeyDown={(e) => {
          // ⌥⇧N — new row from anywhere in the database (§8.7); the table grid handles its own keys first.
          if (e.altKey && e.shiftKey && e.code === 'KeyN' && !readOnly && !e.defaultPrevented) {
            e.preventDefault();
            void newRow(undefined, { open: true });
          }
        }}
      >
        {header ? header(schema, { total: total ?? shown ?? 0, shown: filtered ? shown : null }) : null}
        <div className="edb-bar">
          {titleSlot ? titleSlot(schema) : null}
          <ViewTabs schema={schema} activeId={view.id} onSelect={select} readOnly={readOnly} compact={inline} />
          <Toolbar filterSignal={filterSignal} />
        </div>
        <div className="edb-body-host">
          <AnimatePresence mode="wait" initial={false} custom={navSign}>
            <m.div key={view.id + view.layout} className="edb-body" custom={navSign} variants={switchVariants} initial="enter" animate="center" exit="exit">
              <Body layout={view.layout} />
            </m.div>
          </AnimatePresence>
        </div>
        {inline && total !== null ? (
          <div className="edb-inline-foot tabular-nums">
            {total} {total === 1 ? 'row' : 'rows'}
            {filtered && shown !== null ? ` · ${shown} shown` : ''}
          </div>
        ) : null}
      </div>
    </DbViewContext.Provider>
  );
}

export default DatabaseView;
