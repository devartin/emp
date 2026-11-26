/** Today widget (§6.4 row 1): next events (Google, Life OS blocks, ICS), tasks due, and a habit strip. */
import { ArrowRight, CalendarDays, CheckCircle2 } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/backend";
import type { CalendarEvent, RowDTO } from "@/backend/types";
import { navigate } from "@/app/router";
import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/dates";
import { notify } from "@/stores/toasts";
import { useUi } from "@/stores/ui";
import { Button } from "@/ui/Button";
import { Checkbox } from "@/ui/Checkbox";
import { Ring } from "@/ui/Ring";
import { Skeleton } from "@/ui/Skeleton";
import { Tooltip } from "@/ui/Tooltip";
import { ease, spring } from "@/ui/motion/tokens";
import { localDay, optionId, read, write } from "@/features/lifeapps/cells";
import { useAppDatabases, useRows, useStableNow } from "@/features/lifeapps/data";
import { identity } from "@/features/lifeapps/identity";
import { useAppInstance, useUpcomingEvents } from "./useHomeData";

const isAllDay = (e: CalendarEvent) => e.allDay;

function EventRow({ e, now, next }: { e: CalendarEvent; now: Date; next: boolean }) {
  const start = new Date(e.start);
  const end = new Date(e.end);
  const live = !e.allDay && start <= now && end > now;
  return (
    <button type="button" className="hm-event" onClick={() => (e.link ? useUi.getState().openPeek(e.link) : navigate({ t: "calendar" } as never))}>
      <span className="hm-event-time tabular" data-next={next ? "" : undefined}>{e.allDay ? "All day" : formatTime(e.start)}</span>
      <span className="hm-event-bar" style={{ background: `var(--block-${e.color}-text, var(--accent-solid))` }} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body-sm font-medium text-primary">{e.title}</span>
        {e.location || !e.allDay ? <span className="block truncate text-caption text-tertiary">{!e.allDay ? `${formatTime(e.start)} – ${formatTime(e.end)}` : ""}{e.location ? `${!e.allDay ? " · " : ""}${e.location}` : ""}</span> : null}
      </span>
      {live ? <span className="hm-live">Now</span> : null}
    </button>
  );
}

