/**
 * Placeholder Home (owned by the home feature, §6.4): greeting, date and recent pages, so the shell has a real
 * landing screen until the full widget dashboard replaces this file.
 */
import { FileText } from "lucide-react";
import { m } from "motion/react";
import { useShallow } from "zustand/react/shallow";
import { navigate } from "@/app/router";
import { formatDate, formatRelative } from "@/lib/dates";
import { useSettings } from "@/stores/settings";
import { useTree } from "@/stores/tree";
import { useWorkspace } from "@/stores/workspace";
import { PageIcon } from "@/features/shell/PageIcon";
import { staggerItem, staggerList } from "@/ui/motion/presets";

function greeting(h: number) {
  if (h < 5) return "Good evening";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export default function HomePage() {
  const name = useSettings((s) => s.vault?.profileName?.trim());
  const recents = useWorkspace((s) => s.recents);
  const pages = useTree(useShallow((s) => recents.map((id) => s.byId.get(id)).filter((p) => !!p && !p.flags.template).slice(0, 8)));
  const now = new Date();
  return (
    <div className="mx-auto w-full max-w-[880px] px-12 pb-24 pt-16">
      <h1 className="text-h1 text-primary">{greeting(now.getHours())}{name ? `, ${name}` : ""}</h1>
      <p className="mt-1 text-body text-secondary">{formatDate(now, "full")}</p>
      <section className="mt-12" aria-labelledby="home-recent">
        <h2 id="home-recent" className="text-micro uppercase text-tertiary">Recent pages</h2>
        {pages.length ? (
          <m.ul className="mt-3 grid grid-cols-4 gap-3" variants={staggerList(0.03)} initial="hidden" animate="show">
            {pages.map((p) =>
              p ? (
                <m.li key={p.id} variants={staggerItem}>
                  <button
                    type="button"
                    onClick={() => navigate({ t: "page", id: p.id })}
                    className="group flex h-[100px] w-full flex-col justify-between rounded-xl border border-subtle bg-surface-1 p-3 text-left shadow-elev-1 transition-[translate,box-shadow] duration-160 ease-out hover:-translate-y-px hover:shadow-elev-2"
                  >
                    <PageIcon icon={p.icon} kind={p.kind} size={20} />
                    <span className="flex flex-col gap-0.5">
                      <span className="truncate text-body-sm font-medium text-primary">{p.title || "Untitled"}</span>
                      <span className="text-caption text-tertiary" style={{ fontWeight: 400 }}>{formatRelative(p.updatedAt)}</span>
                    </span>
                  </button>
                </m.li>
              ) : null,
            )}
          </m.ul>
        ) : (
          <p className="mt-3 flex items-center gap-2 text-body-sm text-tertiary">
            <FileText size={14} aria-hidden /> Pages you open will show up here.
          </p>
        )}
      </section>
    </div>
  );
}
