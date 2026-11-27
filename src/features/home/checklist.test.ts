/**
 * One Getting Started checklist (1.0 brief §2.6), against the mock backend (which mirrors repo/tour.rs): the page
 * lists Home's items in Home's order, the tour map is published for Home, and a to-do ticked by hand on the page
 * counts on Home.
 */
import { describe, expect, test, vi } from "vitest";
import type { TipTapDoc, TipTapNode } from "@/backend/types";

vi.mock("@/backend", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/backend")>();
  const { mockApi } = await import("@/test/helpers");
  const { api } = await mockApi({ seed: "empty" });
  return { ...real, api, default: api };
});

/** The page's checklist: to-dos in order, with their block ids, bold labels and ticks. */
function todos(doc: TipTapDoc): { id: string; label: string; checked: boolean }[] {
  const out: { id: string; label: string; checked: boolean }[] = [];
  const visit = (n: TipTapNode) => {
    const c = n.content?.[0];
    if (n.type === "blockContainer" && c?.type === "todoItem") {
      const bold = (c.content ?? []).find((t) => t.marks?.some((m) => m.type === "bold"));
      out.push({ id: String(n.attrs?.id), label: bold?.text ?? "", checked: c.attrs?.checked === true });
    }
    for (const k of n.content ?? []) visit(k);
  };
  doc.content.forEach(visit);
  return out;
}

describe("Getting Started checklist", () => {
  test("the page and Home list the same items; a hand tick on the page counts on Home", { timeout: 30_000 }, async () => {
    const { api } = (await import("@/backend")) as typeof import("@/backend");
    const { CHECK_KEYS, tickedOnPage } = await import("./checklist");
    const autoLock = { idleMinutes: 15, onSleep: true, onScreenLock: true, onBlurMinutes: null, maxSessionHours: null };
    await api.vault.create({ password: "plinth-ocelot-marzipan-quaver-87", profile: "standard", autoLock });

    const tour = (await api.kv.get({ ns: "ui.gettingStarted", key: "tour" })) as { pageId: string; items: Record<string, string> };
    expect(tour?.pageId).toBeTruthy();
    // An encrypted workspace lists every item, "Lock" last, in Home's order.
    expect(Object.keys(tour.items)).toEqual([...CHECK_KEYS]);
    const page = await api.page.get({ id: tour.pageId });
    const list = todos(page.doc!);
    expect(list.map((t) => t.label)).toEqual(["Write a document", "Add a heading, list or table", "Add a task or a note", "Find anything", "Lock Ultranote"]);
    expect(list.map((t) => t.id)).toEqual(CHECK_KEYS.map((k) => tour.items[k]));
    expect(list.some((t) => /hide numbers/i.test(t.label))).toBe(false);
    expect((await tickedOnPage(tour)).size).toBe(0);

    // Tick "Find anything" by hand on the page (an ordinary document save).
    const doc = structuredClone(page.doc!);
    const tickBlock = (n: TipTapNode) => {
      if (n.type === "blockContainer" && n.attrs?.id === tour.items.open_palette) n.content![0].attrs = { ...n.content![0].attrs, checked: true };
      n.content?.forEach(tickBlock);
    };
    doc.content.forEach(tickBlock);
    await api.page.saveDoc({ ownerId: tour.pageId, ownerKind: "page", doc, baseRev: page.docRev });
    expect([...(await tickedOnPage(tour))]).toEqual(["open_palette"]);

    // A capture ticks "Add a task or a note" on the page too (the store records it, as Rust does).
    await api.kv.set({ ns: "ui.gettingStarted", key: "capture", value: Date.now() });
    expect([...(await tickedOnPage(tour))].sort()).toEqual(["capture", "open_palette"]);

    // No map, or a page in Trash: nothing ticked, no error.
    expect((await tickedOnPage(null)).size).toBe(0);
    await api.page.delete({ ids: [tour.pageId] });
    expect((await tickedOnPage(tour)).size).toBe(0);
  });
});
