/**
 * One sidebar section's page tree (§5.8, §13.1; brief §2.1): virtualised rows (@tanstack/react-virtual, overscan 8)
 * inside the sidebar's shared scroll container, `role="tree"` with roving focus — arrows navigate, → / ← expand/
 * collapse, Enter opens, ⇧Enter opens in the side peek, F2 renames, Delete moves to Trash (with an Undo toast). Drag
 * to reorder or nest (useTreeDrag), double-click to rename inline, right-click for the page menu.
 *
 * The rows come from `selectSectionRows`: the section's top-level pages, then their children whatever their kind.
 * An installed app's hub is one leaf row that opens the app; its generated pages never list.
 */
import { observeElementRect, useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, Ellipsis, Plus } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { navigate, routePageId, useRoute, type AppRoute } from "@/app/router";
import { preloadRoute } from "@/app/routes";
import type { Id, PageMeta } from "@/backend/types";
import { isProject, MAX_INDENT_LEVELS, selectSectionRows, useTree, type AppIndex, type SidebarSection, type TreeRow } from "@/stores/tree";
import { useUi } from "@/stores/ui";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/ui/ContextMenu";
import { Menu, MenuContent, MenuTrigger } from "@/ui/Menu";
import { Tooltip } from "@/ui/Tooltip";
import { useRootAttr } from "@/ui/motion/useReducedEffects";
import { PageIcon } from "../PageIcon";
import { PageContextItems, PageMenuItems, pageActions, routeForPage, type PageAction } from "../PageMenu";
import { hubActions } from "./hubActions";
import { lifeAppIdentity } from "./lifeAppIdentity";
import { type DragState, type useTreeDrag } from "./useTreeDrag";

const INDENT = 12;

const heightOnlyRect: typeof observeElementRect<HTMLElement> = (instance, cb) => {
  let h = -1;
  return observeElementRect(instance, (rect) => {
    if (Math.abs(rect.height - h) < 0.5) return;
    h = rect.height;
    cb(rect);
  });
};

/** Where a row opens: an app hub opens its app; any other page opens as a page (dispatched by kind). */
export function routeForRow(row: Pick<TreeRow, "meta" | "hub">): AppRoute {
  return row.hub ? { t: "app", instanceId: row.hub.instanceId } : routeForPage(row.meta);
}

function rowActions(row: TreeRow, onRename: () => void): PageAction[] {
  return row.hub ? hubActions(row.meta, row.hub) : pageActions(row.meta, { onRename });
}

export interface PageTreeProps {
  section: SidebarSection;
  /** Accessible name of the tree (the section title). */
  label: string;
  apps: AppIndex;
  scrollEl: () => HTMLElement | null;
  drag: ReturnType<typeof useTreeDrag>;
  /** Rename request from outside (e.g. after creating a page). */
  renameId?: Id | null;
  onRenameDone?: () => void;
}

