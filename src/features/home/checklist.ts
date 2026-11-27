/**
 * The one Getting Started checklist (1.0 brief §2.6): Home lists the same items, in the same order, as the Getting
 * Started page (`ITEMS` + `LOCK_ITEM` in crates/emp-store/src/repo/tour.rs; `GS_ITEMS` in the mock seed). An item is
 * done when the store recorded it (`ui.gettingStarted/<key>`) or when its to-do on the page is ticked, by the store
 * or by hand. The page and its item → to-do block map are published at `ui.gettingStarted/tour`.
 */
import { api } from "@/backend";
import type { Id, TipTapNode } from "@/backend/types";

/** The checklist's items, in the Getting Started page's order ("lock" only in an encrypted workspace). */
export const CHECK_KEYS = ["create_page", "try_slash", "capture", "open_palette", "lock"] as const;
export type CheckKey = (typeof CHECK_KEYS)[number];

/** `ui.gettingStarted/tour`: the Getting Started page and its item → to-do block map (written when the tour is made). */
export interface TourMap {
  pageId: Id;
  items: Partial<Record<string, string>>;
}

/** Items whose to-do is ticked on the Getting Started page. Nothing for a missing, deleted or unreadable page. */
export async function tickedOnPage(tour: unknown): Promise<Set<string>> {
  const t = tour as TourMap | null;
  const out = new Set<string>();
  if (!t || typeof t.pageId !== "string" || !t.items || typeof t.items !== "object") return out;
  const page = await api.page.get({ id: t.pageId }).catch(() => null);
  if (!page?.doc || page.meta.deletedAt) return out;
  const checked = new Set<string>();
  const visit = (n: TipTapNode) => {
    const first = n.content?.[0];
    if (n.type === "blockContainer" && first?.type === "todoItem" && first.attrs?.checked === true) checked.add(String(n.attrs?.id ?? ""));
    for (const c of n.content ?? []) visit(c);
  };
  page.doc.content.forEach(visit);
  for (const [key, block] of Object.entries(t.items)) if (block && checked.has(block)) out.add(key);
  return out;
}
