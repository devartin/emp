/**
 * Trash (§11.3 trash_list / page_restore / page_purge / trash_empty). Deleted pages grouped by when they were
 * deleted, with their original location; restore (back to the original parent, or the top level if it's gone),
 * delete forever (confirmed), and Empty trash (job with progress). Pages are purged after the retention window.
 * Ruled, not boxed: one 36px row per page, and rows leave the list at once (C0).
 */
import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { navigate } from "@/app/router";
import { api, latestRequest } from "@/backend";
import type { Id, PageMeta } from "@/backend/types";
import { formatRelative, isToday } from "@/lib/dates";
import { useSettings } from "@/stores/settings";
import { notify } from "@/stores/toasts";
import { useTree } from "@/stores/tree";
import { useWorkspace } from "@/stores/workspace";
import { AlertDialog } from "@/ui/AlertDialog";
import { Button } from "@/ui/Button";
import { EmptyState } from "@/ui/EmptyState";
import { IconButton } from "@/ui/IconButton";
import { SearchField } from "@/ui/SearchField";
import { PageIcon } from "./PageIcon";
import "./shell.css";

const DAY = 86_400_000;

function groupOf(ts: number, now: number): string {
  if (isToday(ts)) return "Today";
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const start = d.getTime();
  if (ts >= start - DAY) return "Yesterday";
  if (ts >= start - 6 * DAY) return "Earlier this week";
  if (ts >= start - 29 * DAY) return "Earlier this month";
  return "Older";
}