export function PageTree({ section, label, apps, scrollEl, renameId, onRenameDone, drag }: PageTreeProps) {
  const rows = useTree((s) => selectSectionRows(s, section, apps));
  const density = useRootAttr("data-density");
  const rowH = density === "compact" ? 24 : 28;
  const route = useRoute();
  const currentId = route.t === "app" ? ([...apps.hubs].find(([, h]) => h.instanceId === route.instanceId)?.[0] ?? null) : routePageId(route);
  const listRef = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);
  const [focusId, setFocusId] = useState<Id | null>(null);
  const [renaming, setRenaming] = useState<Id | null>(null);
  const [ctxId, setCtxId] = useState<Id | null>(null);
  const fresh = useFreshRows(rows);

  useEffect(() => {
    if (renameId) setRenaming(renameId);
  }, [renameId]);

  // Offset of the list inside the scroll container (sections above it change height). The scroll container is a
  // parent, so its ref may attach after this layout effect runs: retry on the next frame until it exists.
  useLayoutEffect(() => {
    let ro: ResizeObserver | null = null;
    let raf = 0;
    const setup = () => {
      const list = listRef.current;
      const sc = scrollEl();
      if (!list || !sc) {
        raf = requestAnimationFrame(setup);
        return;
      }
      // Layout offsets, not rects: a section above may be mid-collapse, and a rect read would bake its transition
      // into the virtualiser's scroll margin.
      const measure = () => {
        let top = 0;
        let el: HTMLElement | null = list;
        while (el && el !== sc) {
          top += el.offsetTop;
          const parent = el.offsetParent as HTMLElement | null;
          if (!parent || !sc.contains(parent)) break;
          el = parent;
        }
        if (el !== sc) top = list.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
        setMargin((m) => (Math.abs(m - top) > 0.5 ? top : m));
      };
      measure();
      ro = new ResizeObserver(measure);
      ro.observe(sc);
      if (sc.firstElementChild) ro.observe(sc.firstElementChild);
    };
    setup();
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [scrollEl]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: scrollEl,
    estimateSize: () => rowH,
    overscan: 8,
    scrollMargin: margin,
    getItemKey: (i) => rows[i]?.id ?? i,
    // Vertical list: only height changes matter. Forwarding width changes re-rendered every row on each frame of a
    // sidebar resize drag.
    observeElementRect: heightOnlyRect,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [rowH, virtualizer]);

  const indexOf = useCallback((id: Id | null) => (id ? rows.findIndex((r) => r.id === id) : -1), [rows]);

  const focusRow = (id: Id) => {
    setFocusId(id);
    const i = indexOf(id);
    if (i >= 0) virtualizer.scrollToIndex(i, { align: "auto" });
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-tree-row][data-id="${CSS.escape(id)}"]`)?.focus());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (renaming) return;
    const id = (e.target as HTMLElement).closest<HTMLElement>("[data-tree-row]")?.dataset.id;
    const i = indexOf(id ?? null);
    if (i < 0) return;
    const row = rows[i];
    const tree = useTree.getState();
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (rows[i + 1]) focusRow(rows[i + 1].id);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (rows[i - 1]) focusRow(rows[i - 1].id);
        break;
      case "ArrowRight":
        e.preventDefault();
        if (row.hasChildren && !row.expanded) tree.setExpanded(row.id, true);
        else if (row.hasChildren && rows[i + 1]) focusRow(rows[i + 1].id);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (row.expanded) tree.setExpanded(row.id, false);
        else if (row.meta.parentId && indexOf(row.meta.parentId) >= 0) focusRow(row.meta.parentId);
        break;
      case "Home":
        e.preventDefault();
        if (rows[0]) focusRow(rows[0].id);
        break;
      case "End":
        e.preventDefault();
        if (rows.length) focusRow(rows[rows.length - 1].id);
        break;
      case "Enter":
        e.preventDefault();
        if (e.shiftKey) useUi.getState().openPeek(routeForRow(row));
        else navigate(routeForRow(row));
        break;
      case "F2":
        if (row.hub) break;
        e.preventDefault();
        setRenaming(row.id);
        break;
      case "Delete":
      case "Backspace":
        // An app is removed from its own settings, never by a stray key in the sidebar.
        if (row.hub) break;
        if (e.key === "Backspace" && !(e.metaKey || e.ctrlKey)) break;
        e.preventDefault();
        if (rows[i + 1] ?? rows[i - 1]) setFocusId((rows[i + 1] ?? rows[i - 1]).id);
        void tree.trash([row.id]);
        if (currentId === row.id) navigate(row.meta.parentId ? { t: "page", id: row.meta.parentId } : { t: "home" }, { replace: true });
        break;
      default:
        break;
    }
  };

  const tabbable = focusId && indexOf(focusId) >= 0 ? focusId : currentId && indexOf(currentId) >= 0 ? currentId : rows[0]?.id;
  const items = virtualizer.getVirtualItems();
  const dragState = drag.drag;

  // One context menu for the whole tree (a Radix menu root per row would add a document keydown listener per row):
  // the right-clicked row is resolved from the event target.
  const ctxRow = ctxId ? rows.find((r) => r.id === ctxId) : undefined;
  if (!rows.length) return null;
  return (
    <ContextMenu onOpenChange={(o) => !o && setCtxId(null)}>
      <ContextMenuTrigger asChild disabled={!!renaming}>
        <div
          ref={listRef}
          role="tree"
          aria-label={label}
          className="relative"
          style={{ height: virtualizer.getTotalSize() }}
          onKeyDown={onKeyDown}
          onContextMenu={(e) => {
            const id = (e.target as HTMLElement).closest<HTMLElement>("[data-tree-row]")?.dataset.id;
            if (!id) e.preventDefault();
            else setCtxId(id);
          }}
          data-drop-root=""
          data-section={section}
        >
          {items.map((v) => {
            const row = rows[v.index];
            if (!row) return null;
            return (
              <div key={v.key} data-index={v.index} className="emp-tree-slot" style={{ position: "absolute", top: 0, left: 0, right: 0, height: rowH, transform: `translateY(${v.start - margin}px)` }}>
                <TreeItem
                  row={row}
                  selected={row.id === currentId}
                  tabbable={row.id === tabbable}
                  renaming={renaming === row.id}
                  dragging={dragState?.id === row.id}
                  drop={dragState?.target?.id === row.id && dragState.target.zone === "inside"}
                  ctxOpen={ctxId === row.id}
                  fresh={fresh.has(row.id)}
                  onFocusRow={setFocusId}
                  onRename={() => setRenaming(row.id)}
                  onRenameEnd={() => {
                    setRenaming(null);
                    onRenameDone?.();
                    focusRow(row.id);
                  }}
                  onPointerDown={drag.start}
                />
              </div>
            );
          })}
          {dragState ? <DropLine drag={dragState} rows={rows} rowH={rowH} indexOf={indexOf} offset={(i) => (virtualizer.measurementsCache[i]?.start ?? i * rowH) - margin} /> : null}
        </div>
      </ContextMenuTrigger>
      {ctxRow ? (
        <ContextMenuContent width={264}>
          <PageContextItems actions={rowActions(ctxRow, () => setRenaming(ctxRow.id))} />
        </ContextMenuContent>
      ) : null}
    </ContextMenu>
  );
}

/**
 * Ids of rows that appeared after the tree first rendered (a new page, an expanded parent's children). They play the
 * 160ms row insert (fade + 4px, register: rowInsert) once: an id stays "fresh" for a moment after it appears, so the
 * re-renders that follow a create (tree events, the route change) don't cut the animation short. The first render
 * and known rows don't animate.
 */
const FRESH_MS = 400;
function useFreshRows(rows: TreeRow[]): Set<Id> {
  const known = useRef<Set<Id> | null>(null);
  const until = useRef(new Map<Id, number>());
  const last = useRef<TreeRow[] | null>(null);
  const now = performance.now();
  if (last.current !== rows) {
    last.current = rows;
    const ids = new Set(rows.map((r) => r.id));
    if (known.current) for (const id of ids) if (!known.current.has(id)) until.current.set(id, now + FRESH_MS);
    known.current = ids;
    for (const [id, t] of until.current) if (t < now) until.current.delete(id);
  }
  const out = new Set<Id>();
  for (const [id, t] of until.current) if (t >= now) out.add(id);
  return out;
}

function DropLine({ drag, rows, rowH, indexOf, offset }: { drag: DragState; rows: TreeRow[]; rowH: number; indexOf: (id: Id) => number; offset: (i: number) => number }) {
  const t = drag.target;
  if (!t || !t.id || t.zone === "inside" || t.zone === "end") return null;
  const i = indexOf(t.id);
  if (i < 0) return null;
  // "after" an expanded parent visually sits after its whole subtree.
  let at = i;
  if (t.zone === "after") {
    const depth = rows[i].depth;
    let j = i + 1;
    while (j < rows.length && rows[j].depth > depth) j++;
    at = j - 1;
  }
  const top = t.zone === "before" ? offset(i) - 1 : offset(at) + rowH - 1;
  const left = 8 + Math.min(t.depth, MAX_INDENT_LEVELS) * INDENT + 14;
  return <div className="emp-drop-line" style={{ top, left, right: 4 }} aria-hidden />;
}

interface TreeItemProps {
  row: TreeRow;
  selected: boolean;
  tabbable: boolean;
  renaming: boolean;
  dragging: boolean;
  drop: boolean;
  /** The shared tree context menu is open for this row. */
  ctxOpen: boolean;
  /** Newly inserted: plays the row insert once. */
  fresh: boolean;
  onFocusRow: (id: Id) => void;
  onRename: () => void;
  onRenameEnd: () => void;
  onPointerDown: (id: Id, e: ReactPointerEvent) => void;
}

const TreeItem = memo(function TreeItem({ row, selected, tabbable, renaming, dragging, drop, ctxOpen, fresh, onFocusRow, onRename, onRenameEnd, onPointerDown }: TreeItemProps) {
  const { meta, depth, hasChildren, expanded, hub } = row;
  const [menuOpen, setMenuOpen] = useState(false);
  // The row's dropdown mounts on first hover/focus (see LazyMenu).
  const [armed, setArmed] = useState(false);
  const pad = 8 + Math.min(depth, MAX_INDENT_LEVELS) * INDENT;
  const app = hub ? lifeAppIdentity(hub.appId) : null;
  const title = app ? app.name : meta.title || "Untitled";
  const AppGlyph = app?.icon;
  const route = routeForRow(row);

  const open = (e: MouseEvent) => {
    if (renaming) return;
    if (e.shiftKey || e.metaKey || e.ctrlKey) useUi.getState().openPeek(route);
    else navigate(route);
  };

  const addChild = async (e: MouseEvent) => {
    e.stopPropagation();
    const child = await useTree.getState().createPage({ parentId: meta.id });
    navigate({ t: "page", id: child.id });
  };

  const actions = () => rowActions(row, onRename);
  const canAddInside = !hub && (meta.kind === "doc" || meta.kind === "dashboard");

  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={hasChildren ? expanded : undefined}
      aria-selected={selected}
      aria-current={selected ? "page" : undefined}
      aria-label={title}
      tabIndex={tabbable ? 0 : -1}
      data-tree-row=""
      data-id={meta.id}
      data-depth={depth}
      data-app={hub ? hub.appId : undefined}
      data-project={isProject(meta) ? "" : undefined}
      data-dragging={dragging ? "" : undefined}
      data-drop={drop ? "inside" : undefined}
      data-menu-open={menuOpen || ctxOpen ? "" : undefined}
      data-fresh={fresh ? "" : undefined}
      data-leaving={row.leaving ? "" : undefined}
      className="emp-sb-row"
      style={{ paddingLeft: pad }}
      onClick={open}
      onDoubleClick={(e) => {
        e.preventDefault();
        if (!hub) onRename();
      }}
      onFocus={() => {
        onFocusRow(meta.id);
        setArmed(true);
      }}
      onPointerDown={(e) => onPointerDown(meta.id, e)}
      onPointerEnter={() => {
        preloadRoute(route);
        setArmed(true);
      }}
    >
      <span className="emp-sb-glyph">
        <span className={"ico" + (hasChildren ? " swap-on-hover" : "")}>{AppGlyph ? <AppGlyph aria-hidden /> : <PageIcon icon={meta.icon} kind={meta.kind} project={isProject(meta)} size={18} />}</span>
        {hasChildren ? (
          <button
            type="button"
            tabIndex={-1}
            className="emp-sb-chevron"
            data-open={expanded ? "" : undefined}
            data-no-drag=""
            aria-label={expanded ? "Collapse" : "Expand"}
            onClick={(e) => {
              e.stopPropagation();
              useTree.getState().toggle(meta.id);
            }}
          >
            <ChevronRight aria-hidden />
          </button>
        ) : null}
      </span>
      {renaming ? <RenameInput meta={meta} onDone={onRenameEnd} /> : <span className="label">{title}</span>}
      {!renaming ? (
        <span className="trail hover-only" data-no-drag="">
          <LazyMenu armed={armed} open={menuOpen} onOpenChange={setMenuOpen} label={`Actions for ${title}`} align="start">
            <PageMenuItems actions={actions()} />
          </LazyMenu>
          {canAddInside ? (
            <Tooltip content="Add a page inside">
              <button type="button" tabIndex={-1} className="emp-sb-mini" aria-label={`Add a page inside ${title}`} onClick={(e) => void addChild(e)}>
                <Plus aria-hidden />
              </button>
            </Tooltip>
          ) : null}
        </span>
      ) : null}
    </div>
  );
});

/**
 * A row's "…" dropdown. The Radix menu root (and its document keydown listener) only mounts once the row has been
 * hovered or focused; before that the trigger is a plain button that looks identical.
 */
export function LazyMenu({ armed, open, onOpenChange, label, align, children }: { armed: boolean; open: boolean; onOpenChange: (o: boolean) => void; label: string; align?: "start" | "end"; children: ReactNode }) {
  const button = (
    <button type="button" tabIndex={-1} className="emp-sb-mini" aria-label={label} onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <Ellipsis aria-hidden />
    </button>
  );
  if (!armed && !open) return button;
  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <MenuTrigger asChild>{button}</MenuTrigger>
      {open ? (
        <MenuContent align={align} width={264}>
          {children}
        </MenuContent>
      ) : null}
    </Menu>
  );
}

function RenameInput({ meta, onDone }: { meta: PageMeta; onDone: () => void }) {
  const [value, setValue] = useState(meta.title);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const next = value.trim();
    if (save && next !== meta.title) void useTree.getState().rename(meta.id, next.slice(0, 1024));
    onDone();
  };
  return (
    <input
      ref={ref}
      className="emp-sb-rename"
      value={value}
      aria-label="Page title"
      placeholder="Untitled"
      maxLength={1024}
      onChange={(e) => setValue(e.currentTarget.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          commit(false);
        }
      }}
      onBlur={() => commit(true)}
    />
  );
}
