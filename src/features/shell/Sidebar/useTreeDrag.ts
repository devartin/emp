/**
 * Pointer-driven drag and drop for the sidebar's virtualised section trees (§4.2 DnD lift, drop indicator; §5.8
 * drop target; brief §2.1). Works with virtualisation because targets are resolved from the row under the pointer,
 * not from registered droppables. Zones per row: top 28% → before, bottom 28% → after, middle → inside (nest). Rows
 * can also be dropped on the Favorites section (adds a favourite). Auto-scrolls near the edges and expands a
 * collapsed row after 600ms.
 *
 * Sections list top-level pages by kind (tree.ts `rootSectionOf`), so a drop that would put a page at the top level
 * is only offered in the section where it would then appear; elsewhere the edge zones of a row that can hold pages
 * nest instead (dropping a page on a project in Projects moves it under that project). App hubs are leaves.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Id, PageMeta } from "@/backend/types";
import { rootSectionOf, selectSectionRows, useTree, type AppIndex, type SidebarSection } from "@/stores/tree";
import { useWorkspace } from "@/stores/workspace";

/** `end`: append at the top level (an empty section, or the empty space under a section's rows). */
export type DropZone = "before" | "after" | "inside" | "end";
export interface DropTarget {
  /** The row the drop is relative to (null for `end`). */
  id: Id | null;
  zone: DropZone;
  depth: number;
  section?: SidebarSection;
}

const SECTIONS: readonly string[] = ["projects", "documents", "sheets", "apps"];
const sectionOf = (el: Element): SidebarSection | undefined => {
  const v = el.closest<HTMLElement>("[data-section]")?.dataset.section;
  return v && SECTIONS.includes(v) ? (v as SidebarSection) : undefined;
};
export interface DragState {
  id: Id;
  meta: PageMeta;
  x: number;
  y: number;
  target: DropTarget | null;
  /** Hovering the Favorites section. */
  favorites: boolean;
}

const THRESHOLD = 4;
const EDGE = 36;
const EXPAND_DELAY = 600;

function isInside(byId: Map<Id, PageMeta>, candidate: Id, ancestor: Id): boolean {
  for (let cur: Id | null = candidate; cur; cur = byId.get(cur)?.parentId ?? null) if (cur === ancestor) return true;
  return false;
}

