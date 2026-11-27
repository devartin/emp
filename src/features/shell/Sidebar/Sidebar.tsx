/**
 * Sidebar (brief §2.1; §5.8). Top to bottom: the header (workspace menu, "+ New", Hide sidebar), Search / Home /
 * Calendar, Favorites (only when there are any), Projects, Documents, Spreadsheets and Apps (each collapsible with
 * its own "+" and one quiet line when empty), and the footer (Trash, Settings, the lock status).
 *
 * `SidebarFrame` handles docking, hide/show (a 200ms transform), the left-edge hover peek and resizing (200–420,
 * double-click resets). Its resting position is CSS keyed by `data-state`, never the end of an animation: a hide or
 * show that happens while the window is hidden (WebKitGTK runs no frames then) still lands in place (shellMotion.ts).
 */
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowUp, Calendar, ChartLine, Check, ChevronsUpDown, Eye, EyeOff, House, Lock, LockOpen, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings, SquarePen, Star, Trash2 } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { createPageAndOpen, createProjectAndOpen, createSheetAndOpen, openPaletteHeld, runCommand } from "@/app/commands";
import { navigate, routesEqual, useRoute, type AppRoute } from "@/app/router";
import { preloadRoute } from "@/app/routes";
import { api } from "@/backend";
import type { Id, PageMeta, Workspace } from "@/backend/types";
import { cn } from "@/lib/cn";
import { isMac, isTauri } from "@/lib/platform";
import { useSettings } from "@/stores/settings";
import { notify } from "@/stores/toasts";
import { appIndexOf, isProject, selectSectionRows, useTree, type AppIndex, type SidebarSection } from "@/stores/tree";
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, useUi } from "@/stores/ui";
import { useVault } from "@/stores/vault";
import { useWorkspace } from "@/stores/workspace";
import { useNav } from "@/stores/nav";
import { Button } from "@/ui/Button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/ui/ContextMenu";
import { Dialog } from "@/ui/Dialog";
import { IconButton } from "@/ui/IconButton";
import { Input } from "@/ui/Input";
import { Kbd } from "@/ui/Kbd";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/ui/Menu";
import { Resizable } from "@/ui/Resizable";
import { Tooltip } from "@/ui/Tooltip";
import { PageIcon } from "../PageIcon";
import { PageContextItems, PageMenuItems, pageActions } from "../PageMenu";
import { LockIndicator } from "../LockIndicator";
import { SIDEBAR_MS, useShellMotion } from "../shellMotion";
import { setPaletteOrigin } from "@/features/search/origin";
import { hubActions } from "./hubActions";
import { lifeAppIdentity } from "./lifeAppIdentity";
import { NewMenu } from "./NewMenu";
import { LazyMenu, PageTree } from "./PageTree";
import { Section, SectionEmpty } from "./Section";
import { useTreeDrag } from "./useTreeDrag";

/** The id the toggles point their `aria-controls` at. */
export const SIDEBAR_ID = "emp-sidebar";

/** Hover dwell on the left edge before the sidebar peeks in (long enough that a pass-by doesn't open it). */
const PEEK_DWELL_MS = 160;

// ───────────────────────────────────────────────────────────────────────────── frame

export interface SidebarFrameProps {
  /** Compact window (< 900px): the sidebar is always an overlay. */
  compact: boolean;
}