export function TodayWidget() {
  const now = useStableNow(30_000);
  const today = localDay(now);
  const events = useUpcomingEvents(2);
  const lifeos = useAppInstance("life-os");
  const habitsInst = useAppInstance("habits");
  const { byRole } = useAppDatabases(lifeos?.id);
  const tasksDb = byRole("task.status");
  const { rows: tasks, setRows } = useRows(tasksDb?.id);
  const { byRole: hRole } = useAppDatabases(habitsInst?.id);
  const habitsDb = hRole("habit.name");
  const logDb = hRole("log.date");
  const { rows: habits } = useRows(habitsDb?.id);
  const { rows: logs } = useRows(logDb?.id);

  const upcoming = useMemo(() => {
    if (!events) return null;
    const t = now.getTime();
    const todays = events.filter((e) => (isAllDay(e) ? e.start.slice(0, 10) <= today && e.end.slice(0, 10) >= today && e.source !== "db" : new Date(e.end).getTime() > t));
    return todays.filter((e) => !(e.source === "db" && e.allDay)).slice(0, 5);
  }, [events, now, today]);

  const due = useMemo(() => {
    if (!tasks || !tasksDb) return null;
    return tasks
      .filter((r) => read.opt(r, tasksDb.p("task.status"))?.name !== "Done")
      .filter((r) => {
        const d = read.date(r, tasksDb.p("task.due"))?.start?.slice(0, 10);
        return !!d && d <= today;
      })
      .sort((a, b) => (read.date(a, tasksDb.p("task.due"))?.start ?? "").localeCompare(read.date(b, tasksDb.p("task.due"))?.start ?? ""))
      .slice(0, 4);
  }, [tasks, tasksDb, today]);

  // S13: the box pops, rays burst, the label is struck through; the row leaves after the moment has landed.
  const [checking, setChecking] = useState<ReadonlySet<string>>(() => new Set());
  // The write is deferred until the moment has landed (a live refresh would otherwise yank the row mid-strike);
  // pending writes flush immediately if the widget unmounts, so a completion is never lost.
  const pending = useRef(new Map<string, { timer: number; run: () => void }>());
  useEffect(() => {
    const map = pending.current;
    return () => {
      map.forEach(({ timer, run }) => {
        window.clearTimeout(timer);
        run();
      });
      map.clear();
    };
  }, []);
  const complete = (r: RowDTO) => {
    if (!tasksDb || checking.has(r.id)) return;
    const status = tasksDb.p("task.status");
    const done = optionId(status, "Done");
    if (!status || !done) return;
    setChecking((s) => new Set(s).add(r.id));
    const run = () => {
      pending.current.delete(r.id);
      void api.db.rowsUpdate({ updates: [{ id: r.id, values: { [status.id]: write.status(done) } }] }).catch((e) => {
        notify.fromError(e, "Couldn’t complete the task");
        setChecking((s) => {
          const n = new Set(s);
          n.delete(r.id);
          return n;
        });
      });
    };
    const timer = window.setTimeout(() => {
      setRows((rows) => rows.filter((x) => x.id !== r.id));
      run();
    }, 640);
    pending.current.set(r.id, { timer, run });
  };

  const habitDots = useMemo(() => {
    if (!habits || !habitsDb || !logs || !logDb) return null;
    return habits
      .filter((h) => read.bool(h, habitsDb.p("habit.active")))
      .map((h) => ({
        id: h.id,
        name: read.text(h, habitsDb.p("habit.name")),
        emoji: h.icon?.t === "emoji" ? h.icon.v : "✨",
        done: logs.some((l) => read.rel(l, logDb.p("log.habit"))[0] === h.id && read.date(l, logDb.p("log.date"))?.start?.slice(0, 10) === today && ["Done", "Partial"].includes(read.opt(l, logDb.p("log.status"))?.name ?? "")),
      }));
  }, [habits, habitsDb, logs, logDb, today]);

  return (
    <div className="flex h-full flex-col gap-4">
      <div data-widget-head="" className="flex items-center justify-between">
        <h2 className="hm-title"><CalendarDays size={15} aria-hidden />Today</h2>
        <Button size="xs" variant="ghost" iconRight={ArrowRight} onClick={() => navigate({ t: "calendar" } as never)}>
          Calendar
        </Button>
      </div>
      <div className="flex flex-col">
        {!upcoming ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 3 }, (_, i) => <Skeleton key={i} height={36} radius={8} />)}
          </div>
        ) : upcoming.length ? (
          upcoming.map((e, i) => <EventRow key={e.id} e={e} now={now} next={i === upcoming.findIndex((x) => !x.allDay && new Date(x.start) > now)} />)
        ) : (
          <p className="py-3 text-body-sm text-tertiary">Nothing else on the calendar today.</p>
        )}
      </div>
      {lifeos ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <span className="hm-section-label">Due</span>
            <Button size="xs" variant="link" onClick={() => navigate({ t: "app", instanceId: lifeos.id, tab: "today" })}>Life OS</Button>
          </div>
          {!due ? (
            <Skeleton height={64} radius={8} />
          ) : due.length ? (
            <AnimatePresence initial={false} mode="popLayout">
              {due.map((r) => {
                const d = read.date(r, tasksDb?.p("task.due"))?.start?.slice(0, 10) ?? "";
                const title = read.text(r, tasksDb?.p("task.title"));
                const isDone = checking.has(r.id);
                return (
                  <m.div
                    key={r.id}
                    layout="position"
                    transition={spring.morph}
                    exit={{ opacity: 0, x: 8, transition: { duration: 0.16, ease: ease.in } }}
                    className="hm-task"
                  >
                    <Checkbox celebrate checked={isDone} label={title || "Untitled task"} aria-label={`Complete ${title}`} onCheckedChange={(v) => v && complete(r)} />
                    <span className={cn("text-caption tabular transition-opacity", isDone && "opacity-0", d < today ? "text-loss-text font-semibold" : "text-tertiary")}>{d < today ? "Overdue" : "Today"}</span>
                  </m.div>
                );
              })}
            </AnimatePresence>
          ) : (
            <p className="flex items-center gap-2 py-1 text-body-sm text-tertiary"><CheckCircle2 size={14} aria-hidden /> Nothing due today.</p>
          )}
        </div>
      ) : null}
      {habitsInst && habitDots ? (
        <button type="button" className="hm-habits well" onClick={() => navigate({ t: "app", instanceId: habitsInst.id })} style={{ ["--app" as string]: identity("habits").color }}>
          <span className="hm-section-label">Habits</span>
          <span className="flex flex-1 items-center gap-1.5">
            {habitDots.map((h) => (
              <Tooltip key={h.id} content={`${h.name}${h.done ? " · done" : ""}`}>
                <m.span className={cn("hm-habit", h.done && "is-done")} initial={false} animate={{ scale: 1 }} transition={spring.bouncy}>
                  {h.emoji}
                </m.span>
              </Tooltip>
            ))}
          </span>
          <Ring value={habitDots.length ? habitDots.filter((h) => h.done).length / habitDots.length : 0} size={40} completeMoment aria-label={`${habitDots.filter((h) => h.done).length} of ${habitDots.length} habits done today`}>
            <span className="text-[11px] font-semibold tabular text-secondary">
              {habitDots.filter((h) => h.done).length}/{habitDots.length}
            </span>
          </Ring>
        </button>
      ) : null}
    </div>
  );
}
