/**
 * Home data (PROGRAMME-v3 K4 "Home = the day"): today's events, Life OS tasks due or overdue, unchecked to-dos from
 * today's note, the habits count and Money's one-line glance. Every source is read through existing commands; a
 * source that is still loading returns `null` (never placeholder content) and an absent app returns `undefined`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api, listen } from "@/backend";
import type { CalendarEvent, FinanceOverview, Id, PageMeta, TipTapDoc, TipTapNode } from "@/backend/types";
import { useTree } from "@/stores/tree";
import { useWorkspace } from "@/stores/workspace";
import { localDay } from "@/features/lifeapps/cells";
import { useAppDatabases } from "@/features/lifeapps/data";
import { dueOn, useHabitData } from "@/features/lifeapps/habitData";
import { isIncomeGroup, isSavingGroup, spendingBudget } from "@/features/finance/shared/figures";

export function useAppInstance(appId: string) {
  return useWorkspace((s) => s.lifeapps.find((i) => i.appId === appId && !i.detached));
}

/** Runs `fn` now and again (debounced) after any database change. */
function useRefetch(fn: () => void, deps: unknown[]) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cb = useCallback(fn, deps);
  useEffect(() => {
    cb();
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = listen("db:changed", () => {
      if (t) clearTimeout(t);
      t = setTimeout(cb, 300);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  }, [cb]);
}

// ───────────────────────────────────────────────────────────────────────────── agenda

/** Today's events: all-day first, then by start. Task due dates (db all-day items) belong to To do, not here. */
export function useTodayEvents(today: string): CalendarEvent[] | null {
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  useRefetch(() => {
    api.calendar
      .events({ from: today, to: today })
      .then((list) => {
        const own = list.filter((e) => !(e.source === "db" && e.allDay));
        own.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
        setEvents(own);
      })
      .catch(() => setEvents([]));
  }, [today]);
  return events;
}

// ───────────────────────────────────────────────────────────────────────────── today's note

/** The title both backends give today's note ("Thursday, Nov 26, 2026", en-US), under the "Journal" page. */
export function dailyNoteTitle(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const wd = dt.toLocaleDateString("en-US", { weekday: "long" });
  const short = dt.toLocaleDateString("en-US", { month: "short" });
  return `${wd}, ${short} ${d}, ${y}`;
}

const NOTE_FOLDER = "Journal";

/** Today's note if it already exists (Home never creates it just by being looked at). */
export function useTodayNoteMeta(today: string): PageMeta | null {
  const title = useMemo(() => dailyNoteTitle(today), [today]);
  return useTree(
    useShallow((s) => {
      for (const p of s.byId.values()) {
        if (p.deletedAt || p.kind !== "doc" || !p.parentId || p.title !== title) continue;
        if (s.byId.get(p.parentId)?.title === NOTE_FOLDER) return p;
      }
      return null;
    }),
  );
}

export interface NoteTodo {
  blockId: string;
  text: string;
  checked: boolean;
}

function inlineText(n: TipTapNode | undefined): string {
  if (!n) return "";
  if (n.type === "text") return n.text ?? "";
  if (n.type === "mention") {
    const date = (n.attrs?.date as { start?: string } | undefined)?.start;
    return date ? new Date(`${date.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
  }
  return (n.content ?? []).map(inlineText).join("");
}

export function todosIn(doc: TipTapDoc | null | undefined): NoteTodo[] {
  const out: NoteTodo[] = [];
  const visit = (n: TipTapNode) => {
    if (n.type === "blockContainer") {
      const c = n.content?.[0];
      if (c?.type === "todoItem") {
        const text = inlineText(c).trim();
        if (text) out.push({ blockId: String(n.attrs?.id ?? ""), text, checked: !!c.attrs?.checked });
      }
    }
    for (const k of n.content ?? []) visit(k);
  };
  for (const n of doc?.content ?? []) visit(n);
  return out;
}

/** Unchecked to-dos of today's note (read from its TipTap JSON) and a writer that ticks one in place. */
export function useNoteTodos(note: PageMeta | null) {
  const [todos, setTodos] = useState<NoteTodo[] | null>(null);
  const noteId = note?.id ?? null;
  const updatedAt = note?.updatedAt ?? 0;
  useEffect(() => {
    if (!noteId) {
      setTodos([]);
      return;
    }
    let live = true;
    api.page
      .get({ id: noteId })
      .then((r) => live && setTodos(todosIn(r.doc)))
      .catch(() => live && setTodos([]));
    return () => {
      live = false;
    };
  }, [noteId, updatedAt]);
  const setChecked = useCallback(
    async (blockId: string, checked: boolean) => {
      if (!noteId) return;
      setTodos((list) => list?.map((t) => (t.blockId === blockId ? { ...t, checked } : t)) ?? list);
      const page = await api.page.get({ id: noteId });
      if (!page.doc) return;
      const doc = structuredClone(page.doc);
      const visit = (n: TipTapNode): boolean => {
        if (n.type === "blockContainer" && n.attrs?.id === blockId && n.content?.[0]?.type === "todoItem") {
          n.content[0].attrs = { ...n.content[0].attrs, checked };
          return true;
        }
        return (n.content ?? []).some(visit);
      };
      if (!doc.content.some(visit)) return;
      await api.page.saveDoc({ ownerId: noteId, ownerKind: "page", doc, baseRev: page.docRev });
    },
    [noteId],
  );
  return { todos, setChecked };
}

// ───────────────────────────────────────────────────────────────────────────── habits

/**
 * "2 of 4 done" for today: habits due today (by schedule) and how many are checked in, counted from the Habits
 * databases exactly as the Habits hub counts them. `undefined` without Habits or with nothing due, `null` while loading.
 */
export function useHabitsToday(today: string): { instanceId: Id; done: number; total: number } | null | undefined {
  const habits = useAppInstance("habits");
  const { byRole, dbs } = useAppDatabases(habits?.id);
  const habitsDb = byRole("habit.name");
  const logDb = byRole("log.date");
  const { habits: list, entries, loading } = useHabitData(habitsDb, logDb);
  return useMemo(() => {
    if (!habits) return undefined;
    if (!dbs) return null;
    if (!habitsDb || !logDb) return undefined;
    if (loading) return null;
    const { due, done } = dueOn(list, entries, today);
    return due.length ? { instanceId: habits.id, done, total: due.length } : undefined;
  }, [habits, dbs, habitsDb, logDb, loading, list, entries, today]);
}

// ───────────────────────────────────────────────────────────────────────────── money

export interface MoneyGlance {
  instanceId: Id;
  currency: string;
  month: string;
  /** budget.left (> 0) or the amount over budget (< 0); null without a budget. */
  left: number | null;
  /** Rows to review: `reviewed = false` when the template has that role, else uncategorised rows. */
  toReview: number;
  reviewLabel: "to review" | "to categorise";
  /** Days since the newest imported row, if any row was imported. */
  importedDaysAgo: number | null;
  /** At most one alert: an over-budget category or a bill due within 3 days. */
  alert: { text: string; amount: number; tab: string } | null;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00`) - Date.parse(`${a}T12:00:00`)) / 86_400_000);
}