export function SidebarFrame({ compact }: SidebarFrameProps) {
  const collapsedPref = useUi((s) => s.sidebarCollapsed);
  const width = useUi((s) => s.sidebarWidth);
  const peeking = useUi((s) => s.sidebarPeeking);
  const setPeeking = useUi((s) => s.setSidebarPeeking);
  const motion = useShellMotion();
  const collapsed = collapsedPref || compact;
  const [liveWidth, setLiveWidth] = useState(width);
  const enterTimer = useRef<number | undefined>(undefined);
  const asideRef = useRef<HTMLElement>(null);
  const leaveTimer = useRef<number | undefined>(undefined);

  useEffect(() => setLiveWidth(width), [width]);
  // The live (dragging) width goes on the main column only — `--sb-live-w` is registered as non-inherited
  // (shell.css @property), so a resize restyles one element instead of the whole document.
  useLayoutEffect(() => {
    const main = asideRef.current?.parentElement?.querySelector<HTMLElement>(":scope > .emp-main");
    main?.style.setProperty("--sb-live-w", `${liveWidth}px`);
  }, [liveWidth]);
  useEffect(() => {
    if (!collapsed) setPeeking(false);
  }, [collapsed, setPeeking]);
  useEffect(
    () => () => {
      window.clearTimeout(enterTimer.current);
      window.clearTimeout(leaveTimer.current);
    },
    [],
  );

  const scheduleLeave = () => {
    window.clearTimeout(enterTimer.current);
    window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => setPeeking(false), 300);
  };
  const cancelLeave = () => window.clearTimeout(leaveTimer.current);

  const floating = collapsed && peeking;
  const visible = !collapsed || peeking;
  const state = !collapsed ? "open" : peeking ? "peek" : "closed";
  // A peek slides out as the floating card it was, not as the docked sheet.
  const [leaving, setLeaving] = useState(false);
  const wasFloating = useRef(false);
  // A layout effect, so the card style never drops for a painted frame between the peek ending and the slide out.
  useLayoutEffect(() => {
    if (wasFloating.current && !floating && collapsed && motion) {
      setLeaving(true);
      const t = window.setTimeout(() => setLeaving(false), SIDEBAR_MS + 40);
      wasFloating.current = false;
      return () => window.clearTimeout(t);
    }
    wasFloating.current = floating;
    setLeaving(false);
  }, [floating, collapsed, motion]);

  // A peeking sidebar closes on outside press, Escape, or navigation.
  useEffect(() => {
    if (!floating) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (asideRef.current?.contains(t) || (t instanceof Element && t.closest("[data-sidebar-toggle], [role=menu], [role=dialog], [data-radix-popper-content-wrapper]"))) return;
      setPeeking(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && setPeeking(false);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    const off = useNav.subscribe((s, prev) => s.route !== prev.route && setPeeking(false));
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
      off();
    };
  }, [floating, setPeeking]);

  return (
    <>
      {collapsed ? (
        <div
          className="emp-peek-zone"
          aria-hidden
          onPointerEnter={() => {
            cancelLeave();
            window.clearTimeout(enterTimer.current);
            enterTimer.current = window.setTimeout(() => setPeeking(true), PEEK_DWELL_MS);
          }}
          onPointerLeave={() => {
            window.clearTimeout(enterTimer.current);
            // Leaving the edge without going into the peeking sidebar closes it again.
            if (useUi.getState().sidebarPeeking) scheduleLeave();
          }}
        />
      ) : null}
      <aside
        ref={asideRef}
        id={SIDEBAR_ID}
        className="emp-sidebar"
        data-state={state}
        data-floating={floating || leaving ? "" : undefined}
        data-motion={motion ? "" : undefined}
        data-region="sidebar"
        aria-label="Sidebar"
        aria-hidden={!visible || undefined}
        inert={!visible || undefined}
        style={{ width: liveWidth }}
        onPointerEnter={floating ? cancelLeave : undefined}
        onPointerLeave={floating ? scheduleLeave : undefined}
      >
        <Resizable
          className="h-full"
          width={liveWidth}
          min={SIDEBAR_MIN}
          max={SIDEBAR_MAX}
          defaultWidth={SIDEBAR_DEFAULT}
          onWidthChange={setLiveWidth}
          onResizeEnd={(w) => useUi.getState().setSidebarWidth(w)}
          aria-label="Resize sidebar"
        >
          <div className="emp-sidebar-inner">
            <SidebarContent floating={floating} compact={compact} />
          </div>
          <span className="emp-sidebar-sep" aria-hidden />
        </Resizable>
      </aside>
    </>
  );
}

// ───────────────────────────────────────────────────────────────────────────── content

