/**
 * Home = the day (PROGRAMME-v3 K4; Flow r2 §2.3). One 720px column in a fixed order, no containers, motion C0:
 *
 *   the date (H1) · subtitle: all-day items · Today's note
 *   one capture field (t / n / −12.50 prefixes, capture.ts)
 *   Agenda       today's events, with a now line
 *   To do        starred, overdue and due-today Life OS tasks, then unchecked to-dos of today's note; the habits line
 *   Money        Money's one-line glance plus at most one alert (only with Money HQ)
 *   Recent       six pages
 *
 * Empty sections are omitted. A new vault adds a self-ticking "Get started" list and one Life apps line. Not
 * customisable by design. j/k (or ↓/↑) move through the rows, x or Space ticks a to-do, Enter opens.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api, listen } from "@/backend";
import type { CalendarEvent, Id, RowDTO } from "@/backend/types";
import { openTodayNote, runCommand } from "@/app/commands";
import { navigate } from "@/app/router";
import { cn } from "@/lib/cn";
import { formatCurrency } from "@/lib/format";
import { formatRelative, formatTime } from "@/lib/dates";
import { notify } from "@/stores/toasts";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { Checkbox } from "@/ui/Checkbox";
import { Sensitive } from "@/ui/Sensitive";
import { PageIcon } from "@/features/shell/PageIcon";
import { optionId, read, write } from "@/features/lifeapps/cells";
import { useAppDatabases, useRows, useStableNow, type AppDb } from "@/features/lifeapps/data";
import { CaptureField } from "./CaptureField";
import { localDay, useAppInstance, useHabitsToday, useMoneyGlance, useNoteTodos, useRecentPages, useTodayEvents, useTodayNoteMeta } from "./data";
import "./home.css";

// ───────────────────────────────────────────────────────────────────────────── pieces

function Section({ title, link, children, label }: { title: string; link?: { label: string; go: () => void }; children: ReactNode; label?: string }) {
  return (
    <section className="hm-section" aria-label={label ?? title}>
      <div className="hm-section-head">
        <h2 className="hm-section-title">{title}</h2>
        {link ? (
          <button type="button" className="hm-quiet-link" onClick={link.go}>
            {link.label}
          </button>
        ) : null}
      </div>
      {children}
    </section>
  );
}

const daysLate = (due: string, today: string) => Math.round((Date.parse(`${today}T12:00:00`) - Date.parse(`${due}T12:00:00`)) / 86_400_000);

// ───────────────────────────────────────────────────────────────────────────── agenda

function Agenda({ events, now, taskIds }: { events: CalendarEvent[]; now: Date; taskIds: ReadonlySet<Id> }) {
  const t = now.getTime();
  // Life OS time blocks are tasks: they are listed (with their time) under To do, not twice.
  const timed = events.filter((e) => !e.allDay && !(e.source === "db" && e.link?.t === "row" && taskIds.has(e.link.id)));
  const nowIndex = timed.findIndex((e) => Date.parse(e.end) > t);
  const rows: ReactNode[] = [];
  timed.forEach((e, i) => {
    const start = Date.parse(e.start);
    const end = Date.parse(e.end);
    const live = start <= t && end > t;
    if (i === nowIndex && !live) rows.push(<li key="now" className="hm-now" aria-label={`Now, ${formatTime(now)}`} />);
    rows.push(
      <li key={e.id}>
        <button
          type="button"
          data-home-item=""
          className={cn("hm-row hm-event", end <= t && "is-past")}
          onClick={() => (e.link ? useUi.getState().openPeek(e.link) : navigate({ t: "calendar" }))}
        >
          <span className="hm-time tabular">{formatTime(e.start)}</span>
          <span className="hm-row-title">{e.title}</span>
          <span className="hm-row-meta">{live ? `until ${formatTime(e.end)}` : e.location ?? ""}</span>
        </button>
      </li>,
    );
  });
  if (nowIndex < 0 && timed.length) rows.push(<li key="now" className="hm-now" aria-label={`Now, ${formatTime(now)}`} />);
  if (!timed.length) return null;
  return (
    <Section title="Agenda" link={{ label: "Calendar", go: () => navigate({ t: "calendar" }) }}>
      <ul className="hm-list">{rows}</ul>
    </Section>
  );
}

// ───────────────────────────────────────────────────────────────────────────── to do

interface TodoItem {
  key: string;
  title: string;
  meta: string;
  late: boolean;
  checked: boolean;
  toggle: (checked: boolean) => void;
  open: () => void;
}

function useLifeOsTodos(today: string): { db: AppDb | undefined; items: TodoItem[] | null; instanceId: Id | undefined; ids: ReadonlySet<Id> } {
  const lifeos = useAppInstance("life-os");
  const { byRole, dbs } = useAppDatabases(lifeos?.id);
  const db = byRole("task.status");
  const { rows, setRows } = useRows(db?.id);
  // Rows ticked during this visit stay in place (struck through) until you leave Home.
  const kept = useRef(new Set<Id>());
  const complete = useCallback(
    async (r: RowDTO, done: boolean) => {
      if (!db) return;
      const status = db.p("task.status");
      const next = optionId(status, done ? "Done" : "Next");
      if (!status || !next) return;
      kept.current.add(r.id);
      setRows((list) => list.map((x) => (x.id === r.id ? { ...x, values: { ...x.values, [status.id]: write.status(next) } } : x)));
      const values: Record<Id, ReturnType<typeof write.status> | null> = { [status.id]: write.status(next) };
      const completed = db.p("task.completed");
      if (completed) values[completed.id] = done ? write.date(today) : null;
      try {
        await api.db.rowsUpdate({ updates: [{ id: r.id, values }] });
      } catch (e) {
        notify.fromError(e, "Couldn’t update the task");
      }
    },
    [db, setRows, today],
  );
  const items = useMemo(() => {
    if (!lifeos) return [];
    if (!dbs || (db && !rows)) return null;
    if (!db || !rows) return [];
    const isDone = (r: RowDTO) => read.opt(r, db.p("task.status"))?.name === "Done";
    const due = (r: RowDTO) => read.date(r, db.p("task.due"));
    const starred = (r: RowDTO) => read.bool(r, db.p("task.top3"));
    const picked = rows.filter((r) => {
      if (kept.current.has(r.id)) return true;
      if (isDone(r)) return false;
      const d = due(r)?.start?.slice(0, 10);
      return starred(r) || (!!d && d <= today);
    });
    const rank = (r: RowDTO) => {
      const d = due(r)?.start?.slice(0, 10);
      return starred(r) ? 0 : d && d < today ? 1 : 2;
    };
    picked.sort((a, b) => rank(a) - rank(b) || (due(a)?.start ?? "").localeCompare(due(b)?.start ?? ""));
    return picked.map((r): TodoItem => {
      const d = due(r);
      const day = d?.start?.slice(0, 10);
      const late = !!day && day < today;
      const n = day ? daysLate(day, today) : 0;
      const sched = read.date(r, db.p("task.scheduled"));
      const at = sched?.time && sched.start && sched.start.slice(0, 10) === today ? sched.start : d?.time && d.start ? d.start : null;
      const meta = late ? (n === 1 ? "Yesterday" : `${n} days late`) : at ? formatTime(at) : "";
      return {
        key: r.id,
        title: read.text(r, db.p("task.title")) || "Untitled task",
        meta,
        late: late && !isDone(r),
        checked: isDone(r),
        toggle: (v) => void complete(r, v),
        open: () => useUi.getState().openPeek({ t: "row", id: r.id }),
      };
    });
  }, [lifeos, dbs, db, rows, today, complete]);
  const ids = useMemo(() => new Set((rows ?? []).map((r) => r.id)), [rows]);
  return { db, items, instanceId: lifeos?.id, ids };
}

function Todo({ today, noteId, lifeos }: { today: string; noteId: Id | null; lifeos: ReturnType<typeof useLifeOsTodos> }) {
  const { items: tasks, instanceId } = lifeos;
  const note = useTodayNoteMeta(today);
  const { todos, setChecked } = useNoteTodos(note);
  const kept = useRef(new Set<string>());
  const habits = useHabitsToday();
  if (tasks === null || todos === null) return null;
  const noteItems: TodoItem[] = todos
    .filter((t) => !t.checked || kept.current.has(t.blockId))
    .map((t) => ({
      key: `note:${t.blockId}`,
      title: t.text,
      meta: "Today’s note",
      late: false,
      checked: t.checked,
      toggle: (v) => {
        kept.current.add(t.blockId);
        void setChecked(t.blockId, v).catch((e) => notify.fromError(e, "Couldn’t update the to-do"));
      },
      open: () => noteId && navigate({ t: "page", id: noteId, blockId: t.blockId }),
    }));
  const all = [...tasks, ...noteItems];
  const habitLine = habits && habits.total > 0 ? habits : null;
  if (!all.length && !habitLine) return null;
  return (
    <Section title="To do" link={instanceId ? { label: "Life OS", go: () => navigate({ t: "app", instanceId }) } : undefined}>
      <ul className="hm-list">
        {all.map((t) => (
          <li key={t.key} className={cn("hm-row hm-todo", t.checked && "is-done")}>
            <Checkbox checked={t.checked} onCheckedChange={t.toggle} aria-label={t.checked ? `Mark “${t.title}” not done` : `Complete “${t.title}”`} />
            <button type="button" data-home-item="" data-toggle="" className="hm-row-title hm-todo-title" onClick={t.open}>
              {t.title}
            </button>
            <span className={cn("hm-row-meta tabular", t.late && "is-late")}>{t.meta}</span>
          </li>
        ))}
        {habitLine ? (
          <li className="hm-row hm-habits">
            <span className="hm-row-title">
              Habits <span className="hm-dot">·</span> <span className="tabular">{habitLine.done} of {habitLine.total}</span> done
            </span>
            <button type="button" data-home-item="" className="hm-quiet-link" onClick={() => navigate({ t: "app", instanceId: habitLine.instanceId, tab: "checkin" })}>
              Check in
            </button>
          </li>
        ) : null}
      </ul>
    </Section>
  );
}

// ───────────────────────────────────────────────────────────────────────────── money

function MoneyLine({ today }: { today: string }) {
  const g = useMoneyGlance(today);
  if (!g) return null;
  const fmt = (n: number) => formatCurrency(Math.round(n), g.currency, { maximumFractionDigits: 0 });
  const parts: ReactNode[] = [];
  if (g.left !== null)
    parts.push(
      <button key="left" type="button" data-home-item="" className="hm-money-part" onClick={() => navigate({ t: "app", instanceId: g.instanceId, tab: "budget" })}>
        <Sensitive className={cn("hm-num tabular", g.left < 0 && "is-over")}>{fmt(Math.abs(g.left))}</Sensitive> {g.left < 0 ? "over" : "left"} in {g.month}
      </button>,
    );
  if (g.toReview > 0)
    parts.push(
      <button key="review" type="button" data-home-item="" className="hm-money-part" onClick={() => navigate({ t: "app", instanceId: g.instanceId, tab: "transactions" })}>
        <span className="hm-num tabular">{g.toReview}</span> {g.reviewLabel}
      </button>,
    );
  if (g.importedDaysAgo !== null)
    parts.push(
      <button key="import" type="button" data-home-item="" className="hm-money-part" onClick={() => navigate({ t: "app", instanceId: g.instanceId, tab: "accounts" })}>
        last import {g.importedDaysAgo === 0 ? "today" : g.importedDaysAgo === 1 ? "yesterday" : `${g.importedDaysAgo} days ago`}
      </button>,
    );
  if (!parts.length) return null;
  const alert = g.alert;
  return (
    <Section title="Money" link={{ label: "Money HQ", go: () => navigate({ t: "app", instanceId: g.instanceId }) }}>
      <p className="hm-money">
        {parts.map((p, i) => (
          <span key={i}>
            {i > 0 ? <span className="hm-dot"> · </span> : null}
            {p}
          </span>
        ))}
      </p>
      {alert ? (
        <p className="hm-money-alert">
          {alert.tab === "budget" ? (
            <>
              {alert.text} <Sensitive className="tabular">{fmt(alert.amount)}</Sensitive> over budget
            </>
          ) : (
            <>
              {alert.text} <Sensitive className="tabular">{fmt(alert.amount)}</Sensitive> due{" "}
              {alert.tab.slice(5) === today ? "today" : new Date(`${alert.tab.slice(5)}T12:00:00`).toLocaleDateString(undefined, { weekday: "long" })}
            </>
          )}
        </p>
      ) : null}
    </Section>
  );
}

// ───────────────────────────────────────────────────────────────────────────── recent

function Recent() {
  const pages = useRecentPages(6);
  if (!pages.length) return null;
  return (
    <Section title="Recent">
      <ul className="hm-list">
        {pages.map((p) => (
          <li key={p.id}>
            <button type="button" data-home-item="" className="hm-row" onClick={(e) => (e.shiftKey ? useUi.getState().openPeek({ t: "page", id: p.id }) : navigate({ t: "page", id: p.id }))}>
              <PageIcon icon={p.icon} kind={p.kind} size={16} className="hm-row-icon" />
              <span className="hm-row-title">{p.title || "Untitled"}</span>
              <span className="hm-row-meta">{formatRelative(p.updatedAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ───────────────────────────────────────────────────────────────────────────── first run

const GET_STARTED: { key: string; label: string; run: () => void }[] = [
  { key: "capture", label: "Add a task or note in the field above", run: () => document.querySelector<HTMLInputElement>(".hm-capture-input")?.focus() },
  { key: "open_palette", label: "Search everything with ⌘K", run: () => useUi.getState().openPalette("all") },
  { key: "try_slash", label: "Type / in a page to add a block", run: () => runCommand("page.new") },
  { key: "import", label: "Import pages or a bank file", run: () => useUi.getState().setImportOpen(true) },
];

/** Shown after first run until every item is done. Each item ticks itself when you do the thing. */
function useGetStarted(): { done: Record<string, boolean>; show: boolean } | null {
  const [state, setState] = useState<{ done: Record<string, boolean>; show: boolean } | null>(null);
  const paletteOpen = useUi((s) => s.paletteOpen);
  const importOpen = useUi((s) => s.importOpen);
  const load = useCallback(() => {
    Promise.all([api.kv.get({ ns: "ui.onboarding", key: "completedAt" }), api.kv.getMany({ ns: "ui.gettingStarted", keys: GET_STARTED.map((g) => g.key) })])
      .then(([completed, got]) => {
        const done = Object.fromEntries(GET_STARTED.map((g) => [g.key, !!got[g.key]]));
        setState({ done, show: !!completed && !Object.values(done).every(Boolean) });
      })
      .catch(() => setState({ done: {}, show: false }));
  }, []);
  useEffect(() => {
    if (!paletteOpen && !importOpen) load();
  }, [load, paletteOpen, importOpen]);
  useEffect(() => listen("db:changed", () => load()), [load]);
  return state;
}

