/**
 * Habits read from the app's two databases (habits + log), shared by the Habits hub and Home's habits line so both
 * count "done today" the same way: a habit is due when its schedule expects today (weekly targets are always due).
 */
import { useMemo } from "react";
import type { Id, RowDTO } from "@/backend/types";
import { keyOf, localDay, read } from "./cells";
import { useRows, type AppDb } from "./data";
import { isExpected, type HabitDef, type HabitLogEntry } from "./engine/habitMath";

/** Habit type, schedule, time-of-day and log-status option keys (the option ids of the desktop manifest). */
export const HABIT_TYPES = ["yes_no", "count", "duration", "quantity", "avoid"] as const;
export const HABIT_SCHEDULES = ["daily", "x_per_week", "weekdays", "every_n_days"] as const;
export const HABIT_TIMES = ["morning", "afternoon", "evening", "anytime"] as const;
export const LOG_STATUSES = ["done", "partial", "skipped", "missed", "frozen"] as const;
export const TIME_LABEL: Record<(typeof HABIT_TIMES)[number], string> = { morning: "Morning", afternoon: "Afternoon", evening: "Evening", anytime: "Anytime" };
export const TYPE_LABEL: Record<(typeof HABIT_TYPES)[number], string> = { yes_no: "Yes or no", count: "Count", duration: "Duration", quantity: "Quantity", avoid: "Avoid" };

export interface Habit {
  def: HabitDef;
  row: RowDTO;
  /** Type key (`yes_no`, `count`, …). */
  type: (typeof HABIT_TYPES)[number];
  target: number | null;
  unit: string;
  twoMin: string;
  cue: string;
  /** Time-of-day key. */
  time: (typeof HABIT_TIMES)[number];
}

export type LogEntry = HabitLogEntry & { rowId: Id };

export function useHabitData(habitsDb: AppDb | undefined, logDb: AppDb | undefined) {
  const { rows: hRows } = useRows(habitsDb?.id);
  const { rows: lRows, setRows: setLog } = useRows(logDb?.id);
  const habits: Habit[] = useMemo(
    () =>
      (hRows ?? []).map((r) => {
        const sched = (keyOf(read.opt(r, habitsDb?.p("habit.schedule")), HABIT_SCHEDULES) ?? "daily") as HabitDef["schedule"];
        const everyN = read.num(r, habitsDb?.p("habit.every_n"));
        return {
          row: r,
          type: (keyOf(read.opt(r, habitsDb?.p("habit.type")), HABIT_TYPES) ?? "yes_no") as Habit["type"],
          target: read.num(r, habitsDb?.p("habit.target")),
          unit: read.text(r, habitsDb?.p("habit.unit")),
          twoMin: read.text(r, habitsDb?.p("habit.two_min")),
          cue: read.text(r, habitsDb?.p("habit.cue")),
          time: (keyOf(read.opt(r, habitsDb?.p("habit.time")), HABIT_TIMES) ?? "anytime") as Habit["time"],
          def: {
            id: r.id,
            name: read.text(r, habitsDb?.p("habit.name")) || "Habit",
            schedule: sched,
            ...(everyN ? { everyN } : {}),
            perWeek: read.num(r, habitsDb?.p("habit.per_week")) ?? 3,
            active: read.bool(r, habitsDb?.p("habit.active")),
            started: read.date(r, habitsDb?.p("habit.started"))?.start?.slice(0, 10) ?? localDay(new Date(r.createdAt)),
          },
        };
      }),
    [hRows, habitsDb],
  );
  const entries: LogEntry[] = useMemo(() => {
    const out: LogEntry[] = [];
    for (const r of lRows ?? []) {
      const d = read.date(r, logDb?.p("log.date"))?.start?.slice(0, 10);
      const h = read.rel(r, logDb?.p("log.habit"))[0];
      if (!d || !h) continue;
      out.push({ rowId: r.id, habitId: h, date: d, status: (keyOf(read.opt(r, logDb?.p("log.status")), LOG_STATUSES) ?? "done") as HabitLogEntry["status"], value: read.num(r, logDb?.p("log.value")) });
    }
    return out;
  }, [lRows, logDb]);
  return { habits, entries, loading: !hRows || !lRows, setLog };
}

export const isDoneEntry = (e: HabitLogEntry | undefined) => !!e && (e.status === "done" || e.status === "partial");

/** Active habits due on `day` and how many of them are checked in. */
export function dueOn(habits: Habit[], entries: HabitLogEntry[], day: string): { due: Habit[]; done: number } {
  const due = habits.filter((h) => h.def.active && (isExpected(h.def, day) || h.def.schedule === "x_per_week"));
  const done = due.filter((h) => isDoneEntry(entries.find((e) => e.habitId === h.def.id && e.date === day))).length;
  return { due, done };
}
