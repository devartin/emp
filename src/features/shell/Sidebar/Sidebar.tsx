/**
 * Sidebar (§5.8): workspace row, primary rows, Favorites, Life Apps, Pages (virtualised tree), bottom group and the
 * status footer. `SidebarFrame` handles docking, collapse (`x 0 ↔ −100%`, spring.ui), hover-peek (left 8px for 120ms
 * brings in a floating sidebar; it leaves 300ms after the pointer exits) and resizing (200–420, double-click resets).
 */
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  CandlestickChart,
  Check,
  ChevronDown,
  ChevronsUpDown,
  FileDown,
  House,
  LayoutTemplate,
  Lock,
  LockOpen,
  Plus,
  Search,
  Settings,
  SquarePen,
  Trash2,
  Calendar,
} from "lucide-react";
import { AnimatePresence, LayoutGroup, m } from "motion/react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { createPageAndOpen, runCommand } from "@/app/commands";
import { navigate, routesEqual, useRoute, type AppRoute } from "@/app/router";
import { preloadRoute } from "@/app/routes";
import { api } from "@/backend";
import type { Id, PageMeta, Workspace } from "@/backend/types";
import { cn } from "@/lib/cn";
import { isMac, isTauri } from "@/lib/platform";
import { useSettings } from "@/stores/settings";
import { notify } from "@/stores/toasts";
import { useTree } from "@/stores/tree";
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, useUi } from "@/stores/ui";
import { useVault } from "@/stores/vault";
import { useWorkspace } from "@/stores/workspace";
import { useNav } from "@/stores/nav";
import { Button } from "@/ui/Button";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/ui/ContextMenu";
import { Dialog } from "@/ui/Dialog";
import { IconButton } from "@/ui/IconButton";
import { Input } from "@/ui/Input";
import { Kbd } from "@/ui/Kbd";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/ui/Menu";
import { Resizable } from "@/ui/Resizable";
import { Tooltip } from "@/ui/Tooltip";
import { ease, spring } from "@/ui/motion/tokens";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { PageIcon } from "../PageIcon";
import { PageContextItems, PageMenuItems, pageActions } from "../PageMenu";
import { lifeAppIdentity } from "./lifeAppIdentity";
import { LazyMenu, PageTree } from "./PageTree";
import { SelectionSlab } from "./SelectionSlab";
import { setPaletteOrigin } from "@/features/search/origin";
import { useTreeDrag } from "./useTreeDrag";

// ───────────────────────────────────────────────────────────────────────────── frame

export interface SidebarFrameProps {
  /** Compact window (< 900px): the sidebar is always a hover-peek overlay. */
  compact: boolean;
}

export function SidebarFrame({ compact }: SidebarFrameProps) {
  const collapsedPref = useUi((s) => s.sidebarCollapsed);
  const width = useUi((s) => s.sidebarWidth);
  const peeking = useUi((s) => s.sidebarPeeking);
  const setPeeking = useUi((s) => s.setSidebarPeeking);
  const reduced = useReducedMotionPref();
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
  useEffect(() => () => {
    window.clearTimeout(enterTimer.current);
    window.clearTimeout(leaveTimer.current);
  }, []);

  const scheduleLeave = () => {
    window.clearTimeout(enterTimer.current);
    window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => setPeeking(false), 300);
  };
  const cancelLeave = () => window.clearTimeout(leaveTimer.current);

  const floating = collapsed && peeking;
  const visible = !collapsed || peeking;

  // A peeking sidebar closes on outside press, Escape, or navigation.
  useEffect(() => {
    if (!floating) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (asideRef.current?.contains(t) || (t instanceof Element && t.closest("[data-sidebar-toggle], [role=menu], [data-radix-popper-content-wrapper]"))) return;
      setPeeking(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPeeking(false);
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
            enterTimer.current = window.setTimeout(() => setPeeking(true), 120);
          }}
          onPointerLeave={() => window.clearTimeout(enterTimer.current)}
        />
      ) : null}
      <m.aside
        ref={asideRef}
        className="emp-sidebar"
        data-floating={floating ? "" : undefined}
        data-region="sidebar"
        aria-label="Sidebar"
        aria-hidden={!visible || undefined}
        inert={!visible || undefined}
        style={{ width: liveWidth }}
        initial={false}
        animate={{ x: visible ? 0 : "-104%" }}
        transition={reduced ? { duration: 0 } : spring.ui}
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
          <m.div className="emp-sidebar-inner" initial={false} animate={{ opacity: visible ? 1 : 0 }} transition={{ duration: visible ? 0.14 : 0.1, delay: visible ? 0.03 : 0 }}>
            <SidebarContent floating={floating} />
          </m.div>
          <span className="emp-sidebar-sep" aria-hidden />
        </Resizable>
      </m.aside>
    </>
  );
}

