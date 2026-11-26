/**
 * Route → view mapping (§12, CLAUDE.md). Every feature entry is a lazy chunk at a fixed path; feature owners replace
 * their placeholder file in place. A `page` route dispatches by `PageMeta.kind` (doc → PageView, database →
 * DatabasePage, sheet → SheetPage, app/dashboard → AppPage); an `app` route dispatches by the instance's life app.
 *
 *   <RouteOutlet />                 — the main pane: current route + page transitions (§4.2 "Page navigate")
 *   <RouteView route={…} />         — any route in isolation (side peek)
 *   preloadRoute(route)             — warm a chunk on hover / intent
 */
import { AnimatePresence, m } from "motion/react";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ComponentType, type LazyExoticComponent, type ReactNode, type RefObject } from "react";
import { useShallow } from "zustand/react/shallow";
import { FileQuestion, Trash2 } from "lucide-react";
import { api, hasCode } from "@/backend";
import type { Id, PageMeta } from "@/backend/types";
import { RouteErrorBoundary } from "@/features/shell/ErrorBoundary";
import { RouteSkeleton, type RouteSkeletonVariant } from "@/features/shell/RouteSkeleton";
import { useTree } from "@/stores/tree";
import { useWorkspace } from "@/stores/workspace";
import { Button } from "@/ui/Button";
import { EmptyState } from "@/ui/EmptyState";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { isViewTransitionActive } from "@/ui/motion/viewTransition";
import { useNav } from "@/stores/nav";
import { registerShellPreload } from "./boot";
import { navigate, routeKey, useRoute, type AppRoute } from "./router";
import { watchRouteReady } from "./routeReady";

// ───────────────────────────────────────────────────────────────────────────── lazy entries

type Loader<P> = () => Promise<{ default: ComponentType<P> }>;
interface Entry<P> {
  load: Loader<P>;
  C: LazyExoticComponent<ComponentType<P>>;
}
function entry<P>(load: Loader<P>): Entry<P> {
  let promise: Promise<{ default: ComponentType<P> }> | null = null;
  const once: Loader<P> = () => (promise ??= load().catch((e) => {
    promise = null; // allow a retry after a failed chunk download
    throw e;
  }));
  return { load: once, C: lazy(once) };
}

/* Shell chunk (§12): shell + editor. Shell.tsx itself is loaded by App.tsx through `shellEntry`. */
export const shellEntry = entry<Record<string, never>>(() => import("@/features/shell/Shell"));
const PageView = entry<{ pageId: Id; blockId?: string }>(() => import("@/features/editor/PageView"));
const HomePage = entry<Record<string, never>>(() => import("@/features/home/HomePage"));
const TrashPage = entry<Record<string, never>>(() => import("@/features/shell/TrashPage"));
/* Lazy feature chunks. */
const DatabasePage = entry<{ pageId: Id; viewId?: Id }>(() => import("@/features/databases/DatabasePage"));
const RowPage = entry<{ rowId: Id }>(() => import("@/features/databases/RowPage"));
const SheetPage = entry<{ pageId: Id; sheetId?: Id }>(() => import("@/features/sheets/SheetPage"));
const AppPage = entry<{ instanceId: Id; tab?: string }>(() => import("@/features/lifeapps/AppPage"));
const Gallery = entry<{ appId?: string }>(() => import("@/features/lifeapps/Gallery"));
const MoneyHQ = entry<{ instanceId: Id; tab?: string }>(() => import("@/features/finance/MoneyHQ/MoneyHQ"));
const PortfolioDashboard = entry<{ instanceId: Id; tab?: string }>(() => import("@/features/portfolio/PortfolioDashboard"));
const TaxHub = entry<{ instanceId: Id; tab?: string }>(() => import("@/features/taxes/TaxHub"));
const MarketsPage = entry<{ symbol?: string }>(() => import("@/features/markets/MarketsPage"));
const CalendarPage = entry<Record<string, never>>(() => import("@/features/calendar/CalendarPage"));
const SettingsPage = entry<{ section: string }>(() => import("@/features/settings/SettingsPage"));

/** Shell-level overlays that live in other features (mounted once by the shell). */
export const CommandPaletteEntry = entry<Record<string, never>>(() => import("@/features/search/CommandPalette"));

// Download the shell and editor while the KDF runs / onboarding plays (§12 boot.ts).
registerShellPreload(shellEntry.load);
registerShellPreload(PageView.load);
registerShellPreload(HomePage.load);
registerShellPreload(CommandPaletteEntry.load);

/** Life apps with a dedicated hub (§16); everything else uses the generic AppPage. */
const APP_HUBS: Record<string, Entry<{ instanceId: Id; tab?: string }>> = {
  "money-hq": MoneyHQ,
  portfolio: PortfolioDashboard,
  "tax-organizer": TaxHub,
};

