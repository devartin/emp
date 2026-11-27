/**
 * App shell (§6.1, brief §2): sidebar (248, resizable 200–420, hide/show, hover-peek), top bar (44px), content,
 * optional right panel (320, 280–480) and the shell-level overlays (side peek, command palette, shortcuts, templates,
 * import, project pickers, link confirmation). Below 900px the sidebar becomes an overlay.
 */
import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { routeKey, routePageId, useRoute, type AppRoute } from "@/app/router";
import { CommandPaletteEntry, RouteOutlet } from "@/app/routes";
import { writeLockIdentity } from "@/features/vault/identity";
import { usePrivacy } from "@/stores/privacy";
import { useTree } from "@/stores/tree";
import { useCompactWindow, useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { ProjectDialogs } from "@/features/projects/ProjectDialogs";
import { loadIconSet } from "./icons";
import { ImportDialog } from "./ImportDialog";
import { OpenExternalPrompt } from "./OpenExternalPrompt";
import { RightPanel } from "./RightPanel";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { SidebarFrame } from "./Sidebar/Sidebar";
import { SidePeek } from "./SidePeek";
import { TemplatesDialog } from "./TemplatesDialog";
import { Topbar } from "./Topbar";
import { SIDEBAR_MS, SIDEBAR_OUT_MS, flipX, useShellMotion } from "./shellMotion";
import "./shell.css";

const SENSITIVE_APPS = new Set(["money-hq", "portfolio", "tax-organizer"]);

const CommandPalette = CommandPaletteEntry.C;

export default function Shell() {
  const compact = useCompactWindow();
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const motion = useShellMotion();
  const hidden = collapsed || compact;
  const scrollRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  // The main column moves over as the sidebar slides (a FLIP: its margin changes at once, the transform glides back
  // to rest). The resting position is the margin, so a dropped animation never leaves it out of place.
  const wasHidden = useRef(hidden);
  useLayoutEffect(() => {
    if (wasHidden.current === hidden) return;
    wasHidden.current = hidden;
    if (!motion) return;
    const w = useUi.getState().sidebarWidth;
    flipX(mainRef.current, hidden ? w : -w, hidden ? SIDEBAR_OUT_MS : SIDEBAR_MS);
  }, [hidden, motion]);
  // The committed sidebar width is written imperatively: subscribing would re-render the whole shell (and the
  // route under it) at the end of every resize drag.
  useLayoutEffect(() => {
    const apply = (w: number) => shellRef.current?.style.setProperty("--sb-w", `${w}px`);
    apply(useUi.getState().sidebarWidth);
    return useUi.subscribe((st, prev) => {
      if (st.sidebarWidth !== prev.sidebarWidth) apply(st.sidebarWidth);
    });
  }, []);
  const [scrolled, setScrolled] = useState(false);
  const route = useRoute();
  const workspace = useWorkspace((s) => s.workspace);
  const lifeapps = useWorkspace((s) => s.lifeapps);

  // Lock screen identity (name + emoji only).
  useEffect(() => {
    if (workspace) writeLockIdentity(workspace);
  }, [workspace?.name, workspace?.icon]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sensitive views blur when the window loses focus (§9.23).
  useEffect(() => {
    const inst = route.t === "app" ? lifeapps.find((i) => i.id === route.instanceId) : undefined;
    usePrivacy.getState().setSensitiveView(!!inst && SENSITIVE_APPS.has(inst.appId));
    // An app inside a project (or any page) shows as selected in the sidebar: open its parents.
    if (inst) useTree.getState().reveal(inst.rootPageId);
  }, [route, lifeapps]);

  const onRouteChange = useCallback((r: AppRoute) => {
    const el = scrollRef.current;
    if (el && !(r.t === "page" && r.blockId)) el.scrollTop = 0;
    setScrolled(false);
    const id = routePageId(r);
    if (id) {
      useWorkspace.getState().touchRecent(id);
      // The page you are on is visible in the sidebar (its parents open), wherever it was created from.
      useTree.getState().reveal(id);
    }
    // Focus follows the route (N-FL4): when the element that had focus left with the old route, the content region
    // takes it, so the keyboard keeps working. A route that focuses its own input (Life OS) keeps that focus.
    requestAnimationFrame(() => {
      const ae = document.activeElement;
      if (!ae || ae === document.body || !ae.isConnected) el?.focus({ preventScroll: true });
    });
  }, []);

  // The full glyph set (page and app icons) loads once the shell is idle.
  useEffect(() => {
    const ric = window.requestIdleCallback ?? ((fn: () => void) => window.setTimeout(fn, 300));
    ric(() => void loadIconSet());
  }, []);

  return (
    <div ref={shellRef} className="emp-shell">
      {/* First focusable element: keyboard users skip the sidebar and top bar. A button, not a #fragment link,
          because the router owns the hash. */}
      <button
        type="button"
        className="emp-skip-link"
        onClick={() => {
          const el = scrollRef.current;
          const target = el?.querySelector<HTMLElement>("h1") ?? null;
          if (target && !target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
          (target ?? el)?.focus();
        }}
      >
        Skip to content
      </button>
      <SidebarFrame compact={compact} />
      <main ref={mainRef} className="emp-main" style={{ marginLeft: hidden ? 0 : "var(--sb-live-w, var(--sb-w))" }} data-route-key={routeKey(route)}>
        <Topbar sidebarHidden={hidden} scrolled={scrolled} />
        <div className="flex min-h-0 flex-1">
          <div
            ref={scrollRef}
            className="emp-content"
            data-region="content"
            tabIndex={-1}
            onScroll={(e) => {
              const s = e.currentTarget.scrollTop > 8;
              setScrolled((cur) => (cur === s ? cur : s));
            }}
          >
            <RouteOutlet onRouteChange={onRouteChange} />
          </div>
          <RightPanel />
        </div>
      </main>
      <SidePeek />
      <ShortcutsDialog />
      <TemplatesDialog />
      <ImportDialog />
      <OpenExternalPrompt />
      <ProjectDialogs />
      <Suspense fallback={null}>
        <CommandPalette />
      </Suspense>
    </div>
  );
}
