/** Workspace (§11.3 Workspaces): the open workspace, favourites, recents and installed life apps. */
import { create } from 'zustand';
import { api } from '@/backend';
import type { Id, LifeAppInstance, Route, Workspace, WorkspaceDefaults } from '@/backend/types';
import { notify } from './toasts';
import { useTree } from './tree';

interface WorkspaceState {
  workspace: Workspace | null;
  workspaces: Workspace[];
  recents: Id[];
  lifeapps: LifeAppInstance[];
  lastRoute: Route | null;
  loading: boolean;

  /** workspace_list → workspace_open(first) and load the tree. */
  openDefault(): Promise<Workspace | null>;
  open(id: Id): Promise<void>;
  reset(): void;

  isFavorite(pageId: Id): boolean;
  toggleFavorite(pageId: Id): Promise<void>;
  reorderFavorites(ids: Id[]): Promise<void>;
  /** Local bump (the backend records recents on page_get). */
  touchRecent(pageId: Id): void;
  rename(name: string): Promise<void>;
  setDefaults(defaults: Partial<WorkspaceDefaults>): Promise<void>;
  refreshLifeapps(): Promise<void>;
}

const RECENTS_MAX = 20;

export const useWorkspace = create<WorkspaceState>()((set, get) => {
  const patch = async (p: Parameters<typeof api.workspace.update>[0]['patch'], optimistic: Partial<Workspace>) => {
    const ws = get().workspace;
    if (!ws) return;
    set({ workspace: { ...ws, ...optimistic } });
    try {
      const saved = await api.workspace.update({ id: ws.id, patch: p });
      set((s) => ({ workspace: saved, workspaces: s.workspaces.map((w) => (w.id === saved.id ? saved : w)) }));
    } catch (e) {
      set({ workspace: ws });
      notify.fromError(e, "Couldn't update the workspace");
    }
  };

  return {
    workspace: null,
    workspaces: [],
    recents: [],
    lifeapps: [],
    lastRoute: null,
    loading: false,

    async openDefault() {
      const list = await api.workspace.list();
      set({ workspaces: list });
      const first = list[0];
      if (!first) return null;
      await get().open(first.id);
      return get().workspace;
    },

    async open(id) {
      set({ loading: true });
      try {
        const res = await api.workspace.open({ id });
        useTree.getState().load(res.workspace.id, res.pages);
        set({
          workspace: res.workspace,
          recents: res.recents,
          lifeapps: res.lifeapps,
          lastRoute: res.lastRoute ?? null,
        });
        void useTree.getState().loadExpanded();
      } finally {
        set({ loading: false });
      }
    },

    reset: () => set({ workspace: null, workspaces: [], recents: [], lifeapps: [], lastRoute: null }),

    isFavorite: (pageId) => !!get().workspace?.favorites.includes(pageId),

    async toggleFavorite(pageId) {
      const ws = get().workspace;
      if (!ws) return;
      const favorites = ws.favorites.includes(pageId) ? ws.favorites.filter((f) => f !== pageId) : [...ws.favorites, pageId];
      await patch({ favorites }, { favorites });
    },

    async reorderFavorites(ids) {
      await patch({ favorites: ids }, { favorites: ids });
    },

    touchRecent(pageId) {
      set((s) => ({ recents: [pageId, ...s.recents.filter((r) => r !== pageId)].slice(0, RECENTS_MAX) }));
    },

    async rename(name) {
      await patch({ name }, { name });
    },

    async setDefaults(defaults) {
      const ws = get().workspace;
      if (!ws) return;
      const next = { ...ws.defaults, ...defaults };
      await patch({ defaults: next }, { defaults: next });
    },

    async refreshLifeapps() {
      const ws = get().workspace;
      if (!ws) return;
      try {
        const lifeapps = await api.lifeapp.instances({ workspaceId: ws.id });
        set({ lifeapps });
      } catch {
        /* life apps not available */
      }
    },
  };
});

export const selectFavorites = (s: WorkspaceState) => s.workspace?.favorites ?? [];
export const selectWorkspaceId = (s: WorkspaceState) => s.workspace?.id ?? null;
