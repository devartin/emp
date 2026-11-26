/** Quick actions: the few things people start from Home. */
import { CalendarPlus, CheckSquare, FilePlus2, HeartPulse, Search, Sparkles } from "lucide-react";
import { m } from "motion/react";
import { api } from "@/backend";
import { navigate } from "@/app/router";
import { notify } from "@/stores/toasts";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { spring } from "@/ui/motion/tokens";
import { Kbd } from "@/ui/Kbd";

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
    { id: "page", label: "New page", icon: FilePlus2, kbd: "mod+n", run: newPage },
    { id: "task", label: "Add a task", icon: CheckSquare, run: () => (lifeos ? navigate({ t: "app", instanceId: lifeos.id, tab: "tasks" }) : navigate({ t: "lifeapps", appId: "life-os" })) },
    { id: "habits", label: "Check in", icon: HeartPulse, run: () => (habits ? navigate({ t: "app", instanceId: habits.id }) : navigate({ t: "lifeapps", appId: "habits" })) },
    { id: "event", label: "New event", icon: CalendarPlus, run: () => navigate({ t: "calendar" } as never) },
    { id: "apps", label: "Life apps", icon: Sparkles, run: () => navigate({ t: "lifeapps" }) },
    { id: "search", label: "Search", icon: Search, kbd: "mod+k", run: () => useUi.getState().openPalette() },
  ];
  return (
    <div className="hm-quick" role="toolbar" aria-label="Quick actions">
      {actions.map((a, i) => (
        <m.button key={a.id} type="button" className="hm-quick-btn" onClick={() => void a.run()} whileTap={{ scale: 0.97 }} transition={spring.snappy} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0, transition: { ...spring.gentle, delay: i * 0.03 } }}>
          <a.icon size={15} aria-hidden />
          <span>{a.label}</span>
          {a.kbd ? <Kbd keys={a.kbd} /> : null}
        </m.button>
      ))}
    </div>
  );
}
