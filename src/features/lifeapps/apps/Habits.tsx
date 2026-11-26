/**
 * Habits hub (§16.7): Check-in · Habits · Stats. It lands on Check-in: each habit is a name, a glyph and a checkbox;
 * click to check in, right-click (or the menu key) to log an amount. Habits shows 12×12 heatmaps and streaks; Stats
 * the trends. Streaks honour the grace mode (§15.8). Home shows today's count and links here (PROGRAMME-v3 K4).
 * The work leads: no KPI row, rings or flame pills; numbers are plain text and appear only once the data has loaded.
 */
import { BarChart3, Check, Grid3x3, ListChecks } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/backend";
import type { Id, LifeAppInstance } from "@/backend/types";
import { navigate } from "@/app/router";
import { BarChart } from "@/charts/Bar";
import { LineChart } from "@/charts/Line";
import { Sparkline } from "@/charts/Sparkline";
import { cn } from "@/lib/cn";
import { notify } from "@/stores/toasts";
import { Button } from "@/ui/Button";
import { Checkbox } from "@/ui/Checkbox";
import { Card } from "@/ui/Card";
import { EmptyState } from "@/ui/EmptyState";
import { NumberField } from "@/ui/NumberField";
import { Popover, PopoverAnchor, PopoverContent } from "@/ui/Popover";
import { Skeleton } from "@/ui/Skeleton";
import { Tooltip } from "@/ui/Tooltip";
import { AppHeader } from "../AppHeader";
import { localDay, optionId, write } from "../cells";
import { useAppDatabases, useStableNow } from "../data";
import { addDays, heatCells, isExpected, streakStats, type GraceMode, type HabitLogEntry, type StreakStats } from "../engine/habitMath";
import { Glyph } from "../Glyph";
import { dueOn, isDoneEntry, useHabitData, type Habit } from "../habitData";
import { InsightsFeed } from "../Insights";

type Tab = "checkin" | "habits" | "stats";

// ───────────────────────────────────────────────────────────────────────────── pieces

function Streak({ n }: { n: number }) {
  return <span className="flex-none text-caption tabular text-tertiary">{n ? `${n}-day streak` : "No streak"}</span>;
}

