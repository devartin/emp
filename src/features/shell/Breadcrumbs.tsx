/**
 * Breadcrumbs (§5.11): 28px ghost-sm items, "/" separators in tertiary. More than 4 levels collapse the middle into a
 * "…" menu. The current page's crumb opens an inline rename popover (title + icon live in the editor too).
 */
import { CalendarDays, ChartLine, ChevronRight, Ellipsis, House, LayoutGrid, Settings, Trash2, Calendar } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { navigate, routePageId, useRoute, type AppRoute } from "@/app/router";
import { api, listen } from "@/backend";
import type { Id, PageMeta } from "@/backend/types";
import { appIndexOf, isProject, selectAncestors, useTree, type AppIndex } from "@/stores/tree";
import { useWorkspace } from "@/stores/workspace";
import { Input } from "@/ui/Input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/Menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/Popover";
import { PageIcon } from "./PageIcon";
import { lifeAppIdentity } from "./Sidebar/lifeAppIdentity";
import { SECTIONS, resolveSection } from "@/features/settings/meta";

const SETTINGS_TITLES: Record<string, string> = {
  general: "General",
  appearance: "Appearance",
  accessibility: "Accessibility",
  security: "Security Center",
  integrations: "Integrations",
  connections: "Integrations",
  markets: "Market data",
  backups: "Backups & snapshots",
  shortcuts: "Keyboard shortcuts",
  about: "About",
};

interface Crumb {
  key: string;
  label: string;
  icon: ReactNode;
  route?: AppRoute;
  meta?: PageMeta;
}

/** Database id + title of the open row page (the route only carries the row id). */
function useRowInfo(rowId: Id | null): { databaseId: Id; title: string } | null {
  const [info, setInfo] = useState<{ id: Id; databaseId: Id; title: string } | null>(null);
  useEffect(() => {
    if (!rowId) return;
    let live = true;
    const load = async () => {
      try {
        const r = await api.db.rowGet({ id: rowId });
        const schema = await api.db.getSchema({ id: r.databaseId });
        const cell = r.row.values[schema.database.primaryPropId];
        const title = cell?.t === "text" && Array.isArray(cell.v) ? cell.v.map((x) => x?.text ?? "").join("") : "";
        if (live) setInfo({ id: rowId, databaseId: r.databaseId, title });
      } catch {
        if (live) setInfo(null);
      }
    };
    void load();
    const off = listen("db:changed", () => void load());
    return () => {
      live = false;
      off();
    };
  }, [rowId]);
  return info && info.id === rowId ? info : null;
}

/**
 * One crumb per page of the real parent chain (brief §2.3): a project's contents show the project, and an app's
 * pages show the app (by its display name, opening the app) and whatever holds it.
 */
function pageCrumb(m: PageMeta, apps: AppIndex, current: boolean): Crumb {
  const hub = apps.hubs.get(m.id);
  if (hub) {
    const id = lifeAppIdentity(hub.appId);
    const Glyph = id.icon;
    return { key: m.id, label: id.name, icon: <Glyph size={15} className="text-tertiary" aria-hidden />, route: { t: "app", instanceId: hub.instanceId } };
  }
  return { key: m.id, label: m.title || "Untitled", icon: <PageIcon icon={m.icon} kind={m.kind} project={isProject(m)} size={16} />, route: { t: "page", id: m.id }, meta: current ? m : undefined };
}

