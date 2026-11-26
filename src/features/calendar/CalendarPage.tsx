/**
 * Calendar (§6.4 "Today", §17.1 Calendar read, §17.3 ICS): month / week / agenda views over the local merge of Google
 * calendars, imported ICS files and database dates (Life OS blocks and due dates, tax deadlines), plus your own Events
 * database. Create events, import / export .ics, choose which sources to show, and connect Google.
 * Month cells ≥ 112px; today is a 22px accent circle; event chips are 20px at radius 4 (§5.11).
 */
import { CalendarPlus, Check, ChevronLeft, ChevronRight, Download, Ellipsis, Link2, MapPin, RefreshCw, Trash2, Upload } from "lucide-react";
import { AnimatePresence, m, useMotionValue, type HTMLMotionProps, type MotionValue } from "motion/react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, errorMessage, listen } from "@/backend";
import type { CalendarEvent, GoogleCalendarInfo, Id, Route } from "@/backend/types";
import { cn } from "@/lib/cn";
import { formatTime, getWeekStart, monthGrid } from "@/lib/dates";
import { notify } from "@/stores/toasts";
import { useUi } from "@/stores/ui";
import { useTree } from "@/stores/tree";
import { useWorkspace } from "@/stores/workspace";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { Calendar as MiniCalendar } from "@/ui/DatePicker";
import { Dialog } from "@/ui/Dialog";
import { IconButton } from "@/ui/IconButton";
import { Input } from "@/ui/Input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/ui/Menu";
import { Popover, PopoverAnchor, PopoverContent } from "@/ui/Popover";
import { Segmented } from "@/ui/Segmented";
import { Select } from "@/ui/Select";
import { Switch } from "@/ui/Switch";
import { Textarea } from "@/ui/Textarea";
import { RollingNumber } from "@/ui/motion/RollingNumber";
import { spring } from "@/ui/motion/tokens";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { GoogleSetupSheet } from "@/features/integrations/GoogleSetupSheet";
import { localDay, read, write } from "@/features/lifeapps/cells";
import "./calendar.css";

type View = "month" | "week" | "agenda";

const pad = (n: number) => String(n).padStart(2, "0");
const dayOf = (d: Date) => localDay(d);
const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const parseDay = (s: string) => new Date(`${s.slice(0, 10)}T12:00:00`);
/** Day strings an event covers (inclusive), capped at 60. */
function daysOf(e: CalendarEvent): string[] {
  const s = e.allDay ? e.start.slice(0, 10) : dayOf(new Date(e.start));
  const en = e.allDay ? (e.end || e.start).slice(0, 10) : dayOf(new Date(new Date(e.end).getTime() - 1));
  const out: string[] = [];
  for (let d = parseDay(s); dayOf(d) <= en && out.length < 60; d = addDays(d, 1)) out.push(dayOf(d));
  return out.length ? out : [s];
}

interface CalPrefs {
  eventsDb?: Id;
  hidden?: string[];
}

function sourceKey(e: CalendarEvent): string {
  if (e.source === "google") return `google:${e.calendarId}`;
  if (e.source === "ics") return `ics:${e.calendarId}`;
  return `db:${e.calendarId}`;
}

// ───────────────────────────────────────────────────────────────────────────── data

function useCalendarData(from: Date, to: Date, prefs: CalPrefs) {
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const base = await api.calendar.events({ from: dayOf(from), to: dayOf(to) });
      let mine: CalendarEvent[] = [];
      if (prefs.eventsDb) {
        try {
          const [schema, res] = await Promise.all([api.db.getSchema({ id: prefs.eventsDb }), api.db.query({ databaseId: prefs.eventsDb, window: { offset: 0, limit: 500 }, reqId: n })]);
          const date = schema.properties.find((p) => p.type === "date");
          const title = schema.properties.find((p) => p.id === schema.database.primaryPropId);
          const loc = schema.properties.find((p) => p.name === "Location");
          const notes = schema.properties.find((p) => p.name === "Notes");
          if (date && !("notModified" in res)) {
            for (const r of res.rows) {
              const d = read.date(r, date);
              if (!d) continue;
              const end = d.end ?? d.start;
              if (end.slice(0, 10) < dayOf(from) || d.start.slice(0, 10) > dayOf(to)) continue;
              mine.push({ id: r.id, source: "db", calendarId: prefs.eventsDb, title: read.text(r, title) || "Untitled event", start: d.start, end, allDay: !d.time, color: "gray", recurring: false, location: read.text(r, loc) || undefined, description: read.text(r, notes) || undefined, link: { t: "row", id: r.id } });
            }
          }
        } catch {
          mine = [];
        }
      }
      if (n === seq.current) setEvents([...base, ...mine]);
    } catch {
      if (n === seq.current) setEvents((e) => e ?? []);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayOf(from), dayOf(to), prefs.eventsDb]);
  useEffect(() => {
    void load();
    let t: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => void load(), 200);
    };
    const offs = [listen("db:changed", bump), listen("sync:status", (e) => e.state !== "syncing" && bump())];
    return () => {
      offs.forEach((o) => o());
      if (t) clearTimeout(t);
    };
  }, [load]);
  /** Optimistic local edit (drag-to-reschedule); the next load reconciles. */
  const patch = useCallback((id: Id, next: Partial<CalendarEvent>) => setEvents((list) => list?.map((x) => (x.id === id ? { ...x, ...next } : x)) ?? list), []);
  return { events, reload: load, patch };
}

// ───────────────────────────────────────────────────────────────────────────── drag to reschedule (S14)