function skeletonFor(route: AppRoute, kind?: PageMeta["kind"]): RouteSkeletonVariant {
  switch (route.t) {
    case "db":
      return "table";
    case "sheet":
      return "grid";
    case "app":
    case "lifeapps":
    case "markets":
      return "dashboard";
    case "calendar":
      return "calendar";
    case "settings":
      return "settings";
    case "trash":
      return "list";
    case "home":
      return "dashboard";
    case "page":
      return kind === "database" ? "table" : kind === "sheet" ? "grid" : kind === "app" || kind === "dashboard" ? "dashboard" : "doc";
    default:
      return "doc";
  }
}

/** Warm the chunk(s) a route needs (sidebar hover, palette highlight). */
export function preloadRoute(route: AppRoute): void {
  const run = (e: Entry<never> | Entry<any>) => void e.load().catch(() => undefined); // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (route.t) {
    case "page": {
      const meta = useTree.getState().byId.get(route.id);
      if (!meta || meta.kind === "doc") run(PageView);
      else if (meta.kind === "database") run(DatabasePage);
      else if (meta.kind === "sheet") run(SheetPage);
      else run(AppPage);
      break;
    }
    case "db":
      run(DatabasePage);
      break;
    case "row":
      run(RowPage);
      break;
    case "sheet":
      run(SheetPage);
      break;
    case "app": {
      const inst = useWorkspace.getState().lifeapps.find((i) => i.id === route.instanceId);
      run((inst && APP_HUBS[inst.appId]) || AppPage);
      break;
    }
    case "lifeapps":
      run(Gallery);
      break;
    case "markets":
      run(MarketsPage);
      break;
    case "calendar":
      run(CalendarPage);
      break;
    case "settings":
      run(SettingsPage);
      break;
    case "trash":
      run(TrashPage);
      break;
    case "today":
    case "home":
      run(HomePage);
      break;
    default:
      break;
  }
}

// ───────────────────────────────────────────────────────────────────────────── page-kind dispatch

type MetaState = { status: "ok"; meta: PageMeta } | { status: "loading" } | { status: "missing" } | { status: "error"; message: string };

