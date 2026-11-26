/**
 * Home (§6.4): greeting + date, then a customisable 12-column widget grid — Today (events, tasks due, habit strip),
 * Money snapshot, Watchlist, Recent pages, Suggestions and Quick actions. "Customize home" reveals the dotted grid,
 * drag handles (dnd-kit, `spring.layout`), width presets and hide/show; the layout persists in kv `ui.home.layout`.
 */
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, rectSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Check, Eye, EyeOff, GripVertical, LayoutGrid, RotateCcw } from "lucide-react";
import { AnimatePresence, m, PresenceContext } from "motion/react";
import { useEffect, useMemo, useState, type ComponentType } from "react";
import { api } from "@/backend";
import { cn } from "@/lib/cn";
import { useSettings } from "@/stores/settings";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { Segmented } from "@/ui/Segmented";
import { EdgeLight } from "@/ui/motion/EdgeLight";
import { ease, spring } from "@/ui/motion/tokens";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { useStableNow } from "@/features/lifeapps/data";
import { WizardSheet } from "@/features/lifeapps/WizardSheet";
import { MoneyWidget } from "./widgets/Money";
import { QuickActionsWidget } from "./widgets/QuickActions";
import { RecentWidget } from "./widgets/Recent";
import { SuggestionsWidget } from "./widgets/Suggestions";
import { TodayWidget } from "./widgets/Today";
import { WatchlistWidget } from "./widgets/Watchlist";
import "@/features/lifeapps/lifeapps.css";
import "./home.css";

type Span = 4 | 5 | 6 | 7 | 8 | 12;
interface Slot {
  id: string;
  span: Span;
  hidden?: boolean;
}

const WIDGETS: Record<string, { title: string; C: ComponentType; bare?: boolean }> = {
  quick: { title: "Quick actions", C: QuickActionsWidget, bare: true },
  today: { title: "Today", C: TodayWidget },
  suggestions: { title: "Suggestions", C: SuggestionsWidget },
  money: { title: "Money", C: MoneyWidget },
  watchlist: { title: "Watchlist", C: WatchlistWidget },
  recent: { title: "Recent pages", C: RecentWidget },
};

const DEFAULT: Slot[] = [
  { id: "quick", span: 12 },
  { id: "today", span: 7 },
  { id: "suggestions", span: 5 },
  { id: "money", span: 12 },
  { id: "recent", span: 7 },
  { id: "watchlist", span: 5 },
];

const SIZES: { value: string; label: string }[] = [
  { value: "4", label: "S" },
  { value: "6", label: "M" },
  { value: "8", label: "L" },
  { value: "12", label: "Full" },
];

function greeting(h: number) {
  if (h < 5) return "Good evening";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function sanitize(v: unknown): Slot[] | null {
  if (!Array.isArray(v)) return null;
  const out: Slot[] = [];
  for (const x of v) {
    if (!x || typeof x !== "object") continue;
    const s = x as Partial<Slot>;
    if (typeof s.id !== "string" || !WIDGETS[s.id] || out.some((o) => o.id === s.id)) continue;
    const span = [4, 5, 6, 7, 8, 12].includes(Number(s.span)) ? (Number(s.span) as Span) : 6;
    out.push({ id: s.id, span, hidden: !!s.hidden });
  }
  for (const d of DEFAULT) if (!out.some((o) => o.id === d.id)) out.push(d);
  return out;
}

/** Arrival (S19): the greeting rises first, then widgets cascade at 40ms (cap 8) on the settle spring. */
const ARRIVAL_DELAY = 0.14;
let arrivedThisSession = false;

function Widget({ slot, editing, onSpan, onHide, index, arrive }: { slot: Slot; editing: boolean; onSpan: (s: Span) => void; onHide: () => void; index: number; arrive: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: slot.id, disabled: !editing, transition: { duration: 380, easing: "var(--spring-morph)" } });
  const reduced = useReducedMotionPref();
  const def = WIDGETS[slot.id];
  const C = def.C;
  const bare = def.bare && !editing;
  const delay = ARRIVAL_DELAY + Math.min(index, 7) * 0.04;
  return (
    <m.section
      ref={setNodeRef}
      layout={reduced ? false : "position"}
      transition={spring.morph}
      initial={arrive ? (reduced ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.985 }) : false}
      animate={{ opacity: 1, y: 0, scale: 1, transition: reduced ? { duration: 0.14, delay: Math.min(index, 7) * 0.02 } : { ...spring.settle, delay, opacity: { duration: 0.26, ease: ease.out, delay } } }}
      className={cn("hm-slot", isDragging && "is-dragging")}
      style={{ gridColumn: `span ${slot.span} / span ${slot.span}`, transform: CSS.Translate.toString(transform), transition }}
      aria-label={def.title}
    >
      <div className={cn("hm-widget", bare ? "is-bare" : "panel", editing && "is-editing")} data-light={bare ? undefined : ""}>
      {bare ? null : <EdgeLight />}
      {editing ? (
        <div className="hm-edit-bar">
          <button type="button" className="hm-grip" {...attributes} {...listeners} aria-label={`Move ${def.title}`}>
            <GripVertical size={14} aria-hidden />
          </button>
          <span className="flex-1 truncate text-caption font-semibold text-secondary">{def.title}</span>
          <Segmented size="sm" value={String([4, 6, 8, 12].includes(slot.span) ? slot.span : slot.span < 6 ? 4 : 8)} onValueChange={(v) => onSpan(Number(v) as Span)} options={SIZES} aria-label="Width" />
          <IconButton size="xs" icon={EyeOff} label={`Hide ${def.title}`} onClick={onHide} />
        </div>
      ) : null}
      <div className={cn("hm-widget-body", editing && "pointer-events-none select-none")}>
        <C />
      </div>
      </div>
    </m.section>
  );
}

