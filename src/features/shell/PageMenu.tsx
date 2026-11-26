/**
 * Page actions shared by the sidebar row context menu, its `…` button and the top bar's page menu. One list of
 * descriptors, rendered with either the dropdown or the context-menu parts (same skin, §5.6).
 */
import { Copy, CornerUpLeft, FilePlus2, Link, PanelRight, Pencil, Star, StarOff, Trash2 } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { navigate } from "@/app/router";
import type { Id, PageMeta } from "@/backend/types";
import { notify } from "@/stores/toasts";
import { useTree } from "@/stores/tree";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { ContextMenuItem, ContextMenuSeparator } from "@/ui/ContextMenu";
import { MenuItem, MenuSeparator } from "@/ui/Menu";
import type { IconComponent } from "@/ui/Button";

export type PageAction =
  | { kind: "item"; id: string; icon: IconComponent; label: string; shortcut?: string; destructive?: boolean; run: () => void | Promise<void> }
  | { kind: "sep"; id: string };

export function routeForPage(meta: Pick<PageMeta, "id" | "kind">) {
  return { t: "page" as const, id: meta.id };
}

export async function copyPageLink(id: Id): Promise<void> {
  try {
    await navigator.clipboard.writeText(`emp://page/${id}`);
    notify.success("Link copied");
  } catch {
    notify.error("Couldn't copy the link");
  }
}

export function pageActions(meta: PageMeta, opts: { onRename?: () => void; current?: boolean } = {}): PageAction[] {
  const ws = useWorkspace.getState();
  const fav = ws.isFavorite(meta.id);
  const out: PageAction[] = [];
  if (!opts.current) {
    out.push({ kind: "item", id: "peek", icon: PanelRight, label: "Open in side peek", shortcut: "shift+enter", run: () => useUi.getState().openPeek(routeForPage(meta)) });
  }
  out.push({
    kind: "item",
    id: "fav",
    icon: fav ? StarOff : Star,
    label: fav ? "Remove from Favorites" : "Add to Favorites",
    run: () => ws.toggleFavorite(meta.id),
  });
  out.push({ kind: "sep", id: "s1" });
  if (meta.kind === "doc" || meta.kind === "dashboard") {
    out.push({
      kind: "item",
      id: "child",
      icon: FilePlus2,
      label: "New sub-page",
      run: async () => {
        const child = await useTree.getState().createPage({ parentId: meta.id });
        navigate({ t: "page", id: child.id });
      },
    });
  }
  if (opts.onRename) out.push({ kind: "item", id: "rename", icon: Pencil, label: "Rename", shortcut: "f2", run: opts.onRename });
  out.push({
    kind: "item",
    id: "dup",
    icon: Copy,
    label: "Duplicate",
    run: async () => {
      const copy = await useTree.getState().duplicate(meta.id, true);
      if (copy) {
        useTree.getState().reveal(copy.id);
        notify.success(`Duplicated “${meta.title || "Untitled"}”`);
      }
    },
  });
  out.push({ kind: "item", id: "link", icon: Link, label: "Copy link", shortcut: opts.current ? "mod+l" : undefined, run: () => copyPageLink(meta.id) });
  if (meta.parentId) {
    out.push({
      kind: "item",
      id: "root",
      icon: CornerUpLeft,
      label: "Move to top level",
      run: () => useTree.getState().move(meta.id, null),
    });
  }
  out.push({ kind: "sep", id: "s2" });
  out.push({
    kind: "item",
    id: "trash",
    icon: Trash2,
    label: "Move to Trash",
    shortcut: "delete",
    destructive: true,
    run: async () => {
      const parent = meta.parentId;
      await useTree.getState().trash([meta.id]);
      if (opts.current) navigate(parent ? { t: "page", id: parent } : { t: "home" }, { replace: true });
    },
  });
  return out;
}

type ItemComp = ComponentType<{ icon?: IconComponent | ReactNode; children: ReactNode; shortcut?: string; destructive?: boolean; onSelect?: (e: Event) => void }>;

function render(actions: PageAction[], Item: ItemComp, Sep: ComponentType) {
  return actions.map((a, i) => {
    if (a.kind === "sep") {
      if (i === 0 || i === actions.length - 1 || actions[i - 1]?.kind === "sep") return null;
      return <Sep key={a.id} />;
    }
    return (
      <Item key={a.id} icon={a.icon} shortcut={a.shortcut} destructive={a.destructive} onSelect={() => void Promise.resolve(a.run()).catch((e) => notify.fromError(e))}>
        {a.label}
      </Item>
    );
  });
}

export function PageMenuItems({ actions }: { actions: PageAction[] }) {
  return <>{render(actions, MenuItem as ItemComp, MenuSeparator)}</>;
}

export function PageContextItems({ actions }: { actions: PageAction[] }) {
  return <>{render(actions, ContextMenuItem as ItemComp, ContextMenuSeparator)}</>;
}
