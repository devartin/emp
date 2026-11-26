/**
 * Side peek (§4.2 "Sheet or side peek"): any route (rows, pages opened with ⇧↵ / ⇧click) in a 720px sheet from the
 * right — `x 100%→0` on spring.gentle, exit 180ms. Non-modal, so the page behind stays usable; Esc closes it.
 */
import { Maximize2 } from "lucide-react";
import { navigate, type AppRoute } from "@/app/router";
import { RouteView } from "@/app/routes";
import { useTree } from "@/stores/tree";
import { useUi } from "@/stores/ui";
import { Button } from "@/ui/Button";
import { Sheet } from "@/ui/Sheet";
import { PageIcon } from "./PageIcon";

function PeekTitle({ route }: { route: AppRoute }) {
  const meta = useTree((s) => (route.t === "page" || route.t === "db" || route.t === "sheet" ? s.byId.get(route.id) : undefined));
  if (!meta) return <span className="text-body-sm text-tertiary">{route.t === "row" ? "Row" : "Preview"}</span>;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-body-sm font-medium text-secondary">
      <PageIcon icon={meta.icon} kind={meta.kind} size={16} />
      <span className="truncate">{meta.title || "Untitled"}</span>
    </span>
  );
}

export function SidePeek() {
  const peek = useUi((s) => s.peek);
  const close = useUi((s) => s.closePeek);
  return (
    <Sheet
      open={!!peek}
      onOpenChange={(o) => !o && close()}
      size="wizard"
      scrim={false}
      className="emp-peek"
      bodyClassName="!p-0 emp-peek-body"
      header={
        peek ? (
          <div className="flex h-12 flex-none items-center gap-2 border-b border-subtle pl-4 pr-12">
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
