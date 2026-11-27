/**
 * Tasks hub (app id `life-os`, §16.6; called "Tasks" since 1.0): Tasks · Lists · Review. It lands on Tasks with focus
 * in the quick-add field; the day itself (due and overdue tasks, today's agenda, habits) lives on Home (PROGRAMME-v3
 * K4: Home is the only "Today"). Completing a task ticks the check and strikes the title (C1); the backend keeps
 * `Done` / `Completed at` in step and spawns the next occurrence of a recurring task. Quick add previews its parse as
 * plain chips before Enter. No KPI row: the subtitle states the counts once the tasks have loaded (never "0 open"
 * while they load). Options are matched by manifest key (`done`, `next`, `p1`), which is the option id on both
 * backends, so renamed statuses keep working.
 */
import { ArrowRight, CalendarDays, Check, FolderKanban, Inbox, Plus, RotateCcw, Target } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { api } from "@/backend";
import type { Id, LifeAppInstance, RowDTO } from "@/backend/types";
import { navigate } from "@/app/router";
import { BarChart } from "@/charts/Bar";
import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/dates";
import { parseNatural } from "@/lib/nlp";
import { notify } from "@/stores/toasts";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { Button } from "@/ui/Button";
import { Card } from "@/ui/Card";
import { EmptyState } from "@/ui/EmptyState";
import { Progress } from "@/ui/Progress";
import { Segmented } from "@/ui/Segmented";
import { Skeleton } from "@/ui/Skeleton";
import { Tag } from "@/ui/Tag";
import { spring } from "@/ui/motion/tokens";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { AppHeader } from "../AppHeader";
import { keyOf, localDay, optIs, optionFor, read, write } from "../cells";
import { useAppDatabases, useMetrics, useRows, useStableNow, type AppDb } from "../data";
import { appVars, identity } from "../identity";
import { PageIcon } from "@/features/shell/PageIcon";

type Tab = "tasks" | "lists" | "review";

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return localDay(d);
};

function dueLabel(due: string | undefined, today: string): { text: string; cls?: string } | null {
  if (!due) return null;
  const d = due.slice(0, 10);
  if (d < today) {
    const n = Math.round((new Date(`${today}T12:00:00`).getTime() - new Date(`${d}T12:00:00`).getTime()) / 86_400_000);
    return { text: n === 1 ? "Yesterday" : `${n} days ago`, cls: "lo-due-over" };
  }
  if (d === today) return { text: "Today", cls: "lo-due-today" };
  if (d === addDays(today, 1)) return { text: "Tomorrow" };
  return { text: new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) };
}

/** Priority / quadrant option keys → dot colour. */
const PRIO_COLOR: Record<string, string> = { p1: "var(--loss)", p2: "var(--warning)", p3: "var(--info)", p4: "rgba(var(--text-rgb),.25)", do: "var(--loss)", do_now: "var(--loss)", schedule: "var(--info)", delegate: "var(--warning)", drop: "rgba(var(--text-rgb),.25)" };
const PRIO_KEYS = Object.keys(PRIO_COLOR);

/** The task lists (status option keys) in order, with their labels. */
const LISTS = [
  { key: "inbox", label: "Inbox" },
  { key: "next", label: "Next" },
  { key: "scheduled", label: "Scheduled" },
  { key: "waiting", label: "Waiting" },
  { key: "someday", label: "Someday" },
  { key: "done", label: "Done" },
] as const;
type ListKey = (typeof LISTS)[number]["key"];
const LIST_KEYS = LISTS.map((l) => l.key);

/** The status key of a task (`inbox` … `done`), matched by option id first. */
function statusKey(row: RowDTO, db: AppDb | undefined): ListKey | null {
  return keyOf(read.opt(row, db?.p("task.status")), LIST_KEYS) as ListKey | null;
}

// ───────────────────────────────────────────────────────────────────────────── task row

