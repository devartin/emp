/**
 * Habits hub (§16.7): Today (tap to check in, long-press to enter a value; streak flame pops with spring.bouncy when it
 * grows), per-habit 12×12 heatmaps whose cell fills with a scale animation on check-in, a weekly score ring, a
 * four-week sparkline, the identity card, and stats. Streaks honour the grace mode (§15.8).
 */
import { BarChart3, Flame, Grid3x3, Sun } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/backend";
import type { Id, LifeAppInstance, RowDTO } from "@/backend/types";
import { navigate } from "@/app/router";
import { BarChart } from "@/charts/Bar";
import { LineChart } from "@/charts/Line";
import { Sparkline } from "@/charts/Sparkline";
import { cn } from "@/lib/cn";
import { notify } from "@/stores/toasts";
import { Button } from "@/ui/Button";
import { Card } from "@/ui/Card";
import { EmptyState } from "@/ui/EmptyState";
import { KpiTile } from "@/ui/KpiTile";
import { NumberField } from "@/ui/NumberField";
import { Popover, PopoverAnchor, PopoverContent } from "@/ui/Popover";
import { Ring } from "@/ui/Ring";
import { Skeleton } from "@/ui/Skeleton";
import { Tooltip } from "@/ui/Tooltip";
import { celebrate } from "@/ui/motion/Celebrate";
import { spring } from "@/ui/motion/tokens";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { useSettings } from "@/stores/settings";
import { AppHeader } from "../AppHeader";
import { localDay, optionId, read, write } from "../cells";
import { useAppDatabases, useRows, useStableNow, type AppDb } from "../data";
import { addDays, heatCells, isExpected, streakStats, type GraceMode, type HabitDef, type HabitLogEntry, type StreakStats } from "../engine/habitMath";
import { identity } from "../identity";
import { InsightsFeed } from "../Insights";
import { StartHere } from "../StartHere";

type Tab = "today" | "habits" | "stats";

interface Habit {
  def: HabitDef;
  row: RowDTO;
  emoji: string;
  type: string;
  target: number | null;
  unit: string;
  twoMin: string;
  cue: string;
  time: string;
}

function useHabitData(habitsDb: AppDb | undefined, logDb: AppDb | undefined) {
  const { rows: hRows } = useRows(habitsDb?.id);
  const { rows: lRows, setRows: setLog } = useRows(logDb?.id);
  const habits: Habit[] = useMemo(
    () =>
      (hRows ?? []).map((r) => {
        const sched = read.opt(r, habitsDb?.p("habit.schedule"))?.name;
        return {
          row: r,
          emoji: r.icon?.t === "emoji" ? r.icon.v : "✨",
          type: read.opt(r, habitsDb?.p("habit.type"))?.name ?? "Yes/no",
          target: read.num(r, habitsDb?.p("habit.target")),
          unit: read.text(r, habitsDb?.p("habit.unit")),
          twoMin: read.text(r, habitsDb?.p("habit.two_min")),
          cue: read.text(r, habitsDb?.p("habit.cue")),
          time: read.opt(r, habitsDb?.p("habit.time"))?.name ?? "Anytime",
          def: {
            id: r.id,
            name: read.text(r, habitsDb?.p("habit.name")) || "Habit",
            schedule: sched === "X per week" ? "x_per_week" : sched === "Weekdays" ? "weekdays" : sched === "Every N days" ? "every_n_days" : "daily",
            perWeek: read.num(r, habitsDb?.p("habit.per_week")) ?? 3,
            active: read.bool(r, habitsDb?.p("habit.active")),
            started: read.date(r, habitsDb?.p("habit.started"))?.start?.slice(0, 10) ?? localDay(new Date(r.createdAt)),
          },
        };
      }),
    [hRows, habitsDb],
  );
  const entries: (HabitLogEntry & { rowId: Id })[] = useMemo(() => {
    const out: (HabitLogEntry & { rowId: Id })[] = [];
    for (const r of lRows ?? []) {
      const d = read.date(r, logDb?.p("log.date"))?.start?.slice(0, 10);
      const h = read.rel(r, logDb?.p("log.habit"))[0];
      if (!d || !h) continue;
      out.push({ rowId: r.id, habitId: h, date: d, status: (read.opt(r, logDb?.p("log.status"))?.name ?? "Done").toLowerCase() as HabitLogEntry["status"], value: read.num(r, logDb?.p("log.value")) });
    }
    return out;
  }, [lRows, logDb]);
  return { habits, entries, loading: !hRows || !lRows, setLog };
}

