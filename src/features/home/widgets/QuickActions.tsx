/** Quick actions: the few things people start from Home. */
import { CalendarPlus, CheckSquare, FilePlus2, HeartPulse, Search, Sparkles } from "lucide-react";
import { api } from "@/backend";
import { navigate } from "@/app/router";
import { notify } from "@/stores/toasts";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { Button, type IconMotion } from "@/ui/Button";
import { setPaletteOrigin } from "@/features/search/origin";

export function QuickActionsWidget() {
  const ws = useWorkspace((s) => s.workspace);
  const apps = useWorkspace((s) => s.lifeapps);
  const lifeos = apps.find((a) => a.appId === "life-os" && !a.detached);
  const habits = apps.find((a) => a.appId === "habits" && !a.detached);
  const newPage = async () => {
    if (!ws) return;
    try {
      const p = await api.page.create({ workspaceId: ws.id, parentId: null, kind: "doc", title: "" });
      navigate({ t: "page", id: p.meta.id });
    } catch (e) {
      notify.fromError(e, "Couldn’t create a page");
    }
  };
  const actions = [
    { id: "page", label: "New page", icon: FilePlus2, kbd: "mod+n", run: newPage, primary: true, motion: "plus" as IconMotion },
    { id: "task", label: "Add a task", icon: CheckSquare, run: () => (lifeos ? navigate({ t: "app", instanceId: lifeos.id, tab: "tasks" }) : navigate({ t: "lifeapps", appId: "life-os" })) },
    { id: "habits", label: "Check in", icon: HeartPulse, run: () => (habits ? navigate({ t: "app", instanceId: habits.id }) : navigate({ t: "lifeapps", appId: "habits" })) },
    { id: "event", label: "New event", icon: CalendarPlus, run: () => navigate({ t: "calendar" } as never) },
    { id: "apps", label: "Life apps", icon: Sparkles, run: () => navigate({ t: "lifeapps" }), motion: "sparkle" as IconMotion },
    { id: "search", label: "Search", icon: Search, kbd: "mod+k", run: (el?: HTMLElement) => (setPaletteOrigin(el), useUi.getState().openPalette()), motion: "search" as IconMotion },
  ] as { id: string; label: string; icon: typeof Search; kbd?: string; run: (el?: HTMLElement) => unknown; primary?: boolean; motion?: IconMotion }[];
  return (
    <div className="hm-quick-wrap">
    <div className="hm-quick" role="toolbar" aria-label="Quick actions">
      {actions.map((a) => (
        <Button key={a.id} data-qa={a.id} variant={a.primary ? "primary" : "secondary"} size="md" icon={a.icon} iconMotion={a.motion} kbd={a.kbd} onClick={(e) => void a.run(e.currentTarget)}>
          {a.label}
        </Button>
      ))}
    </div>
    </div>
  );
}
