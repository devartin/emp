/**
 * The Pages tree (§5.8, §13.1): virtualised rows (@tanstack/react-virtual, overscan 8) inside the sidebar's scroll
 * container, `role="tree"` with roving focus — arrows navigate, → / ← expand/collapse, Enter opens, ⇧Enter opens in
 * the side peek, F2 renames, Delete moves to Trash (with an Undo toast). Drag to reorder or nest (useTreeDrag),
 * double-click to rename inline, right-click for the page menu.
 */
import { observeElementRect, useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, Ellipsis, Plus } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { navigate, routePageId, useRoute } from "@/app/router";
import { preloadRoute } from "@/app/routes";
import type { Id, PageMeta } from "@/backend/types";
import { isTreeVisible, MAX_INDENT_LEVELS, selectVisibleRows, useTree, type TreeRow } from "@/stores/tree";
import { useUi } from "@/stores/ui";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/ui/ContextMenu";
import { Menu, MenuContent, MenuTrigger } from "@/ui/Menu";
import { Tooltip } from "@/ui/Tooltip";
import { useRootAttr } from "@/ui/motion/useReducedEffects";
import { PageIcon } from "../PageIcon";
import { PageContextItems, PageMenuItems, pageActions, routeForPage } from "../PageMenu";
import { useTreeDrag, type DragState } from "./useTreeDrag";

const INDENT = 12;

const heightOnlyRect: typeof observeElementRect<HTMLElement> = (instance, cb) => {
  let h = -1;
  return observeElementRect(instance, (rect) => {
    if (Math.abs(rect.height - h) < 0.5) return;
    h = rect.height;
    cb(rect);
  });
};
export const pagesFilter = (m: PageMeta) => isTreeVisible(m) && !(m.appInstanceId && m.parentId === null);

export interface PageTreeProps {
  scrollEl: () => HTMLElement | null;
  /** Rename request from outside (e.g. after creating a page). */
  renameId?: Id | null;
  onRenameDone?: () => void;
  drag: ReturnType<typeof useTreeDrag>;
}

export function PageTree({ scrollEl, renameId, onRenameDone, drag }: PageTreeProps) {
  const rows = useTree((s) => selectVisibleRows(s, null, pagesFilter, "pages"));
  const density = useRootAttr("data-density");
  const rowH = density === "compact" ? 24 : 28;
  const route = useRoute();
  const currentId = routePageId(route);
  const listRef = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);
  const [focusId, setFocusId] = useState<Id | null>(null);
  const [renaming, setRenaming] = useState<Id | null>(null);
  const [ctxId, setCtxId] = useState<Id | null>(null);
  const seen = useRef<Set<Id> | null>(null);

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
      // Layout offsets, not rects: the sections above ride a transform-based layout morph, and a rect read
      // mid-morph would bake the in-flight transform into the virtualiser's scroll margin.
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

  // Rows that just appeared (expand / create) fade in; the first render doesn't animate.
  const fresh = useMemo(() => {
    const prev = seen.current;
    const next = new Set(rows.map((r) => r.id));
    seen.current = next;
    if (!prev) return new Set<Id>();
    return new Set(rows.filter((r) => !prev.has(r.id)).map((r) => r.id));
  }, [rows]);

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
        else if (row.meta.parentId) focusRow(row.meta.parentId);
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
        if (e.shiftKey) useUi.getState().openPeek(routeForPage(row.meta));
        else navigate(routeForPage(row.meta));
        break;
      case "F2":
        e.preventDefault();
        setRenaming(row.id);
        break;
      case "Delete":
      case "Backspace":
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
  const ctxMeta = ctxId ? (rows.find((r) => r.id === ctxId)?.meta ?? useTree.getState().byId.get(ctxId)) : undefined;
  return (
    <ContextMenu onOpenChange={(o) => !o && setCtxId(null)}>
      <ContextMenuTrigger asChild disabled={!!renaming}>
    <div
      ref={listRef}
      role="tree"
      aria-label="Pages"
      className="relative"
      style={{ height: virtualizer.getTotalSize() }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        const id = (e.target as HTMLElement).closest<HTMLElement>("[data-tree-row]")?.dataset.id;
        if (!id) e.preventDefault();
        else setCtxId(id);
      }}
      data-drop-root
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
              fresh={fresh.has(row.id)}
              renaming={renaming === row.id}
              dragging={dragState?.id === row.id}
              drop={dragState?.target?.id === row.id && dragState.target.zone === "inside"}
              ctxOpen={ctxId === row.id}
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
      {ctxMeta ? (
        <ContextMenuContent width={264}>
          <PageContextItems actions={pageActions(ctxMeta, { onRename: () => setRenaming(ctxMeta.id) })} />
        </ContextMenuContent>
      ) : null}
    </ContextMenu>
  );
}

function DropLine({ drag, rows, rowH, indexOf, offset }: { drag: DragState; rows: TreeRow[]; rowH: number; indexOf: (id: Id) => number; offset: (i: number) => number }) {
  const t = drag.target;
  if (!t || t.zone === "inside") return null;
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
  fresh: boolean;
  renaming: boolean;
  dragging: boolean;
  drop: boolean;
  /** The shared tree context menu is open for this row. */
  ctxOpen: boolean;
  onFocusRow: (id: Id) => void;
  onRename: () => void;
  onRenameEnd: () => void;
  onPointerDown: (id: Id, e: ReactPointerEvent) => void;
}

const TreeItem = memo(function TreeItem({ row, selected, tabbable, fresh, renaming, dragging, drop, ctxOpen, onFocusRow, onRename, onRenameEnd, onPointerDown }: TreeItemProps) {
  const { meta, depth, hasChildren, expanded } = row;
  const [menuOpen, setMenuOpen] = useState(false);
  // The row's dropdown mounts on first hover/focus (see LazyMenu).
  const [armed, setArmed] = useState(false);
  const pad = 8 + Math.min(depth, MAX_INDENT_LEVELS) * INDENT;
  const title = meta.title || "Untitled";

  const open = (e: MouseEvent) => {
    if (renaming) return;
    if (e.shiftKey || e.metaKey || e.ctrlKey) useUi.getState().openPeek(routeForPage(meta));
    else navigate(routeForPage(meta));
  };

  const addChild = async (e: MouseEvent) => {
    e.stopPropagation();
    const child = await useTree.getState().createPage({ parentId: meta.id });
    navigate({ t: "page", id: child.id });
  };

  const actions = () => pageActions(meta, { onRename });

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
          data-dragging={dragging ? "" : undefined}
          data-drop={drop ? "inside" : undefined}
          data-menu-open={menuOpen || ctxOpen ? "" : undefined}
          className={"emp-sb-row" + (fresh ? " emp-row-in" : "")}
          style={{ paddingLeft: pad }}
          onClick={open}
          onDoubleClick={(e) => {
            e.preventDefault();
            onRename();
          }}
          onFocus={() => {
            onFocusRow(meta.id);
            setArmed(true);
          }}
          onPointerDown={(e) => onPointerDown(meta.id, e)}
          onPointerEnter={() => {
            preloadRoute(routeForPage(meta));
            setArmed(true);
          }}
        >
          <span className="relative flex h-[18px] w-[18px] flex-none items-center justify-center">
            <span className={"ico" + (hasChildren ? " swap-on-hover" : "")} style={{ transition: "opacity 120ms var(--ease-out)" }}>
              <PageIcon icon={meta.icon} kind={meta.kind} size={18} />
            </span>
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
              {meta.kind === "doc" || meta.kind === "dashboard" ? (
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