export default function TrashPage() {
  const wsId = useWorkspace((s) => s.workspace?.id);
  const retention = useSettings((s) => s.vault?.trashRetentionDays ?? 30);
  const [items, setItems] = useState<PageMeta[] | null>(null);
  const [q, setQ] = useState("");
  const [confirm, setConfirm] = useState<null | { kind: "one"; meta: PageMeta } | { kind: "all" }>(null);
  const [emptying, setEmptying] = useState<number | null>(null);
  const latest = useMemo(() => latestRequest(), []);

  const load = useCallback(
    (query: string) => {
      if (!wsId) return;
      const reqId = latest.next();
      api.trash
        .list({ workspaceId: wsId, q: query.trim() || undefined })
        .then((r) => latest.isLatest(reqId) && setItems(r))
        .catch((e) => {
          if (latest.isLatest(reqId)) setItems([]);
          notify.fromError(e, "Couldn't load Trash");
        });
    },
    [latest, wsId],
  );

  useEffect(() => {
    const t = window.setTimeout(() => load(q), q ? 120 : 0);
    return () => window.clearTimeout(t);
  }, [load, q]);

  const byId = useTree((s) => s.byId);
  const now = Date.now();
  const groups = useMemo(() => {
    const out: { label: string; items: PageMeta[] }[] = [];
    for (const p of items ?? []) {
      const label = groupOf(p.deletedAt ?? now, now);
      const g = out.find((x) => x.label === label);
      if (g) g.items.push(p);
      else out.push({ label, items: [p] });
    }
    return out;
  }, [items, now]);

  const removeLocal = (ids: Id[]) => setItems((cur) => (cur ? cur.filter((p) => !ids.includes(p.id)) : cur));

  const restore = async (meta: PageMeta) => {
    removeLocal([meta.id]);
    try {
      const restored = await api.page.restore({ ids: [meta.id] });
      useTree.getState().upsert(restored);
      const main = restored.find((r) => r.id === meta.id) ?? restored[0];
      if (main) useTree.getState().reveal(main.id);
      const parent = main?.parentId ? useTree.getState().byId.get(main.parentId) : null;
      notify.success(`Restored “${meta.title || "Untitled"}”`, {
        description: parent ? `Back in ${parent.title || "Untitled"}.` : "Back at the top level of Pages.",
        action: main ? { label: "Open", onClick: () => navigate({ t: "page", id: main.id }) } : undefined,
      });
    } catch (e) {
      notify.fromError(e, "Couldn't restore the page");
      load(q);
    }
  };

  const purge = async (meta: PageMeta) => {
    removeLocal([meta.id]);
    try {
      await api.page.purge({ ids: [meta.id] });
      notify.info(`Deleted “${meta.title || "Untitled"}” forever`);
    } catch (e) {
      notify.fromError(e, "Couldn't delete the page");
      load(q);
    }
  };

  const emptyTrash = async () => {
    if (!wsId) return;
    setEmptying(0);
    try {
      const job = await api.trash.empty({ workspaceId: wsId, onEvent: (e) => e.kind === "progress" && setEmptying(e.total ? e.done / e.total : 0) });
      const { purged } = await job.result;
      setItems([]);
      notify.success("Trash emptied", { description: `${purged} ${purged === 1 ? "page" : "pages"} deleted forever.` });
    } catch (e) {
      notify.fromError(e, "Couldn't empty Trash");
      load(q);
    } finally {
      setEmptying(null);
    }
  };

  const count = items?.length ?? 0;

  return (
    <div className="mx-auto w-full max-w-[720px] px-6 pb-24 pt-14">
      <div className="flex items-start gap-4">
        <div className="flex-1">
          <h1 className="text-h1 text-primary">Trash</h1>
          <p className="mt-1 text-body-sm text-secondary">Pages here are deleted forever after {retention} days.</p>
        </div>
        <Button variant="ghost" disabled={!count || emptying !== null} loading={emptying !== null} onClick={() => setConfirm({ kind: "all" })}>
          Empty trash
        </Button>
      </div>
      <div className="mt-6">
        <SearchField value={q} onChange={(e) => setQ(e.currentTarget.value)} onClear={() => setQ("")} placeholder="Search trash" shortcut={null} aria-label="Search trash" />
      </div>

      {/* Until the list arrives the route reports busy (routeReady.ts), so it appears whole at its first frame. */}
      {items === null ? (
        <span data-route-busy="" hidden />
      ) : count === 0 ? (
          <div className="mt-10">
            <EmptyState
              icon={Trash2}
              title={q ? "Nothing matches" : "Trash is empty"}
              body={q ? `No deleted pages match “${q}”.` : "Deleted pages stay here until you restore them or they expire."}
            />
          </div>
        ) : (
          <div className="mt-2">
            {groups.map((g) => (
              <section key={g.label} aria-label={g.label}>
                <h2 className="emp-trash-group">{g.label}</h2>
                <ul>
                  {g.items.map((p) => {
                    const parent = p.parentId ? byId.get(p.parentId) : null;
                    const from = parent ? parent.title || "Untitled" : p.parentId ? "a deleted page" : "Pages";
                    const when = formatRelative(p.deletedAt ?? now);
                    return (
                      <li key={p.id} className="emp-trash-row" tabIndex={0} aria-label={`${p.title || "Untitled"}, deleted ${when}, from ${from}`}>
                        <span className="emp-trash-glyph">
                          <PageIcon icon={p.icon} kind={p.kind} size={16} />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-body text-primary">{p.title || "Untitled"}</span>
                        <span className="emp-trash-meta">
                          {p.hasChildren ? "With sub-pages · " : ""}
                          {from} · {when}
                        </span>
                        <span className="actions">
                          <Button size="sm" variant="ghost" onClick={() => restore(p)}>
                            Restore
                          </Button>
                          <IconButton size="sm" variant="destructive-ghost" icon={Trash2} label="Delete forever" onClick={() => setConfirm({ kind: "one", meta: p })} />
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}

      <AlertDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        tone="danger"
        title={confirm?.kind === "all" ? `Delete ${count} ${count === 1 ? "page" : "pages"} forever?` : `Delete “${confirm?.kind === "one" ? confirm.meta.title || "Untitled" : ""}” forever?`}
        description={
          confirm?.kind === "all"
            ? "Everything in Trash, including sub-pages and attachments only they use, is removed from this device. This can't be undone."
            : "The page, its sub-pages and attachments only they use are removed from this device. This can't be undone."
        }
        confirmLabel="Delete forever"
        onConfirm={async () => {
          const c = confirm;
          setConfirm(null);
          if (c?.kind === "all") await emptyTrash();
          else if (c?.kind === "one") await purge(c.meta);
        }}
      />
    </div>
  );
}