function Heatmap({ h, entries, today }: { h: Habit; entries: HabitLogEntry[]; today: string }) {
  const cells = useMemo(() => heatCells(h.def, entries, today, 144), [h.def, entries, today]);
  return (
    <div className="hb-heat well" data-static="" role="img" aria-label={`${h.def.name}: last 144 days`}>
      {cells.map((c) => (
        <Tooltip key={c.date} content={`${new Date(`${c.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} · ${c.status ? c.status[0].toUpperCase() + c.status.slice(1) : c.expected ? "Missed" : "Not scheduled"}`}>
          <span className={cn("hb-cell", c.date === today && "is-today", !c.expected && !c.status && "is-off")} data-level={c.level > 0 ? Math.min(4, Math.ceil(c.level * 4)) : undefined} />
        </Tooltip>
      ))}
    </div>
  );
}

function CheckRow({ h, entry, onToggle, onValue }: { h: Habit; entry?: HabitLogEntry; onToggle: (h: Habit) => void; onValue: (h: Habit, v: number) => void }) {
  const done = !!entry && (entry.status === "done" || entry.status === "partial");
  const [valueOpen, setValueOpen] = useState(false);
  const [val, setVal] = useState<number | null>(h.target);
  const wantsValue = h.type !== "Yes/no" && h.type !== "Avoid";
  const sub = done && entry?.value ? `${entry.value.toLocaleString()} ${h.unit}`.trim() : h.target && wantsValue ? `${h.target.toLocaleString()} ${h.unit}`.trim() : h.cue;
  return (
    <Popover open={valueOpen} onOpenChange={setValueOpen}>
      <PopoverAnchor asChild>
        <div
          className={cn("hb-check", done && "is-done")}
          onContextMenu={(e) => {
            if (!wantsValue) return;
            e.preventDefault();
            setValueOpen(true);
          }}
        >
          <Glyph icon={h.row.icon} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-body text-primary">{h.def.name}</span>
            {sub ? <span className="truncate text-caption text-tertiary">{sub}</span> : null}
          </span>
          {wantsValue ? (
            <Button size="xs" variant="ghost" onClick={() => setValueOpen(true)} aria-label={`Log an amount for ${h.def.name}`}>
              Amount
            </Button>
          ) : null}
          <Checkbox checked={done} onCheckedChange={() => onToggle(h)} aria-label={done ? `${h.def.name}: done. Undo` : `Check in ${h.def.name}`} />
        </div>
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
          <NumberField label="How much today?" value={val} onChange={setVal} suffix={h.unit || undefined} min={0} steppers autoFocus />
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
  // "today" is an older link to this tab.
  const tab = (tabProp === "habits" || tabProp === "stats" ? tabProp : "checkin") as Tab;
  const { byRole, dbs } = useAppDatabases(instance.id);
  const habitsDb = byRole("habit.name");
  const logDb = byRole("log.date");
  const { habits, entries, loading, setLog } = useHabitData(habitsDb, logDb);
  const now = useStableNow();
  const today = localDay(now);
  const [grace, setGrace] = useState<GraceMode>("never_miss_twice");

  // Grace mode + identity come from the wizard answers.
  useEffect(() => {
    api.kv
      .get({ ns: "ui.lifeapps", key: `answers:${instance.id}` })
      .then((a) => {
        const ans = (a ?? {}) as { grace?: GraceMode };
        if (ans.grace) setGrace(ans.grace);
      })
      .catch(() => undefined);
  }, [instance.id]);

  const active = habits.filter((h) => h.def.active);
  const stats = useMemo(() => new Map(active.map((h) => [h.def.id, streakStats(h.def, entries.filter((e) => e.habitId === h.def.id), today, grace)] as const)), [active, entries, today, grace]);
  const todayEntry = (id: Id) => entries.find((e) => e.habitId === id && e.date === today);
  const { due: dueToday, done: doneToday } = dueOn(habits, entries, today);

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

  const toggle = async (h: Habit, value?: number) => {
    if (!logDb) return;
    const existing = entries.find((e) => e.habitId === h.def.id && e.date === today);
    const statusProp = logDb.p("log.status");
    try {
      // A done check-in toggles off; a skipped / missed / frozen one is upgraded to done.
      if (existing && isDoneEntry(existing) && value === undefined) {
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
        setLog((rows) => rows.map((r) => (r.id === existing.rowId ? { ...r, values: { ...r.values, ...values } } : r)));
        await api.db.rowsUpdate({ updates: [{ id: existing.rowId, values }] });
      } else {
        const row = await api.db.rowCreate({ databaseId: logDb.id, values });
        setLog((rows) => (rows.some((r) => r.id === row.id) ? rows : [...rows, row]));
      }
    } catch (e) {
      notify.fromError(e, "Couldn’t save the check-in");
    }
  };

  const setTab = (t: Tab) => navigate({ t: "app", instanceId: instance.id, tab: t });
  return (
    <div className="la-hub">
      <AppHeader<Tab>
        instance={instance}
        title="Habits"
        subtitle={loading ? undefined : dueToday.length ? `${doneToday} of ${dueToday.length} done today · ${Math.round(week * 100)}% of this week’s check-ins` : "Nothing due today"}
        tabs={[
          { value: "checkin", label: "Check-in", icon: ListChecks },
          { value: "habits", label: "Habits", icon: Grid3x3 },
          { value: "stats", label: "Stats", icon: BarChart3 },
        ]}
        tab={tab}
        onTab={setTab}
      />
      <div className="la-hub-body">
        {dbs && (!habitsDb || !logDb) ? (
          <EmptyState icon={ListChecks} title="Habit databases not found" body="They may have been deleted. Tune up Habits to recreate them." />
        ) : tab === "checkin" ? (
          <div className="lo-grid">
            <div className="flex min-w-0 flex-col gap-5">
              <div className="flex items-baseline justify-between">
                <h2 className="text-title text-primary">Check-in</h2>
                <span className="text-caption text-tertiary">Click to check in{dueToday.some((h) => h.type !== "Yes/no" && h.type !== "Avoid") ? " · right-click to log an amount" : ""}</span>
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
                        <span className="mt-2 text-caption text-tertiary">{slot}</span>
                        {list.map((h) => (
                          <CheckRow key={h.def.id} h={h} entry={todayEntry(h.def.id)} onToggle={(x) => void toggle(x)} onValue={(x, v) => void toggle(x, v)} />
                        ))}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="py-6 text-body-sm text-tertiary">Nothing due today. Weekly habits keep their streaks.</p>
              )}
            </div>
            <section className="flex min-w-0 flex-col">
              <h2 className="la-section-title">Notes</h2>
              <InsightsFeed instanceId={instance.id} limit={3} empty="Nothing to note." />
            </section>
          </div>
        ) : tab === "habits" ? (
          loading ? (
            <Skeleton height={300} radius={16} />
          ) : (
            <div className="hb-grid">
              {active.map((h) => {
                const s = stats.get(h.def.id)!;
                return (
                  <div key={h.def.id} className="hb-card panel">
                    <div className="flex items-center gap-3">
                      <Glyph icon={h.row.icon} size={18} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-body font-semibold text-primary">{h.def.name}</div>
                        <div className="text-caption text-tertiary">
                          {h.def.schedule === "x_per_week" ? `${h.def.perWeek}× a week` : h.def.schedule === "weekdays" ? "Weekdays" : "Every day"} · {h.time.toLowerCase()}
                        </div>
                      </div>
                      <Streak n={s.current} />
                    </div>
                    <div className="hb-card-body">
                      <Heatmap h={h} entries={entries.filter((e) => e.habitId === h.def.id)} today={today} />
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
                        <Button size="sm" variant="secondary" active={!!todayEntry(h.def.id)} aria-pressed={!!todayEntry(h.def.id)} icon={todayEntry(h.def.id) ? Check : undefined} onClick={() => void toggle(h)}>
                          {todayEntry(h.def.id) ? "Checked in" : "Check in"}
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )
        ) : (
          <StatsTab habits={active} entries={entries} stats={stats} today={today} />
        )}
      </div>
    </div>
  );
}

function StatsTab({ habits, entries, stats, today }: { habits: Habit[]; entries: HabitLogEntry[]; stats: Map<Id, StreakStats>; today: string }) {
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
          <LineChart data={weekly} x="week" series={[{ key: "pct", label: "Completion" }]} height={220} format={(n) => `${n}%`} xFormat={(v) => new Date(`${String(v)}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })} curve="monotoneX" area colorBySign={false} startReference={false} yAxis="right" summaryLabel="Weekly habit completion over the last 12 weeks" />
        </Card>
        <Card title="30-day rate by habit" subtitle={`${checkins} check-ins this month`}>
          <BarChart data={rates} x="habit" series={[{ key: "rate", label: "30-day rate" }]} height={220} format={(n) => `${n}%`} horizontal summaryLabel="Thirty-day completion rate per habit" />
        </Card>
      </div>
      <Card title="Streaks">
        <ul className="flex flex-col">
          {habits
            .map((h) => ({ h, s: stats.get(h.def.id)! }))
            .sort((a, b) => b.s.current - a.s.current)
            .map(({ h, s }) => (
              <li key={h.def.id} className="flex items-center gap-3 border-b border-subtle py-2.5 last:border-0">
                <Glyph icon={h.row.icon} />
                <span className="flex-1 text-body text-primary">{h.def.name}</span>
                <span className="text-caption tabular text-tertiary">best {s.best}</span>
                <Streak n={s.current} />
                <div className="w-28">
                  <Sparkline data={s.last28.map((x) => Math.max(0, x))} height={24} endDot={false} aria-label={`${h.def.name} last 28 days`} />
                </div>
              </li>
            ))}
        </ul>
      </Card>
    </div>
  );
}