// Memoised: the frame re-renders on every resize pointermove; the content must not.
const SidebarContent = memo(function SidebarContent({ floating, compact }: { floating: boolean; compact: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const getScroll = useCallback(() => scrollRef.current, []);
  const [scrolled, setScrolled] = useState(false);
  const lifeapps = useWorkspace((s) => s.lifeapps);
  const apps = useMemo(() => appIndexOf(lifeapps), [lifeapps]);
  const appsRef = useRef(apps);
  appsRef.current = apps;
  const getApps = useCallback(() => appsRef.current, []);
  const drag = useTreeDrag(getScroll, getApps);
  const trafficLights = isTauri && isMac && !floating;
  const dropEnd = (section: SidebarSection) => drag.drag?.target?.zone === "end" && drag.drag.target.section === section;
  const hasFavorites = useFavoriteCount() > 0;

  return (
    <div className="emp-sb-frame" data-traffic-lights={trafficLights ? "" : undefined}>
      {trafficLights ? <div className="drag-region emp-sb-traffic" data-tauri-drag-region /> : null}
      <SidebarHeader floating={floating} compact={compact} />
      <div className="emp-sb-top">
        <NewMenu />
        <PrimaryRows />
        {/* While a row is dragged and there are no favourites yet, Favorites is a drop target laid over the rows above
            the sections, so nothing below moves under the pointer. */}
        {drag.drag && !hasFavorites ? <FavoritesDropZone active={!!drag.drag.favorites} /> : null}
      </div>
      <div ref={scrollRef} className="emp-sidebar-scroll" data-scrolled={scrolled ? "" : undefined} onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 2)}>
        <div className="emp-sb-body">
          <FavoritesSection dropActive={!!drag.drag?.favorites} apps={apps} />
          <TreeSection
            section="projects"
            title="Projects"
            addLabel="New project"
            onAdd={() => void createProjectAndOpen(null)}
            empty="Add a project for related work"
            emptyHint="A project keeps the documents, spreadsheets and apps for one goal together"
            apps={apps}
            scrollEl={getScroll}
            drag={drag}
            dropEnd={dropEnd("projects")}
          />
          <TreeSection
            section="documents"
            title="Documents"
            addLabel="New document"
            addShortcut="mod+n"
            onAdd={() => void createPageAndOpen(null)}
            empty="Add a document for notes"
            emptyHint="Documents hold notes, plans and databases"
            apps={apps}
            scrollEl={getScroll}
            drag={drag}
            dropEnd={dropEnd("documents")}
          />
          <TreeSection
            section="sheets"
            title="Spreadsheets"
            addLabel="New spreadsheet"
            onAdd={() => void createSheetAndOpen(null)}
            empty="Add a spreadsheet for budgets"
            emptyHint="Spreadsheets are for budgets, numbers and lists"
            apps={apps}
            scrollEl={getScroll}
            drag={drag}
            dropEnd={dropEnd("sheets")}
          />
          <TreeSection
            section="apps"
            title="Apps"
            addLabel="Add an app"
            onAdd={() => navigate({ t: "lifeapps" })}
            empty="Add an app for tasks or money"
            emptyHint="Apps are ready-made tools: tasks, habits, money, investments and taxes"
            apps={apps}
            scrollEl={getScroll}
            drag={drag}
            dropEnd={dropEnd("apps")}
          >
            <NavRow icon={ChartLine} label="Markets" route={{ t: "markets" }} match={(r) => r.t === "markets"} />
          </TreeSection>
        </div>
      </div>
      <SidebarFooter />
      {drag.drag ? <DragGhost x={drag.drag.x} y={drag.drag.y} meta={drag.drag.meta} apps={apps} /> : null}
    </div>
  );
});

function DragGhost({ x, y, meta, apps }: { x: number; y: number; meta: PageMeta; apps: AppIndex }) {
  const hub = apps.hubs.get(meta.id);
  const app = hub ? lifeAppIdentity(hub.appId) : null;
  const Glyph = app?.icon;
  return (
    <div className="emp-drag-ghost" style={{ left: x + 14, top: y + 12 }} aria-hidden>
      {Glyph ? <Glyph size={16} aria-hidden /> : <PageIcon icon={meta.icon} kind={meta.kind} project={isProject(meta)} size={16} />}
      <span className="truncate">{app ? app.name : meta.title || "Untitled"}</span>
    </div>
  );
}

