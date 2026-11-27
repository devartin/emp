/**
 * Project actions (brief §2.2). A project is a document page with `flags.project`; its children are its contents.
 * Everything here goes through the tree store (optimistic, undoable moves) and the shared create helpers.
 */
import { createDatabaseAndOpen, createPageAndOpen, createSheetAndOpen } from "@/app/commands";
import type { Id, PageMeta } from "@/backend/types";
import { notify } from "@/stores/toasts";
import { isProject, useTree } from "@/stores/tree";

const name = (m: Pick<PageMeta, "title"> | undefined) => m?.title.trim() || "Untitled";

/** "Turn into project" / "Turn back into a document". */
export async function setProject(meta: PageMeta, on: boolean): Promise<void> {
  if (meta.kind !== "doc" || isProject(meta) === on) return;
  await useTree.getState().updateMeta(meta.id, { flags: { project: on } });
  const now = useTree.getState().byId.get(meta.id);
  if (!now || isProject(now) !== on) return; // the store already reported the failure
  notify.success(on ? `“${name(meta)}” is now a project` : `“${name(meta)}” is a document again`);
}

/**
 * Move a page (or an app's hub) into a project, with an Undo toast. The toast's Undo reverts this move, wherever it
 * sits in the undo stack (later moves and other commands stay as they are).
 */
export async function moveIntoProject(pageId: Id, projectId: Id, label?: string): Promise<boolean> {
  const tree = useTree.getState();
  const page = tree.byId.get(pageId);
  const project = tree.byId.get(projectId);
  if (!page || !project || page.parentId === projectId) return false;
  await tree.move(pageId, projectId, {}, { toast: `Moved “${label ?? name(page)}” to “${name(project)}”` });
  const moved = useTree.getState().byId.get(pageId)?.parentId === projectId;
  if (moved) useTree.getState().setExpanded(projectId, true);
  return moved;
}

export type ContentKind = "doc" | "sheet" | "database";

/** New document, spreadsheet or database inside a project (opened, like every other "New …"). */
export function createInProject(projectId: Id, kind: ContentKind): Promise<void> {
  if (kind === "sheet") return createSheetAndOpen(projectId);
  if (kind === "database") return createDatabaseAndOpen(projectId);
  return createPageAndOpen(projectId);
}
