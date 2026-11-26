/** Recent pages (§6.4 row 4): 4 columns of 160×100 cards. */
import { Clock } from "lucide-react";
import { m } from "motion/react";
import { useShallow } from "zustand/react/shallow";
import { navigate } from "@/app/router";
import { formatRelative } from "@/lib/dates";
import { useTree } from "@/stores/tree";
import { useWorkspace } from "@/stores/workspace";
import { PageIcon } from "@/features/shell/PageIcon";
import { staggerItem, staggerList } from "@/ui/motion/presets";

export function RecentWidget() {
  const recents = useWorkspace((s) => s.recents);
  const pages = useTree(useShallow((s) => recents.map((id) => s.byId.get(id)).filter((p): p is NonNullable<typeof p> => !!p && !p.flags.template && !p.deletedAt).slice(0, 8)));
  return (
    <div className="flex h-full flex-col gap-3">
      <h2 className="hm-title"><Clock size={15} aria-hidden />Recent</h2>
      {pages.length ? (
        <m.ul className="hm-recent" variants={staggerList(0.03)} initial="hidden" animate="show">
          {pages.map((p) => (
            <m.li key={p.id} variants={staggerItem}>
              <button type="button" className="hm-recent-card" onClick={() => navigate({ t: "page", id: p.id })}>
                <PageIcon icon={p.icon} kind={p.kind} size={20} />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-body-sm font-medium text-primary">{p.title || "Untitled"}</span>
                  <span className="text-caption text-tertiary" style={{ fontWeight: 400 }}>{formatRelative(p.updatedAt)}</span>
                </span>
              </button>
            </m.li>
          ))}
        </m.ul>
      ) : (
        <p className="text-body-sm text-tertiary">Pages you open will show up here.</p>
      )}
    </div>
  );
}