// ───────────────────────────────────────────────────────────────────────────── content

// Memoised: the frame re-renders on every resize pointermove; the content (and its layout-animated sections, which
// measure on render) must not.
const SidebarContent = memo(function SidebarContent({ floating }: { floating: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const getScroll = useCallback(() => scrollRef.current, []);
  const [scrolled, setScrolled] = useState(false);
  const drag = useTreeDrag(getScroll);
  const trafficLights = isTauri && isMac && !floating;

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ paddingTop: trafficLights ? 40 : 4 }}>
      {trafficLights ? <div className="drag-region absolute inset-x-0 top-0 h-[40px]" data-tauri-drag-region /> : null}
      <WorkspaceRow />
      <PrimaryRows />
      <m.div
        ref={scrollRef}
        layoutScroll
        className="emp-sidebar-scroll"
        data-scrolled={scrolled ? "" : undefined}
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 2)}
      >
        <LayoutGroup id="sidebar-sections">
        <div className="emp-sb-body">
          <SelectionSlab />
          <FavoritesSection dropActive={!!drag.drag?.favorites} dragging={!!drag.drag} />
          <LifeAppsSection />
          <Section id="pages" title="Pages" onAdd={() => void createPageAndOpen(null)} addLabel="New page" addShortcut="mod+n">
            <PageTree scrollEl={getScroll} drag={drag} />
            <EmptyPagesHint />
          </Section>
          <MorphBlock className="emp-sb-section">
            <NavRow icon={LayoutTemplate} label="Templates" onClick={() => runCommand("templates.open")} />
            <NavRow icon={FileDown} label="Import" onClick={() => runCommand("import.open")} />
            <NavRow icon={Trash2} label="Trash" route={{ t: "trash" }} />
          </MorphBlock>
        </div>
        </LayoutGroup>
      </m.div>
      <SidebarFooter />
      {drag.drag ? (
        <div className="emp-drag-ghost" style={{ left: drag.drag.x + 14, top: drag.drag.y + 12 }} aria-hidden>
          <PageIcon icon={drag.drag.meta.icon} kind={drag.drag.meta.kind} size={16} />
          <span className="truncate">{drag.drag.meta.title || "Untitled"}</span>
        </div>
      ) : null}
    </div>
  );
});

function EmptyPagesHint() {
  const count = useTree((s) => s.byId.size);
  if (count > 0) return null;
  return (
    <button type="button" className="emp-sb-row text-tertiary" onClick={() => void createPageAndOpen(null)}>
      <span className="ico">
        <Plus aria-hidden />
      </span>
      <span className="label">New page</span>
    </button>
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
}

function NavRow({ icon: Icon, label, route, onClick, shortcut, trailing, match }: NavRowProps) {
  const current = useRoute();
  const active = route ? (match ? match(current) : routesEqual(route, current)) : false;
  return (
    <button
      type="button"
      className="emp-sb-row"
      aria-current={active ? "page" : undefined}
      onClick={(e) => (onClick ? onClick(e) : route && navigate(route))}
      onPointerEnter={route ? () => preloadRoute(route) : undefined}
    >
      <span className="ico">
        <Icon aria-hidden />
      </span>
      <span className="label">{label}</span>
      {trailing}
      {shortcut ? (
        <span className="trail kbd-hint">
          <Kbd keys={shortcut} size="xs" />
        </span>
      ) : null}
    </button>
  );
}

function PrimaryRows() {
  return (
    <nav className="emp-sb-primary" aria-label="Main">
      <SelectionSlab />
      <NavRow
        icon={Search}
        label="Search"
        shortcut="mod+k"
        onClick={(e) => {
          setPaletteOrigin(e.currentTarget);
          useUi.getState().openPalette("all");
        }}
      />
      <NavRow icon={House} label="Home" route={{ t: "home" }} />
      <NavRow icon={Calendar} label="Calendar" route={{ t: "calendar" }} />
    </nav>
  );
}

// ───────────────────────────────────────────────────────────────────────────── sections

function useSectionOpen(id: string): [boolean, () => void] {
  const key = `emp.sb.${id}`;
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) !== "0";
    } catch {
      return true;
    }
  });
  const toggle = () =>
    setOpen((o) => {
      try {
        localStorage.setItem(key, o ? "0" : "1");
      } catch {
        /* storage unavailable */
      }
      return !o;
    });
  return [open, toggle];
}