interface TreeSectionProps {
  section: SidebarSection;
  title: string;
  addLabel: string;
  addShortcut?: string;
  onAdd: () => void;
  /** The one quiet line shown when the section has nothing at the top level: how to add one and what goes there (a
   *  click adds one). */
  empty: string;
  /** What goes in the section, as the empty line's tooltip. */
  emptyHint: string;
  apps: AppIndex;
  scrollEl: () => HTMLElement | null;
  drag: ReturnType<typeof useTreeDrag>;
  dropEnd: boolean;
  /** Fixed rows after the tree (Markets under Apps). */
  children?: ReactNode;
}

function TreeSection({ section, title, addLabel, addShortcut, onAdd, empty, emptyHint, apps, scrollEl, drag, dropEnd, children }: TreeSectionProps) {
  const count = useTree((s) => selectSectionRows(s, section, apps).length);
  return (
    <Section id={section} title={title} onAdd={onAdd} addLabel={addLabel} addShortcut={addShortcut}>
      <PageTree section={section} label={title} apps={apps} scrollEl={scrollEl} drag={drag} />
      {count ? null : <SectionEmpty label={empty} hint={emptyHint} onClick={onAdd} section={section} drop={dropEnd} />}
      {children}
    </Section>
  );
}

// ───────────────────────────────────────────────────────────────────────────── rows

interface NavRowProps {
  icon: ComponentType<{ className?: string; size?: number; "aria-hidden"?: boolean }>;
  label: string;
  route?: AppRoute;
  onClick?: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  shortcut?: string;
  trailing?: ReactNode;
  match?: (r: AppRoute) => boolean;
  /** Secondary row (tertiary ink). */
  muted?: boolean;
  className?: string;
}

function NavRow({ icon: Icon, label, route, onClick, shortcut, trailing, match, muted, className }: NavRowProps) {
  const current = useRoute();
  const active = route ? (match ? match(current) : routesEqual(route, current)) : false;
  return (
    <button
      type="button"
      className={cn("emp-sb-row", className)}
      aria-current={active ? "page" : undefined}
      onClick={(e) => (onClick ? onClick(e) : route && navigate(route))}
      onPointerEnter={route ? () => preloadRoute(route) : undefined}
    >
      <span className="ico">
        <Icon aria-hidden />
      </span>
      <span className={cn("label", muted && "text-tertiary")}>{label}</span>
      {trailing}
      {shortcut ? (
        <span className="trail kbd-hint">
          <Kbd keys={shortcut} size="xs" />
        </span>
      ) : null}
    </button>
  );
}

// The primary rows (Search, Home, Calendar) can be hidden and reordered (PROGRAMME-v3 K4). The layout is a per-device
// preference, kept beside the sections' collapse state.
type PrimaryId = "search" | "home" | "calendar";
const PRIMARY_IDS: PrimaryId[] = ["search", "home", "calendar"];
const PRIMARY_LABEL: Record<PrimaryId, string> = { search: "Search", home: "Home", calendar: "Calendar" };
const PRIMARY_KEY = "emp.sb.primary";

interface PrimaryLayout {
  order: PrimaryId[];
  hidden: PrimaryId[];
}

function readPrimary(): PrimaryLayout {
  try {
    const raw = JSON.parse(localStorage.getItem(PRIMARY_KEY) ?? "null") as Partial<PrimaryLayout> | null;
    const known = (xs: unknown): PrimaryId[] => (Array.isArray(xs) ? xs.filter((x): x is PrimaryId => PRIMARY_IDS.includes(x as PrimaryId)) : []);
    const order = known(raw?.order);
    return { order: [...new Set([...order, ...PRIMARY_IDS])], hidden: known(raw?.hidden) };
  } catch {
    return { order: PRIMARY_IDS, hidden: [] };
  }
}

let primaryState: PrimaryLayout | null = null;
const primaryListeners = new Set<() => void>();

function setPrimary(next: PrimaryLayout) {
  primaryState = next;
  try {
    localStorage.setItem(PRIMARY_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: the change lasts for this session */
  }
  primaryListeners.forEach((l) => l());
}

function usePrimaryLayout(): PrimaryLayout {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    primaryListeners.add(l);
    return () => void primaryListeners.delete(l);
  }, []);
  return currentPrimary();
}