/** Money's one-line glance (r2_money §2.4). `undefined` without Money HQ, `null` while loading. */
export function useMoneyGlance(today: string): MoneyGlance | null | undefined {
  const money = useAppInstance("money-hq");
  const { byRole } = useAppDatabases(money?.id);
  const txns = byRole("txn.amount");
  const [overview, setOverview] = useState<FinanceOverview | null | undefined>(undefined);
  const [extra, setExtra] = useState<{ review: number | null; lastImport: string | null } | null>(null);
  const seq = useRef(0);
  useRefetch(() => {
    if (!money) return;
    api.finance
      .overview({ instanceId: money.id, month: today.slice(0, 7) })
      .then(setOverview)
      .catch(() => setOverview(null));
  }, [money?.id, today]);
  useRefetch(() => {
    if (!txns) return;
    const n = ++seq.current;
    const reviewed = txns.p("txn.reviewed");
    const source = txns.p("txn.source");
    const date = txns.p("txn.date");
    const count = reviewed
      ? api.db.query({ databaseId: txns.id, override: { filter: { prop: reviewed.id, op: "unchecked" } }, window: { offset: 0, limit: 1 }, reqId: n }).then((r) => ("notModified" in r ? null : r.total))
      : Promise.resolve(null);
    const last =
      source && date
        ? api.db
            .query({ databaseId: txns.id, override: { filter: { prop: source.id, op: "eq", value: "import" }, sorts: [{ prop: date.id, dir: "desc" }] }, window: { offset: 0, limit: 1 }, reqId: n })
            .then((r) => {
              if ("notModified" in r || !r.rows[0]) return null;
              const v = r.rows[0].values[date.id];
              return v && v.t === "date" && v.v ? v.v.start.slice(0, 10) : null;
            })
        : Promise.resolve(null);
    Promise.all([count, last])
      .then(([review, lastImport]) => n === seq.current && setExtra({ review, lastImport }))
      .catch(() => n === seq.current && setExtra({ review: null, lastImport: null }));
  }, [txns?.id]);

  return useMemo(() => {
    if (!money) return undefined;
    if (overview === undefined || (txns && !extra)) return null;
    // The overview couldn't load: the section is left out rather than shown wrong.
    if (!overview) return undefined;
    const currency = overview.netWorth.currency;
    const { assigned, spent } = spendingBudget(overview.budget);
    const left = assigned > 0 ? assigned - spent : null;
    const month = new Date(`${today}T12:00:00`).toLocaleDateString(undefined, { month: "long" });
    let alert: MoneyGlance["alert"] = null;
    const over = overview.budget
      .filter((b) => !isIncomeGroup(b.group) && !isSavingGroup(b.group) && Number(b.available.amount) < 0)
      .sort((a, b) => Number(a.available.amount) - Number(b.available.amount))[0];
    if (over) alert = { text: `${over.name}`, amount: -Number(over.available.amount), tab: "budget" };
    else {
      const bill = overview.upcoming.filter((u) => u.due >= today && daysBetween(today, u.due) <= 3).sort((a, b) => a.due.localeCompare(b.due))[0];
      if (bill) alert = { text: bill.name, amount: Math.abs(Number(bill.amount.amount)), tab: `bill:${bill.due}` };
    }
    const review = extra?.review;
    return {
      instanceId: money.id,
      currency,
      month,
      left,
      toReview: review ?? overview.uncategorized,
      reviewLabel: review === null || review === undefined ? "to categorise" : "to review",
      importedDaysAgo: extra?.lastImport ? Math.max(0, daysBetween(extra.lastImport, today)) : null,
      alert,
    };
  }, [money, overview, txns, extra, today]);
}

// ───────────────────────────────────────────────────────────────────────────── recents

export function useRecentPages(limit = 6): PageMeta[] {
  const recents = useWorkspace((s) => s.recents);
  return useTree(
    useShallow((s) =>
      recents
        .map((id) => s.byId.get(id))
        .filter((p): p is PageMeta => !!p && !p.flags.template && !p.deletedAt)
        .slice(0, limit),
    ),
  );
}

export { localDay };
