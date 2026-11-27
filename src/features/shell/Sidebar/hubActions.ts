/**
 * Menu for an app's row (sidebar, project contents). An app is one row wherever it lives: it opens, peeks, moves into
 * a project or back out to the top level, and joins Favorites. It is not renamed, duplicated or trashed from here
 * (its name comes from the app identity map; removing an app lives in the app gallery).
 */
import { CornerUpLeft, FolderInput, LayoutGrid, PanelRight, Star, StarOff } from "lucide-react";
import { navigate } from "@/app/router";
import type { PageMeta } from "@/backend/types";
import { openMoveToProject } from "@/features/projects/dialogs";
import type { AppHub } from "@/stores/tree";
import { useTree } from "@/stores/tree";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import type { PageAction } from "../PageMenu";

export function hubActions(meta: PageMeta, hub: AppHub): PageAction[] {
  const ws = useWorkspace.getState();
  const fav = ws.isFavorite(meta.id);
  const out: PageAction[] = [
    { kind: "item", id: "peek", icon: PanelRight, label: "Open in side peek", shortcut: "shift+enter", run: () => useUi.getState().openPeek({ t: "app", instanceId: hub.instanceId }) },
    { kind: "item", id: "fav", icon: fav ? StarOff : Star, label: fav ? "Remove from Favorites" : "Add to Favorites", run: () => ws.toggleFavorite(meta.id) },
    { kind: "sep", id: "s1" },
    { kind: "item", id: "project", icon: FolderInput, label: "Move to project…", run: () => openMoveToProject(meta.id) },
  ];
  if (meta.parentId) {
    out.push({ kind: "item", id: "root", icon: CornerUpLeft, label: "Move to top level", run: () => useTree.getState().move(meta.id, null) });
  }
  out.push({ kind: "sep", id: "s2" });
  out.push({ kind: "item", id: "apps", icon: LayoutGrid, label: "Manage apps", run: () => navigate({ t: "lifeapps" }) });
  return out;
}