function movePrimary(id: PrimaryId, dir: -1 | 1) {
  const cur = currentPrimary();
  const visible = cur.order.filter((x) => !cur.hidden.includes(x));
  const i = visible.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= visible.length) return;
  const swap = visible[j];
  const order = [...cur.order];
  const a = order.indexOf(id);
  const b = order.indexOf(swap);
  [order[a], order[b]] = [order[b], order[a]];
  setPrimary({ ...cur, order });
}

function currentPrimary(): PrimaryLayout {
  primaryState ??= readPrimary();
  return primaryState;
}

/** "Search", "Search and Home", "Search, Home and Calendar". */
function listNames(ids: PrimaryId[]): string {
  const n = ids.map((id) => PRIMARY_LABEL[id]);
  return n.length > 1 ? `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}` : n.join("");
}

function PrimaryRows() {
  const layout = usePrimaryLayout();
  const visible = layout.order.filter((id) => !layout.hidden.includes(id));
  const [ctx, setCtx] = useState<PrimaryId | null>(null);
  const at = ctx ? visible.indexOf(ctx) : -1;
  if (!visible.length) return null;
  const row = (id: PrimaryId) => {
    if (id === "search")
      return (
        <NavRow
          key={id}
          icon={Search}
          label="Search"
          shortcut="mod+k"
          onClick={(e) => {
            setPaletteOrigin(e.currentTarget);
            openPaletteHeld("all");
          }}
        />
      );
    if (id === "home") return <NavRow key={id} icon={House} label="Home" route={{ t: "home" }} />;
    return <NavRow key={id} icon={Calendar} label="Calendar" route={{ t: "calendar" }} />;
  };
  return (
    <ContextMenu onOpenChange={(o) => !o && setCtx(null)}>
      <ContextMenuTrigger asChild>
        <nav
          className="emp-sb-primary"
          aria-label="Main"
          onContextMenu={(e) => {
            const i = [...e.currentTarget.children].findIndex((el) => el.contains(e.target as Node));
            if (i < 0) e.preventDefault();
            else setCtx(visible[i]);
          }}
        >
          {visible.map(row)}
        </nav>
      </ContextMenuTrigger>
      {ctx ? (
        <ContextMenuContent width={200}>
          <ContextMenuItem icon={ArrowUp} disabled={at <= 0} onSelect={() => movePrimary(ctx, -1)}>
            Move up
          </ContextMenuItem>
          <ContextMenuItem icon={ArrowDown} disabled={at >= visible.length - 1} onSelect={() => movePrimary(ctx, 1)}>
            Move down
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem icon={EyeOff} onSelect={() => setPrimary({ ...layout, hidden: [...layout.hidden, ctx] })}>
            Hide {PRIMARY_LABEL[ctx]}
          </ContextMenuItem>
        </ContextMenuContent>
      ) : null}
    </ContextMenu>
  );
}

/** How many favourites are listed (live, not in Trash). */
function useFavoriteCount(): number {
  const ids = useWorkspace(useShallow((s) => s.workspace?.favorites ?? []));
  return useTree((s) => ids.reduce((n, id) => (s.byId.get(id) && !s.byId.get(id)?.deletedAt ? n + 1 : n), 0));
}

/** Favorites as a drop target while there are none yet (see SidebarContent): laid over the rows, never in the flow. */
function FavoritesDropZone({ active }: { active: boolean }) {
  return (
    <div className="emp-sb-favdrop" data-drop-favorites="" data-active={active ? "" : undefined} aria-hidden>
      <Star aria-hidden />
      <span>Drop here to add to Favorites</span>
    </div>
  );
}

