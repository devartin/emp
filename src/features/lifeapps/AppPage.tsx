/**
 * Life-app route entry (`{t:'app'}` and app / dashboard pages). Money HQ, Portfolio and Tax Organizer render the
 * finance feature's hubs (same props); Spreadsheet Studio, Life OS and Habits render here. Generated dashboard pages
 * (e.g. Life OS "Today") open the hub on their tab. The wizard is mounted for tune-ups.
 */
import { LayoutGrid } from "lucide-react";
import { lazy, Suspense, useEffect, type ComponentType } from "react";
import { useShallow } from "zustand/react/shallow";
import type { Id } from "@/backend/types";
import { navigate, useRoute } from "@/app/router";
import { RouteSkeleton } from "@/features/shell/RouteSkeleton";
import { useTree } from "@/stores/tree";
import { useWorkspace } from "@/stores/workspace";
import { Button } from "@/ui/Button";
import { EmptyState } from "@/ui/EmptyState";
import { useInstance } from "./data";
import { claimHandoff, hasPendingHandoff } from "./handoff";
import { WizardSheet } from "./WizardSheet";
import "./lifeapps.css";

export interface AppPageProps {
  instanceId: Id;
  tab?: string;
}

type Hub = ComponentType<{ instanceId: Id; tab?: string }>;
const MoneyHQ = lazy(() => import("@/features/finance/MoneyHQ/MoneyHQ")) as unknown as Hub;
const PortfolioDashboard = lazy(() => import("@/features/portfolio/PortfolioDashboard")) as unknown as Hub;
const TaxHub = lazy(() => import("@/features/taxes/TaxHub")) as unknown as Hub;
const LifeOS = lazy(() => import("./apps/LifeOS"));
const Habits = lazy(() => import("./apps/Habits"));
const Studio = lazy(() => import("./apps/Studio"));

const FINANCE: Record<string, Hub> = { "money-hq": MoneyHQ, portfolio: PortfolioDashboard, "tax-organizer": TaxHub };

/** Generated dashboard pages map to hub tabs by their title. */
const PAGE_TABS: Record<string, Record<string, string>> = {
  "life-os": { today: "tasks" },
};

export default function AppPage({ instanceId, tab }: AppPageProps) {
  // `instanceId` may also be a page id when an app page has lost its instance (detached / uninstalled).
  const inst = useInstance(instanceId);
  const anyLoaded = useWorkspace((s) => !!s.workspace);
  const route = useRoute();
  const pageTitle = useTree(useShallow((s) => (route.t === "page" ? s.byId.get(route.id)?.title ?? null : null)));
  const instId = inst?.id;

  // S6 landing: once the hub has painted (its AppHeader tile exists, or the hub has had a moment to render), lift the
  // hand-off veil off this page and fly the build stage's tile into the header.
  useEffect(() => {
    if (!instId || !hasPendingHandoff(instId)) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = () => {
      const ready = document.querySelector("[data-app-tile]") || performance.now() - t0 > 900;
      if (ready) {
        raf = requestAnimationFrame(() => claimHandoff(instId));
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [instId]);

  if (!inst) {
    if (!anyLoaded) return <RouteSkeleton variant="dashboard" label="Loading app" />;
    return (
      <div className="flex h-full min-h-[480px] items-center justify-center p-8">
        <EmptyState
          icon={LayoutGrid}
          title="This life app isn’t installed"
          body="It may have been uninstalled. Its pages, if you kept them, are still in your sidebar."
          actions={
            <Button variant="primary" onClick={() => navigate({ t: "lifeapps" })}>
              Browse life apps
            </Button>
          }
        />
      </div>
    );
  }

  const derivedTab = tab ?? (route.t === "page" && route.id !== inst.rootPageId && pageTitle ? PAGE_TABS[inst.appId]?.[pageTitle.trim().toLowerCase()] : undefined);
  const Finance = FINANCE[inst.appId];
  let body;
  if (Finance) body = <Finance instanceId={inst.id} tab={derivedTab} />;
  else if (inst.appId === "life-os") body = <LifeOS instance={inst} tab={derivedTab} />;
  else if (inst.appId === "habits") body = <Habits instance={inst} tab={derivedTab} />;
  else if (inst.appId === "spreadsheet-studio") body = <Studio instance={inst} />;
  else
    body = (
      <div className="flex h-full min-h-[480px] items-center justify-center p-8">
        <EmptyState icon={LayoutGrid} title="Unknown life app" body={`“${inst.appId}” isn’t available in this version of Ultra Note.`} />
      </div>
    );

  return (
    <>
      {/* Life OS and Habits lead with a list, so their placeholder is a list (no stat-tile shapes). */}
      <Suspense fallback={<RouteSkeleton variant={inst.appId === "life-os" || inst.appId === "habits" ? "list" : "dashboard"} label="Loading app" />}>{body}</Suspense>
      <WizardSheet />
    </>
  );
}
