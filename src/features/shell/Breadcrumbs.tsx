/**
 * Breadcrumbs (§5.11): 28px ghost-sm items, "/" separators in tertiary. More than 4 levels collapse the middle into a
 * "…" menu. The current page's crumb opens an inline rename popover (title + icon live in the editor too).
 */
import { CalendarDays, CandlestickChart, Ellipsis, House, Settings, Sparkles, Trash2, Calendar } from "lucide-react";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { navigate, routePageId, useRoute, type AppRoute } from "@/app/router";
import type { PageMeta } from "@/backend/types";
import { selectAncestors, useTree } from "@/stores/tree";
import { useWorkspace } from "@/stores/workspace";
import { Input } from "@/ui/Input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/Menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/Popover";
import { PageIcon } from "./PageIcon";
import { lifeAppIdentity } from "./Sidebar/lifeAppIdentity";

const SETTINGS_TITLES: Record<string, string> = {
  general: "General",
  appearance: "Appearance",
  accessibility: "Accessibility",
  security: "Security Center",
  integrations: "Integrations",
  connections: "Integrations",
  markets: "Market data",
  backups: "Backups",
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

function useCrumbs(): Crumb[] {
  const route = useRoute();
  const pageId = routePageId(route) ?? (route.t === "row" ? null : null);
  const chain = useTree(
    useShallow((s) => {
      if (!pageId) return [] as PageMeta[];
      const cur = s.byId.get(pageId);
      return cur ? [...selectAncestors(s, pageId), cur] : [];
    }),
  );
  const app = useWorkspace(useShallow((s) => (route.t === "app" ? s.lifeapps.find((i) => i.id === route.instanceId) : undefined)));
  const appTitle = useTree((s) => (app ? s.byId.get(app.rootPageId)?.title : undefined));

  if (pageId) {
    if (!chain.length) return [{ key: "loading", label: "…", icon: null }];
    return chain.map((m) => ({ key: m.id, label: m.title || "Untitled", icon: <PageIcon icon={m.icon} kind={m.kind} size={16} />, route: { t: "page", id: m.id }, meta: m }));
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
        { key: "markets", label: "Markets", icon: ic(CandlestickChart), route: { t: "markets" } },
        ...(route.symbol ? [{ key: route.symbol, label: route.symbol.split(":")[0], icon: null }] : []),
      ];
    case "lifeapps":
      return [{ key: "lifeapps", label: "Life apps", icon: ic(Sparkles), route: { t: "lifeapps" } }];
    case "settings":
      return [
        { key: "settings", label: "Settings", icon: ic(Settings), route: { t: "settings", section: "general" } },
        { key: route.section, label: SETTINGS_TITLES[route.section] ?? route.section.replace(/^\w/, (c) => c.toUpperCase()), icon: null },
      ];
    case "app": {
      const id = app ? lifeAppIdentity(app.appId) : null;
      const Icon = id?.icon ?? Sparkles;
      return [
        {
          key: "app",
          label: appTitle || id?.name || "Life app",
          icon: (
            <span className="emp-app-tile" style={{ background: id?.color ?? "var(--text-tertiary)" }}>
              <Icon aria-hidden strokeWidth={2.25} />
            </span>
          ),
          route: { t: "app", instanceId: route.instanceId },
        },
        ...(route.tab ? [{ key: route.tab, label: route.tab.replace(/[-_]/g, " ").replace(/^\w/, (c) => c.toUpperCase()), icon: null }] : []),
      ];
    }
    case "row":
      return [{ key: "row", label: "Row", icon: null }];
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
      {visible.map((c, i) => (
        <Fragment key={c?.key ?? "more"}>
          {i > 0 ? (
            <span className="emp-crumb-sep" aria-hidden>
              /
            </span>
          ) : null}
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
        </Fragment>
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