/** Resolve a page's meta from the tree, falling back to `page_get_meta` (pages outside the tree, deep links). */
function usePageMeta(id: Id): MetaState {
  const fromTree = useTree((s) => s.byId.get(id));
  const [remote, setRemote] = useState<MetaState>({ status: "loading" });
  useEffect(() => {
    if (fromTree) return;
    let live = true;
    setRemote({ status: "loading" });
    api.page
      .getMeta({ ids: [id] })
      .then((list) => {
        if (!live) return;
        const meta = list.find((p) => p.id === id);
        setRemote(meta ? { status: "ok", meta } : { status: "missing" });
      })
      .catch((e) => {
        if (!live) return;
        setRemote(hasCode(e, "NOT_FOUND") ? { status: "missing" } : { status: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      live = false;
    };
  }, [id, fromTree]);
  return fromTree ? { status: "ok", meta: fromTree } : remote;
}

/** `#/today` is a legacy link: Home is the day, so it redirects there (today's note opens with ⌘⌥D or Home's link). */
function TodayRedirect() {
  useEffect(() => navigate({ t: "home" }, { replace: true }), []);
  return null;
}

function PageMissing({ deleted }: { deleted?: boolean }) {
  return (
    <div className="flex h-full min-h-[420px] w-full items-center justify-center p-8">
      <EmptyState
        icon={deleted ? Trash2 : FileQuestion}
        title={deleted ? "This page is in Trash" : "This page doesn't exist"}
        body={deleted ? "Restore it from Trash to keep working on it." : "It may have been deleted forever, or the link is from another workspace."}
        actions={
          <>
            <Button variant="primary" onClick={() => navigate({ t: deleted ? "trash" : "home" }, { replace: true })}>
              {deleted ? "Open Trash" : "Go home"}
            </Button>
          </>
        }
      />
    </div>
  );
}

function PageDispatch({ id, blockId }: { id: Id; blockId?: string }) {
  const state = usePageMeta(id);
  if (state.status === "loading") return <RouteSkeleton variant="doc" label="Loading page" />;
  if (state.status === "missing") return <PageMissing />;
  if (state.status === "error") return <PageMissing />;
  const meta = state.meta;
  if (meta.deletedAt) return <PageMissing deleted />;
  switch (meta.kind) {
    case "database":
      return <DatabasePage.C pageId={meta.id} />;
    case "sheet":
      return <SheetPage.C pageId={meta.id} />;
    case "app":
    case "dashboard":
      return <AppDispatch instanceId={meta.appInstanceId ?? meta.id} />;
    default:
      return <PageView.C pageId={meta.id} blockId={blockId} />;
  }
}

function AppDispatch({ instanceId, tab }: { instanceId: Id; tab?: string }) {
  const appId = useWorkspace(useShallow((s) => s.lifeapps.find((i) => i.id === instanceId)?.appId));
  const E = (appId && APP_HUBS[appId]) || AppPage;
  return <E.C instanceId={instanceId} tab={tab} />;
}

// ───────────────────────────────────────────────────────────────────────────── views

function renderRoute(route: AppRoute): ReactNode {
  switch (route.t) {
    case "page":
      return <PageDispatch id={route.id} blockId={route.blockId} />;
    case "row":
      return <RowPage.C rowId={route.id} />;
    case "db":
      return <DatabasePage.C pageId={route.id} viewId={route.viewId} />;
    case "sheet":
      return <SheetPage.C pageId={route.id} sheetId={route.sheetId} />;
    case "app":
      return <AppDispatch instanceId={route.instanceId} tab={route.tab} />;
    case "lifeapps":
      return <Gallery.C appId={route.appId} />;
    case "markets":
      return <MarketsPage.C symbol={route.symbol} />;
    case "calendar":
      return <CalendarPage.C />;
    case "settings":
      return <SettingsPage.C section={route.section || "general"} />;
    case "trash":
      return <TrashPage.C />;
    case "today":
      return <TodayRedirect />;
    case "home":
      return <HomePage.C />;
    default:
      return <HomePage.C />;
  }
}

export interface RouteViewProps {
  route: AppRoute;
  /** Main outlet only: emit `emp:route-ready` for this route's content inside this element (routeReady.ts). */
  readyHost?: RefObject<HTMLElement | null>;
}

/** Mounted inside the route's Suspense boundary, so its effect runs once the lazy chunk has resolved. */
function RouteReadyMark({ host, route }: { host: RefObject<HTMLElement | null>; route: string }) {
  useEffect(() => watchRouteReady(host.current, route), [host, route]);
  return null;
}

/** One route in isolation, with its own Suspense fallback and error boundary. */
export function RouteView({ route, readyHost }: RouteViewProps) {
  const kind = useTree((s) => (route.t === "page" ? s.byId.get(route.id)?.kind : undefined));
  const key = routeKey(route);
  return (
    <RouteErrorBoundary resetKey={key}>
      <Suspense fallback={<RouteSkeleton variant={skeletonFor(route, kind)} />}>
        {renderRoute(route)}
        {readyHost ? <RouteReadyMark host={readyHost} route={key} /> : null}
      </Suspense>
    </RouteErrorBoundary>
  );
}

type NavDir = "forward" | "back" | "lateral";
interface DirInfo {
  dir: NavDir;
  sign: number;
  reduced: boolean;
  instant: boolean;
}

/**
 * Route changes are C0 (PROGRAMME-v3 K3 motion register): the new route is present at its first frame and the old
 * one leaves at once. The direction is still inferred and mirrored to `:root[data-nav-dir]` for CSS.
 */
const routeVariants = {
  initial: { opacity: 1, x: 0 },
  enter: { opacity: 1, x: 0, transition: { duration: 0 } },
  exit: { opacity: 0, transition: { duration: 0 } },
};

/** Infer the navigation direction from the nav store and a short local history of route keys. */
function useNavDirection(key: string): DirInfo {
  const reduced = useReducedMotionPref();
  const lastChange = useNav((s) => s.lastChange);
  const visited = useRef<string[]>([key]);
  const info = useRef<DirInfo>({ dir: "forward", sign: 1, reduced, instant: false });
  const last = visited.current[visited.current.length - 1];
  if (last !== key) {
    const prior = visited.current[visited.current.length - 2];
    let dir: NavDir;
    if (lastChange === "back" || (lastChange === "browser" && prior === key)) dir = "back";
    else if (lastChange === "replace") dir = "lateral";
    else dir = "forward";
    if (dir === "back") visited.current.pop();
    else visited.current = [...visited.current, key].slice(-50);
    info.current = { dir, sign: 1, reduced, instant: isViewTransitionActive() };
  } else {
    info.current = { ...info.current, reduced };
  }
  return info.current;
}

/**
 * The main pane: the current route, swapped instantly (C0). `:root[data-nav-dir]` mirrors the navigation direction
 * for CSS. Sub-target changes (block anchors, tabs) keep the same key and don't remount.
 */
export function RouteOutlet({ onRouteChange }: { onRouteChange?: (route: AppRoute) => void }) {
  const route = useRoute();
  const key = routeKey(route);
  const dir = useNavDirection(key);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    onRouteChange?.(route);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-nav-dir", dir.dir);
  }, [dir]);
  return (
    <AnimatePresence mode="wait" initial={false} custom={dir}>
      <m.div
        key={key}
        ref={host}
        className="emp-route"
        data-route={route.t}
        custom={dir}
        variants={routeVariants}
        initial="initial"
        animate="enter"
        exit="exit"
      >
        <RouteView route={route} readyHost={host} />
      </m.div>
    </AnimatePresence>
  );
}
