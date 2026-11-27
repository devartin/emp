/**
 * Home = the day (PROGRAMME-v3 K4; Flow r2 §2.3; 1.0 brief §2.6). One 720px column in a fixed order, no containers:
 *
 *   the date (H1, no greeting) · all-day items · Today's note
 *   [new workspace] the recovery-key reminder, Start here, the apps building in the background
 *   one capture field (plain text is a task; t / n / −12.50 prefixes keep working, capture.ts)
 *   [new workspace] Getting started: a short self-ticking checklist that can be hidden
 *   Agenda       today's events, with a now line
 *   To do        starred, overdue and due-today tasks, then unchecked to-dos of today's note; the habits line
 *   Money        Money's one-line glance plus at most one alert (only with the Money app)
 *   Recent       six pages
 *
 * Empty sections are omitted. Not customisable by design. j/k (or ↓/↑) move through the rows from the moment Home
 * opens, x ticks the focused to-do, Enter or Space opens it. Home's first render never pulls in the editor.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { api } from "@/backend";
import type { CalendarEvent, Id, RowDTO } from "@/backend/types";
import { openTodayNote } from "@/app/commands";
import { navigate } from "@/app/router";
import { cn } from "@/lib/cn";
import { formatRelative, formatTime } from "@/lib/dates";
import { notify } from "@/stores/toasts";
import { useUi } from "@/stores/ui";
import { Amount } from "@/ui/Amount";
import { Checkbox } from "@/ui/Checkbox";
import { PageIcon } from "@/features/shell/PageIcon";
import { optionId, read, write } from "@/features/lifeapps/cells";
import { useAppDatabases, useRows, useStableNow, type AppDb } from "@/features/lifeapps/data";
import { CaptureField } from "./CaptureField";
import { GettingStarted, RecoveryReminder, SetupProgress, StartHere, useFirstRun } from "./firstRun";
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

/** Marks a section that is still loading, so `emp:route-ready` waits for it (routeReady.ts) and nothing is shown
 * until its data is real. */
const Loading = () => <span data-route-busy="" hidden />;

/** Chained loads (a section's data, then its rows) leave short gaps; the body waits this long without one. */
const SETTLE_QUIET_MS = 40;
/** A section that never finishes loading does not keep the rest of Home hidden for longer than this. */
const SETTLE_MAX_MS = 1200;

/**
 * Home's body appears whole (1.0 brief §4, skeleton → content without jumps): it stays transparent until no
 * section is loading, then fades in (120 ms, CSS; instant under reduced motion). Without this, Start here and
 * Getting started (which wait on the workspace's first-run state) popped in above the capture field after the
 * first paint and pushed everything down. The date above it paints at once.
 */
function useSettled(ref: RefObject<HTMLElement | null>): boolean {
  const [settled, setSettled] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (settled || !el) return;
    let quiet = 0;
    const idle = () => !el.querySelector("[data-route-busy]");
    const arm = () => {
      window.clearTimeout(quiet);
      if (idle()) quiet = window.setTimeout(() => idle() && setSettled(true), SETTLE_QUIET_MS);
    };
    const mo = new MutationObserver(arm);
    mo.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-route-busy"] });
    arm();
    const cap = window.setTimeout(() => setSettled(true), SETTLE_MAX_MS);
    return () => {
      mo.disconnect();
      window.clearTimeout(quiet);
      window.clearTimeout(cap);
    };
  }, [ref, settled]);
  return settled;
}

/** Times always carry minutes ("4:00 PM", not "4 PM") so the time column lines up. */
const clock = (v: Date | string) => {
  const s = formatTime(v);
  return /^\d{1,2} \S+$/.test(s) ? s.replace(" ", ":00 ") : s;
};

const daysLate = (due: string, today: string) => Math.round((Date.parse(`${today}T12:00:00`) - Date.parse(`${due}T12:00:00`)) / 86_400_000);

// ───────────────────────────────────────────────────────────────────────────── agenda

function NowLine({ now }: { now: Date }) {
  return (
    <li className="hm-now">
      <span className="sr-only">Now, {clock(now)}</span>
    </li>
  );
}