function GetStarted({ state }: { state: { done: Record<string, boolean> } }) {
  return (
    <Section title="Get started">
      <ul className="hm-list">
        {GET_STARTED.map((g) => (
          <li key={g.key} className={cn("hm-row hm-todo", state.done[g.key] && "is-done")}>
            <Checkbox checked={!!state.done[g.key]} disabled aria-label={state.done[g.key] ? "Done" : "Not done yet"} />
            <button type="button" data-home-item="" className="hm-row-title hm-todo-title" onClick={g.run}>
              {g.label}
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function LifeAppsLine() {
  const apps = useWorkspace((s) => s.lifeapps);
  if (apps.some((a) => a.appId === "money-hq" || a.appId === "portfolio" || a.appId === "tax-organizer")) return null;
  return (
    <p className="hm-apps-line">
      <span>Add money, investing or taxes</span>
      <span className="hm-dot"> · </span>
      <button type="button" data-home-item="" className="hm-quiet-link" onClick={() => navigate({ t: "lifeapps" })}>
        Life apps
      </button>
    </p>
  );
}

// ───────────────────────────────────────────────────────────────────────────── page

/** j/k and ↓/↑ move through Home's rows; x and Space tick the focused to-do. */
function onListKeys(e: KeyboardEvent<HTMLDivElement>) {
  const t = e.target as HTMLElement;
  if (t.closest("input, textarea, [contenteditable='true']") || e.metaKey || e.ctrlKey || e.altKey) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-home-item]")];
  const i = items.indexOf(t.closest<HTMLElement>("[data-home-item]") ?? (null as unknown as HTMLElement));
  if (e.key === "j" || e.key === "ArrowDown" || e.key === "k" || e.key === "ArrowUp") {
    const dir = e.key === "j" || e.key === "ArrowDown" ? 1 : -1;
    const next = items[i < 0 ? (dir > 0 ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, i + dir))];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  } else if ((e.key === "x" || e.key === " ") && t.hasAttribute("data-toggle")) {
    e.preventDefault();
    t.closest("li")?.querySelector<HTMLButtonElement>("[role=checkbox]")?.click();
  }
}

export default function HomePage() {
  const now = useStableNow(30_000);
  const today = localDay(now);
  const events = useTodayEvents(today);
  const lifeos = useLifeOsTodos(today);
  const note = useTodayNoteMeta(today);
  const gs = useGetStarted();
  const fresh = !!gs?.show;
  const allDay = (events ?? []).filter((e) => e.allDay);
  const date = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  return (
    <div className="hm-page" onKeyDown={onListKeys}>
      <header className="hm-head">
        <h1 className="hm-date">{date}</h1>
        <p className="hm-sub">
          {allDay.map((e) => (
            <span key={e.id}>
              {e.title}
              <span className="hm-dot"> · </span>
            </span>
          ))}
          <button type="button" className="hm-quiet-link is-underlined" onClick={() => void openTodayNote().catch((e) => notify.fromError(e, "Couldn’t open today’s note"))}>
            Today’s note
          </button>
        </p>
      </header>
      <CaptureField autoFocus={fresh} />
      {fresh ? <GetStarted state={gs!} /> : null}
      {events && lifeos.items !== null ? <Agenda events={events} now={now} taskIds={lifeos.ids} /> : null}
      <Todo today={today} noteId={note?.id ?? null} lifeos={lifeos} />
      <MoneyLine today={today} />
      <Recent />
      {fresh ? <LifeAppsLine /> : null}
    </div>
  );
}