export function useTreeDrag(scrollEl: () => HTMLElement | null, getApps: () => AppIndex) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const pending = useRef<{ id: Id; x: number; y: number; pointerId: number } | null>(null);
  const suppressClick = useRef(false);
  const raf = useRef(0);
  const expandTimer = useRef<{ id: Id; t: number } | null>(null);
  const lastPointer = useRef({ x: 0, y: 0 });

  const set = (d: DragState | null) => {
    dragRef.current = d;
    setDrag(d);
  };

  const resolve = useCallback(
    (x: number, y: number, draggedId: Id): Pick<DragState, "target" | "favorites"> => {
      const none = { target: null, favorites: false };
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      if (!el) return none;
      if (el.closest("[data-drop-favorites]")) return { target: null, favorites: true };
      const tree = useTree.getState();
      const dragged = tree.byId.get(draggedId);
      if (!dragged) return none;
      const apps = getApps();
      // Where the dragged page would list if it ended up at the top level.
      const home = rootSectionOf({ ...dragged, parentId: null }, apps);
      const row = el.closest<HTMLElement>("[data-tree-row]");
      if (!row) {
        const root = el.closest<HTMLElement>("[data-drop-root]");
        const section = root ? sectionOf(root) : undefined;
        if (!root || !section || section !== home) return none;
        const roots = selectSectionRows(tree, section, apps).filter((r) => r.depth === 0 && r.id !== draggedId);
        const last = roots[roots.length - 1];
        return { target: last ? { id: last.id, zone: "after", depth: 0, section } : { id: null, zone: "end", depth: 0, section }, favorites: false };
      }
      const id = row.dataset.id as Id;
      const depth = Number(row.dataset.depth ?? 0);
      const section = sectionOf(row);
      if (!id || id === draggedId || isInside(tree.byId, id, draggedId)) return none;
      const r = row.getBoundingClientRect();
      const rel = (y - r.top) / r.height;
      const meta = tree.byId.get(id);
      const canNest = !!meta && !apps.hubs.has(id) && (meta.kind === "doc" || meta.kind === "dashboard");
      let zone: DropZone = rel < 0.28 ? "before" : rel > 0.72 ? "after" : "inside";
      if (zone === "inside" && !canNest) zone = rel < 0.5 ? "before" : "after";
      // A top-level drop only where the page would then list; otherwise nest into the row, or nothing.
      if (zone !== "inside" && depth === 0 && section && section !== home) {
        if (!canNest) return none;
        zone = "inside";
      }
      return { target: { id, zone, depth, section }, favorites: false };
    },
    [getApps],
  );

  const tick = useCallback(() => {
    const d = dragRef.current;
    const sc = scrollEl();
    if (!d || !sc) return;
    const r = sc.getBoundingClientRect();
    const { y, x } = lastPointer.current;
    let dy = 0;
    if (y < r.top + EDGE) dy = -Math.ceil(((r.top + EDGE - y) / EDGE) * 12);
    else if (y > r.bottom - EDGE) dy = Math.ceil(((y - (r.bottom - EDGE)) / EDGE) * 12);
    if (dy) {
      sc.scrollTop += dy;
      const res = resolve(x, y, d.id);
      set({ ...d, ...res });
    }
    // Auto-expand a collapsed parent while hovering "inside".
    const t = dragRef.current?.target;
    if (t && t.id && t.zone === "inside") {
      const tree = useTree.getState();
      if (!tree.expanded.has(t.id) && (tree.children.get(t.id)?.length ?? 0) > 0) {
        if (expandTimer.current?.id !== t.id) expandTimer.current = { id: t.id, t: performance.now() };
        else if (performance.now() - expandTimer.current.t > EXPAND_DELAY) {
          tree.setExpanded(t.id, true);
          expandTimer.current = null;
        }
      }
    } else expandTimer.current = null;
    raf.current = requestAnimationFrame(tick);
  }, [resolve, scrollEl]);

  const finish = useCallback((commit: boolean) => {
    const d = dragRef.current;
    cancelAnimationFrame(raf.current);
    pending.current = null;
    expandTimer.current = null;
    set(null);
    document.body.style.cursor = "";
    if (!d || !commit) return;
    if (d.favorites) {
      const ws = useWorkspace.getState();
      if (!ws.isFavorite(d.id)) void ws.toggleFavorite(d.id);
      return;
    }
    const t = d.target;
    if (!t) return;
    const tree = useTree.getState();
    if (t.zone === "end" || !t.id) {
      void tree.move(d.id, null);
      return;
    }
    const target = tree.byId.get(t.id);
    if (!target) return;
    if (t.zone === "inside") void tree.move(d.id, t.id);
    else if (t.zone === "before") void tree.move(d.id, target.parentId, { beforeId: t.id });
    else void tree.move(d.id, target.parentId, { afterId: t.id });
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      lastPointer.current = { x: e.clientX, y: e.clientY };
      const p = pending.current;
      const d = dragRef.current;
      if (!d && p) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < THRESHOLD) return;
        const meta = useTree.getState().byId.get(p.id);
        if (!meta) {
          pending.current = null;
          return;
        }
        suppressClick.current = true;
        document.body.style.cursor = "grabbing";
        set({ id: p.id, meta, x: e.clientX, y: e.clientY, ...resolve(e.clientX, e.clientY, p.id) });
        raf.current = requestAnimationFrame(tick);
        return;
      }
      if (d) set({ ...d, x: e.clientX, y: e.clientY, ...resolve(e.clientX, e.clientY, d.id) });
    };
    const onUp = () => {
      if (dragRef.current) finish(true);
      pending.current = null;
      // The click that may follow this release (same task) is swallowed. A drop on another element (or a drag ended
      // with Escape) gets no click at all, and the next real click must not be eaten instead.
      if (suppressClick.current)
        window.setTimeout(() => {
          suppressClick.current = false;
        }, 0);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dragRef.current) {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    };
    const onClickCapture = (e: MouseEvent) => {
      if (suppressClick.current) {
        suppressClick.current = false;
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("click", onClickCapture, true);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("click", onClickCapture, true);
      cancelAnimationFrame(raf.current);
    };
  }, [finish, resolve, tick]);

  /** Attach to a row's onPointerDown. */
  const start = useCallback((id: Id, e: ReactPointerEvent) => {
    if (e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target as HTMLElement;
    if (t.closest("input, [data-no-drag]")) return;
    suppressClick.current = false;
    pending.current = { id, x: e.clientX, y: e.clientY, pointerId: e.pointerId };
  }, []);

  return { drag, start };
}
