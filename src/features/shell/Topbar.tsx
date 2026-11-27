/**
 * Top bar (§6.1, brief §2.3): 44px drag region. Left: "Show sidebar" (only while the sidebar is hidden), back /
 * forward (⌘[ / ⌘]), breadcrumbs. Right: "Edited 2m ago" (3s after each save), Favorite, Export, Hide numbers (only
 * on screens that show money), the right-panel toggle and the `…` page menu; custom caption buttons on Windows.
 *
 * The Show button fades in (CSS, so it is at rest even if no frame runs) and the controls after it glide over with a
 * FLIP that never writes their style (shellMotion.ts).
 */
import { ArrowLeft, ArrowRight, Eye, EyeOff, PanelLeft, PanelRight } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { runCommand, showSidebar } from "@/app/commands";
import { routePageId, useRoute } from "@/app/router";
import { listen } from "@/backend";
import { formatRelative } from "@/lib/dates";
import { isMac, isTauri } from "@/lib/platform";
import { selectCanGoBack, selectCanGoForward, useNav } from "@/stores/nav";
import { usePrivacy } from "@/stores/privacy";
import { useTree } from "@/stores/tree";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { IconButton } from "@/ui/IconButton";
import { Breadcrumbs } from "./Breadcrumbs";
import { ExportMenu, FavoriteButton, PageMoreMenu } from "./PageActions";
import { SIDEBAR_ID } from "./Sidebar/Sidebar";
import { SIDEBAR_MS, SIDEBAR_OUT_MS, flipX, useShellMotion } from "./shellMotion";
import { WindowControls } from "./WindowControls";
import { showsMoney } from "./moneyScreens";

function EditedIndicator({ pageId }: { pageId: string }) {
  const updatedAt = useTree((s) => s.byId.get(pageId)?.updatedAt);
  const [visibleUntil, setVisibleUntil] = useState(0);
  const [, force] = useState(0);
  useEffect(() => {
    setVisibleUntil(0);
    return listen("page:changed", (e) => {
      if (e.id !== pageId || e.docRev === undefined) return;
      setVisibleUntil(Date.now() + 3000);
      window.setTimeout(() => force((n) => n + 1), 3050);
    });
  }, [pageId]);
  const show = visibleUntil > Date.now();
  return (
    <AnimatePresence>
      {show && updatedAt ? (
        <m.span
          key="edited"
          className="emp-edited"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.16 } }}
          exit={{ opacity: 0, transition: { duration: 0.3 } }}
          aria-live="polite"
        >
          Edited {formatRelative(Math.min(updatedAt, Date.now()))}
        </m.span>
      ) : null}
    </AnimatePresence>
  );
}

export interface TopbarProps {
  /** The sidebar is collapsed or the window is compact. */
  sidebarHidden: boolean;
  scrolled: boolean;
}

export function Topbar({ sidebarHidden, scrolled }: TopbarProps) {
  const route = useRoute();
  const canBack = useNav(selectCanGoBack);
  const canForward = useNav(selectCanGoForward);
  const pageId = routePageId(route);
  const meta = useTree((s) => (pageId ? s.byId.get(pageId) : undefined));
  const hidden = usePrivacy((s) => s.hidden);
  const rightOpen = useUi((s) => s.rightPanelOpen);
  const hasPanel = !!meta || route.t === "app";
  const trafficLights = isTauri && isMac && sidebarHidden;
  const lifeapps = useWorkspace((s) => s.lifeapps);
  const owner = meta?.appInstanceId;
  const money = showsMoney(route, lifeapps, owner);
  const motion = useShellMotion();
  const navRef = useRef<HTMLSpanElement>(null);
  const crumbsRef = useRef<HTMLDivElement>(null);
  const wasHidden = useRef(sidebarHidden);
  // The Show button (28px + 2px gap) arrives or leaves: the controls after it glide over instead of jumping.
  useLayoutEffect(() => {
    if (wasHidden.current === sidebarHidden) return;
    wasHidden.current = sidebarHidden;
    if (!motion) return;
    const dx = sidebarHidden ? -30 : 30;
    const ms = sidebarHidden ? SIDEBAR_OUT_MS : SIDEBAR_MS;
    flipX(navRef.current, dx, ms);
    flipX(crumbsRef.current, dx, ms);
  }, [sidebarHidden, motion]);

  return (
    <header className="emp-topbar drag-region" data-region="topbar" data-scrolled={scrolled ? "" : undefined} data-glass="" data-tauri-drag-region style={trafficLights ? { paddingLeft: 78 } : undefined}>
      <div className="no-drag flex items-center gap-0.5">
        {sidebarHidden ? (
          <span data-sidebar-toggle="" className="emp-sb-show flex" data-motion={motion ? "" : undefined}>
            <IconButton
              size="sm"
              icon={PanelLeft}
              label="Show sidebar"
              shortcut="mod+\"
              aria-controls={SIDEBAR_ID}
              aria-expanded={false}
              onClick={() => {
                showSidebar();
                // The button goes away: focus moves to the sidebar's own toggle.
                window.setTimeout(() => document.querySelector<HTMLElement>('aside.emp-sidebar [data-sidebar-toggle] button')?.focus({ preventScroll: true }), 0);
              }}
            />
          </span>
        ) : null}
        <span ref={navRef} className="flex items-center gap-0.5">
          <IconButton size="sm" icon={ArrowLeft} label="Back" shortcut="mod+[" disabled={!canBack} onClick={() => void useNav.getState().goBack()} />
          <IconButton size="sm" icon={ArrowRight} label="Forward" shortcut="mod+]" disabled={!canForward} onClick={() => void useNav.getState().goForward()} />
        </span>
      </div>
      <div ref={crumbsRef} className="ml-1 min-w-0 flex-shrink">
        <Breadcrumbs />
      </div>
      <div className="grow" />
      <div className="no-drag flex items-center gap-0.5">
        {meta ? <EditedIndicator pageId={meta.id} /> : null}
        {meta ? <FavoriteButton meta={meta} /> : null}
        {meta ? <ExportMenu meta={meta} /> : null}
        {money ? <IconButton size="sm" icon={hidden ? EyeOff : Eye} active={hidden} label={hidden ? "Show numbers" : "Hide numbers"} shortcut="mod+shift+h" onClick={() => runCommand("privacy.toggle")} /> : null}
        {hasPanel ? (
          <IconButton size="sm" icon={PanelRight} active={rightOpen} label={rightOpen ? "Hide panel" : "Show panel"} onClick={() => runCommand("panel.toggle")} />
        ) : null}
        {meta ? <PageMoreMenu meta={meta} /> : null}
      </div>
      <WindowControls className="-mr-2 ml-1" />
    </header>
  );
}

export default Topbar;
