/**
 * Side peek (§4.2 "Sheet or side peek"): any route (rows, pages opened with ⇧↵ / ⇧click) in a 720px sheet from the
 * right — `x 100%→0` on spring.gentle, exit 180ms. Non-modal, so the page behind stays usable; Esc closes it.
 */
import { ChartLine, Maximize2 } from "lucide-react";
import { useEffect, useRef, type ComponentType } from "react";
import { navigate, type AppRoute } from "@/app/router";
import { RouteView } from "@/app/routes";
import { isProject, useTree } from "@/stores/tree";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { Button } from "@/ui/Button";
import { Sheet } from "@/ui/Sheet";
import { PageIcon } from "./PageIcon";
import { lifeAppIdentity } from "./Sidebar/lifeAppIdentity";

/** What the peek shows: the page's icon and title, an app's name and glyph (rows opened from the sidebar), Markets. */
function PeekTitle({ route }: { route: AppRoute }) {
  const meta = useTree((s) => (route.t === "page" || route.t === "db" || route.t === "sheet" ? s.byId.get(route.id) : undefined));
  const appId = useWorkspace((s) => (route.t === "app" ? s.lifeapps.find((i) => i.id === route.instanceId)?.appId : undefined));
  const named = (Glyph: ComponentType<{ size?: number; "aria-hidden"?: boolean }>, name: string) => (
    <span className="flex min-w-0 items-center gap-1.5 text-body-sm font-medium text-secondary">
      <Glyph size={16} aria-hidden />
      <span className="truncate">{name}</span>
    </span>
  );
  if (appId) {
    const app = lifeAppIdentity(appId);
    return named(app.icon, app.name);
  }
  if (route.t === "markets") return named(ChartLine, "Markets");
  if (!meta) return <span className="text-body-sm text-tertiary">{route.t === "row" ? "Row" : "Preview"}</span>;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-body-sm font-medium text-secondary">
      <PageIcon icon={meta.icon} kind={meta.kind} project={isProject(meta)} size={16} />
      <span className="truncate">{meta.title || "Untitled"}</span>
    </span>
  );
}

/**
 * A peek opened from a menu ("Open in side peek") would close at once: the closing menu hands focus back to the row it
 * came from, which is outside the (non-modal) sheet. A dismissal in the first moments after opening is that hand-back,
 * not the user, so it is ignored.
 */
const SETTLE_MS = 400;

export function SidePeek() {
  const peek = useUi((s) => s.peek);
  const close = useUi((s) => s.closePeek);
  const openedAt = useRef(0);
  useEffect(() => {
    if (peek) openedAt.current = performance.now();
  }, [peek]);
  return (
    <Sheet
      open={!!peek}
      onOpenChange={(o) => {
        if (!o && performance.now() - openedAt.current > SETTLE_MS) close();
      }}
      size="wizard"
      scrim={false}
      className="emp-peek"
      bodyClassName="!p-0 emp-peek-body"
      header={
        peek ? (
          <div className="groove-bottom flex h-12 flex-none items-center gap-2 pl-4 pr-12">
            <PeekTitle route={peek} />
            <span className="flex-1" />
            <Button
              size="sm"
              variant="ghost"
              icon={Maximize2}
              onClick={() => {
                close();
                navigate(peek);
              }}
            >
              Open as page
            </Button>
          </div>
        ) : null
      }
    >
      {peek ? <RouteView route={peek} /> : null}
    </Sheet>
  );
}

export default SidePeek;
