/**
 * Right panel (§6.1): 320 wide, resizable 280–480, tabs Outline · Page info · Guide. Outline comes from
 * `page_outline` (refreshed on `page:changed`), Page info shows dates, kind and backlinks, and Guide hosts the
 * life-app checklists (ticks via `lifeapp_checklist_tick`).
 */
import { Check, LayoutGrid, Link2, ListTree, ScrollText, X } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { navigate, routePageId, useRoute } from "@/app/router";
import { api, listen } from "@/backend";
import type { Backlink, Id, LifeAppInstance, OutlineItem, PageMeta } from "@/backend/types";
import { formatDateTime, formatRelative } from "@/lib/dates";
import { notify } from "@/stores/toasts";
import { useTree } from "@/stores/tree";
import { useUi, type RightPanelTab } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { EmptyState } from "@/ui/EmptyState";
import { IconButton } from "@/ui/IconButton";
import { Progress } from "@/ui/Progress";
import { Resizable } from "@/ui/Resizable";
import { Skeleton } from "@/ui/Skeleton";
import { Tabs } from "@/ui/Tabs";
import { spring } from "@/ui/motion/tokens";
import { PageIcon } from "./PageIcon";
import { lifeAppIdentity } from "./Sidebar/lifeAppIdentity";

export function RightPanel() {
  const open = useUi((s) => s.rightPanelOpen);
  const tab = useUi((s) => s.rightPanelTab);
  const width = useUi((s) => s.rightPanelWidth);
  const [live, setLive] = useState(width);
  useEffect(() => setLive(width), [width]);
  const route = useRoute();
  const pageId = routePageId(route);
  const meta = useTree((s) => (pageId ? s.byId.get(pageId) : undefined));
  const instance = useWorkspace((s) =>
    route.t === "app" ? s.lifeapps.find((i) => i.id === route.instanceId) : meta?.appInstanceId ? s.lifeapps.find((i) => i.id === meta.appInstanceId) : undefined,
  );
  const available = !!meta || !!instance;

  return (
    <AnimatePresence initial={false}>
      {open && available ? (
        <m.div
          key="rp"
          className="h-full flex-none"
          initial={{ opacity: 0, x: 16 }}
          animate={{ opacity: 1, x: 0, transition: spring.ui }}
          exit={{ opacity: 0, x: 16, transition: { duration: 0.12 } }}
        >
          <Resizable side="left" width={live} min={280} max={480} defaultWidth={320} onWidthChange={setLive} onResizeEnd={(w) => useUi.getState().setRightPanelWidth(w)} className="h-full" aria-label="Resize panel">
            <aside className="emp-rpanel" data-region="panel" aria-label="Page panel">
              <div className="flex items-center gap-1 px-3 pt-1.5">
                <Tabs<RightPanelTab>
                  className="min-w-0 flex-1"
                  aria-label="Panel"
                  value={tab}
                  onValueChange={(t) => useUi.getState().setRightPanelTab(t)}
                  items={[
                    { value: "outline", label: "Outline", disabled: !meta },
                    { value: "info", label: "Page info", disabled: !meta },
                    { value: "guide", label: "Guide" },
                  ]}
                />
                <IconButton size="xs" icon={X} label="Close panel" onClick={() => useUi.getState().toggleRightPanel()} />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6 pt-3">
                {tab === "outline" && meta ? <OutlineTab meta={meta} /> : null}
                {tab === "info" && meta ? <InfoTab meta={meta} /> : null}
                {tab === "guide" || !meta ? <GuideTab instance={instance} /> : null}
              </div>
            </aside>
          </Resizable>
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}

function useRefreshOn(pageId: Id): number {
  const [n, setN] = useState(0);
  useEffect(() => listen("page:changed", (e) => e.id === pageId && setN((x) => x + 1)), [pageId]);
  return n;
}

function OutlineTab({ meta }: { meta: PageMeta }) {
  const [items, setItems] = useState<OutlineItem[] | null>(null);
  const bump = useRefreshOn(meta.id);
  useEffect(() => {
    let live = true;
    api.page
      .outline({ id: meta.id })
      .then((r) => live && setItems(r))
      .catch(() => live && setItems([]));
    return () => {
      live = false;
    };
  }, [meta.id, bump]);
  if (!items) return <PanelSkeleton />;
  if (!items.length) {
    return <EmptyState icon={ListTree} title="No headings yet" body="Add headings to this page and they'll appear here as an outline." className="!py-8" />;
  }
  return (
    <nav aria-label="Outline" className="flex flex-col gap-px">
      {items.map((it) => (
        <button
          key={it.blockId}
          type="button"
          className="emp-outline-item"
          style={{ paddingLeft: 8 + (it.level - 1) * 14, fontWeight: it.level === 1 ? 550 : 400, color: it.level === 1 ? "var(--text-primary)" : undefined }}
          onClick={() => navigate({ t: "page", id: meta.id, blockId: it.blockId }, { replace: true })}
        >
          {it.text || "Untitled heading"}
        </button>
      ))}
    </nav>
  );
}

function InfoTab({ meta }: { meta: PageMeta }) {
  const [links, setLinks] = useState<Backlink[] | null>(null);
  const bump = useRefreshOn(meta.id);
  const children = useTree((s) => s.children.get(meta.id)?.length ?? 0);
  useEffect(() => {
    let live = true;
    api.page
      .backlinks({ id: meta.id })
      .then((r) => live && setLinks(r))
      .catch(() => live && setLinks([]));
    return () => {
      live = false;
    };
  }, [meta.id, bump]);
  const kind = { doc: "Page", database: "Database", sheet: "Workbook", app: "Life app", dashboard: "Dashboard" }[meta.kind];
  return (
    <div className="flex flex-col gap-6">
      <dl>
        <div className="emp-info-row">
          <dt>Type</dt>
          <dd>{kind}</dd>
        </div>
        <div className="emp-info-row">
          <dt>Created</dt>
          <dd title={formatDateTime(meta.createdAt)}>{formatRelative(meta.createdAt)}</dd>
        </div>
        <div className="emp-info-row">
          <dt>Last edited</dt>
          <dd title={formatDateTime(meta.updatedAt)}>{formatRelative(meta.updatedAt)}</dd>
        </div>
        <div className="emp-info-row">
          <dt>Sub-pages</dt>
          <dd className="tabular">{children}</dd>
        </div>
        {meta.flags.locked ? (
          <div className="emp-info-row">
            <dt>Editing</dt>
            <dd>Locked</dd>
          </div>
        ) : null}
      </dl>
      <section aria-labelledby="bl-h">
        <h3 id="bl-h" className="mb-2 flex items-center gap-1.5 text-caption text-tertiary">
          <Link2 size={12} aria-hidden /> Backlinks {links ? <span className="tabular">· {links.length}</span> : null}
        </h3>
        {!links ? (
          <PanelSkeleton rows={2} />
        ) : links.length ? (
          <ul className="flex flex-col gap-1">
            {links.map((l, i) => (
              <li key={`${l.sourceId}${l.blockId ?? ""}${i}`}>
                <button
                  type="button"
                  className="flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-160 hover:bg-hover"
                  onClick={() => navigate({ t: "page", id: l.sourceId, blockId: l.blockId })}
                >
                  <span className="flex items-center gap-1.5 text-body-sm font-medium text-primary">
                    <PageIcon icon={l.sourceIcon} size={15} />
                    <span className="truncate">{l.sourceTitle || "Untitled"}</span>
                  </span>
                  {l.snippet ? <span className="line-clamp-2 text-caption text-tertiary" style={{ fontWeight: 400 }}>{l.snippet}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-2 text-body-sm text-tertiary">No pages link here yet. Type @ in another page to mention this one.</p>
        )}
      </section>
    </div>
  );
}

function GuideTab({ instance }: { instance?: LifeAppInstance }) {
  const all = useWorkspace((s) => s.lifeapps);
  const list = useMemo(() => (instance ? [instance] : all), [instance, all]);
  if (!list.length) {
    return (
      <EmptyState
        icon={LayoutGrid}
        title="Guides live in life apps"
        body="Install a life app and its setup checklist will show up here."
        actions={
          <button type="button" className="emp-link text-body-sm" onClick={() => navigate({ t: "lifeapps" })}>
            Browse life apps
          </button>
        }
        className="!py-8"
      />
    );
  }
  return (
    <div className="flex flex-col gap-6">
      {list.map((inst) => (
        <Checklist key={inst.id} inst={inst} />
      ))}
    </div>
  );
}

function Checklist({ inst }: { inst: LifeAppInstance }) {
  const id = lifeAppIdentity(inst.appId);
  const Icon = id.icon;
  const done = inst.checklist.filter((c) => c.done).length;
  const tick = async (itemId: string) => {
    useWorkspace.setState((s) => ({
      lifeapps: s.lifeapps.map((i) => (i.id === inst.id ? { ...i, checklist: i.checklist.map((c) => (c.id === itemId ? { ...c, done: true } : c)) } : i)),
    }));
    try {
      await api.lifeapp.checklistTick({ instanceId: inst.id, itemId });
    } catch (e) {
      notify.fromError(e, "Couldn't update the checklist");
      void useWorkspace.getState().refreshLifeapps();
    }
  };
  return (
    <section aria-label={`${id.name} guide`}>
      <div className="mb-2 flex items-center gap-2">
        <Icon size={16} strokeWidth={1.75} className="flex-none text-secondary" aria-hidden />
        <span className="flex-1 text-body-sm font-semibold text-primary">{id.name}</span>
        <span className="text-caption text-tertiary tabular">
          {done}/{inst.checklist.length}
        </span>
      </div>
      <Progress value={inst.checklist.length ? done / inst.checklist.length : 0} size={2} aria-label={`${done} of ${inst.checklist.length} done`} />
      {inst.checklist.length ? (
        <ul className="mt-2 flex flex-col">
          {inst.checklist.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                disabled={c.done}
                onClick={() => void tick(c.id)}
                className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left text-body-sm transition-colors duration-160 hover:bg-hover disabled:hover:bg-transparent"
              >
                <span
                  className="flex h-4 w-4 flex-none items-center justify-center rounded-full"
                  style={c.done ? { background: "var(--accent-solid)", color: "var(--accent-contrast)" } : { boxShadow: "inset 0 0 0 1.5px var(--border-strong)" }}
                  aria-hidden
                >
                  {c.done ? <Check size={10} strokeWidth={3} /> : null}
                </span>
                <span className={c.done ? "text-tertiary line-through decoration-[var(--text-disabled)]" : "text-primary"}>{c.label}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 flex items-center gap-1.5 text-caption text-tertiary">
          <ScrollText size={12} aria-hidden /> Nothing to set up.
        </p>
      )}
    </section>
  );
}

function PanelSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3 px-2 py-1" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} width={`${80 - ((i * 13) % 35)}%`} height={10} />
      ))}
    </div>
  );
}

export default RightPanel;
