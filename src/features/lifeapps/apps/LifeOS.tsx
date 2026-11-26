/**
 * Life OS hub (§16.6): Today (quick add with natural-language chips, Top 3, due & overdue, agenda timeline with
 * Google events and scheduled task blocks, habit strip, insights from every app), Tasks, Projects and Review.
 * Completing a task: the box pops with spring.bouncy, a strike line draws from the left over 220ms and the text
 * fades to tertiary (§4.2 "To-do checked"); recurring tasks spawn their next occurrence in the backend.
 */
import { ArrowRight, CalendarDays, Check, CircleDashed, FolderKanban, Inbox, Plus, RotateCcw, Star, Sun, Target } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "@/backend";
import type { CalendarEvent, Id, LifeAppInstance, RowDTO } from "@/backend/types";
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
import { KpiTile } from "@/ui/KpiTile";
import { Progress } from "@/ui/Progress";
import { Segmented } from "@/ui/Segmented";
import { Skeleton } from "@/ui/Skeleton";
import { Tag } from "@/ui/Tag";
import { celebrate } from "@/ui/motion/Celebrate";
import { spring } from "@/ui/motion/tokens";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { AppHeader } from "../AppHeader";
import { localDay, optionId, read, write } from "../cells";
import { useAppDatabases, useMetrics, useRows, useStableNow, type AppDb } from "../data";
import { identity } from "../identity";
import { InsightsFeed } from "../Insights";
import { StartHere } from "../StartHere";

type Tab = "today" | "tasks" | "projects" | "review";

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

const PRIO_COLOR: Record<string, string> = { P1: "var(--loss)", P2: "var(--warning)", P3: "var(--info)", P4: "rgba(var(--text-rgb),.25)", "Do now": "var(--loss)", Schedule: "var(--info)", Delegate: "var(--warning)", Drop: "rgba(var(--text-rgb),.25)" };

// ───────────────────────────────────────────────────────────────────────────── task row

function TaskRow({ row, db, today, projectName, onToggle, showStatus }: { row: RowDTO; db: AppDb; today: string; projectName?: string; onToggle: (row: RowDTO, el: HTMLElement) => void; showStatus?: boolean }) {
  const reduced = useReducedMotionPref();
  const status = read.opt(row, db.p("task.status"));
  const done = status?.name === "Done";
  const prio = read.opt(row, db.p("task.priority"));
  const due = read.date(row, db.p("task.due"));
  const sched = read.date(row, db.p("task.scheduled"));
  const dl = dueLabel(due?.start, today);
  const title = read.text(row, db.p("task.title")) || "Untitled";
  const repeat = row.values[db.p("task.recurrence")?.id ?? ""];
  const p = prio?.name === "P1" || prio?.name === "Do now" ? "1" : prio?.name === "P2" ? "2" : undefined;
  return (
    <m.div layout="position" className={cn("lo-task group", done && "is-done")} exit={{ opacity: 0, height: 0, transition: { duration: 0.2 } }}>
      <m.button
        type="button"
        className={cn("lo-check", done && "is-done")}
        data-p={p}
        aria-label={done ? `Mark “${title}” not done` : `Complete “${title}”`}
        aria-pressed={done}
        onClick={(e) => onToggle(row, e.currentTarget)}
        animate={done && !reduced ? { scale: [0.85, 1] } : { scale: 1 }}
        transition={spring.bouncy}
        whileTap={{ scale: 0.9 }}
      >
        <AnimatePresence>
          {done ? (
            <m.svg key="c" viewBox="0 0 24 24" width="12" height="12" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <m.path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: reduced ? 1 : 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }} />
            </m.svg>
          ) : null}
        </AnimatePresence>
      </m.button>
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
        {prio ? <span className="lo-pri" style={{ background: PRIO_COLOR[prio.name] ?? "var(--text-tertiary)" }} title={prio.name} /> : null}
      </span>
    </m.div>
  );
}