// Favorites — sortable (dnd-kit; the reorder is the C2 220ms ease-out) and a drop target for tree rows. Shown only
// when there are favourites (while there are none, a dragged row drops on FavoritesDropZone).
function FavoritesSection({ dropActive, apps }: { dropActive: boolean; apps: AppIndex }) {
  const ids = useWorkspace(useShallow((s) => s.workspace?.favorites ?? []));
  const metas = useTree(useShallow((s) => ids.map((id) => s.byId.get(id)).filter((m): m is PageMeta => !!m && !m.deletedAt)));
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const [ctxId, setCtxId] = useState<Id | null>(null);
  const ctxMeta = ctxId ? metas.find((m) => m.id === ctxId) : undefined;
  if (!metas.length) return null;
  const onEnd = (e: DragEndEvent) => {
    const from = ids.indexOf(String(e.active.id));
    const to = e.over ? ids.indexOf(String(e.over.id)) : -1;
    if (from < 0 || to < 0 || from === to) return;
    void useWorkspace.getState().reorderFavorites(arrayMove(ids, from, to));
  };
  const actionsFor = (meta: PageMeta) => {
    const hub = apps.hubs.get(meta.id);
    return hub ? hubActions(meta, hub) : pageActions(meta);
  };
  return (
    <Section id="favorites" title="Favorites" data-drop-favorites="" className={dropActive ? "emp-sb-drop" : undefined}>
      {/* One shared context menu for the list (not a Radix menu root per row); the row comes from the event target. */}
      <ContextMenu onOpenChange={(o) => !o && setCtxId(null)}>
        <ContextMenuTrigger asChild>
          <div
            className="flex flex-col gap-px"
            onContextMenu={(e) => {
              const id = (e.target as HTMLElement).closest<HTMLElement>("[data-fav-id]")?.dataset.favId;
              if (!id) e.preventDefault();
              else setCtxId(id);
            }}
          >
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onEnd}>
              <SortableContext items={metas.map((m) => m.id)} strategy={verticalListSortingStrategy}>
                {metas.map((meta) => (
                  <FavoriteRow key={meta.id} meta={meta} ctxOpen={ctxId === meta.id} apps={apps} actions={() => actionsFor(meta)} />
                ))}
              </SortableContext>
            </DndContext>
          </div>
        </ContextMenuTrigger>
        {ctxMeta ? (
          <ContextMenuContent width={264}>
            <PageContextItems actions={actionsFor(ctxMeta)} />
          </ContextMenuContent>
        ) : null}
      </ContextMenu>
    </Section>
  );
}