// ───────────────────────────────────────────────────────────────────────────── pieces

function FlameCount({ n, bump }: { n: number; bump: boolean }) {
  const reduced = useReducedMotionPref();
  return (
    <span className={cn("hb-flame", n === 0 && "is-cold")} aria-label={`${n}-day streak`}>
      <m.span key={bump ? `b${n}` : "s"} initial={bump && !reduced ? { scale: 0.5, rotate: -12 } : false} animate={{ scale: 1, rotate: 0 }} transition={spring.bouncy} className="flex">
        <Flame size={14} strokeWidth={2.4} fill={n ? "currentColor" : "none"} fillOpacity={0.25} aria-hidden />
      </m.span>
      <AnimatePresence mode="popLayout" initial={false}>
        <m.span key={n} initial={reduced ? { opacity: 0 } : { y: 8, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={reduced ? { opacity: 0 } : { y: -8, opacity: 0 }} transition={spring.ui}>
          {n}
        </m.span>
      </AnimatePresence>
    </span>
  );
}

function Heatmap({ h, entries, today, color }: { h: Habit; entries: HabitLogEntry[]; today: string; color: string }) {
  const cells = useMemo(() => heatCells(h.def, entries, today, 144), [h.def, entries, today]);
  const reduced = useReducedMotionPref();
  return (
    <div className="hb-heat" role="img" aria-label={`${h.def.name}: last 144 days`} style={{ ["--app" as string]: color }}>
      {cells.map((c) => (
        <Tooltip key={c.date} content={`${new Date(`${c.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} · ${c.status ? c.status[0].toUpperCase() + c.status.slice(1) : c.expected ? "Missed" : "Not scheduled"}`}>
          <span className={cn("hb-cell", c.date === today && "is-today", !c.expected && !c.status && "is-off")}>
            <AnimatePresence initial={false}>
              {c.level > 0 ? (
                <m.i
                  key={c.status}
                  initial={c.date === today && !reduced ? { scale: 0, opacity: 0 } : false}
                  animate={{ scale: 1, opacity: c.level * 0.92 }}
                  exit={{ scale: reduced ? 1 : 0.4, opacity: 0 }}
                  transition={c.date === today ? spring.bouncy : { duration: 0 }}
                />
              ) : null}
            </AnimatePresence>
          </span>
        </Tooltip>
      ))}
    </div>
  );
}

function CheckRow({ h, stats, entry, onToggle, onValue, color }: { h: Habit; stats: StreakStats; entry?: HabitLogEntry; onToggle: (h: Habit, el: HTMLElement) => void; onValue: (h: Habit, v: number) => void; color: string }) {
  const done = !!entry && (entry.status === "done" || entry.status === "partial");
  const reduced = useReducedMotionPref();
  const [valueOpen, setValueOpen] = useState(false);
  const [val, setVal] = useState<number | null>(h.target);
  const timer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const wantsValue = h.type !== "Yes/no" && h.type !== "Avoid";
  const ref = useRef<HTMLButtonElement>(null);
  const start = () => {
    longPressed.current = false;
    if (!wantsValue) return;
    timer.current = window.setTimeout(() => {
      longPressed.current = true;
      setValueOpen(true);
    }, 450);
  };
  const cancel = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const sub = done && entry?.value ? `${entry.value.toLocaleString()} ${h.unit}`.trim() : h.target && wantsValue ? `${h.target.toLocaleString()} ${h.unit}`.trim() : h.twoMin ? `Or just: ${h.twoMin.toLowerCase()}` : h.cue;
  return (
    <Popover open={valueOpen} onOpenChange={setValueOpen}>
      <PopoverAnchor asChild>
        <m.button
          ref={ref}
          type="button"
          className={cn("hb-check", done && "is-done")}
          style={{ ["--app" as string]: color }}
          onPointerDown={start}
          onPointerUp={cancel}
          onPointerLeave={cancel}
          onContextMenu={(e) => {
            if (wantsValue) {
              e.preventDefault();
              setValueOpen(true);
            }
          }}
          onClick={(e) => {
            if (longPressed.current) return;
            onToggle(h, e.currentTarget.querySelector(".hb-tick") as HTMLElement);
          }}
          whileTap={reduced ? undefined : { scale: 0.985 }}
          transition={spring.snappy}
          aria-pressed={done}
          aria-label={`${h.def.name}${done ? " — done" : ""}${wantsValue ? ". Long-press to enter a value" : ""}`}
        >
          <AnimatePresence>{done && !reduced ? <m.span key="p" className="hb-press" initial={{ scaleX: 0, opacity: 1 }} animate={{ scaleX: 1, opacity: 0 }} transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }} /> : null}</AnimatePresence>
          <span className="hb-emoji" aria-hidden>{h.emoji}</span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-body font-semibold text-primary">{h.def.name}</span>
            <span className="truncate text-caption text-tertiary">{sub}</span>
          </span>
          <span className="ml-auto flex items-center gap-2">
            <FlameCount n={stats.current} bump={stats.incrementedToday} />
            <m.span className={cn("hb-tick", done && "is-done")} animate={done && !reduced ? { scale: [0.8, 1.08, 1] } : { scale: 1 }} transition={{ duration: 0.36, ease: [0.16, 1, 0.3, 1] }}>
              <AnimatePresence>
                {done ? (
                  <m.svg key="c" viewBox="0 0 24 24" width="14" height="14" exit={{ opacity: 0 }}>
                    <m.path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: reduced ? 1 : 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.2, ease: [0.2, 0, 0, 1], delay: 0.05 }} />
                  </m.svg>
                ) : null}
              </AnimatePresence>
            </m.span>
          </span>
        </m.button>
      </PopoverAnchor>
      <PopoverContent side="bottom" align="end" form className="w-[240px]">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (val !== null) onValue(h, val);
            setValueOpen(false);
          }}
        >
          <NumberField label={`How much today?`} value={val} onChange={setVal} suffix={h.unit || undefined} min={0} autoFocus />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setValueOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit">
              Save
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

// ───────────────────────────────────────────────────────────────────────────── page

export default function Habits({ instance, tab: tabProp }: { instance: LifeAppInstance; tab?: string }) {
  const tab = (["today", "habits", "stats"].includes(tabProp ?? "") ? tabProp : "today") as Tab;
  const { byRole, dbs } = useAppDatabases(instance.id);
  const habitsDb = byRole("habit.name");
  const logDb = byRole("log.date");
  const { habits, entries, loading, setLog } = useHabitData(habitsDb, logDb);
  const now = useStableNow();
  const today = localDay(now);
  const [grace, setGrace] = useState<GraceMode>("never_miss_twice");
  const identityText = useRef<string>("");
  const [identityLoaded, setIdentityLoaded] = useState(false);
  const color = identity("habits").color;
  const profile = useSettings((s) => s.vault?.profileName);

  // Grace mode + identity come from the wizard answers.
  useEffect(() => {
    api.kv
      .get({ ns: "ui.lifeapps", key: `answers:${instance.id}` })
      .then((a) => {
        const ans = (a ?? {}) as { grace?: GraceMode; identity?: string };
        if (ans.grace) setGrace(ans.grace);
        identityText.current = ans.identity ?? "";
        setIdentityLoaded(true);
      })
      .catch(() => setIdentityLoaded(true));
  }, [instance.id]);

  const active = habits.filter((h) => h.def.active);
  const stats = useMemo(() => new Map(active.map((h) => [h.def.id, streakStats(h.def, entries.filter((e) => e.habitId === h.def.id), today, grace)] as const)), [active, entries, today, grace]);
  const todayEntry = (id: Id) => entries.find((e) => e.habitId === id && e.date === today);
  const dueToday = active.filter((h) => isExpected(h.def, today) || h.def.schedule === "x_per_week");
  const doneToday = dueToday.filter((h) => {
    const e = todayEntry(h.def.id);
    return e && (e.status === "done" || e.status === "partial");
  }).length;
  const allDoneRef = useRef<HTMLDivElement>(null);

  const week = useMemo(() => {
    // Mon..today: completed ÷ expected
    const d = new Date(`${today}T12:00:00`);
    const monday = addDays(today, -((d.getDay() + 6) % 7));
    let exp = 0;
    let got = 0;
    for (let day = monday; day <= today; day = addDays(day, 1)) {
      for (const h of active) {
        if (!isExpected(h.def, day) && h.def.schedule !== "x_per_week") continue;
        if (h.def.schedule === "x_per_week") {
          exp += h.def.perWeek / 7;
        } else exp += 1;
        const e = entries.find((x) => x.habitId === h.def.id && x.date === day);
        if (e && (e.status === "done" || e.status === "partial")) got += e.status === "partial" ? 0.5 : 1;
      }
    }
    return exp ? Math.min(1, got / exp) : 0;
  }, [active, entries, today]);

  const daily28 = useMemo(() => {
    const out: number[] = [];
    for (let i = 27; i >= 0; i--) {
      const day = addDays(today, -i);
      const exp = active.filter((h) => isExpected(h.def, day) && h.def.schedule !== "x_per_week" && h.def.started <= day);
      if (!exp.length) {
        out.push(0);
        continue;
      }
      const got = exp.filter((h) => entries.some((e) => e.habitId === h.def.id && e.date === day && (e.status === "done" || e.status === "partial"))).length;
      out.push(got / exp.length);
    }
    return out;
  }, [active, entries, today]);

  const toggle = async (h: Habit, el: HTMLElement | null, value?: number) => {
    if (!logDb) return;
    const existing = entries.find((e) => e.habitId === h.def.id && e.date === today) as (HabitLogEntry & { rowId: Id }) | undefined;
    const statusProp = logDb.p("log.status");
    try {
      if (existing && value === undefined) {
        setLog((rows) => rows.filter((r) => r.id !== existing.rowId));
        await api.db.rowsDelete({ ids: [existing.rowId] });
        return;
      }
      const status = value !== undefined && h.target && value < h.target ? "Partial" : "Done";
      const sid = optionId(statusProp, status);
      const values: Record<Id, ReturnType<typeof write.text>> = {};
      const title = logDb.schema.properties.find((p) => p.id === logDb.schema.database.primaryPropId);
      if (title) values[title.id] = write.text(`${h.def.name} · ${today}`);
      const date = logDb.p("log.date");
      if (date) values[date.id] = write.date(today);
      const habit = logDb.p("log.habit");
      if (habit) values[habit.id] = write.rel([h.def.id]);
      if (statusProp && sid) values[statusProp.id] = write.select(sid);
      const v = logDb.p("log.value");
      if (v && value !== undefined) values[v.id] = write.num(value);
      if (existing) {
        await api.db.rowsUpdate({ updates: [{ id: existing.rowId, values }] });
      } else {
        const remaining = dueToday.filter((x) => x.def.id !== h.def.id && !todayEntry(x.def.id)).length;
        if (el) celebrate(el, { badge: false, particles: remaining === 0 ? 10 : 6 });
        if (remaining === 0 && allDoneRef.current) window.setTimeout(() => allDoneRef.current && celebrate(allDoneRef.current), 260);
        const row = await api.db.rowCreate({ databaseId: logDb.id, values });
        setLog((rows) => (rows.some((r) => r.id === row.id) ? rows : [...rows, row]));
      }
    } catch (e) {
      notify.fromError(e, "Couldn’t save the check-in");
    }
  };

  const setTab = (t: Tab) => navigate({ t: "app", instanceId: instance.id, tab: t });
  const best = Math.max(0, ...[...stats.values()].map((s) => s.best));
  const avg30 = stats.size ? [...stats.values()].reduce((s, x) => s + x.rate30, 0) / stats.size : 0;

  const kpis = (
    <>
      <KpiTile label="Today" value={dueToday.length ? Math.round((doneToday / dueToday.length) * 100) : 0} format={(n) => `${Math.round(n)}%`} loading={loading} footer={<span className="text-caption text-tertiary">{doneToday} of {dueToday.length} habits</span>} />
      <KpiTile label="Check-ins this month" value={entries.filter((e) => e.date.startsWith(today.slice(0, 7)) && (e.status === "done" || e.status === "partial")).length} format={(n) => String(Math.round(n))} loading={loading} spark={daily28} sparkColor={color} />
      <KpiTile label="Best streak" value={best} format={(n) => `${Math.round(n)}\u00a0days`} loading={loading} />
      <KpiTile label="30-day average" value={Math.round(avg30 * 100)} format={(n) => `${Math.round(n)}%`} loading={loading} />
    </>
  );

  return (
    <div className="la-hub">
      <AppHeader<Tab>
        instance={instance}
        title="Habits"
        subtitle={profile ? `Small wins add up, ${profile}.` : "Small wins add up."}
        kpis={kpis}
        tabs={[
          { value: "today", label: "Today", icon: Sun },
          { value: "habits", label: "Habits", icon: Grid3x3, count: active.length || undefined },
          { value: "stats", label: "Stats", icon: BarChart3 },
        ]}
        tab={tab}
        onTab={setTab}
      />
      <div className="la-hub-body" style={{ ["--app" as string]: color }}>
        {dbs && (!habitsDb || !logDb) ? (
          <EmptyState icon={Flame} title="Habit databases not found" body="They may have been deleted. Tune up Habits to recreate them." />
        ) : tab === "today" ? (
          <div className="lo-grid">
            <div className="flex min-w-0 flex-col gap-5">
              <div ref={allDoneRef} className="flex items-baseline justify-between">
                <h2 className="text-title text-primary">{doneToday === dueToday.length && dueToday.length ? "All done for today 🎉" : "Today"}</h2>
                <span className="text-caption text-tertiary">Tap to check in{dueToday.some((h) => h.type !== "Yes/no") ? " · long-press to log an amount" : ""}</span>
              </div>
              {loading ? (
                <div className="flex flex-col gap-2">
                  {Array.from({ length: 5 }, (_, i) => (
                    <Skeleton key={i} height={52} radius={12} />
                  ))}
                </div>
              ) : dueToday.length ? (
                <div className="hb-today">
                  {["Morning", "Afternoon", "Evening", "Anytime"].map((slot) => {
                    const list = dueToday.filter((h) => h.time === slot);
                    if (!list.length) return null;
                    return (
                      <div key={slot} className="flex flex-col gap-1.5">
                        <span className="mt-2 text-micro uppercase text-tertiary">{slot}</span>
                        {list.map((h) => (
                          <CheckRow key={h.def.id} h={h} stats={stats.get(h.def.id)!} entry={todayEntry(h.def.id)} onToggle={(x, el) => void toggle(x, el)} onValue={(x, v) => void toggle(x, null, v)} color={color} />
                        ))}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <EmptyState icon={Flame} title="Nothing scheduled today" body="Enjoy the rest day — streaks for weekly habits keep going." />
              )}
              <StartHere instance={instance} />
            </div>
            <div className="flex min-w-0 flex-col gap-5">
              <Card title="This week" subtitle="Check-ins ÷ scheduled">
                <div className="flex items-center gap-5">
                  <Ring value={week} size={96} color={color} aria-label={`Weekly score ${Math.round(week * 100)}%`}>
                    <span className="text-h3 tabular text-primary">{Math.round(week * 100)}%</span>
                  </Ring>
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 text-caption text-tertiary">Last 4 weeks</div>
                    <Sparkline data={daily28} height={48} color={color} aria-label="Daily completion over the last four weeks" />
                  </div>
                </div>
              </Card>
              {identityLoaded && identityText.current ? (
                <div className="hb-identity">
                  <div className="text-micro uppercase text-tertiary">Who you’re becoming</div>
                  <p className="mt-1.5 font-serif text-[19px] leading-snug text-primary">“I’m becoming someone who {identityText.current.replace(/^who\s+/i, "")}.”</p>
                </div>
              ) : null}
              <section>
                <h2 className="la-section-title">Insights</h2>
                <InsightsFeed instanceId={instance.id} limit={3} empty="You’re on track. Keep going." />
              </section>
            </div>
          </div>
        ) : tab === "habits" ? (
          loading ? (
            <Skeleton height={300} radius={16} />
          ) : (
            <div className="hb-grid">
              {active.map((h, i) => {
                const s = stats.get(h.def.id)!;
                return (
                  <m.div key={h.def.id} className="hb-card" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, transition: { ...spring.gentle, delay: i * 0.04 } }}>
                    <div className="flex items-center gap-3">
                      <span className="hb-emoji" aria-hidden>{h.emoji}</span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-body font-semibold text-primary">{h.def.name}</div>
                        <div className="text-caption text-tertiary">
                          {h.def.schedule === "x_per_week" ? `${h.def.perWeek}× a week` : h.def.schedule === "weekdays" ? "Weekdays" : "Every day"} · {h.time.toLowerCase()}
                        </div>
                      </div>
                      <FlameCount n={s.current} bump={false} />
                    </div>
                    <div className="hb-card-body">
                      <Heatmap h={h} entries={entries.filter((e) => e.habitId === h.def.id)} today={today} color={color} />
                      <div className="hb-stats">
                        <div className="hb-stat">
                          <b>{Math.round(s.rate30 * 100)}%</b>
                          <span>last 30 days</span>
                        </div>
                        <div className="hb-stat">
                          <b>{s.best}</b>
                          <span>best streak</span>
                        </div>
                        <div className="hb-stat">
                          <b>{h.target ? `${h.target.toLocaleString()} ${h.unit}`.trim() : h.type}</b>
                          <span>{h.cue || "target"}</span>
                        </div>
                        <Button size="sm" variant={todayEntry(h.def.id) ? "soft" : "secondary"} onClick={(e) => void toggle(h, e.currentTarget)}>
                          {todayEntry(h.def.id) ? "Checked in" : "Check in"}
                        </Button>
                      </div>
                    </div>
                  </m.div>
                );
              })}
            </div>
          )
        ) : (
          <StatsTab habits={active} entries={entries} stats={stats} today={today} color={color} />
        )}
      </div>
    </div>
  );
}

function StatsTab({ habits, entries, stats, today, color }: { habits: Habit[]; entries: HabitLogEntry[]; stats: Map<Id, StreakStats>; today: string; color: string }) {
  const rates = habits.map((h) => ({ habit: h.def.name, rate: Math.round((stats.get(h.def.id)?.rate30 ?? 0) * 1000) / 10 }));
  const weekly = useMemo(() => {
    const out: { week: string; pct: number }[] = [];
    for (let w = 11; w >= 0; w--) {
      const end = addDays(today, -w * 7);
      const start = addDays(end, -6);
      let exp = 0;
      let got = 0;
      for (let d = start; d <= end; d = addDays(d, 1)) {
        for (const h of habits) {
          if (h.def.started > d || h.def.schedule === "x_per_week" || !isExpected(h.def, d)) continue;
          exp += 1;
          if (entries.some((e) => e.habitId === h.def.id && e.date === d && (e.status === "done" || e.status === "partial"))) got += 1;
        }
      }
      out.push({ week: start, pct: exp ? Math.round((got / exp) * 1000) / 10 : 0 });
    }
    return out;
  }, [habits, entries, today]);
  const month = today.slice(0, 7);
  const checkins = entries.filter((e) => e.date.startsWith(month) && (e.status === "done" || e.status === "partial")).length;
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-5 max-[1080px]:grid-cols-1">
        <Card title="Consistency" subtitle="Weekly completion, last 12 weeks">
          <LineChart data={weekly} x="week" series={[{ key: "pct", label: "Completion", color }]} height={220} format={(n) => `${n}%`} xFormat={(v) => new Date(`${String(v)}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })} curve="monotoneX" area colorBySign={false} startReference={false} yAxis="right" summaryLabel="Weekly habit completion over the last 12 weeks" />
        </Card>
        <Card title="30-day rate by habit" subtitle={`${checkins} check-ins this month`}>
          <BarChart data={rates} x="habit" series={[{ key: "rate", label: "30-day rate", color }]} height={220} format={(n) => `${n}%`} horizontal summaryLabel="Thirty-day completion rate per habit" />
        </Card>
      </div>
      <Card title="Streaks">
        <ul className="flex flex-col">
          {habits
            .map((h) => ({ h, s: stats.get(h.def.id)! }))
            .sort((a, b) => b.s.current - a.s.current)
            .map(({ h, s }) => (
              <li key={h.def.id} className="flex items-center gap-3 border-b border-subtle py-2.5 last:border-0">
                <span className="hb-emoji" aria-hidden>{h.emoji}</span>
                <span className="flex-1 text-body text-primary">{h.def.name}</span>
                <span className="text-caption tabular text-tertiary">best {s.best}</span>
                <FlameCount n={s.current} bump={false} />
                <div className="w-28">
                  <Sparkline data={s.last28.map((x) => Math.max(0, x))} height={24} color={color} endDot={false} aria-label={`${h.def.name} last 28 days`} />
                </div>
              </li>
            ))}
        </ul>
      </Card>
    </div>
  );
}