function Agenda({ events, now, taskIds }: { events: CalendarEvent[]; now: Date; taskIds: ReadonlySet<Id> }) {
  const t = now.getTime();
  // Tasks that To do lists (time blocks included) are not listed twice; other Life OS rows stay on the agenda.
  const timed = events.filter((e) => !e.allDay && !(e.source === "db" && e.link?.t === "row" && taskIds.has(e.link.id)));
  const nowIndex = timed.findIndex((e) => Date.parse(e.end) > t);
  const rows: ReactNode[] = [];
  timed.forEach((e, i) => {
    const start = Date.parse(e.start);
    const end = Date.parse(e.end);
    const live = start <= t && end > t;
    if (i === nowIndex && !live) rows.push(<NowLine key="now" now={now} />);
    rows.push(
      <li key={e.id}>
        <button
          type="button"
          data-home-item=""
          className={cn("hm-row hm-event", end <= t && "is-past")}
          onClick={() => (e.link ? useUi.getState().openPeek(e.link) : navigate({ t: "calendar" }))}
        >
          <span className="hm-time tabular">{clock(e.start)}</span>
          <span className="hm-row-title">{e.title}</span>
          <span className="hm-row-meta">{live ? `until ${clock(e.end)}` : e.location ?? ""}</span>
        </button>
      </li>,
    );
  });
  if (nowIndex < 0 && timed.length) rows.push(<NowLine key="now" now={now} />);
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
  // Rows ticked during this visit stay in place (struck through) until you leave Home, and remember the status they
  // had, so unticking puts a Scheduled or Waiting task back where it was.
  const kept = useRef(new Map<Id, string | null>());
  const complete = useCallback(
    async (r: RowDTO, done: boolean) => {
      if (!db) return;
      const status = db.p("task.status");
      if (!status) return;
      const current = r.values[status.id];
      const before = current && current.t === "status" ? current.v : null;
      if (done && !kept.current.get(r.id)) kept.current.set(r.id, before);
      const next = done ? optionId(status, "Done") : (kept.current.get(r.id) ?? optionId(status, "Next"));
      if (!next) return;
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
  const picked = useMemo(() => {
    if (!lifeos) return [];
    if (!dbs || (db && !rows)) return null;
    if (!db || !rows) return [];
    const isDone = (r: RowDTO) => read.opt(r, db.p("task.status"))?.name === "Done";
    const day = (r: RowDTO, role: string) => read.date(r, db.p(role))?.start?.slice(0, 10);
    const starred = (r: RowDTO) => read.bool(r, db.p("task.top3"));
    const list = rows.filter((r) => {
      if (kept.current.has(r.id)) return true;
      if (isDone(r)) return false;
      const d = day(r, "task.due");
      return starred(r) || (!!d && d <= today) || day(r, "task.scheduled") === today;
    });
    // The time a row shows: its time block today, else the due time.
    const at = (r: RowDTO) => {
      const sched = read.date(r, db.p("task.scheduled"));
      const due = read.date(r, db.p("task.due"));
      return sched?.time && sched.start?.slice(0, 10) === today ? sched.start : due?.time && due.start ? due.start : null;
    };
    const rank = (r: RowDTO) => {
      const d = day(r, "task.due");
      return starred(r) ? 0 : d && d < today ? 1 : 2;
    };
    const ms = (r: RowDTO) => {
      const t = at(r);
      return t ? Date.parse(t) : Number.POSITIVE_INFINITY;
    };
    list.sort((x, y) => rank(x) - rank(y) || ms(x) - ms(y) || (day(x, "task.due") ?? "9999").localeCompare(day(y, "task.due") ?? "9999"));
    return list.map((r) => ({ r, at: at(r), late: (day(r, "task.due") ?? "9999") < today, done: isDone(r) }));
  }, [lifeos, dbs, db, rows, today]);
  const items = useMemo(
    () =>
      picked?.map(({ r, at, late, done }): TodoItem => {
        const n = late ? daysLate(day10(read.date(r, db?.p("task.due"))?.start), today) : 0;
        return {
          key: r.id,
          title: read.text(r, db?.p("task.title")) || "Untitled task",
          meta: late ? (n === 1 ? "Yesterday" : `${n} days late`) : at ? clock(at) : "",
          late: late && !done,
          checked: done,
          toggle: (v) => void complete(r, v),
          open: () => useUi.getState().openPeek({ t: "row", id: r.id }),
        };
      }) ?? null,
    [picked, db, today, complete],
  );
  // Only the tasks To do lists leave the agenda; any other Life OS time block stays there.
  const ids = useMemo(() => new Set((picked ?? []).map((x) => x.r.id)), [picked]);
  return { db, items, instanceId: lifeos?.id, ids };
}

const day10 = (v: string | undefined) => (v ?? "").slice(0, 10);

/** To do shows this many rows at first; the rest open in place. */
const TODO_FIRST = 5;

function Todo({ today, noteId, lifeos }: { today: string; noteId: Id | null; lifeos: ReturnType<typeof useLifeOsTodos> }) {
  const { items: tasks, instanceId } = lifeos;
  const note = useTodayNoteMeta(today);
  const { todos, setChecked } = useNoteTodos(note);
  const kept = useRef(new Set<string>());
  const habits = useHabitsToday(today);
  const [all_, setAll] = useState(false);
  if (tasks === null || todos === null || habits === null) return <Loading />;
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
  const habitLine = habits ?? null;
  if (!all.length && !habitLine) return null;
  // A long list would push Money below the fold: the first rows show, the rest open in place.
  const over = all.length - TODO_FIRST;
  const hidden = all_ || over <= 1 ? 0 : over;
  const shown = hidden ? all.slice(0, TODO_FIRST) : all;
  return (
    <Section title="To do" link={instanceId ? { label: "Tasks", go: () => navigate({ t: "app", instanceId }) } : undefined}>
      <ul className="hm-list">
        {shown.map((t) => (
          <li key={t.key} className={cn("hm-row hm-todo", t.checked && "is-done")}>
            <Checkbox checked={t.checked} onCheckedChange={t.toggle} aria-label={t.checked ? `Mark “${t.title}” not done` : `Complete “${t.title}”`} />
            <button type="button" data-home-item="" data-toggle="" className="hm-row-title hm-todo-title" onClick={t.open} aria-keyshortcuts="x">
              {t.title}
            </button>
            <span className={cn("hm-row-meta tabular", t.late && "is-late")}>{t.meta}</span>
          </li>
        ))}
        {hidden ? (
          <li className="hm-row">
            <button type="button" data-home-item="" className="hm-quiet-link" onClick={() => setAll(true)}>
              {hidden} more
            </button>
          </li>
        ) : null}
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
  if (g === null) return <Loading />;
  if (!g) return null;
  // Whole units in a sentence (DESIGN §6.2: summaries drop cents); <Amount> is tabular and masked under Hide numbers.
  const money = (n: number, className?: string) => <Amount value={{ amount: String(Math.round(Math.abs(n))), currency: g.currency }} noCents className={className} />;
  const parts: ReactNode[] = [];
  if (g.left !== null)
    parts.push(
      <button key="left" type="button" data-home-item="" className="hm-money-part" onClick={() => navigate({ t: "app", instanceId: g.instanceId, tab: "budget" })}>
        {money(g.left, cn("hm-num", g.left < 0 && "is-over"))} {g.left < 0 ? "over" : "left"} in {g.month}
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
    <Section title="Money" link={{ label: "Money", go: () => navigate({ t: "app", instanceId: g.instanceId }) }}>
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
              {alert.text} {money(alert.amount)} over budget
            </>
          ) : (
            <>
              {alert.text} {money(alert.amount)} due{" "}
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

// ───────────────────────────────────────────────────────────────────────────── page

/**
 * j/k and ↓/↑ move through Home's rows; x ticks the focused to-do. The listener is on the window so the keys work
 * the moment Home opens, whether focus sits in the content region (Shell puts it there on every route change), on the
 * page, or still on the sidebar's Home row after a click.
 */
function useListKeys(pageRef: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const page = pageRef.current;
      if (!page || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (!t || t.closest("input, textarea, select, [contenteditable='true'], [role='dialog'], [role='menu'], [role='listbox']")) return;
      const inPage = page.contains(t);
      const vertical = e.key === "j" || e.key === "k" || e.key === "ArrowDown" || e.key === "ArrowUp";
      // From outside the page: j/k from the content region or the sidebar's main rows; the arrows only when nothing in
      // particular has focus (so they never steal a widget's own arrow keys).
      const idle = t === document.body || t.classList.contains("emp-content");
      const jk = e.key === "j" || e.key === "k";
      if (!inPage && !(idle && vertical) && !(jk && t.closest(".emp-sb-primary"))) return;
      const items = [...page.querySelectorAll<HTMLElement>("[data-home-item]")];
      if (vertical) {
        const i = inPage ? items.indexOf(t.closest<HTMLElement>("[data-home-item]") ?? t) : -1;
        const dir = e.key === "j" || e.key === "ArrowDown" ? 1 : -1;
        const next = items[i < 0 ? (dir > 0 ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, i + dir))];
        if (next) {
          e.preventDefault();
          next.focus();
          next.scrollIntoView({ block: "nearest" });
        }
      } else if (e.key === "x" && inPage && t.hasAttribute("data-toggle")) {
        e.preventDefault();
        t.closest("li")?.querySelector<HTMLButtonElement>("[role=checkbox]")?.click();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pageRef]);
}

export default function HomePage() {
  const now = useStableNow(30_000);
  const today = localDay(now);
  const events = useTodayEvents(today);
  const lifeos = useLifeOsTodos(today);
  const note = useTodayNoteMeta(today);
  const [first, setFirst] = useFirstRun();
  const allDay = (events ?? []).filter((e) => e.allDay);
  const date = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const pageRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const settled = useSettled(bodyRef);
  useListKeys(pageRef);

  return (
    <div className="hm-page" ref={pageRef}>
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
      <div ref={bodyRef} className="hm-body" data-settled={settled ? "" : undefined}>
        <RecoveryReminder />
        {first ? <StartHere state={first} set={setFirst} /> : <Loading />}
        <SetupProgress />
        <CaptureField />
        {first ? <GettingStarted state={first} set={setFirst} /> : null}
        {events && lifeos.items !== null ? <Agenda events={events} now={now} taskIds={lifeos.ids} /> : <Loading />}
        <Todo today={today} noteId={note?.id ?? null} lifeos={lifeos} />
        <MoneyLine today={today} />
        <Recent />
      </div>
    </div>
  );
}