function useToggleTask(db: AppDb | undefined, setRows: (fn: (r: RowDTO[]) => RowDTO[]) => void) {
  return async (row: RowDTO, el: HTMLElement) => {
    if (!db) return;
    const status = db.p("task.status");
    const done = read.opt(row, status)?.name === "Done";
    const next = optionId(status, done ? "Next" : "Done");
    if (!status || !next) return;
    if (!done) celebrate(el, { particles: 6, badge: false });
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

function QuickAdd({ db }: { db: AppDb | undefined }) {
  const [text, setText] = useState("");
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
      const st = optionId(status, parsed.start ? "Next" : "Inbox");
      if (status && st) values[status.id] = write.status(st);
      const due = db.p("task.due");
      if (due && parsed.start) values[due.id] = parsed.hasTime ? write.date(parsed.start.toISOString(), parsed.end?.toISOString(), true) : write.date(localDay(parsed.start));
      const prio = db.p("task.priority");
      const pName = parsed.priority === "high" ? "P1" : parsed.priority === "med" ? "P2" : parsed.priority === "low" ? "P4" : null;
      const pid = pName ? optionId(prio, pName) : null;
      if (prio && pid) values[prio.id] = write.select(pid);
      const src = db.p("task.source");
      const sid = optionId(src, "Quick add");
      if (src && sid) values[src.id] = write.select(sid);
      const est = db.p("task.estimate");
      if (est && parsed.durationMinutes) values[est.id] = write.num(parsed.durationMinutes);
      await api.db.rowCreate({ databaseId: db.id, values });
      setText("");
      notify.success(parsed.start ? "Task added" : "Added to Inbox");
    } catch (e) {
      notify.fromError(e, "Couldn’t add the task");
    } finally {
      setBusy(false);
    }
  };
  const chips: ReactNode[] = [];
  if (parsed?.start) chips.push(<span key="d" className="lo-tok"><CalendarDays size={11} aria-hidden />{parsed.start.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}{parsed.hasTime ? ` ${formatTime(parsed.start)}` : ""}</span>);
  if (parsed?.priority) chips.push(<span key="p" className="lo-tok">!{parsed.priority}</span>);
  for (const t of parsed?.tags ?? []) chips.push(<span key={t} className="lo-tok">#{t}</span>);
  if (parsed?.durationMinutes) chips.push(<span key="m" className="lo-tok">{parsed.durationMinutes} min</span>);
  return (
    <div className="lo-quickadd">
      <Plus size={16} className="flex-none text-tertiary" aria-hidden />
      <input
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
        placeholder="Add a task — try “Call the bank tomorrow 3pm !high”"
        aria-label="Quick add a task"
        disabled={!db || busy}
      />
      <AnimatePresence initial={false}>
        {chips.map((c, i) => (
          <m.span key={i} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} transition={spring.snappy}>
            {c}
          </m.span>
        ))}
      </AnimatePresence>
      <Button size="sm" variant="primary" disabled={!parsed?.title.trim() || busy} onClick={submit} kbd="↵">
        Add
      </Button>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── agenda

const START_H = 7;
const END_H = 21;
const HOUR_PX = 44;

/** Side-by-side lanes for overlapping events (greedy column packing per overlap cluster). */
function layoutLanes(list: CalendarEvent[]): { e: CalendarEvent; lane: number; lanes: number }[] {
  const sorted = [...list].sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || Date.parse(b.end) - Date.parse(a.end));
  const out: { e: CalendarEvent; lane: number; lanes: number }[] = [];
  let cluster: { e: CalendarEvent; lane: number; lanes: number }[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    const n = Math.max(1, laneEnds.length);
    for (const c of cluster) c.lanes = n;
    out.push(...cluster);
    cluster = [];
    laneEnds = [];
  };
  for (const e of sorted) {
    const s = Date.parse(e.start);
    const en = Math.max(Date.parse(e.end), s + 20 * 60_000);
    if (s >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= s);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(en);
    } else laneEnds[lane] = en;
    cluster.push({ e, lane, lanes: 1 });
    clusterEnd = Math.max(clusterEnd === -Infinity ? en : clusterEnd, en);
  }
  flush();
  return out;
}