function Section({
  id,
  title,
  children,
  onAdd,
  addLabel,
  addShortcut,
  className,
  ...rest
}: {
  id: string;
  title: string;
  children: ReactNode;
  onAdd?: () => void;
  addLabel?: string;
  addShortcut?: string;
  className?: string;
  "data-drop-favorites"?: string;
}) {
  const [open, toggle] = useSectionOpen(id);
  const reduced = useReducedMotionPref();
  return (
    <m.section layout={reduced ? false : "position"} transition={spring.morph} className={cn("emp-sb-section", className)} aria-label={title} {...rest}>
      <div className="emp-sb-head" data-collapsed={open ? undefined : ""}>
        <button type="button" onClick={toggle} aria-expanded={open}>
          {title}
          <ChevronDown className="caret" aria-hidden />
        </button>
        {onAdd ? (
          <span className="actions">
            <Tooltip content={addLabel} shortcut={addShortcut}>
              <button type="button" className="emp-sb-mini" aria-label={addLabel} onClick={onAdd}>
                <Plus aria-hidden />
              </button>
            </Tooltip>
          </span>
        ) : null}
      </div>
      {/* Collapse is a layout morph (§5.4.5): the body pops out of flow and folds up while the sections below glide
          into place on the morph spring; expanding unfolds the rows from under the header. No height animation. */}
      <AnimatePresence initial={false} mode="popLayout">
        {open ? (
          <m.div
            key="body"
            className="emp-sb-sec-body flex flex-col gap-px"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: -8, scaleY: 0.96 }}
            animate={{ opacity: 1, y: 0, scaleY: 1, transition: reduced ? { duration: 0.12 } : { ...spring.morph, opacity: { duration: 0.2, ease: ease.out } } }}
            exit={reduced ? { opacity: 0, transition: { duration: 0.1 } } : { opacity: 0, y: -6, scaleY: 0.96, transition: { duration: 0.14, ease: ease.in } }}
          >
            {children}
          </m.div>
        ) : null}
      </AnimatePresence>
    </m.section>
  );
}

/** A plain block that rides the sections' layout morph. */
function MorphBlock({ className, children }: { className?: string; children: ReactNode }) {
  const reduced = useReducedMotionPref();
  return (
    <m.div layout={reduced ? false : "position"} transition={spring.morph} className={className}>
      {children}
    </m.div>
  );
}

