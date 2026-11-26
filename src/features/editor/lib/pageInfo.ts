/** Page titles/icons for mentions, sub-page and link blocks: tree store first, then a cached `page_get_meta`. */
import { api } from '@/backend';
import type { Id, PageMeta } from '@/backend/types';
import { useTree } from '@/stores/tree';

const fetched = new Map<Id, PageMeta | null>();
const inflight = new Map<Id, Promise<PageMeta | null>>();
const listeners = new Set<() => void>();

export function pageInfo(id: Id | null | undefined): PageMeta | null | undefined {
  if (!id) return null;
  const fromTree = useTree.getState().byId.get(id);
  if (fromTree) return fromTree;
  if (fetched.has(id)) return fetched.get(id) ?? null;
  if (!inflight.has(id)) {
    const p = api.page
      .getMeta({ ids: [id] })
      .then((list) => {
        const m = list[0] && !list[0].deletedAt ? list[0] : null;
        fetched.set(id, m);
        return m;
      })
      .catch(() => {
        fetched.set(id, null);
        return null;
      })
      .finally(() => {
        inflight.delete(id);
        listeners.forEach((l) => l());
      });
    inflight.set(id, p);
  }
  return undefined;
}

/** Subscribe to title/icon changes (tree updates and late fetches). */
export function subscribePageInfo(fn: () => void): () => void {
  listeners.add(fn);
  const unsub = useTree.subscribe((s, prev) => {
    if (s.byId !== prev.byId) fn();
  });
  return () => {
    listeners.delete(fn);
    unsub();
  };
}

export function rememberPage(meta: PageMeta): void {
  fetched.set(meta.id, meta);
}