/** `ref` (React 19 prop) lets AnimatePresence `popLayout` pop an exiting row out of flow so its siblings glide up. */
function TaskRow({ row, db, today, projectName, onToggle, showStatus, ref }: { row: RowDTO; db: AppDb; today: string; projectName?: string; onToggle: (row: RowDTO, el: HTMLElement) => void; showStatus?: boolean; ref?: Ref<HTMLDivElement> }) {
  const reduced = useReducedMotionPref();
  const status = read.opt(row, db.p("task.status"));
  const done = optIs(status, "done");
  const prio = read.opt(row, db.p("task.priority"));
  const prioKey = keyOf(prio, PRIO_KEYS);
  const due = read.date(row, db.p("task.due"));
  const sched = read.date(row, db.p("task.scheduled"));
  const dl = dueLabel(due?.start, today);
  const title = read.text(row, db.p("task.title")) || "Untitled";
  const repeat = row.values[db.p("task.recurrence")?.id ?? ""];
  const p = prioKey === "p1" || prioKey === "do" || prioKey === "do_now" ? "1" : prioKey === "p2" ? "2" : undefined;
  return (
    <m.div ref={ref} layout="position" transition={spring.glide} className={cn("lo-task group", done && "is-done")} exit={{ opacity: 0, transition: { duration: 0.12, ease: [0.4, 0, 1, 1] } }}>
      <button
        type="button"
        className={cn("lo-check", done && "is-done")}
        style={appVars("life-os")}
        data-p={p}
        aria-label={done ? `Mark “${title}” not done` : `Complete “${title}”`}
        aria-pressed={done}
        onClick={(e) => onToggle(row, e.currentTarget)}
      >
        <AnimatePresence>
          {done ? (
            <m.svg key="c" viewBox="0 0 24 24" width="12" height="12" initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.4 }} animate={{ opacity: 1, scale: 1, transition: reduced ? { duration: 0.12 } : spring.pop }} exit={{ opacity: 0, transition: { duration: 0.1 } }}>
              <m.path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: reduced ? 1 : 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.2, delay: 0.04, ease: [0.2, 0, 0, 1] }} />
            </m.svg>
          ) : null}
        </AnimatePresence>
      </button>
      <button type="button" className="lo-task-title text-left" onClick={() => useUi.getState().openPeek({ t: "row", id: row.id })}>
        <span className="relative inline-block max-w-full truncate align-bottom">
          {title}
          <AnimatePresence>{done ? <m.span key="s" className="lo-strike" initial={{ scaleX: reduced ? 1 : 0 }} animate={{ scaleX: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }} /> : null}</AnimatePresence>
        </span>
      </button>
      <span className="lo-meta">
        {repeat ? <RotateCcw size={11} aria-label="Repeats" /> : null}
        {projectName ? <span className="max-w-[140px] truncate">{projectName}</span> : null}
        {sched?.time && sched.start ? <span className="tabular">{formatTime(sched.start)}</span> : null}
        {dl ? <span className={cn("tabular", dl.cls)}>{dl.text}</span> : null}
        {showStatus && status ? <Tag color={(status.color as never) ?? "gray"}>{status.name}</Tag> : null}
        {prio ? <span className="lo-pri" style={{ background: (prioKey && PRIO_COLOR[prioKey]) || "var(--text-tertiary)" }} title={prio.name} /> : null}
      </span>
    </m.div>
  );
}

function useToggleTask(db: AppDb | undefined, setRows: (fn: (r: RowDTO[]) => RowDTO[]) => void) {
  return async (row: RowDTO, _el: HTMLElement) => {
    if (!db) return;
    const status = db.p("task.status");
    const done = optIs(read.opt(row, status), "done");
    const next = optionFor(status, done ? "next" : "done");
    if (!status || !next) return;
    setRows((rows) => rows.map((r) => (r.id === row.id ? { ...r, values: { ...r.values, [status.id]: write.status(next) } } : r)));
    try {
      const values: Record<Id, ReturnType<typeof write.status> | null> = { [status.id]: write.status(next) };
      const completed = db.p("task.completed");
      if (completed) values[completed.id] = done ? null : write.date(localDay());
      await api.db.rowsUpdate({ updates: [{ id: row.id, values }] });
      if (!done && row.values[db.p("task.recurrence")?.id ?? ""]) notify.info("Next one is scheduled", { description: "This task repeats." });
    } catch (e) {
      notify.fromError(e, "Couldn’t update the task");
    }
  };
}

// ───────────────────────────────────────────────────────────────────────────── quick add