// Favorites — sortable (dnd-kit, spring.layout-like transitions) and a drop target for tree rows.
function FavoritesSection({ dropActive, dragging }: { dropActive: boolean; dragging: boolean }) {
  const ids = useWorkspace(useShallow((s) => s.workspace?.favorites ?? []));
  const metas = useTree(useShallow((s) => ids.map((id) => s.byId.get(id)).filter((m): m is PageMeta => !!m)));
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const [ctxId, setCtxId] = useState<Id | null>(null);
  const ctxMeta = ctxId ? metas.find((m) => m.id === ctxId) : undefined;
  if (!metas.length && !dragging) return null;
  const onEnd = (e: DragEndEvent) => {
    const from = ids.indexOf(String(e.active.id));
    const to = e.over ? ids.indexOf(String(e.over.id)) : -1;
    if (from < 0 || to < 0 || from === to) return;
    void useWorkspace.getState().reorderFavorites(arrayMove(ids, from, to));
  };
  return (
    <Section id="favorites" title="Favorites" data-drop-favorites="" className={dropActive ? "rounded-md bg-selected shadow-[inset_0_0_0_1px_var(--accent-solid)]" : undefined}>
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
                  <FavoriteRow key={meta.id} meta={meta} ctxOpen={ctxId === meta.id} />
                ))}
              </SortableContext>
            </DndContext>
          </div>
        </ContextMenuTrigger>
        {ctxMeta ? (
          <ContextMenuContent width={264}>
            <PageContextItems actions={pageActions(ctxMeta)} />
          </ContextMenuContent>
        ) : null}
      </ContextMenu>
      {!metas.length ? <p className="px-2 py-1.5 text-caption text-tertiary">Drop a page here to pin it</p> : null}
    </Section>
  );
}

function FavoriteRow({ meta, ctxOpen }: { meta: PageMeta; ctxOpen: boolean }) {
  const route = useRoute();
  const active = route.t === "page" && route.id === meta.id;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: meta.id, transition: { duration: 380, easing: "var(--spring-morph)" } });
  const [menuOpen, setMenuOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const title = meta.title || "Untitled";
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
        transform: isDragging && transform ? `${CSS.Translate.toString(transform)} scale(1.03) rotate(-1deg)` : CSS.Translate.toString(transform),
        transition: isDragging ? "transform 60ms linear" : transition,
      }}
      onClick={(e) => (e.shiftKey ? useUi.getState().openPeek({ t: "page", id: meta.id }) : navigate({ t: "page", id: meta.id }))}
      onKeyDown={(e) => {
        if (e.key === "Enter") navigate({ t: "page", id: meta.id });
      }}
      onFocus={() => setArmed(true)}
      onPointerEnter={() => {
        preloadRoute({ t: "page", id: meta.id });
        setArmed(true);
      }}
    >
      <span className="ico">
        <PageIcon icon={meta.icon} kind={meta.kind} size={18} />
      </span>
      <span className="label">{title}</span>
      <span className="trail hover-only">
        <LazyMenu armed={armed} open={menuOpen} onOpenChange={setMenuOpen} label={`Actions for ${title}`}>
          <PageMenuItems actions={pageActions(meta)} />
        </LazyMenu>
      </span>
    </div>
  );
}