function useCrumbs(): Crumb[] {
  const route = useRoute();
  const row = useRowInfo(route.t === "row" ? route.id : null);
  const pageId = routePageId(route) ?? (route.t === "row" ? (row?.databaseId ?? null) : null);
  const lifeapps = useWorkspace((s) => s.lifeapps);
  const apps = useMemo(() => appIndexOf(lifeapps), [lifeapps]);
  const chain = useTree(
    useShallow((s) => {
      if (!pageId) return [] as PageMeta[];
      const cur = s.byId.get(pageId);
      return cur ? [...selectAncestors(s, pageId), cur] : [];
    }),
  );
  const app = lifeapps.find((i) => route.t === "app" && i.id === route.instanceId);
  // An app's hub can live inside a project (or any page): those come first.
  const appParents = useTree(useShallow((s) => (app ? selectAncestors(s, app.rootPageId) : ([] as PageMeta[]))));

  if (pageId) {
    if (!chain.length) return [{ key: "loading", label: "…", icon: null }];
    const pages = chain.map((m, i) => pageCrumb(m, apps, route.t !== "row" && i === chain.length - 1));
    return route.t === "row" ? [...pages, { key: "row", label: row?.title || "Untitled", icon: null }] : pages;
  }
  const ic = (I: typeof House) => <I size={15} className="text-tertiary" aria-hidden />;
  switch (route.t) {
    case "home":
      return [{ key: "home", label: "Home", icon: ic(House) }];
    case "today":
      return [{ key: "today", label: "Today", icon: ic(CalendarDays) }];
    case "calendar":
      return [{ key: "calendar", label: "Calendar", icon: ic(Calendar) }];
    case "trash":
      return [{ key: "trash", label: "Trash", icon: ic(Trash2) }];
    case "markets":
      return [
        { key: "markets", label: "Markets", icon: ic(ChartLine), route: { t: "markets" } },
        ...(route.symbol ? [{ key: route.symbol, label: route.symbol.split(":")[0], icon: null }] : []),
      ];
    case "lifeapps":
      return [{ key: "lifeapps", label: "Apps", icon: ic(LayoutGrid), route: { t: "lifeapps" } }];
    case "settings":
      return [
        { key: "settings", label: "Settings", icon: ic(Settings), route: { t: "settings", section: "general" } },
        { key: route.section, label: SETTINGS_TITLES[route.section] ?? SECTIONS.find((x) => x.id === resolveSection(route.section))?.title ?? route.section.replace(/^\w/, (c) => c.toUpperCase()), icon: null },
      ];
    case "app": {
      const id = app ? lifeAppIdentity(app.appId) : null;
      return [
        ...appParents.map((m) => pageCrumb(m, apps, false)),
        {
          key: "app",
          label: id?.name || "App",
          icon: ic(id?.icon ?? LayoutGrid),
          route: { t: "app", instanceId: route.instanceId },
        },
        ...(route.tab ? [{ key: route.tab, label: tabLabel(route.tab), icon: null }] : []),
      ];
    }
    case "row":
      return [{ key: "row", label: row?.title || "…", icon: null }];
    default:
      return [];
  }
}

export function Breadcrumbs() {
  const crumbs = useCrumbs();
  if (!crumbs.length) return null;
  const collapse = crumbs.length > 4;
  const visible = collapse ? [crumbs[0], null, ...crumbs.slice(-2)] : crumbs;
  const hidden = collapse ? crumbs.slice(1, -2) : [];
  return (
    <nav className="emp-crumbs no-drag" aria-label="Breadcrumbs">
      {/* Route changes are C0: the trail is simply the new trail, with no slide or stagger. */}
      {visible.map((c, i) => (
          <span key={c?.key ?? "more"} className="emp-crumb-slot">
            {i > 0 ? <ChevronRight className="emp-crumb-sep" size={13} strokeWidth={2} aria-hidden /> : null}
            {c === null ? (
              <Menu>
                <MenuTrigger asChild>
                  <button type="button" className="emp-crumb" aria-label={`${hidden.length} more`}>
                    <Ellipsis size={15} aria-hidden />
                  </button>
                </MenuTrigger>
                <MenuContent>
                  {hidden.map((h) => (
                    <MenuItem key={h.key} icon={h.icon} onSelect={() => h.route && navigate(h.route)}>
                      {h.label}
                    </MenuItem>
                  ))}
                </MenuContent>
              </Menu>
            ) : i === visible.length - 1 && c.meta ? (
              <CurrentCrumb crumb={c} meta={c.meta} />
            ) : (
              <button
                type="button"
                className="emp-crumb"
                aria-current={i === visible.length - 1 ? "page" : undefined}
                onClick={() => c.route && navigate(c.route)}
                disabled={!c.route}
              >
                {c.icon}
                <span>{c.label}</span>
              </button>
            )}
          </span>
        ))}
    </nav>
  );
}

function CurrentCrumb({ crumb, meta }: { crumb: Crumb; meta: PageMeta }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(meta.title);
  useEffect(() => {
    if (open) setTitle(meta.title);
  }, [open, meta.title]);
  const commit = () => {
    const next = title.trim();
    if (next !== meta.title) void useTree.getState().rename(meta.id, next.slice(0, 1024));
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={(o) => (o ? setOpen(true) : commit())}>
      <PopoverTrigger asChild>
        <button type="button" className="emp-crumb" aria-current="page" aria-label={`${crumb.label}, rename`}>
          {crumb.icon}
          <span>{crumb.label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] !p-2" align="start">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            commit();
          }}
        >
          <Input
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
            placeholder="Untitled"
            aria-label="Page title"
            icon={<PageIcon icon={meta.icon} kind={meta.kind} size={16} />}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
          />
        </form>
      </PopoverContent>
    </Popover>
  );
}

export default Breadcrumbs;

/** Tab ids that don't title-case cleanly. */
const TAB_LABELS: Record<string, string> = { networth: "Net worth", ips: "Investment policy" };

function tabLabel(tab: string): string {
  return TAB_LABELS[tab] ?? tab.replace(/[-_]/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