/** The greeting moment: each word rises out of a soft blur, 50ms apart; the date follows. */
function Greeting({ text, date }: { text: string; date: string }) {
  const reduced = useReducedMotionPref();
  const [arrive] = useState(() => !arrivedThisSession);
  // Once every word has landed the greeting renders plain spans: no motion values, no resting filter/transform and
  // no compositor layers left on the text (it rasterises crisply).
  const [landed, setLanded] = useState(!arrive);
  const words = text.split(" ");
  return (
    <div className="hm-greeting">
      <h1 className="hm-hello" aria-label={text}>
        {words.map((w, i) => [
          i > 0 ? " " : null,
          landed ? (
            <span key={`${i}-${w}`} aria-hidden className="hm-word">
              {w}
            </span>
          ) : (
            <m.span
              key={`${i}-${w}`}
              aria-hidden
              className="hm-word"
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: "0.42em", filter: "blur(6px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)", transition: reduced ? { duration: 0.14 } : { ...spring.settle, delay: i * 0.05, opacity: { duration: 0.3, ease: ease.out, delay: i * 0.05 }, filter: { duration: 0.32, ease: ease.out, delay: i * 0.05 } } }}
              onAnimationComplete={i === words.length - 1 ? () => setLanded(true) : undefined}
            >
              {w}
            </m.span>
          ),
        ])}
      </h1>
      <m.p
        className="hm-date"
        initial={arrive ? { opacity: 0, y: reduced ? 0 : 4 } : false}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.32, ease: ease.out, delay: reduced ? 0 : 0.1 + words.length * 0.05 } }}
      >
        {date}
      </m.p>
    </div>
  );
}

export default function HomePage() {
  const name = useSettings((s) => s.vault?.profileName?.trim());
  const now = useStableNow(60_000);
  const [layout, setLayout] = useState<Slot[]>(DEFAULT);
  const [editing, setEditing] = useState(false);
  const [arrive] = useState(() => !arrivedThisSession);
  useEffect(() => {
    arrivedThisSession = true;
  }, []);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  useEffect(() => {
    api.kv
      .get({ ns: "ui.home", key: "layout" })
      .then((v) => {
        const s = sanitize(v);
        if (s) setLayout(s);
      })
      .catch(() => undefined);
  }, []);
  const save = (next: Slot[]) => {
    setLayout(next);
    void api.kv.set({ ns: "ui.home", key: "layout", value: next }).catch(() => undefined);
  };
  const visible = useMemo(() => layout.filter((s) => !s.hidden), [layout]);
  const hidden = layout.filter((s) => s.hidden);

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = layout.findIndex((s) => s.id === e.active.id);
    const to = layout.findIndex((s) => s.id === e.over!.id);
    save(arrayMove(layout, from, to));
  };

  // The route outlet's AnimatePresence starts with initial={false}, which would also suppress the S19 arrival of
  // everything inside Home on first load. Home owns its arrival (once per session), so it opts out of that context.
  return (
    <PresenceContext.Provider value={null}>
    <div className="hm-page">
      <header className="hm-head">
        <Greeting text={`${greeting(now.getHours())}${name ? `, ${name}` : ""}`} date={now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })} />
        <div className="flex items-center gap-2">
          <AnimatePresence>
            {editing ? (
              <m.div initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }} transition={spring.ui}>
                <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => save(DEFAULT)}>
                  Reset
                </Button>
              </m.div>
            ) : null}
          </AnimatePresence>
          <Button size="sm" variant={editing ? "primary" : "ghost"} icon={editing ? Check : LayoutGrid} active={editing} onClick={() => setEditing((e) => !e)}>
            {editing ? "Done" : "Customize home"}
          </Button>
        </div>
      </header>
      <AnimatePresence>
        {editing && hidden.length ? (
          <m.div className="hm-tray well" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4, transition: { duration: 0.12 } }} transition={spring.settle}>
            <span className="text-caption text-tertiary">Hidden:</span>
            {hidden.map((s) => (
              <Button key={s.id} size="xs" variant="soft" icon={Eye} onClick={() => save(layout.map((x) => (x.id === s.id ? { ...x, hidden: false } : x)))}>
                {WIDGETS[s.id].title}
              </Button>
            ))}
          </m.div>
        ) : null}
      </AnimatePresence>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={visible.map((s) => s.id)} strategy={rectSortingStrategy}>
          <div className={cn("hm-grid", editing && "is-editing")}>
            {visible.map((s, i) => (
              <Widget key={s.id} slot={s} index={i} arrive={arrive} editing={editing} onSpan={(span) => save(layout.map((x) => (x.id === s.id ? { ...x, span } : x)))} onHide={() => save(layout.map((x) => (x.id === s.id ? { ...x, hidden: true } : x)))} />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      <WizardSheet />
    </div>
    </PresenceContext.Provider>
  );
}