/** Markets is listed with the life apps once Portfolio is installed or a watchlist exists. */
function useShowMarkets(hasPortfolio: boolean): boolean {
  const [watchlist, setWatchlist] = useState(false);
  useEffect(() => {
    if (hasPortfolio) return;
    let live = true;
    api.watchlist
      .list({})
      .then((lists) => live && setWatchlist(lists.some((l) => l.symbols.length > 0)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [hasPortfolio]);
  return hasPortfolio || watchlist;
}

function LifeAppsSection() {
  const apps = useWorkspace((s) => s.lifeapps);
  const titles = useTree(useShallow((s) => apps.map((a) => s.byId.get(a.rootPageId)?.title ?? "")));
  const route = useRoute();
  const markets = useShowMarkets(apps.some((a) => a.appId === "portfolio" && !a.detached));
  return (
    <Section id="lifeapps" title="Life apps" onAdd={() => navigate({ t: "lifeapps" })} addLabel="Add a life app">
      {apps.map((inst, i) => {
        const id = lifeAppIdentity(inst.appId);
        const Icon = id.icon;
        const active = route.t === "app" && route.instanceId === inst.id;
        const r: AppRoute = { t: "app", instanceId: inst.id };
        return (
          <button
            key={inst.id}
            type="button"
            className="emp-sb-row"
            aria-current={active ? "page" : undefined}
            onClick={() => navigate(r)}
            onPointerEnter={() => preloadRoute(r)}
          >
            <span className="ico">
              <Icon aria-hidden />
            </span>
            <span className="label">{titles[i] || id.name}</span>
            {inst.upgradeAvailable ? <span className="h-1.5 w-1.5 flex-none rounded-full bg-accent" aria-label="Update available" /> : null}
          </button>
        );
      })}
      {markets ? <NavRow icon={CandlestickChart} label="Markets" route={{ t: "markets" }} match={(r) => r.t === "markets"} /> : null}
      {!apps.length ? <NavRow icon={Plus} label="Add a life app" route={{ t: "lifeapps" }} match={(r) => r.t === "lifeapps"} /> : null}
    </Section>
  );
}

// ───────────────────────────────────────────────────────────────────────────── workspace row

function WorkspaceGlyph({ ws, size = 22 }: { ws: Pick<Workspace, "name" | "icon"> | null; size?: number }) {
  // The workspace's initial (an emoji icon from an older vault is not shown: no emoji in the app's chrome).
  const letter = (ws?.name.trim()[0] ?? "U").toUpperCase();
  return (
    <span className="emp-ws-glyph" style={{ width: size, height: size, fontSize: size * 0.5 }} aria-hidden>
      {letter}
    </span>
  );
}

function WorkspaceRow() {
  const ws = useWorkspace((s) => s.workspace);
  const workspaces = useWorkspace((s) => s.workspaces);
  const encrypted = useVault((s) => !!s.status?.encrypted);
  const [dialog, setDialog] = useState<null | "new" | "rename">(null);
  return (
    <div className="emp-ws-row">
      <Menu>
        <MenuTrigger asChild>
          <button type="button" className="emp-ws-button" aria-label={`Workspace: ${ws?.name ?? ""}. Switch workspace`}>
            <WorkspaceGlyph ws={ws} />
            <span className="name">{ws?.name ?? "Workspace"}</span>
            <ChevronsUpDown size={14} className="chev flex-none text-tertiary" aria-hidden />
            {encrypted ? (
              <Tooltip content="Encrypted on this device">
                <Lock size={12} className="flex-none text-tertiary" aria-label="Encrypted" />
              </Tooltip>
            ) : null}
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
          <MenuItem icon={SquarePen} onSelect={() => setDialog("rename")}>
            Rename workspace…
          </MenuItem>
          <MenuItem icon={Settings} shortcut="mod+," onSelect={() => navigate({ t: "settings", section: "general" })}>
            Settings
          </MenuItem>
          {encrypted ? (
            <MenuItem icon={Lock} shortcut="mod+shift+l" onSelect={() => runCommand("vault.lock")}>
              Lock Ultra Note
            </MenuItem>
          ) : (
            <MenuItem icon={LockOpen} onSelect={() => navigate({ t: "settings", section: "security" })}>
              Turn on encryption…
            </MenuItem>
          )}
        </MenuContent>
      </Menu>
      <IconButton icon={SquarePen} label="New page" shortcut="mod+n" size="sm" onClick={() => void createPageAndOpen(null)} />
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
      description={mode === "new" ? "Workspaces keep separate page trees, favourites and life apps in the same vault." : undefined}
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
      <Tooltip content={encrypted ? "Encrypted on this device" : "Turn on encryption in Settings, Security"}>
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left text-caption text-tertiary hover:text-secondary" onClick={() => navigate({ t: "settings", section: "security" })}>
          <span className="emp-status-dot" data-tone={offline ? "off" : undefined} data-pulse={pulsing ? "" : undefined} aria-hidden />
          <span className="truncate">
            {offline ? "Offline" : "Local"} · {encrypted ? "Encrypted" : "Not encrypted"}
          </span>
        </button>
      </Tooltip>
      <IconButton size="xs" icon={Settings} label="Settings" shortcut="mod+," onClick={() => navigate({ t: "settings", section: "general" })} />
      {encrypted ? (
        <IconButton size="xs" icon={Lock} label="Lock Ultra Note" shortcut="mod+shift+l" onClick={() => runCommand("vault.lock")} />
      ) : (
        <IconButton size="xs" icon={LockOpen} label="Turn on encryption" onClick={() => navigate({ t: "settings", section: "security" })} />
      )}
    </footer>
  );
}