interface DragTarget {
  day: string;
  /** Week view: minutes from midnight of the dragged block's new top (15-minute steps). */
  minutes?: number;
}
interface DragState {
  e: CalendarEvent;
  key: string;
  mode: "month" | "week";
  w: number;
  h: number;
  ox: number;
  oy: number;
  from: string;
  target: DragTarget | null;
  tilt: number;
}
interface DragApi {
  canDrag: (e: CalendarEvent) => boolean;
  start: (ev: React.PointerEvent<HTMLElement>, e: CalendarEvent, key: string, mode: "month" | "week", from: string) => void;
  dragging: string | null;
  over: string | null;
  landed: string | null;
  /** True right after a drag ended: the click that follows must not open the details popover. */
  consumeClick: () => boolean;
}
const DragCtx = createContext<DragApi | null>(null);
const useDrag = () => useContext(DragCtx);

function useEventDrag(canDrag: (e: CalendarEvent) => boolean, onDrop: (e: CalendarEvent, t: DragTarget) => void) {
  const [st, setSt] = useState<DragState | null>(null);
  const [landed, setLanded] = useState<string | null>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const suppress = useRef(false);
  const lastX = useRef(0);
  const live = useRef<DragState | null>(null);

  const start = useCallback(
    (ev: React.PointerEvent<HTMLElement>, e: CalendarEvent, key: string, mode: "month" | "week", from: string) => {
      if (ev.button !== 0 || !canDrag(e)) return;
      const el = ev.currentTarget;
      const r = el.getBoundingClientRect();
      const sx = ev.clientX;
      const sy = ev.clientY;
      let active = false;
      const pid = ev.pointerId;
      const targetAt = (cx: number, cy: number, oy: number): DragTarget | null => {
        const hit = document.elementFromPoint(cx, cy)?.closest<HTMLElement>("[data-day]");
        if (!hit) return null;
        const day = hit.dataset.day as string;
        if (mode === "week" && hit.dataset.col !== undefined) {
          const top = cy - oy - hit.getBoundingClientRect().top;
          const minutes = Math.max(0, Math.min(24 * 60 - 15, Math.round(((top / HPX) * 60) / 15) * 15));
          return { day, minutes };
        }
        return { day };
      };
      const move = (pe: PointerEvent) => {
        if (pe.pointerId !== pid) return;
        if (!active) {
          if (Math.hypot(pe.clientX - sx, pe.clientY - sy) < 5) return;
          active = true;
          suppress.current = true;
          lastX.current = pe.clientX;
          x.set(r.left);
          y.set(r.top);
          const s0: DragState = { e, key, mode, w: r.width, h: r.height, ox: sx - r.left, oy: sy - r.top, from, target: null, tilt: 0 };
          live.current = s0;
          setSt(s0);
          document.documentElement.style.cursor = "grabbing";
        }
        const cur = live.current;
        if (!cur) return;
        x.set(pe.clientX - cur.ox);
        y.set(pe.clientY - cur.oy);
        const vx = pe.clientX - lastX.current;
        lastX.current = pe.clientX;
        const tilt = Math.abs(vx) > 1.5 ? Math.sign(vx) * 1.5 : cur.tilt;
        const t = targetAt(pe.clientX, pe.clientY, cur.oy);
        const tKey = t ? `${t.day}|${t.minutes ?? ""}` : "";
        const cKey = cur.target ? `${cur.target.day}|${cur.target.minutes ?? ""}` : "";
        if (tKey !== cKey || tilt !== cur.tilt) {
          const next = { ...cur, target: t, tilt };
          live.current = next;
          setSt(next);
        }
      };
      const up = (pe: PointerEvent) => {
        if (pe.pointerId !== pid) return;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        document.documentElement.style.cursor = "";
        const cur = live.current;
        live.current = null;
        setSt(null);
        if (!active || !cur) return;
        window.setTimeout(() => (suppress.current = false), 0);
        const t = cur.target;
        if (t && pe.type === "pointerup" && (t.day !== cur.from || (t.minutes !== undefined && cur.mode === "week"))) {
          setLanded(cur.key.split("@")[0]);
          window.setTimeout(() => setLanded(null), 520);
          onDrop(cur.e, t);
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    },
    [canDrag, onDrop, x, y],
  );

  const api: DragApi = {
    canDrag,
    start,
    dragging: st?.key ?? null,
    over: st?.target ? st.target.day : null,
    landed,
    consumeClick: () => {
      const s0 = suppress.current;
      suppress.current = false;
      return s0;
    },
  };
  return { api, state: st, x, y };
}

/** The lifted card that follows the pointer while dragging (transform-only; a portal above everything). */
function DragGhost({ st, x, y }: { st: DragState; x: MotionValue<number>; y: MotionValue<number> }) {
  const e = st.e;
  const when =
    st.target?.minutes !== undefined
      ? new Date(2026, 0, 1, Math.floor(st.target.minutes / 60), st.target.minutes % 60).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
      : st.target
        ? parseDay(st.target.day).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
        : null;
  return createPortal(
    <m.div className="cal-ghost" style={{ x, y, width: st.w, height: st.h, ...chipStyle(e.color) }} data-mode={st.mode} aria-hidden>
      <m.div className={cn("cal-ghost-card", e.allDay ? "is-allday" : "is-timed")} initial={{ scale: 1, rotate: 0 }} animate={{ scale: 1.03, rotate: st.tilt }} transition={spring.release}>
        {!e.allDay && st.mode === "month" ? <span className="cal-chip-dot" /> : null}
        <span className="truncate">{e.title}</span>
      </m.div>
      {when ? <span className="cal-ghost-when tabular">{when}</span> : null}
    </m.div>,
    document.body,
  );
}

// ───────────────────────────────────────────────────────────────────────────── event chip + details

function chipStyle(color: string): React.CSSProperties {
  return { ["--c-bg" as string]: `var(--block-${color}-bg, var(--bg-surface-2))`, ["--c-fg" as string]: `var(--block-${color}-text, var(--text-primary))` };
}

function EventDetails({ e, calName, onDelete, onClose }: { e: CalendarEvent; calName: string; onDelete?: () => void; onClose: () => void }) {
  const when = e.allDay
    ? daysOf(e).length > 1
      ? `${parseDay(e.start).toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${parseDay(e.end).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
      : parseDay(e.start).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })
    : `${new Date(e.start).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })} · ${formatTime(e.start)} – ${formatTime(e.end)}`;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-1.5 h-2.5 w-2.5 flex-none rounded-[3px]" style={{ background: `var(--block-${e.color}-text, var(--accent-solid))` }} />
        <div className="min-w-0 flex-1">
          <div className="text-title text-primary">{e.title}</div>
          <div className="text-body-sm text-secondary">{when}</div>
        </div>
      </div>
      {e.location ? (
        <div className="flex items-center gap-2 text-body-sm text-secondary">
          <MapPin size={14} className="text-tertiary" aria-hidden />
          {e.location}
        </div>
      ) : null}
      {e.description ? <p className="whitespace-pre-wrap text-body-sm text-secondary">{e.description}</p> : null}
      <div className="flex items-center gap-2">
        <Badge tone="outline">{calName}</Badge>
        {e.recurring ? <Badge tone="neutral">Repeats</Badge> : null}
        {e.source === "google" ? <span className="text-caption text-tertiary">Read-only from Google</span> : null}
      </div>
      {e.link || onDelete ? (
        <div className="flex justify-end gap-2 border-t border-subtle pt-3">
          {onDelete ? (
            <Button size="sm" variant="destructive-ghost" icon={Trash2} onClick={onDelete}>
              Delete
            </Button>
          ) : null}
          {e.link ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                onClose();
                useUi.getState().openPeek(e.link as Route);
              }}
            >
              {e.description === "Due" ? "Open task" : "Open"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── new event

interface Draft {
  title: string;
  day: string;
  allDay: boolean;
  start: string;
  end: string;
  location: string;
  notes: string;
  target: "events" | "task";
}

function NewEventDialog({ open, onOpenChange, draft, setDraft, onSave, hasLifeOs }: { open: boolean; onOpenChange: (o: boolean) => void; draft: Draft; setDraft: (d: Draft) => void; onSave: () => Promise<void>; hasLifeOs: boolean }) {
  const [busy, setBusy] = useState(false);
  const valid = draft.title.trim() && (draft.allDay || draft.end > draft.start);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New event"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave();
              } finally {
                setBusy(false);
              }
            }}
          >
            Add event
          </Button>
        </>
      }
    >
      <form
        className="relative flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void onSave();
        }}
      >
        <Input label="Title" placeholder="Dinner with Sam" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.currentTarget.value })} autoFocus maxLength={1024} />
        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <Input label="Date" type="date" value={draft.day} onChange={(e) => setDraft({ ...draft, day: e.currentTarget.value })} />
          <div className="pb-2">
            <Switch checked={draft.allDay} onCheckedChange={(v) => setDraft({ ...draft, allDay: v })} label="All day" />
          </div>
        </div>
        {/* DESIGN §1.6: the time fields mount at full size and rise in; on removal they pop out of flow while the
            fields below glide with a layout="position" FLIP. Nothing animates height. */}
        <AnimatePresence initial={false} mode="popLayout">
          {!draft.allDay ? (
            <m.div
              key="times"
              className="grid grid-cols-2 gap-3"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0, transition: { opacity: { duration: 0.16 }, y: spring.settle } }}
              exit={{ opacity: 0, y: -4, transition: { duration: 0.12 } }}
            >
              <Input label="Starts" type="time" value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.currentTarget.value })} />
              <Input label="Ends" type="time" value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.currentTarget.value })} error={draft.end <= draft.start ? "Ends before it starts" : undefined} />
            </m.div>
          ) : null}
        </AnimatePresence>
        <m.div layout="position" transition={spring.layout} className="flex flex-col gap-4">
        <Input label="Location" icon={MapPin} value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.currentTarget.value })} />
        <Textarea label="Notes" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.currentTarget.value })} minRows={2} maxRows={6} />
        {hasLifeOs ? (
          <Select<Draft["target"]>
            label="Add to"
            value={draft.target}
            onValueChange={(t) => setDraft({ ...draft, target: t })}
            options={[
              { value: "events", label: "Events", description: "Your calendar in EMP" },
              { value: "task", label: "Life OS task", description: "A scheduled block on your task list" },
            ]}
          />
        ) : null}
        </m.div>
      </form>
    </Dialog>
  );
}

// ───────────────────────────────────────────────────────────────────────────── page

export default function CalendarPage() {
  const reduced = useReducedMotionPref();
  const ws = useWorkspace((s) => s.workspace);
  const lifeos = useWorkspace((s) => s.lifeapps.find((i) => i.appId === "life-os" && !i.detached));
  const [view, setView] = useState<View>("month");
  const [cursor, setCursor] = useState(() => new Date());
  const [dir, setDir] = useState(0);
  const [prefs, setPrefs] = useState<CalPrefs>({});
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [google, setGoogle] = useState<{ connected: boolean; email?: string; accountId?: Id; cals: GoogleCalendarInfo[] }>({ connected: false, cals: [] });
  const [setupOpen, setSetupOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>({ title: "", day: localDay(), allDay: false, start: "10:00", end: "11:00", location: "", notes: "", target: "events" });
  const [open, setOpen] = useState<{ e: CalendarEvent; el: HTMLElement } | null>(null);
  const ws0 = getWeekStart();
  const today = localDay();

  useEffect(() => {
    api.kv
      .get({ ns: "ui.calendar", key: "prefs" })
      .then((v) => setPrefs((v as CalPrefs | null) ?? {}))
      .catch(() => undefined)
      .finally(() => setPrefsLoaded(true));
  }, []);
  const savePrefs = (p: CalPrefs) => {
    setPrefs(p);
    void api.kv.set({ ns: "ui.calendar", key: "prefs", value: p }).catch(() => undefined);
  };
  const loadGoogle = useCallback(async () => {
    try {
      const s = await api.google.status();
      const a = s.accounts.find((x) => x.status === "ok");
      setGoogle({ connected: !!a, email: a?.email, accountId: a?.id, cals: a ? await api.gcal.calendars({ accountId: a.id }).catch(() => []) : [] });
    } catch {
      setGoogle({ connected: false, cals: [] });
    }
  }, []);
  useEffect(() => void loadGoogle(), [loadGoogle, setupOpen]);

  // Range for the current view
  const { from, to, days } = useMemo(() => {
    if (view === "month") {
      const g = monthGrid(cursor, ws0);
      return { from: g[0], to: g[41], days: g };
    }
    if (view === "week") {
      const start = addDays(cursor, -((cursor.getDay() - ws0 + 7) % 7));
      const d = Array.from({ length: 7 }, (_, i) => addDays(start, i));
      return { from: d[0], to: d[6], days: d };
    }
    const d = Array.from({ length: 45 }, (_, i) => addDays(cursor, i));
    return { from: d[0], to: d[44], days: d };
  }, [view, cursor, ws0]);
  const { events, reload, patch } = useCalendarData(from, to, prefsLoaded ? prefs : {});
  const hidden = new Set(prefs.hidden ?? []);
  const visible = (events ?? []).filter((e) => !hidden.has(sourceKey(e)));
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const e of visible) for (const d of daysOf(e)) map.set(d, [...(map.get(d) ?? []), e]);
    for (const list of map.values()) list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, prefs.hidden]);

  const calName = (e: CalendarEvent) => {
    if (e.source === "google") return google.cals.find((c) => c.id === e.calendarId)?.summary ?? "Google";
    if (e.source === "ics") return e.calendarId.replace(/^ics:/, "") || "Imported";
    if (e.calendarId === prefs.eventsDb) return "Events";
    return e.color === "yellow" ? "Tax deadlines" : "Life OS tasks";
  };

  const step = (n: number) => {
    setDir(n);
    setCursor((c) => (view === "month" ? new Date(c.getFullYear(), c.getMonth() + n, 1) : addDays(c, n * (view === "week" ? 7 : 30))));
  };
  const title = view === "month" ? cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" }) : view === "week" ? `${from.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${to.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}` : `From ${cursor.toLocaleDateString(undefined, { month: "long", day: "numeric" })}`;

  const startNew = (day: string, start?: string) => {
    setDraft({ title: "", day, allDay: !start, start: start ?? "10:00", end: start ? `${pad(Math.min(23, Number(start.slice(0, 2)) + 1))}:${start.slice(3)}` : "11:00", location: "", notes: "", target: "events" });
    setNewOpen(true);
  };

  const ensureEventsDb = async (): Promise<Id> => {
    if (prefs.eventsDb) {
      try {
        await api.db.getSchema({ id: prefs.eventsDb });
        return prefs.eventsDb;
      } catch {
        /* recreate */
      }
    }
    if (!ws) throw new Error("No workspace");
    const res = await api.db.create({ workspaceId: ws.id, parentId: null, title: "Events", inline: false, properties: [{ name: "Name", type: "title" }, { name: "When", type: "date" }, { name: "Location", type: "text" }, { name: "Notes", type: "text" }] });
    await api.db.viewCreate({ databaseId: res.page.id, name: "Calendar", layout: "calendar" }).catch(() => undefined);
    savePrefs({ ...prefs, eventsDb: res.page.id });
    return res.page.id;
  };

  const save = async () => {
    try {
      const dateVal = draft.allDay ? write.date(draft.day) : write.date(new Date(`${draft.day}T${draft.start}`).toISOString(), new Date(`${draft.day}T${draft.end}`).toISOString(), true);
      if (draft.target === "task" && lifeos) {
        let schema = null;
        for (const p of useTree.getState().byId.values()) {
          if (p.kind !== "database" || p.appInstanceId !== lifeos.id || p.deletedAt) continue;
          const sc = await api.db.getSchema({ id: p.id }).catch(() => null);
          if (sc?.properties.some((x) => x.role === "task.status")) {
            schema = sc;
            break;
          }
        }
        if (!schema) throw new Error("Life OS Tasks database not found");
        const tasksPage = { id: schema.database.id };
        const role = (r: string) => schema.properties.find((p) => p.role === r);
        const status = role("task.status");
        const sched = role("task.scheduled");
        const values: Record<Id, ReturnType<typeof write.text>> = { [schema.database.primaryPropId]: write.text(draft.title.trim()) };
        if (sched) values[sched.id] = dateVal;
        const scheduledOpt = ((status?.config.options as { id: Id; name: string }[]) ?? []).find((o) => o.name === "Scheduled")?.id;
        if (status && scheduledOpt) values[status.id] = write.status(scheduledOpt);
        await api.db.rowCreate({ databaseId: tasksPage.id, values });
      } else {
        const id = await ensureEventsDb();
        const schema = await api.db.getSchema({ id });
        const date = schema.properties.find((p) => p.type === "date");
        const loc = schema.properties.find((p) => p.name === "Location");
        const notes = schema.properties.find((p) => p.name === "Notes");
        const values: Record<Id, ReturnType<typeof write.text>> = { [schema.database.primaryPropId]: write.text(draft.title.trim()) };
        if (date) values[date.id] = dateVal;
        if (loc && draft.location) values[loc.id] = write.text(draft.location);
        if (notes && draft.notes) values[notes.id] = write.text(draft.notes);
        await api.db.rowCreate({ databaseId: id, values });
      }
      setNewOpen(false);
      notify.success("Event added", { description: `${draft.title.trim()} · ${parseDay(draft.day).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}` });
      void reload();
    } catch (e) {
      notify.error("Couldn’t add the event", { description: errorMessage(e) });
    }
  };

  const importIcs = async () => {
    try {
      const [grant] = await api.file.pick({ purpose: "import", filters: [{ name: "Calendar", extensions: ["ics"] }], multiple: false });
      if (!grant) return;
      const job = await api.import.ics({ grantId: grant.grantId, target: "calendar" });
      const res = await job.result;
      notify.success(`Imported ${res.events.toLocaleString()} ${res.events === 1 ? "event" : "events"}`, { description: grant.displayName });
      void reload();
    } catch (e) {
      notify.fromError(e, "Couldn’t import the calendar");
    }
  };
  const exportIcs = async () => {
    try {
      const id = prefs.eventsDb;
      if (!id) {
        notify.info("Nothing to export yet", { description: "Add an event first — exports include your Events calendar." });
        return;
      }
      const schema = await api.db.getSchema({ id });
      const date = schema.properties.find((p) => p.type === "date");
      if (!date) return;
      const grant = await api.file.saveGrant({ purpose: "export", suggestedName: "EMP events.ics", filters: [{ name: "Calendar", extensions: ["ics"] }] });
      if (!grant) return;
      const res = await api.ics.export({ source: { databaseId: id, dateProp: date.id }, grantId: grant.grantId });
      notify.success(`Exported ${res.events} ${res.events === 1 ? "event" : "events"}`);
    } catch (e) {
      notify.fromError(e, "Couldn’t export");
    }
  };
  const syncNow = async () => {
    setSyncing(true);
    try {
      const job = await api.gcal.syncNow({});
      const r = await job.result;
      notify.success("Google Calendar synced", { description: r.added ? `${r.added} new events` : "Already up to date." });
      void reload();
    } catch (e) {
      notify.fromError(e, "Couldn’t sync");
    } finally {
      setSyncing(false);
    }
  };
  const deleteEvent = async (e: CalendarEvent) => {
    if (!e.link || e.link.t !== "row") return;
    try {
      await api.db.rowsDelete({ ids: [e.link.id] });
      setOpen(null);
      notify.undo("Event deleted", async () => {
        await api.db.rowsRestore({ ids: [(e.link as { id: Id }).id] });
        void reload();
      });
      void reload();
    } catch (err) {
      notify.fromError(err, "Couldn’t delete the event");
    }
  };

  // Drag to reschedule: your own Events calendar is editable; Google, ICS and Life OS items stay read-only here.
  const canDrag = useCallback((e: CalendarEvent) => !!prefs.eventsDb && e.calendarId === prefs.eventsDb && e.link?.t === "row", [prefs.eventsDb]);
  const moveEvent = useCallback(
    async (e: CalendarEvent, t: DragTarget) => {
      if (!prefs.eventsDb || e.link?.t !== "row") return;
      const rowId = e.link.id;
      let start: string;
      let end: string;
      let value: ReturnType<typeof write.date>;
      if (e.allDay) {
        const span = daysOf(e).length - 1;
        start = t.day;
        end = span ? dayOf(addDays(parseDay(t.day), span)) : t.day;
        value = span ? write.date(start, end) : write.date(start);
      } else {
        const s0 = new Date(e.start);
        const dur = Math.max(15 * 60_000, new Date(e.end).getTime() - s0.getTime());
        const ns = new Date(`${t.day}T00:00:00`);
        if (t.minutes !== undefined) ns.setHours(Math.floor(t.minutes / 60), t.minutes % 60, 0, 0);
        else ns.setHours(s0.getHours(), s0.getMinutes(), 0, 0);
        start = ns.toISOString();
        end = new Date(ns.getTime() + dur).toISOString();
        value = write.date(start, end, true);
      }
      if (start === e.start && end === e.end) return;
      const prev = { start: e.start, end: e.end };
      patch(e.id, { start, end });
      try {
        const schema = await api.db.getSchema({ id: prefs.eventsDb });
        const date = schema.properties.find((p) => p.type === "date");
        if (!date) throw new Error("The Events calendar has no date property");
        await api.db.rowsUpdate({ updates: [{ id: rowId, values: { [date.id]: value } }] });
        const label = e.allDay ? parseDay(start).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : `${new Date(start).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} · ${formatTime(start)}`;
        notify.undo(`Moved “${e.title}” to ${label}`, async () => {
          const back = e.allDay ? (daysOf(e).length > 1 ? write.date(prev.start.slice(0, 10), prev.end.slice(0, 10)) : write.date(prev.start.slice(0, 10))) : write.date(prev.start, prev.end, true);
          patch(e.id, prev);
          await api.db.rowsUpdate({ updates: [{ id: rowId, values: { [date.id]: back } }] });
          void reload();
        });
        void reload();
      } catch (err) {
        patch(e.id, prev);
        notify.fromError(err, "Couldn’t move the event");
      }
    },
    [prefs.eventsDb, patch, reload],
  );
  const drag = useEventDrag(canDrag, (e, t) => void moveEvent(e, t));

  // Source list for the rail
  const sources = useMemo(() => {
    const list: { key: string; label: string; color: string }[] = [];
    for (const c of google.cals.filter((x) => x.selected)) list.push({ key: `google:${c.id}`, label: c.summary, color: c.color });
    const seen = new Set(list.map((l) => l.key));
    for (const e of events ?? []) {
      const k = sourceKey(e);
      if (seen.has(k)) continue;
      seen.add(k);
      list.push({ key: k, label: calName(e), color: e.color });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [google.cals, events, prefs.eventsDb]);

  // Period steps slide with direction (±24px); a view switch is lateral by tab order (±16px) with a slight scale.
  const slide: Pick<HTMLMotionProps<"div">, "initial" | "animate" | "exit"> = reduced
    ? { initial: { opacity: 0 }, animate: { opacity: 1, transition: { duration: 0.14 } }, exit: { opacity: 0, transition: { duration: 0.1 } } }
    : {
        initial: { opacity: 0, x: dir * 24, scale: dir ? 1 : 0.992 },
        animate: { opacity: 1, x: 0, scale: 1, transition: { x: spring.glide, scale: spring.glide, opacity: { duration: 0.18, ease: [0.2, 0, 0, 1] } } },
        exit: { opacity: 0, x: -dir * 24, transition: { duration: 0.12, ease: [0.4, 0, 1, 1] } },
      };
  const VIEWS: View[] = ["month", "week", "agenda"];
  const switchView = (v: View) => {
    setDir(Math.sign(VIEWS.indexOf(v) - VIEWS.indexOf(view)));
    setView(v);
  };
  const eventCount = visible.filter((e) => daysOf(e).some((d) => d >= dayOf(from) && d <= dayOf(to))).length;

  return (
    <div className="cal-page">
      <header className="cal-head">
        <div className="flex min-w-0 items-center gap-3">
          <div className="cal-title-wrap">
            <AnimatePresence mode="popLayout" initial={false}>
              <m.h1
                key={title}
                className="cal-title tabular"
                initial={reduced ? { opacity: 0 } : { opacity: 0, y: dir ? dir * 10 : 6, filter: "blur(3px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)", transition: reduced ? { duration: 0.14 } : spring.glide }}
                exit={reduced ? { opacity: 0, transition: { duration: 0.1 } } : { opacity: 0, y: dir ? -dir * 10 : -6, filter: "blur(3px)", transition: { duration: 0.12, ease: [0.4, 0, 1, 1] } }}
              >
                {title}
              </m.h1>
            </AnimatePresence>
          </div>
          <span className="cal-count" aria-live="polite">
            <RollingNumber value={events ? eventCount : 0} /> {eventCount === 1 ? "event" : "events"}
          </span>
          <div className="cal-nav">
            <IconButton icon={ChevronLeft} label="Previous" size="sm" onClick={() => step(-1)} />
            <Button size="sm" variant="ghost" onClick={() => { setDir(0); setCursor(new Date()); }}>Today</Button>
            <IconButton icon={ChevronRight} label="Next" size="sm" onClick={() => step(1)} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Segmented<View> size="sm" value={view} onValueChange={switchView} options={[{ value: "month", label: "Month" }, { value: "week", label: "Week" }, { value: "agenda", label: "Agenda" }]} aria-label="View" />
          <Menu>
            <MenuTrigger asChild>
              <IconButton icon={Ellipsis} label="Calendar menu" size="sm" />
            </MenuTrigger>
            <MenuContent align="end" width={220}>
              <MenuItem icon={Upload} onSelect={() => void importIcs()}>Import .ics…</MenuItem>
              <MenuItem icon={Download} onSelect={() => void exportIcs()}>Export events (.ics)…</MenuItem>
              <MenuSeparator />
              <MenuItem icon={Link2} onSelect={() => setSetupOpen(true)}>{google.connected ? "Google settings…" : "Connect Google Calendar…"}</MenuItem>
            </MenuContent>
          </Menu>
          <Button size="sm" variant="primary" icon={CalendarPlus} onClick={() => startNew(view === "month" && dayOf(cursor).slice(0, 7) !== today.slice(0, 7) ? dayOf(cursor) : today, "10:00")}>
            New event
          </Button>
        </div>
      </header>
      <div className="cal-body">
        <DragCtx.Provider value={drag.api}>
        <div className="cal-main" data-dragging={drag.state ? "" : undefined}>
          <AnimatePresence mode="popLayout" initial={false} custom={dir}>
            <m.div key={`${view}-${dayOf(from)}`} {...slide} className="h-full">
              {view === "month" ? (
                <MonthView days={days} cursor={cursor} today={today} byDay={byDay} loading={!events} onDay={(d) => startNew(d)} onOpen={(e, el) => setOpen({ e, el })} onMore={(d) => { setDir(1); setCursor(parseDay(d)); setView("week"); }} />
              ) : view === "week" ? (
                <WeekView days={days} today={today} byDay={byDay} onSlot={(d, t) => startNew(d, t)} onOpen={(e, el) => setOpen({ e, el })} />
              ) : (
                <AgendaView days={days} today={today} byDay={byDay} loading={!events} onOpen={(e, el) => setOpen({ e, el })} calName={calName} />
              )}
            </m.div>
          </AnimatePresence>
        </div>
        </DragCtx.Provider>
        {drag.state ? <DragGhost st={drag.state} x={drag.x} y={drag.y} /> : null}
        <aside className="cal-rail" aria-label="Calendars">
          <MiniCalendar value={cursor} onSelect={(d) => { setDir(d > cursor ? 1 : -1); setCursor(d); }} month={cursor} onMonthChange={(d) => setCursor(d)} />
          <div className="mt-5 flex flex-col gap-1">
            <span className="cal-rail-label">Calendars</span>
            {sources.map((s) => (
              <button
                key={s.key}
                type="button"
                role="checkbox"
                aria-checked={!hidden.has(s.key)}
                className="cal-src w-full text-left"
                onClick={() => savePrefs({ ...prefs, hidden: hidden.has(s.key) ? (prefs.hidden ?? []).filter((k) => k !== s.key) : [...(prefs.hidden ?? []), s.key] })}
              >
                <span className={cn("cal-src-box", hidden.has(s.key) && "is-off")} style={{ ["--c" as string]: `var(--block-${s.color}-text, var(--accent-solid))` }}>
                  {!hidden.has(s.key) ? <Check size={11} strokeWidth={3.2} aria-hidden /> : null}
                </span>
                <span className="min-w-0 flex-1 truncate">{s.label}</span>
              </button>
            ))}
            {!sources.length ? <p className="text-caption text-tertiary">No calendars yet.</p> : null}
          </div>
          <div className="cal-google">
            {google.connected ? (
              <>
                <div className="flex items-center gap-2">
                  <span className="ig-g" style={{ width: 22, height: 22, fontSize: 11, borderRadius: 6 }} aria-hidden>G</span>
                  <span className="min-w-0 flex-1 truncate text-caption text-secondary">{google.email}</span>
                </div>
                <Button size="xs" variant="ghost" icon={RefreshCw} loading={syncing} onClick={syncNow}>Sync now</Button>
              </>
            ) : (
              <>
                <p className="text-caption text-secondary">See your Google Calendar here — read-only, cached on this device.</p>
                <Button size="sm" variant="secondary" onClick={() => setSetupOpen(true)}>Connect Google</Button>
              </>
            )}
          </div>
        </aside>
      </div>
      <Popover open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        {open ? <PopoverAnchor virtualRef={{ current: open.el }} /> : null}
        <PopoverContent side="right" align="start" className="w-[320px]">
          {open ? <EventDetails e={open.e} calName={calName(open.e)} onClose={() => setOpen(null)} onDelete={open.e.calendarId === prefs.eventsDb ? () => void deleteEvent(open.e) : undefined} /> : null}
        </PopoverContent>
      </Popover>
      <NewEventDialog open={newOpen} onOpenChange={setNewOpen} draft={draft} setDraft={setDraft} onSave={save} hasLifeOs={!!lifeos} />
      <GoogleSetupSheet open={setupOpen} onOpenChange={setSetupOpen} feature="calendar" />
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── views

/** "9:30", "14" / "2p" — compact enough for 96px cells. */
function shortTime(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours();
  const mm = d.getMinutes();
  const twelve = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hour12 !== false;
  if (!twelve) return `${h}${mm ? `:${String(mm).padStart(2, "0")}` : ""}`;
  const hh = ((h + 11) % 12) + 1;
  return `${hh}${mm ? `:${String(mm).padStart(2, "0")}` : ""}${h < 12 ? "a" : "p"}`;
}

function Chip({ e, onOpen, continued, day, mode = "month" }: { e: CalendarEvent; onOpen: (e: CalendarEvent, el: HTMLElement) => void; continued?: boolean; day: string; mode?: "month" | "week" }) {
  const drag = useDrag();
  const key = `${e.id}@${day}`;
  const can = !!drag?.canDrag(e) && !continued;
  return (
    <button
      type="button"
      className={cn("cal-chip", e.allDay ? "is-allday" : "is-timed", continued && "is-cont")}
      style={chipStyle(e.color)}
      data-draggable={can ? "" : undefined}
      data-dragging={drag?.dragging === key ? "" : undefined}
      data-landed={drag?.landed === e.id ? "" : undefined}
      onPointerDown={can ? (ev) => drag?.start(ev, e, key, mode, day) : undefined}
      onClick={(ev) => {
        ev.stopPropagation();
        if (drag?.consumeClick()) return;
        onOpen(e, ev.currentTarget);
      }}
      title={e.title}
    >
      {!e.allDay ? <span className="cal-chip-dot" /> : null}
      {!e.allDay ? <span className="cal-chip-time tabular">{shortTime(e.start)}</span> : null}
      <span className="truncate">{e.title}</span>
    </button>
  );
}

function MonthView({ days, cursor, today, byDay, loading, onDay, onOpen, onMore }: { days: Date[]; cursor: Date; today: string; byDay: Map<string, CalendarEvent[]>; loading: boolean; onDay: (d: string) => void; onOpen: (e: CalendarEvent, el: HTMLElement) => void; onMore: (d: string) => void }) {
  const month = cursor.getMonth();
  const MAX = 3;
  const drag = useDrag();
  return (
    <div className="cal-month" role="grid" aria-label="Month">
      <div className="cal-dow" role="row">
        {days.slice(0, 7).map((d) => (
          <span key={d.getDay()} role="columnheader">{d.toLocaleDateString(undefined, { weekday: "short" })}</span>
        ))}
      </div>
      <div className="cal-cells">
        {days.map((d) => {
          const key = dayOf(d);
          const list = byDay.get(key) ?? [];
          const out = d.getMonth() !== month;
          const isToday = key === today;
          return (
            <div key={key} role="gridcell" data-day={key} data-over={drag?.over === key ? "" : undefined} className={cn("cal-cell", out && "is-out", isToday && "is-today", (d.getDay() === 0 || d.getDay() === 6) && "is-weekend")} onDoubleClick={() => onDay(key)} aria-label={d.toDateString()}>
              <div className="cal-cell-head">
                <span className={cn("cal-daynum tabular", isToday && "is-today")}>{d.getDate() === 1 ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : d.getDate()}</span>
                <button type="button" className="cal-add" aria-label={`New event on ${d.toDateString()}`} onClick={() => onDay(key)}>+</button>
              </div>
              <div className="cal-cell-list">
                {loading ? null : list.slice(0, MAX).map((e) => <Chip key={`${e.id}-${key}`} e={e} day={key} onOpen={onOpen} continued={e.allDay && e.start.slice(0, 10) < key} />)}
                {list.length > MAX ? (
                  <button type="button" className="cal-more" onClick={() => onMore(key)}>
                    +{list.length - MAX} more
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const H0 = 0;
const H1 = 24;
const HPX = 48;

function lanes(list: CalendarEvent[]): { e: CalendarEvent; lane: number; lanes: number }[] {
  const sorted = [...list].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const out: { e: CalendarEvent; lane: number; lanes: number }[] = [];
  let cluster: typeof out = [];
  let ends: number[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    for (const c of cluster) c.lanes = Math.max(1, ends.length);
    out.push(...cluster);
    cluster = [];
    ends = [];
  };
  for (const e of sorted) {
    const s = Date.parse(e.start);
    const en = Math.max(Date.parse(e.end), s + 20 * 60_000);
    if (s >= clusterEnd) flush();
    let l = ends.findIndex((x) => x <= s);
    if (l < 0) {
      l = ends.length;
      ends.push(en);
    } else ends[l] = en;
    cluster.push({ e, lane: l, lanes: 1 });
    clusterEnd = Math.max(clusterEnd, en);
  }
  flush();
  return out;
}

function WeekView({ days, today, byDay, onSlot, onOpen }: { days: Date[]; today: string; byDay: Map<string, CalendarEvent[]>; onSlot: (d: string, t: string) => void; onOpen: (e: CalendarEvent, el: HTMLElement) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useDrag();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const h = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(h);
  }, []);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = 7.5 * HPX;
  }, []);
  const minutes = (iso: string) => {
    const d = new Date(iso);
    return d.getHours() * 60 + d.getMinutes();
  };
  return (
    <div className="cal-week">
      <div className="cal-week-head">
        <span />
        {days.map((d) => {
          const k = dayOf(d);
          return (
            <div key={k} className={cn("cal-week-day", k === today && "is-today")}>
              <span className="text-caption text-tertiary">{d.toLocaleDateString(undefined, { weekday: "short" })}</span>
              <span className={cn("cal-daynum tabular", k === today && "is-today")}>{d.getDate()}</span>
            </div>
          );
        })}
      </div>
      <div className="cal-week-allday">
        <span className="text-[11px] text-tertiary">All day</span>
        {days.map((d) => {
          const k = dayOf(d);
          return (
            <div key={k} className="cal-week-allday-cell flex min-w-0 flex-col gap-0.5" data-day={k} data-over={drag?.over === k ? "" : undefined}>
              {(byDay.get(k) ?? []).filter((e) => e.allDay).slice(0, 3).map((e) => <Chip key={e.id} e={e} day={k} onOpen={onOpen} continued={e.start.slice(0, 10) < k} />)}
            </div>
          );
        })}
      </div>
      <div ref={ref} className="cal-week-scroll">
        <div className="cal-week-grid" style={{ height: (H1 - H0) * HPX }}>
          <div className="cal-hours">
            {Array.from({ length: H1 - H0 }, (_, i) => (
              <span key={i} style={{ top: i * HPX }}>{i === 0 ? "" : new Date(2026, 0, 1, H0 + i).toLocaleTimeString(undefined, { hour: "numeric" })}</span>
            ))}
          </div>
          {days.map((d) => {
            const k = dayOf(d);
            const timed = lanes((byDay.get(k) ?? []).filter((e) => !e.allDay && dayOf(new Date(e.start)) === k));
            return (
              <div
                key={k}
                data-day={k}
                data-col=""
                data-over={drag?.over === k ? "" : undefined}
                className={cn("cal-col", k === today && "is-today")}
                onDoubleClick={(ev) => {
                  const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                  const mins = Math.max(0, Math.min(23 * 60 + 30, Math.round(((ev.clientY - rect.top) / HPX) * 2) * 30));
                  onSlot(k, `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`);
                }}
              >
                {timed.map(({ e, lane, lanes: n }) => {
                  const top = (minutes(e.start) / 60) * HPX;
                  const h = Math.max(20, ((minutes(e.end) - minutes(e.start) || 30) / 60) * HPX - 2);
                  const dkey = `${e.id}@${k}`;
                  const can = !!drag?.canDrag(e);
                  return (
                    <button
                      type="button"
                      key={e.id}
                      className="cal-block"
                      data-draggable={can ? "" : undefined}
                      data-dragging={drag?.dragging === dkey ? "" : undefined}
                      data-landed={drag?.landed === e.id ? "" : undefined}
                      style={{ ...chipStyle(e.color), top, height: h, left: `calc(${(lane / n) * 100}% + 2px)`, width: `calc(${100 / n}% - 4px)` }}
                      onPointerDown={can ? (ev) => drag?.start(ev, e, dkey, "week", k) : undefined}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        if (drag?.consumeClick()) return;
                        onOpen(e, ev.currentTarget);
                      }}
                    >
                      <span className="block truncate font-semibold">{e.title}</span>
                      {h > 34 ? <span className="block truncate opacity-80 tabular">{formatTime(e.start)}{e.location ? ` · ${e.location}` : ""}</span> : null}
                    </button>
                  );
                })}
                {k === today ? <div className="cal-now" style={{ top: ((now.getHours() * 60 + now.getMinutes()) / 60) * HPX }} /> : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function AgendaView({ days, today, byDay, loading, onOpen, calName }: { days: Date[]; today: string; byDay: Map<string, CalendarEvent[]>; loading: boolean; onOpen: (e: CalendarEvent, el: HTMLElement) => void; calName: (e: CalendarEvent) => string }) {
  const withEvents = days.filter((d) => (byDay.get(dayOf(d)) ?? []).length);
  if (loading) return <div className="cal-agenda"><p className="p-8 text-center text-body-sm text-tertiary">Loading…</p></div>;
  if (!withEvents.length) return <div className="cal-agenda"><p className="p-10 text-center text-body-sm text-tertiary">Nothing scheduled in the next six weeks.</p></div>;
  return (
    <div className="cal-agenda">
      {withEvents.map((d, i) => {
        const k = dayOf(d);
        return (
          <m.section key={k} className="cal-agenda-day" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0, transition: { ...spring.gentle, delay: Math.min(i, 10) * 0.02 } }}>
            <div className="cal-agenda-date">
              <span className={cn("cal-daynum tabular", k === today && "is-today")}>{d.getDate()}</span>
              <span className="text-caption text-tertiary">{d.toLocaleDateString(undefined, { weekday: "short", month: "short" })}</span>
            </div>
            <ul className="flex min-w-0 flex-1 flex-col">
              {(byDay.get(k) ?? []).map((e) => (
                <li key={`${e.id}-${k}`}>
                  <button type="button" className="cal-agenda-row" onClick={(ev) => onOpen(e, ev.currentTarget)}>
                    <span className="w-[120px] flex-none text-body-sm tabular text-secondary">{e.allDay ? "All day" : `${formatTime(e.start)} – ${formatTime(e.end)}`}</span>
                    <span className="h-2.5 w-2.5 flex-none rounded-[3px]" style={{ background: `var(--block-${e.color}-text, var(--accent-solid))` }} />
                    <span className="min-w-0 flex-1 truncate text-body-sm font-medium text-primary">{e.title}</span>
                    <span className="hidden truncate text-caption text-tertiary md:block">{e.location ?? calName(e)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </m.section>
        );
      })}
    </div>
  );
}