function Agenda({ events, now }: { events: CalendarEvent[] | null; now: Date }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const timed = useMemo(() => layoutLanes((events ?? []).filter((e) => !e.allDay)), [events]);
  // Due tasks already have their own list; the agenda shows calendars and time blocks.
  const allDay = (events ?? []).filter((e) => e.allDay && e.source !== "db");
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = Math.max(0, (now.getHours() - START_H - 1) * HOUR_PX);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events === null]);
  const pos = (iso: string) => {
    const d = new Date(iso);
    return ((d.getHours() + d.getMinutes() / 60 - START_H) * HOUR_PX);
  };
  const nowTop = (now.getHours() + now.getMinutes() / 60 - START_H) * HOUR_PX;
  return (
    <Card title="Agenda" subtitle={now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })} actions={<Button size="xs" variant="ghost" iconRight={ArrowRight} onClick={() => navigate({ t: "calendar" } as never)}>Calendar</Button>}>
      {allDay.length ? (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {allDay.map((e) => (
            <span key={e.id} className="inline-flex h-6 items-center rounded-md px-2 text-caption font-semibold" style={{ background: `var(--block-${e.color}-bg, var(--bg-surface-2))`, color: `var(--block-${e.color}-text, var(--text-primary))` }}>
              {e.title}
            </span>
          ))}
        </div>
      ) : null}
      {!events ? (
        <Skeleton height={300} radius={10} />
      ) : (
        <div ref={scrollRef} className="relative max-h-[420px] overflow-y-auto pr-1">
          <div className="lo-timeline">
            {Array.from({ length: END_H - START_H + 1 }, (_, i) => (
              <div key={i} className="lo-hour" style={{ gridRow: i + 1 }}>
                {new Date(2026, 0, 1, START_H + i).toLocaleTimeString(undefined, { hour: "numeric" })}
              </div>
            ))}
            <div className="lo-lines" style={{ gridRow: `1 / span ${END_H - START_H + 1}` }}>
              {Array.from({ length: END_H - START_H + 1 }, (_, i) => (
                <div key={i} className="lo-line" />
              ))}
              {timed.map(({ e, lane, lanes }, i) => {
                const top = Math.max(0, pos(e.start));
                const h = Math.max(22, pos(e.end) - pos(e.start) - 2);
                if (top > (END_H - START_H + 1) * HOUR_PX) return null;
                return (
                  <m.button
                    type="button"
                    key={e.id}
                    className="lo-block text-left"
                    style={{ top, height: h, left: `calc(${(lane / lanes) * 100}% + 4px)`, width: `calc(${100 / lanes}% - 6px)`, right: "auto", ["--blk" as string]: `var(--block-${e.color}-text, var(--accent-solid))` }}
                    initial={{ opacity: 0, x: 6 }}
                    animate={{ opacity: 1, x: 0, transition: { ...spring.gentle, delay: i * 0.03 } }}
                    onClick={() => (e.link ? useUi.getState().openPeek(e.link) : navigate({ t: "calendar" } as never))}
                  >
                    <span className="font-semibold">{e.title}</span>
                    {h > 30 ? <small className="tabular">{formatTime(e.start)} – {formatTime(e.end)}{e.location ? ` · ${e.location}` : ""}</small> : null}
                  </m.button>
                );
              })}
              {nowTop >= 0 && nowTop <= (END_H - START_H + 1) * HOUR_PX ? <div className="lo-now" style={{ top: nowTop }} aria-label={`Now, ${formatTime(now)}`} /> : null}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

function HabitStrip() {
  const habits = useWorkspace((s) => s.lifeapps.find((i) => i.appId === "habits" && !i.detached));
  const { metrics } = useMetrics(habits?.id, ["today_done_pct", "active_count"]);
  if (!habits) return null;
  const pct = Number(metrics?.today_done_pct?.value ?? 0);
  const n = Number(metrics?.active_count?.value ?? 0);
  const id = identity("habits");
  return (
    <button type="button" className="flex w-full items-center gap-3 rounded-[14px] bg-surface-1 p-3.5 text-left shadow-elev-1 transition-transform duration-160 hover:-translate-y-px" style={{ boxShadow: "inset 0 0 0 1px var(--border-subtle), var(--elev-1)" }} onClick={() => navigate({ t: "app", instanceId: habits.id })}>
      <span className="la-tile la-tile-sm" style={{ background: id.color }}>
        <id.icon size={12} strokeWidth={2.25} aria-hidden />
      </span>
      <span className="flex-1 text-body-sm">
        <span className="font-semibold text-primary">Habits</span>
        <span className="text-secondary"> · {Math.round(pct * n)} of {n} done today</span>
      </span>
      <div className="w-24">
        <Progress value={pct} size={4} color={id.color} aria-label="Habits done today" />
      </div>
    </button>
  );
}

// ───────────────────────────────────────────────────────────────────────────── page

export default function LifeOS({ instance, tab: tabProp }: { instance: LifeAppInstance; tab?: string }) {
  const tab = (["today", "tasks", "projects", "review"].includes(tabProp ?? "") ? tabProp : "today") as Tab;
  const { byRole, dbs } = useAppDatabases(instance.id);
  const tasksDb = byRole("task.status");
  const projectsDb = byRole("project.status");
  const areasDb = byRole("area.name");
  const { rows: tasks, setRows } = useRows(tasksDb?.id);
  const { rows: projects } = useRows(projectsDb?.id);
  const { rows: areas } = useRows(areasDb?.id);
  const { metrics } = useMetrics(instance.id);
  const now = useStableNow();
  const today = localDay(now);
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const toggle = useToggleTask(tasksDb, setRows);

  useEffect(() => {
    let live = true;
    const load = () => api.calendar.events({ from: today, to: today }).then((e) => live && setEvents(e)).catch(() => live && setEvents([]));
    void load();
    const h = setInterval(load, 60_000);
    return () => {
      live = false;
      clearInterval(h);
    };
  }, [today, tasks]);

  const projectName = useMemo(() => {
    const map = new Map<Id, string>();
    for (const p of projects ?? []) map.set(p.id, read.text(p, projectsDb?.p("project.name")));
    return map;
  }, [projects, projectsDb]);

  const status = (r: RowDTO) => read.opt(r, tasksDb?.p("task.status"))?.name;
  const open = (tasks ?? []).filter((r) => status(r) !== "Done");
  const dueSoon = open
    .filter((r) => {
      const d = read.date(r, tasksDb?.p("task.due"))?.start?.slice(0, 10);
      return !!d && d <= today;
    })
    .sort((a, b) => (read.date(a, tasksDb?.p("task.due"))?.start ?? "").localeCompare(read.date(b, tasksDb?.p("task.due"))?.start ?? ""));
  const top3 = open.filter((r) => read.bool(r, tasksDb?.p("task.top3"))).slice(0, 3);
  const recentlyDone = (tasks ?? []).filter((r) => status(r) === "Done" && read.date(r, tasksDb?.p("task.completed"))?.start?.slice(0, 10) === today);

  const kpis = (
    <>
      <KpiTile label="Due today" value={Number(metrics?.due_today?.value ?? 0)} loading={!metrics} format={(n) => String(Math.round(n))} />
      <KpiTile label="Overdue" value={Number(metrics?.overdue_count?.value ?? 0)} loading={!metrics} format={(n) => String(Math.round(n))} info="Open tasks with a due date before today." />
      <KpiTile label="Inbox" value={Number(metrics?.inbox_count?.value ?? 0)} loading={!metrics} format={(n) => String(Math.round(n))} />
      <KpiTile label="Done this week" value={Number(metrics?.done_7d?.value ?? 0)} loading={!metrics} format={(n) => String(Math.round(n))} />
    </>
  );

  const setTab = (t: Tab) => navigate({ t: "app", instanceId: instance.id, tab: t });
  const greetingSub = `${now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })} · ${open.length} open tasks`;

  return (
    <div className="la-hub">
      <AppHeader<Tab>
        instance={instance}
        title="Life OS"
        subtitle={greetingSub}
        kpis={kpis}
        tabs={[
          { value: "today", label: "Today", icon: Sun },
          { value: "tasks", label: "Tasks", icon: Inbox, count: open.length || undefined },
          { value: "projects", label: "Projects", icon: FolderKanban },
          { value: "review", label: "Review", icon: RotateCcw },
        ]}
        tab={tab}
        onTab={setTab}
      />
      <div className="la-hub-body">
        {dbs && !tasksDb ? (
          <EmptyState icon={Target} title="Tasks database not found" body="It may have been deleted or detached. Tune up Life OS to recreate it." />
        ) : tab === "today" ? (
          <div className="lo-grid">
            <div className="flex min-w-0 flex-col gap-5">
              <QuickAdd db={tasksDb} />
              <Card title={<span className="flex items-center gap-2"><Star size={14} className="text-warning" aria-hidden />Top 3</span>} subtitle="What would make today a win?">
                {!tasks ? (
                  <Skeleton height={96} radius={10} />
                ) : (
                  <div className="flex flex-col">
                    <AnimatePresence initial={false}>
                      {top3.map((r) => (
                        <TaskRow key={r.id} row={r} db={tasksDb!} today={today} projectName={projectName.get(read.rel(r, tasksDb?.p("task.project"))[0] ?? "")} onToggle={toggle} />
                      ))}
                    </AnimatePresence>
                    {Array.from({ length: Math.max(0, 3 - top3.length) }, (_, i) => (
                      <div key={i} className="lo-task text-tertiary">
                        <CircleDashed size={18} className="flex-none opacity-50" aria-hidden />
                        <span className="text-body-sm">Star a task to add it here</span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
              <Card title="Due & overdue" subtitle={dueSoon.length ? `${dueSoon.length} to do` : "You’re clear"}>
                {!tasks ? (
                  <Skeleton height={120} radius={10} />
                ) : dueSoon.length || recentlyDone.length ? (
                  <div className="flex flex-col">
                    <AnimatePresence initial={false}>
                      {[...dueSoon, ...recentlyDone].map((r) => (
                        <TaskRow key={r.id} row={r} db={tasksDb!} today={today} projectName={projectName.get(read.rel(r, tasksDb?.p("task.project"))[0] ?? "")} onToggle={toggle} />
                      ))}
                    </AnimatePresence>
                  </div>
                ) : (
                  <p className="py-4 text-center text-body-sm text-tertiary">Nothing due. Pick something from Next, or enjoy the space.</p>
                )}
              </Card>
              <StartHere instance={instance} />
            </div>
            <div className="flex min-w-0 flex-col gap-5">
              <Agenda events={events} now={now} />
              <HabitStrip />
              <section>
                <h2 className="la-section-title">Insights <span className="la-dim">from all your apps</span></h2>
                <InsightsFeed limit={4} />
              </section>
            </div>
          </div>
        ) : tab === "tasks" ? (
          <TasksTab db={tasksDb} rows={tasks} today={today} projectName={projectName} onToggle={toggle} />
        ) : tab === "projects" ? (
          <ProjectsTab db={projectsDb} rows={projects} tasksDb={tasksDb} tasks={tasks} areas={areas} areasDb={areasDb} today={today} />
        ) : (
          <ReviewTab instance={instance} metrics={metrics} tasksDb={tasksDb} tasks={tasks} areas={areas} areasDb={areasDb} today={today} />
        )}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── tabs

const LISTS = ["Inbox", "Next", "Scheduled", "Waiting", "Someday", "Done"] as const;

function TasksTab({ db, rows, today, projectName, onToggle }: { db: AppDb | undefined; rows: RowDTO[] | null; today: string; projectName: Map<Id, string>; onToggle: (r: RowDTO, el: HTMLElement) => void }) {
  const [list, setList] = useState<(typeof LISTS)[number]>("Inbox");
  const counts = Object.fromEntries(LISTS.map((l) => [l, (rows ?? []).filter((r) => read.opt(r, db?.p("task.status"))?.name === l).length]));
  const shown = (rows ?? [])
    .filter((r) => read.opt(r, db?.p("task.status"))?.name === list)
    .sort((a, b) => (read.date(a, db?.p("task.due"))?.start ?? "9999").localeCompare(read.date(b, db?.p("task.due"))?.start ?? "9999"));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented value={list} onValueChange={setList} options={LISTS.map((l) => ({ value: l, label: `${l} ${counts[l] ? `· ${counts[l]}` : ""}`.trim() }))} aria-label="List" />
        <span className="flex-1" />
        {db ? (
          <Button size="sm" variant="ghost" iconRight={ArrowRight} onClick={() => navigate({ t: "db", id: db.id })}>
            Open database
          </Button>
        ) : null}
      </div>
      <QuickAdd db={db} />
      <Card pad="md">
        {!rows || !db ? (
          <Skeleton height={200} radius={10} />
        ) : shown.length ? (
          <div className="flex flex-col">
            <AnimatePresence initial={false}>
              {shown.map((r) => (
                <TaskRow key={r.id} row={r} db={db} today={today} projectName={projectName.get(read.rel(r, db.p("task.project"))[0] ?? "")} onToggle={onToggle} />
              ))}
            </AnimatePresence>
          </div>
        ) : (
          <p className="py-8 text-center text-body-sm text-tertiary">{list === "Inbox" ? "Inbox zero. Nicely done." : `Nothing in ${list}.`}</p>
        )}
      </Card>
    </div>
  );
}

function ProjectsTab({ db, rows, tasksDb, tasks, areas, areasDb, today }: { db: AppDb | undefined; rows: RowDTO[] | null; tasksDb: AppDb | undefined; tasks: RowDTO[] | null; areas: RowDTO[] | null; areasDb: AppDb | undefined; today: string }) {
  const areaName = new Map((areas ?? []).map((a) => [a.id, { name: read.text(a, areasDb?.p("area.name")), icon: a.icon?.t === "emoji" ? a.icon.v : "" }] as const));
  if (!rows || !db) return <Skeleton height={240} radius={14} />;
  if (!rows.length) return <EmptyState icon={FolderKanban} title="No projects yet" body="Projects group tasks toward an outcome. Add one from the Projects database." actions={<Button variant="primary" onClick={() => navigate({ t: "db", id: db.id })}>Open Projects</Button>} />;
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
      {rows.map((p, i) => {
        const ts = (tasks ?? []).filter((t) => read.rel(t, tasksDb?.p("task.project")).includes(p.id));
        const done = ts.filter((t) => read.opt(t, tasksDb?.p("task.status"))?.name === "Done").length;
        const next = ts.find((t) => ["Next", "Scheduled"].includes(read.opt(t, tasksDb?.p("task.status"))?.name ?? ""));
        const area = areaName.get(read.rel(p, db.p("project.area"))[0] ?? "");
        const st = read.opt(p, db.p("project.status"));
        const deadline = read.date(p, db.p("project.deadline"))?.start?.slice(0, 10);
        const days = deadline ? Math.round((new Date(`${deadline}T12:00:00`).getTime() - new Date(`${today}T12:00:00`).getTime()) / 86_400_000) : null;
        const pct = ts.length ? done / ts.length : 0;
        return (
          <m.button key={p.id} type="button" className="lo-project" onClick={() => useUi.getState().openPeek({ t: "row", id: p.id })} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, transition: { ...spring.gentle, delay: i * 0.04 } }}>
            <div className="flex items-center gap-2">
              <span className="text-[20px] leading-none">{p.icon?.t === "emoji" ? p.icon.v : "📁"}</span>
              <span className="min-w-0 flex-1 truncate text-body font-semibold text-primary">{read.text(p, db.p("project.name"))}</span>
              {st ? <Tag color={(st.color as never) ?? "gray"}>{st.name}</Tag> : null}
            </div>
            <p className="line-clamp-2 min-h-[36px] text-body-sm text-secondary">{read.text(p, db.p("project.outcome")) || "No outcome written yet."}</p>
            <div className="flex items-center gap-2">
              <Progress value={pct} size={4} color="var(--app)" className="flex-1" aria-label="Progress" />
              <span className="text-caption tabular text-tertiary">{done}/{ts.length}</span>
            </div>
            <div className="flex items-center gap-2 text-caption text-tertiary">
              {area ? <span>{area.icon} {area.name}</span> : null}
              <span className="flex-1" />
              {days !== null ? <span className={cn("tabular", days < 7 && "text-warning-text font-semibold")}>{days >= 0 ? `${days} days left` : `${-days} days late`}</span> : null}
            </div>
            <div className="flex items-center gap-1.5 border-t border-subtle pt-2 text-caption">
              <ArrowRight size={12} className={next ? "text-accent-text" : "text-warning-text"} aria-hidden />
              <span className={cn("truncate", next ? "text-primary" : "text-warning-text")}>{next ? read.text(next, tasksDb?.p("task.title")) : "No next action"}</span>
            </div>
          </m.button>
        );
      })}
    </div>
  );
}

function ReviewTab({ instance, metrics, tasksDb, tasks, areas, areasDb, today }: { instance: LifeAppInstance; metrics: Record<string, { value: unknown; display: string }> | null; tasksDb: AppDb | undefined; tasks: RowDTO[] | null; areas: RowDTO[] | null; areasDb: AppDb | undefined; today: string }) {
  const days = Number(metrics?.days_since_review?.value ?? 0);
  const last = metrics?.last_review_date?.display ?? "Not yet";
  const byArea = useMemo(() => {
    const names = new Map((areas ?? []).map((a) => [a.id, read.text(a, areasDb?.p("area.name"))] as const));
    const from = addDays(today, -6);
    const out = new Map<string, number>();
    for (const t of tasks ?? []) {
      const d = read.date(t, tasksDb?.p("task.completed"))?.start?.slice(0, 10);
      if (!d || d < from || read.opt(t, tasksDb?.p("task.status"))?.name !== "Done") continue;
      const a = names.get(read.rel(t, tasksDb?.p("task.area"))[0] ?? "") || "No area";
      out.set(a, (out.get(a) ?? 0) + 1);
    }
    return [...out.entries()].map(([area, done]) => ({ area, done })).sort((a, b) => b.done - a.done);
  }, [tasks, areas, areasDb, tasksDb, today]);
  const markDone = async () => {
    try {
      await api.lifeapp.checklistTick({ instanceId: instance.id, itemId: "review" });
      await useWorkspace.getState().refreshLifeapps();
      notify.success("Weekly review logged", { description: "See you next week." });
    } catch (e) {
      notify.fromError(e, "Couldn’t log the review");
    }
  };
  return (
    <div className="lo-grid">
      <Card title="Weekly review" subtitle={`Last done: ${last}`}>
        <div className="flex items-center gap-4">
          <div className={cn("flex h-16 w-16 flex-none items-center justify-center rounded-2xl text-h3 tabular", days > 7 ? "bg-warning-soft text-warning-text" : "bg-gain-soft text-gain-text")}>{days}</div>
          <p className="text-body-sm text-secondary">{days > 7 ? "days since your last review. Thirty calm minutes now makes next week lighter." : "days since your last review. You’re on rhythm."}</p>
        </div>
        <ol className="mt-4 flex flex-col gap-2 text-body-sm">
          {["Get clear — inbox to zero", "Get current — calendar, projects, waiting", "Get creative — someday list", "Choose next week’s Top 3"].map((s, i) => (
            <li key={s} className="flex items-center gap-3">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-surface-2 text-caption font-semibold tabular text-secondary">{i + 1}</span>
              {s}
            </li>
          ))}
        </ol>
        <div className="mt-5 flex gap-2">
          <Button variant="primary" icon={Check} onClick={markDone}>
            I did my review
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
