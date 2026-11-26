/**
 * App shell (§6.1): sidebar (248, resizable 200–420, collapsible, hover-peek), top bar (44px), content, optional
 * right panel (320, 280–480) and the shell-level overlays (side peek, command palette, shortcuts, templates, import,
 * link confirmation). Below 900px the sidebar becomes a hover-peek overlay.
 */
import { m } from "motion/react";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { routeKey, routePageId, useRoute, type AppRoute } from "@/app/router";
import { CommandPaletteEntry, RouteOutlet } from "@/app/routes";
import { writeLockIdentity } from "@/features/vault/identity";
import { usePrivacy } from "@/stores/privacy";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { spring } from "@/ui/motion/tokens";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { ImportDialog } from "./ImportDialog";
import { OpenExternalPrompt } from "./OpenExternalPrompt";
import { RightPanel } from "./RightPanel";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { SidebarFrame } from "./Sidebar/Sidebar";
import { SidePeek } from "./SidePeek";
import { TemplatesDialog } from "./TemplatesDialog";
import { Topbar } from "./Topbar";
import "./shell.css";

const SENSITIVE_APPS = new Set(["money-hq", "portfolio", "tax-organizer"]);

function useCompact(): boolean {
  const q = "(max-width: 899px)";
  const [compact, setCompact] = useState(() => typeof window !== "undefined" && window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setCompact(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return compact;
}

const CommandPalette = CommandPaletteEntry.C;

export default function Shell() {
  const compact = useCompact();
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const width = useUi((s) => s.sidebarWidth);
  const reduced = useReducedMotionPref();
  const hidden = collapsed || compact;
  const scrollRef = useRef<HTMLDivElement>(null);
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
  }, [route, lifeapps]);

  const onRouteChange = useCallback((r: AppRoute) => {
    const el = scrollRef.current;
    if (el && !(r.t === "page" && r.blockId)) el.scrollTop = 0;
    setScrolled(false);
    const id = routePageId(r);
    if (id) useWorkspace.getState().touchRecent(id);
  }, []);

  return (
    <div className="emp-shell" style={{ ["--sb-w" as string]: `${width}px` }}>
      <SidebarFrame compact={compact} />
      <m.main
        className="emp-main"
        layout={reduced ? false : "position"}
        layoutDependency={hidden}
        transition={spring.ui}
        style={{ marginLeft: hidden ? 0 : "var(--sb-live-w, var(--sb-w))" }}
        data-route-key={routeKey(route)}
      >
        <Topbar sidebarHidden={hidden} compact={compact} scrolled={scrolled} />
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
      </m.main>
      <SidePeek />
      <ShortcutsDialog />
      <TemplatesDialog />
      <ImportDialog />
      <OpenExternalPrompt />
      <Suspense fallback={null}>
        <CommandPalette />
      </Suspense>
    </div>
  );
}