function QuickAdd({ db, autoFocus, onAdded }: { db: AppDb | undefined; autoFocus?: boolean; onAdded?: (list: ListKey) => void }) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // Life OS lands with focus in this field once the tasks database is ready (the field is disabled until then).
  const ready = !!db;
  useEffect(() => {
    if (autoFocus && ready) inputRef.current?.focus({ preventScroll: true });
  }, [autoFocus, ready]);
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => (text.trim() ? parseNatural(text) : null), [text]);
  const submit = async () => {
    if (!db || !parsed || !parsed.title.trim()) return;
    setBusy(true);
    try {
      const values: Record<Id, ReturnType<typeof write.text>> = {};
      const title = db.p("task.title");
      if (title) values[title.id] = write.text(parsed.title.trim());
      const status = db.p("task.status");
      const st = optionFor(status, parsed.start ? "next" : "inbox");
      if (status && st) values[status.id] = status.type === "select" ? write.select(st) : write.status(st);
      const due = db.p("task.due");
      if (due && parsed.start) values[due.id] = parsed.hasTime ? write.date(parsed.start.toISOString(), parsed.end?.toISOString(), true) : write.date(localDay(parsed.start));
      const prio = db.p("task.priority");
      const pKey = parsed.priority === "high" ? "p1" : parsed.priority === "med" ? "p2" : parsed.priority === "low" ? "p4" : null;
      const pid = pKey ? optionFor(prio, pKey) : null;
      if (prio && pid) values[prio.id] = write.select(pid);
      // Source is a text column on desktop and a select in older browser-preview data.
      const src = db.p("task.source");
      if (src?.type === "text") values[src.id] = write.text("Quick add");
      else {
        const sid = optionFor(src, "quick_add");
        if (src && sid) values[src.id] = write.select(sid);
      }
      const est = db.p("task.estimate");
      if (est && parsed.durationMinutes) values[est.id] = write.num(parsed.durationMinutes);
      await api.db.rowCreate({ databaseId: db.id, values });
      setText("");
      // The new task stays in view: the list switches to the one it landed in.
      onAdded?.(parsed.start ? "next" : "inbox");
      notify.success(parsed.start ? "Added to Next" : "Added to Inbox");
    } catch (e) {
      notify.fromError(e, "Couldn’t add the task");
    } finally {
      setBusy(false);
    }
  };
  const chips: ReactNode[] = [];
  if (parsed?.start) chips.push(<span key="d" className="lo-tok panel"><CalendarDays size={11} aria-hidden />{parsed.start.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}{parsed.hasTime ? ` ${formatTime(parsed.start)}` : ""}</span>);
  if (parsed?.priority) chips.push(<span key="p" className="lo-tok panel">!{parsed.priority}</span>);
  for (const t of parsed?.tags ?? []) chips.push(<span key={t} className="lo-tok panel">#{t}</span>);
  if (parsed?.durationMinutes) chips.push(<span key="m" className="lo-tok panel">{parsed.durationMinutes} min</span>);
  return (
    <div className="lo-quickadd well">
      <Plus size={16} className="lo-plus flex-none text-tertiary" aria-hidden />
      <input
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
        placeholder="Add a task, e.g. call the bank tomorrow 3pm !high"
        aria-label="Add a task"
        disabled={!db || busy}
        ref={inputRef}
      />
      {chips}
      <Button size="sm" variant="primary" disabled={!parsed?.title.trim() || busy} onClick={submit} kbd="↵">
        Add
      </Button>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── page

export default function LifeOS({ instance, tab: tabProp }: { instance: LifeAppInstance; tab?: string }) {
  // "projects" is the pre-1.0 name of the Lists tab (older links and insights).
  const tab = (tabProp === "projects" ? "lists" : ["tasks", "lists", "review"].includes(tabProp ?? "") ? tabProp : "tasks") as Tab;
  const { byRole, dbs } = useAppDatabases(instance.id);
  const tasksDb = byRole("task.status");
  const projectsDb = byRole("project.status");
  const areasDb = byRole("area.name");
  const dailyDb = byRole("daily.weekly_review");
  const { rows: tasks, setRows } = useRows(tasksDb?.id);
  const { rows: projects } = useRows(projectsDb?.id);
  const { rows: areas } = useRows(areasDb?.id);
  const { metrics } = useMetrics(instance.id);
  const now = useStableNow();
  const today = localDay(now);
  const toggle = useToggleTask(tasksDb, setRows);

  const projectName = useMemo(() => {
    const map = new Map<Id, string>();
    for (const p of projects ?? []) map.set(p.id, read.text(p, projectsDb?.p("project.name")));
    return map;
  }, [projects, projectsDb]);

  const status = (r: RowDTO) => statusKey(r, tasksDb);
  const open = (tasks ?? []).filter((r) => status(r) !== "done");

  const setTab = (t: Tab) => navigate({ t: "app", instanceId: instance.id, tab: t });
  // Truth: the counts appear once the tasks have loaded; never "0 open" while they load.
  const subtitle = useMemo(() => {
    if (!tasks) return undefined;
    const due = (r: RowDTO) => read.date(r, tasksDb?.p("task.due"))?.start?.slice(0, 10);
    const today_ = open.filter((r) => due(r) === today).length;
    const late = open.filter((r) => (due(r) ?? "9999") < today).length;
    const inbox = open.filter((r) => status(r) === "inbox").length;
    const parts = [`${open.length} open`];
    if (today_) parts.push(`${today_} due today`);
    if (late) parts.push(`${late} overdue`);
    if (inbox) parts.push(`${inbox} in Inbox`);
    return parts.join(" · ");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, tasksDb, today]);

  return (
    <div className="la-hub" style={appVars("life-os")}>
      <AppHeader<Tab>
        instance={instance}
        title={identity("life-os").name}
        subtitle={subtitle}
        tabs={[
          { value: "tasks", label: "Tasks", icon: Inbox },
          { value: "lists", label: "Lists", icon: FolderKanban },
          { value: "review", label: "Review", icon: RotateCcw },
        ]}
        tab={tab}
        onTab={setTab}
      />
      <div className="la-hub-body">
        {dbs && !tasksDb ? (
          <EmptyState icon={Target} title="Your task list is missing" body="It may have been deleted or moved to Trash. Restore it from Trash, or use Tune up to create it again." />
        ) : tab === "tasks" ? (
          <TasksTab db={tasksDb} rows={tasks} today={today} projectName={projectName} onToggle={toggle} />
        ) : tab === "lists" ? (
          <ProjectsTab db={projectsDb} rows={projects} tasksDb={tasksDb} tasks={tasks} areas={areas} areasDb={areasDb} today={today} />
        ) : (
          <ReviewTab instance={instance} metrics={metrics} tasksDb={tasksDb} tasks={tasks} areas={areas} areasDb={areasDb} dailyDb={dailyDb} today={today} />
        )}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── tabs

function TasksTab({ db, rows, today, projectName, onToggle }: { db: AppDb | undefined; rows: RowDTO[] | null; today: string; projectName: Map<Id, string>; onToggle: (r: RowDTO, el: HTMLElement) => void }) {
  const [list, setList] = useState<ListKey>("inbox");
  const label = LISTS.find((l) => l.key === list)?.label ?? "Inbox";
  const shown = (rows ?? [])
    .filter((r) => statusKey(r, db) === list)
    .sort((a, b) => (read.date(a, db?.p("task.due"))?.start ?? "9999").localeCompare(read.date(b, db?.p("task.due"))?.start ?? "9999"));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented value={list} onValueChange={setList} options={LISTS.map((l) => ({ value: l.key, label: l.label }))} aria-label="Show" />
        <span className="flex-1" />
        {db ? (
          <Button size="sm" variant="ghost" onClick={() => navigate({ t: "db", id: db.id })}>
            Open database
          </Button>
        ) : null}
      </div>
      <QuickAdd db={db} autoFocus onAdded={setList} />
      <Card pad="md">
        {!rows || !db ? (
          <Skeleton height={200} radius={10} />
        ) : shown.length ? (
          <div className="relative flex flex-col">
            <AnimatePresence initial={false} mode="popLayout">
              {shown.map((r) => (
                <TaskRow key={r.id} row={r} db={db} today={today} projectName={projectName.get(read.rel(r, db.p("task.project"))[0] ?? "")} onToggle={onToggle} />
              ))}
            </AnimatePresence>
          </div>
        ) : (
          <p className="py-8 text-center text-body-sm text-tertiary">{list === "inbox" ? "Inbox is empty." : `Nothing in ${label}.`}</p>
        )}
      </Card>
    </div>
  );
}

function NewList({ db }: { db: AppDb }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async () => {
    const title = name.trim();
    const nameProp = db.p("project.name");
    if (!title || !nameProp) return;
    setBusy(true);
    try {
      const values: Record<Id, ReturnType<typeof write.text>> = { [nameProp.id]: write.text(title) };
      const st = db.p("project.status");
      const active = optionFor(st, "active");
      if (st && active) values[st.id] = st.type === "status" ? write.status(active) : write.select(active);
      await api.db.rowCreate({ databaseId: db.id, values });
      setName("");
      notify.success(`${title} added`);
    } catch (e) {
      notify.fromError(e, "Couldn’t add the list");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="lo-quickadd well">
      <Plus size={16} className="lo-plus flex-none text-tertiary" aria-hidden />
      <input
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void add();
          }
        }}
        placeholder="New list, e.g. Plan the move"
        aria-label="New list"
        disabled={busy}
      />
      <Button size="sm" variant="primary" disabled={!name.trim() || busy} onClick={add} kbd="↵">
        Add
      </Button>
    </div>
  );
}

function ProjectsTab({ db, rows, tasksDb, tasks, areas, areasDb, today }: { db: AppDb | undefined; rows: RowDTO[] | null; tasksDb: AppDb | undefined; tasks: RowDTO[] | null; areas: RowDTO[] | null; areasDb: AppDb | undefined; today: string }) {
  const areaName = new Map((areas ?? []).map((a) => [a.id, { name: read.text(a, areasDb?.p("area.name")) }] as const));
  if (!rows || !db) return <Skeleton height={240} radius={14} />;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-body-sm text-secondary">A list groups tasks toward an outcome. Give each one a next task.</p>
        <Button size="sm" variant="ghost" onClick={() => navigate({ t: "db", id: db.id })}>
          Open database
        </Button>
      </div>
      <NewList db={db} />
      {!rows.length ? (
        <EmptyState icon={FolderKanban} title="No lists yet" body="Add one above, then pick it as the list of a task." />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
          {rows.map((p) => {
            const ts = (tasks ?? []).filter((t) => read.rel(t, tasksDb?.p("task.project")).includes(p.id));
            const done = ts.filter((t) => statusKey(t, tasksDb) === "done").length;
            const next = ts.find((t) => ["next", "scheduled"].includes(statusKey(t, tasksDb) ?? ""));
            const area = areaName.get(read.rel(p, db.p("project.area"))[0] ?? "");
            const st = read.opt(p, db.p("project.status"));
            const deadline = read.date(p, db.p("project.deadline"))?.start?.slice(0, 10);
            const days = deadline ? Math.round((new Date(`${deadline}T12:00:00`).getTime() - new Date(`${today}T12:00:00`).getTime()) / 86_400_000) : null;
            const pct = ts.length ? done / ts.length : 0;
            return (
              <button key={p.id} type="button" className="lo-project panel" onClick={() => useUi.getState().openPeek({ t: "row", id: p.id })}>
                <div className="flex items-center gap-2">
                  <PageIcon icon={p.icon} kind="doc" size={18} />
                  <span className="min-w-0 flex-1 truncate text-body font-semibold text-primary">{read.text(p, db.p("project.name")) || "Untitled"}</span>
                  {st ? <Tag color={(st.color as never) ?? "gray"}>{st.name}</Tag> : null}
                </div>
                <p className="line-clamp-2 min-h-[36px] text-body-sm text-secondary">{read.text(p, db.p("project.outcome")) || "No outcome written yet."}</p>
                <div className="flex items-center gap-2">
                  <Progress value={pct} size={4} color="var(--app)" className="flex-1" aria-label="Progress" />
                  <span className="text-caption tabular text-tertiary">{done}/{ts.length}</span>
                </div>
                <div className="flex items-center gap-2 text-caption text-tertiary">
                  {area ? <span>{area.name}</span> : null}
                  <span className="flex-1" />
                  {days !== null ? <span className={cn("tabular", days < 7 && "text-warning-text font-semibold")}>{days >= 0 ? `${days} days left` : `${-days} days late`}</span> : null}
                </div>
                <div className="groove-top flex items-center gap-1.5 pt-2.5 text-caption">
                  <ArrowRight size={12} className={next ? "text-accent-text" : "text-warning-text"} aria-hidden />
                  <span className={cn("truncate", next ? "text-primary" : "text-warning-text")}>{next ? read.text(next, tasksDb?.p("task.title")) : "No next task"}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ReviewTab({ instance, metrics, tasksDb, tasks, areas, areasDb, dailyDb, today }: { instance: LifeAppInstance; metrics: Record<string, { value: unknown; display: string }> | null; tasksDb: AppDb | undefined; tasks: RowDTO[] | null; areas: RowDTO[] | null; areasDb: AppDb | undefined; dailyDb: AppDb | undefined; today: string }) {
  const days = Number(metrics?.days_since_review?.value ?? 0);
  const never = !metrics?.last_review_date?.value;
  const last = never ? "Not yet" : (metrics?.last_review_date?.display ?? "Not yet");
  const { rows: daily } = useRows(dailyDb?.id);
  const [busy, setBusy] = useState(false);
  const byArea = useMemo(() => {
    const names = new Map((areas ?? []).map((a) => [a.id, read.text(a, areasDb?.p("area.name"))] as const));
    const from = addDays(today, -6);
    const out = new Map<string, number>();
    for (const t of tasks ?? []) {
      const d = read.date(t, tasksDb?.p("task.completed"))?.start?.slice(0, 10);
      if (!d || d < from || statusKey(t, tasksDb) !== "done") continue;
      const a = names.get(read.rel(t, tasksDb?.p("task.area"))[0] ?? "") || "No area";
      out.set(a, (out.get(a) ?? 0) + 1);
    }
    return [...out.entries()].map(([area, done]) => ({ area, done })).sort((a, b) => b.done - a.done);
  }, [tasks, areas, areasDb, tasksDb, today]);
  /** Logging a review ticks "Weekly review done" on today's daily note (what the review metrics read). */
  const markDone = async () => {
    setBusy(true);
    try {
      const flag = dailyDb?.p("daily.weekly_review");
      const date = dailyDb?.p("daily.date");
      if (dailyDb && flag && date) {
        const existing = (daily ?? []).find((r) => read.date(r, date)?.start?.slice(0, 10) === today);
        if (existing) await api.db.rowsUpdate({ updates: [{ id: existing.id, values: { [flag.id]: write.check(true) } }] });
        else {
          const title = dailyDb.p("daily.title");
          const values: Record<Id, ReturnType<typeof write.text>> = { [date.id]: write.date(today), [flag.id]: write.check(true) };
          if (title) values[title.id] = write.text(new Date(`${today}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }));
          await api.db.rowCreate({ databaseId: dailyDb.id, values });
        }
      }
      if (instance.checklist.some((c) => c.id === "review" && !c.done)) await api.lifeapp.checklistTick({ instanceId: instance.id, itemId: "review" }).catch(() => undefined);
      await useWorkspace.getState().refreshLifeapps();
      notify.success("Weekly review logged");
    } catch (e) {
      notify.fromError(e, "Couldn’t log the review");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="lo-grid">
      <Card title="Weekly review" subtitle={`Last done: ${last}`}>
        <div className="flex items-center gap-4">
          <div className={cn("lo-days well", !never && days > 7 ? "is-late" : "is-ok")} data-static="">
            {never ? "–" : days}
          </div>
          <p className="text-body-sm text-secondary">{never ? "No review logged yet" : days === 1 ? "day since your last review" : "days since your last review"}</p>
        </div>
        <ol className="mt-4 flex flex-col gap-2 text-body-sm">
          {["Clear the inbox", "Check calendar, lists and waiting", "Read the someday list", "Pick next week’s top 3"].map((s, i) => (
            <li key={s} className="flex items-center gap-3">
              <span className="lo-stepnum well" data-static="">{i + 1}</span>
              {s}
            </li>
          ))}
        </ol>
        <div className="mt-5 flex gap-2">
          <Button variant="primary" icon={Check} onClick={markDone} loading={busy}>
            Log review
          </Button>
        </div>
      </Card>
      <Card title="Done this week" subtitle="By area">
        {byArea.length ? (
          <BarChart data={byArea} x="area" series={[{ key: "done", label: "Done", color: "var(--app)" }]} height={220} format="number" horizontal summaryLabel="Tasks completed this week by area" />
        ) : (
          <p className="py-10 text-center text-body-sm text-tertiary">Complete a task to see it here.</p>
        )}
      </Card>
    </div>
  );
}
