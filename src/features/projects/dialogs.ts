/**
 * The project pickers can be opened from anywhere (page menus, the sidebar, the project view, the palette). One
 * dialog at a time; `ProjectDialogs` (mounted once by the shell) renders it.
 */
import { create } from "zustand";
import type { Id } from "@/backend/types";

export type ProjectDialog =
  /** "Move to project…": pick a project for this page. */
  | { kind: "moveTo"; pageId: Id }
  /** "Move an existing page here…": pick pages to move into this project. */
  | { kind: "moveHere"; projectId: Id }
  /** "Add an app…": install an app inside this project, or move an installed one here. */
  | { kind: "addApp"; projectId: Id };

interface State {
  dialog: ProjectDialog | null;
  open(d: ProjectDialog): void;
  close(): void;
}

export const useProjectDialogs = create<State>()((set) => ({
  dialog: null,
  open: (dialog) => set({ dialog }),
  close: () => set({ dialog: null }),
}));

export const openMoveToProject = (pageId: Id) => useProjectDialogs.getState().open({ kind: "moveTo", pageId });
export const openMoveHere = (projectId: Id) => useProjectDialogs.getState().open({ kind: "moveHere", projectId });
export const openAddApp = (projectId: Id) => useProjectDialogs.getState().open({ kind: "addApp", projectId });