function FavoriteRow({ meta, ctxOpen, apps, actions }: { meta: PageMeta; ctxOpen: boolean; apps: AppIndex; actions: () => ReturnType<typeof pageActions> }) {
  const route = useRoute();
  const hub = apps.hubs.get(meta.id);
  const app = hub ? lifeAppIdentity(hub.appId) : null;
  const target: AppRoute = hub ? { t: "app", instanceId: hub.instanceId } : { t: "page", id: meta.id };
  const active = hub ? route.t === "app" && route.instanceId === hub.instanceId : (route.t === "page" || route.t === "db" || route.t === "sheet") && route.id === meta.id;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: meta.id, transition: { duration: 220, easing: "var(--ease-out)" } });
  const [menuOpen, setMenuOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const title = app ? app.name : meta.title || "Untitled";
  const Glyph = app?.icon;
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      role="link"
      tabIndex={0}
      className="emp-sb-row"
      data-fav-id={meta.id}
      aria-current={active ? "page" : undefined}
      data-menu-open={menuOpen || ctxOpen ? "" : undefined}
      data-fav-dragging={isDragging ? "" : undefined}
      style={{
        transform: CSS.Translate.toString(transform),
        transition: isDragging ? "none" : transition,
      }}
      onClick={(e) => (e.shiftKey ? useUi.getState().openPeek(target) : navigate(target))}
      onKeyDown={(e) => {
        if (e.key === "Enter") navigate(target);
      }}
      onFocus={() => setArmed(true)}
      onPointerEnter={() => {
        preloadRoute(target);
        setArmed(true);
      }}
    >
      <span className="ico">{Glyph ? <Glyph aria-hidden /> : <PageIcon icon={meta.icon} kind={meta.kind} project={isProject(meta)} size={18} />}</span>
      <span className="label">{title}</span>
      <span className="trail hover-only">
        <LazyMenu armed={armed} open={menuOpen} onOpenChange={setMenuOpen} label={`Actions for ${title}`}>
          <PageMenuItems actions={actions()} />
        </LazyMenu>
      </span>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── header

function WorkspaceGlyph({ ws, size = 22 }: { ws: Pick<Workspace, "name" | "icon"> | null; size?: number }) {
  // The workspace's initial (an emoji icon from an older vault is not shown: no emoji in the app's chrome).
  const letter = (ws?.name.trim()[0] ?? "U").toUpperCase();
  return (
    <span className="emp-ws-glyph" style={{ width: size, height: size, fontSize: size * 0.5 }} aria-hidden>
      {letter}
    </span>
  );
}

/**
 * The header's sidebar button. Docked: "Hide sidebar". Peeking over the page: "Keep sidebar open" docks it (in a
 * compact window, where it can only be an overlay, it closes the overlay instead).
 */
function SidebarToggle({ floating, compact }: { floating: boolean; compact: boolean }) {
  if (!floating)
    return (
      <IconButton
        icon={PanelLeftClose}
        label="Hide sidebar"
        shortcut="mod+\"
        size="sm"
        aria-controls={SIDEBAR_ID}
        aria-expanded
        onClick={() => {
          runCommand("sidebar.toggle");
          // The button goes with the sidebar: focus moves to its counterpart in the top bar.
          window.setTimeout(() => document.querySelector<HTMLElement>('.emp-topbar [aria-label="Show sidebar"]')?.focus({ preventScroll: true }), 0);
        }}
      />
    );
  if (compact)
    return <IconButton icon={PanelLeftClose} label="Close sidebar" shortcut="mod+\" size="sm" aria-controls={SIDEBAR_ID} aria-expanded onClick={() => useUi.getState().setSidebarPeeking(false)} />;
  return <IconButton icon={PanelLeftOpen} label="Keep sidebar open" shortcut="mod+\" size="sm" aria-controls={SIDEBAR_ID} aria-expanded onClick={() => useUi.getState().setSidebarCollapsed(false)} />;
}

/**
 * The workspace menu and the visible Hide sidebar button (brief §2.1). "+ New" sits on its own row just below
 * (SidebarContent): beside them it left a default name like "Alex's workspace" about 60px to show itself in.
 */
function SidebarHeader({ floating, compact }: { floating: boolean; compact: boolean }) {
  const ws = useWorkspace((s) => s.workspace);
  const workspaces = useWorkspace((s) => s.workspaces);
  const encrypted = useVault((s) => !!s.status?.encrypted);
  const primary = usePrimaryLayout();
  const [dialog, setDialog] = useState<null | "new" | "rename">(null);
  return (
    <div className="emp-ws-row">
      <Menu>
        <MenuTrigger asChild>
          <button type="button" className="emp-ws-button" aria-label={`Workspace: ${ws?.name ?? ""}. Switch workspace`}>
            <WorkspaceGlyph ws={ws} />
            <span className="name">{ws?.name ?? "Workspace"}</span>
            <ChevronsUpDown size={14} className="chev flex-none text-tertiary" aria-hidden />
          </button>
        </MenuTrigger>
        <MenuContent width={260}>
          <MenuLabel>Workspaces</MenuLabel>
          {workspaces.map((w) => (
            <MenuItem
              key={w.id}
              icon={<WorkspaceGlyph ws={w} size={18} />}
              trailing={w.id === ws?.id ? <Check size={14} className="text-accent" aria-hidden /> : undefined}
              onSelect={() => {
                if (w.id !== ws?.id) void switchWorkspace(w.id);
              }}
            >
              {w.name}
            </MenuItem>
          ))}
          <MenuItem icon={Plus} onSelect={() => setDialog("new")}>
            New workspace…
          </MenuItem>
          <MenuSeparator />
          {primary.hidden.length ? (
            <MenuItem icon={Eye} onSelect={() => setPrimary({ ...primary, hidden: [] })}>
              Show {listNames(primary.hidden)} in the sidebar
            </MenuItem>
          ) : null}
          <MenuItem icon={SquarePen} onSelect={() => setDialog("rename")}>
            Rename workspace…
          </MenuItem>
          <MenuItem icon={Settings} shortcut="mod+," onSelect={() => runCommand("settings.open")}>
            Settings
          </MenuItem>
          {encrypted ? (
            <MenuItem icon={Lock} shortcut="mod+shift+l" onSelect={() => runCommand("vault.lock")}>
              Lock Ultranote
            </MenuItem>
          ) : (
            <MenuItem icon={LockOpen} onSelect={() => navigate({ t: "settings", section: "security" })}>
              Turn on encryption…
            </MenuItem>
          )}
        </MenuContent>
      </Menu>
      <span data-sidebar-toggle="" className="flex">
        <SidebarToggle floating={floating} compact={compact} />
      </span>
      <WorkspaceNameDialog mode={dialog} onClose={() => setDialog(null)} current={ws?.name ?? ""} />
    </div>
  );
}

async function switchWorkspace(id: Id) {
  try {
    await useWorkspace.getState().open(id);
    navigate({ t: "home" }, { replace: true });
  } catch (e) {
    notify.fromError(e, "Couldn't open that workspace");
  }
}

function WorkspaceNameDialog({ mode, onClose, current }: { mode: null | "new" | "rename"; onClose: () => void; current: string }) {
  const [name, setName] = useState("");
  useEffect(() => {
    if (mode) setName(mode === "rename" ? current : "");
  }, [mode, current]);
  const submit = async () => {
    const n = name.trim();
    if (!n) return;
    try {
      if (mode === "rename") await useWorkspace.getState().rename(n);
      else {
        const ws = await api.workspace.create({ name: n });
        useWorkspace.setState((s) => ({ workspaces: [...s.workspaces, ws] }));
        await switchWorkspace(ws.id);
        notify.success(`Created “${ws.name}”`);
      }
      onClose();
    } catch (e) {
      notify.fromError(e, mode === "rename" ? "Couldn't rename the workspace" : "Couldn't create the workspace");
    }
  };
  return (
    <Dialog
      open={!!mode}
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={mode === "rename" ? "Rename workspace" : "New workspace"}
      description={mode === "new" ? "Workspaces keep separate pages, favourites and apps on this computer." : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim()} onClick={() => submit()}>
            {mode === "rename" ? "Rename" : "Create workspace"}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Input label="Name" value={name} maxLength={120} autoFocus data-autofocus onChange={(e) => setName(e.currentTarget.value)} />
      </form>
    </Dialog>
  );
}

// ───────────────────────────────────────────────────────────────────────────── footer

/** Trash and Settings, then the workspace's status (where it lives, whether it is encrypted) and the lock. */
function SidebarFooter() {
  const encrypted = useVault((s) => !!s.status?.encrypted);
  const offline = useSettings((s) => s.vault?.offline ?? false);
  const pulse = useUi((s) => s.netPulse?.at);
  const [pulsing, setPulsing] = useState(false);
  useEffect(() => {
    if (!pulse) return;
    setPulsing(true);
    const t = window.setTimeout(() => setPulsing(false), 1600);
    return () => window.clearTimeout(t);
  }, [pulse]);
  return (
    <footer className="emp-sb-footer">
      <div className="emp-sb-foot-row">
        <NavRow icon={Trash2} label="Trash" route={{ t: "trash" }} className="emp-sb-foot-link" />
        <button type="button" className="emp-sb-row emp-sb-foot-link" onClick={() => runCommand("settings.open")}>
          <span className="ico">
            <Settings aria-hidden />
          </span>
          <span className="label">Settings</span>
        </button>
      </div>
      <div className="emp-sb-status">
        <Tooltip content={encrypted ? "Encrypted on this computer" : "Turn on encryption in Settings"}>
          <button type="button" className="emp-sb-status-btn" onClick={() => navigate({ t: "settings", section: "security" })}>
            <span className="emp-status-dot" data-tone={offline ? "off" : undefined} data-pulse={pulsing ? "" : undefined} aria-hidden />
            <span className="truncate">
              {offline ? "Offline" : "Local"} · {encrypted ? "Encrypted" : "Not encrypted"}
            </span>
          </button>
        </Tooltip>
        <LockIndicator size="xs" />
      </div>
    </footer>
  );
}
