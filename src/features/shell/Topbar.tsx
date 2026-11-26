/**
 * Top bar (§6.1): 44px drag region. Left: sidebar toggle (only while collapsed), back / forward (⌘[ / ⌘]),
 * breadcrumbs. Right: "Edited 2m ago" (3s after each save), Favorite, Export, Hide numbers, the lock indicator, the
 * right-panel toggle and the `…` page menu; custom caption buttons on Windows. Turns to glass once content scrolls
 * past 8px (§3.8).
 */
import { ArrowLeft, ArrowRight, Eye, EyeOff, PanelLeft, PanelRight } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useState } from "react";
import { runCommand } from "@/app/commands";
import { routePageId, useRoute } from "@/app/router";
import { listen } from "@/backend";
import { formatRelative } from "@/lib/dates";
import { isMac, isTauri } from "@/lib/platform";
import { selectCanGoBack, selectCanGoForward, useNav } from "@/stores/nav";
import { usePrivacy } from "@/stores/privacy";
import { useTree } from "@/stores/tree";
import { useUi } from "@/stores/ui";
import { IconButton } from "@/ui/IconButton";
import { ease, spring } from "@/ui/motion/tokens";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { Breadcrumbs } from "./Breadcrumbs";
import { ExportMenu, FavoriteButton, PageMoreMenu } from "./PageActions";
import { WindowControls } from "./WindowControls";

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
  /** Window narrower than 900px: the sidebar only peeks. */
  compact: boolean;
  scrolled: boolean;
}

export function Topbar({ sidebarHidden, compact, scrolled }: TopbarProps) {
  const route = useRoute();
  const canBack = useNav(selectCanGoBack);
  const canForward = useNav(selectCanGoForward);
  const pageId = routePageId(route);
  const meta = useTree((s) => (pageId ? s.byId.get(pageId) : undefined));
  const hidden = usePrivacy((s) => s.hidden);
  const rightOpen = useUi((s) => s.rightPanelOpen);
  const hasPanel = !!meta || route.t === "app";
  const trafficLights = isTauri && isMac && sidebarHidden;
  const reduced = useReducedMotionPref();

  return (
    <header className="emp-topbar drag-region" data-region="topbar" data-scrolled={scrolled ? "" : undefined} data-glass="" data-tauri-drag-region style={trafficLights ? { paddingLeft: 78 } : undefined}>
      <div className="no-drag flex items-center gap-0.5">
        {/* The toggle fades/slides in (opacity + x); the controls after it glide over with a layout (transform)
            animation — no width animation. popLayout takes the leaving toggle out of flow at once. */}
        <AnimatePresence initial={false} mode="popLayout">
          {sidebarHidden ? (
            <m.span
              key="sb"
              initial={reduced ? { opacity: 0 } : { opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, x: -10 }}
              transition={reduced ? { duration: 0.12 } : { ...spring.ui, opacity: { duration: 0.16, ease: ease.out } }}
              className="flex"
            >
              <span data-sidebar-toggle="" className="flex">
                <IconButton
                  size="sm"
                  icon={PanelLeft}
                  label="Show sidebar"
                  shortcut="mod+\"
                  onClick={() => {
                    const ui = useUi.getState();
                    if (compact) ui.setSidebarPeeking(!ui.sidebarPeeking);
                    else runCommand("sidebar.toggle");
                  }}
                />
              </span>
            </m.span>
          ) : null}
        </AnimatePresence>
        <m.span className="flex items-center gap-0.5" layout={reduced ? false : "position"} layoutDependency={sidebarHidden} transition={spring.ui}>
          <IconButton size="sm" icon={ArrowLeft} label="Back" shortcut="mod+[" disabled={!canBack} onClick={() => void useNav.getState().goBack()} />
          <IconButton size="sm" icon={ArrowRight} label="Forward" shortcut="mod+]" disabled={!canForward} onClick={() => void useNav.getState().goForward()} />
        </m.span>
      </div>
      <m.div className="ml-1 min-w-0 flex-shrink" layout={reduced ? false : "position"} layoutDependency={sidebarHidden} transition={spring.ui}>
        <Breadcrumbs />
      </m.div>
      <div className="grow" />
      <div className="no-drag flex items-center gap-0.5">
        {meta ? <EditedIndicator pageId={meta.id} /> : null}
        {meta ? <FavoriteButton meta={meta} /> : null}
        {meta ? <ExportMenu meta={meta} /> : null}
        <IconButton size="sm" icon={hidden ? EyeOff : Eye} active={hidden} label={hidden ? "Show numbers" : "Hide numbers"} shortcut="mod+shift+h" onClick={() => runCommand("privacy.toggle")} />
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
