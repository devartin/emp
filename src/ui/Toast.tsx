import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { animate, AnimatePresence, m, useMotionValue, type PanInfo } from "motion/react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { spring } from "./motion/tokens";
import { useReducedMotionPref } from "./motion/useReducedEffects";

/* ───────────────────────── store ───────────────────────── */

export type ToastType = "info" | "success" | "warning" | "error";
export interface ToastAction {
  label: string;
  onClick: () => void;
}
export interface ToastOptions {
  id?: string;
  type?: ToastType;
  title: ReactNode;
  description?: ReactNode;
  action?: ToastAction;
  /** ms; defaults by type (§5.7). Infinity = sticky. */
  duration?: number;
  icon?: ReactNode;
  onDismiss?: () => void;
}
interface ToastRecord extends Required<Pick<ToastOptions, "id" | "type" | "title">> {
  description?: ReactNode;
  action?: ToastAction;
  duration: number;
  icon?: ReactNode;
  onDismiss?: () => void;
  createdAt: number;
  /** bump to restart the timer when updated in place */
  version: number;
}

const DURATION: Record<ToastType, number> = { info: 4000, success: 3000, warning: 6000, error: 8000 };
let toasts: ToastRecord[] = [];
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());
let seq = 0;

function upsert(o: ToastOptions): string {
  const type = o.type ?? "info";
  const base = o.duration ?? DURATION[type];
  const duration = o.action ? Math.max(6000, base) : base;
  const id = o.id ?? `t${++seq}`;
  const existing = toasts.find((t) => t.id === id);
  const rec: ToastRecord = {
    id,
    type,
    title: o.title,
    description: o.description,
    action: o.action,
    duration,
    icon: o.icon,
    onDismiss: o.onDismiss,
    createdAt: existing?.createdAt ?? Date.now(),
    version: (existing?.version ?? 0) + 1,
  };
  toasts = existing ? toasts.map((t) => (t.id === id ? rec : t)) : [...toasts, rec];
  emit();
  return id;
}

function dismiss(id?: string) {
  const gone = id ? toasts.filter((t) => t.id === id) : toasts;
  toasts = id ? toasts.filter((t) => t.id !== id) : [];
  gone.forEach((t) => t.onDismiss?.());
  emit();
}

/**
 * Imperative toast API.
 *   toast("Saved")                         toast.success("Imported 240 rows")
 *   toast.error("Couldn't sync", { description })   toast({ title: "Page deleted", action: { label: "Undo", onClick } })
 *   toast.clipboard(30, () => clearClipboard())     toast.dismiss(id)
 */
export function toast(o: ToastOptions | string, extra?: Partial<ToastOptions>): string {
  return upsert(typeof o === "string" ? { title: o, ...extra } : o);
}
toast.info = (title: ReactNode, o: Partial<ToastOptions> = {}) => upsert({ ...o, title, type: "info" });
toast.success = (title: ReactNode, o: Partial<ToastOptions> = {}) => upsert({ ...o, title, type: "success" });
toast.warning = (title: ReactNode, o: Partial<ToastOptions> = {}) => upsert({ ...o, title, type: "warning" });
toast.error = (title: ReactNode, o: Partial<ToastOptions> = {}) => upsert({ ...o, title, type: "error" });
toast.dismiss = dismiss;
/** "Clipboard clears in 30s" with a live countdown and a "Clear now" action (§5.7). */
toast.clipboard = (seconds: number, clear: () => void) => {
  const id = "clipboard";
  upsert({
    id,
    type: "info",
    title: <ClipboardCountdown seconds={seconds} onDone={() => dismiss(id)} />,
    duration: seconds * 1000 + 400,
    action: {
      label: "Clear now",
      onClick: () => {
        clear();
        dismiss(id);
      },
    },
  });
  return id;
};

function ClipboardCountdown({ seconds, onDone }: { seconds: number; onDone: () => void }) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    const end = Date.now() + seconds * 1000;
    const iv = window.setInterval(() => {
      const s = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) {
        window.clearInterval(iv);
        onDone();
      }
    }, 250);
    return () => window.clearInterval(iv);
  }, [seconds, onDone]);
  return (
    <span>
      Clipboard clears in <span className="tabular">{left}s</span>
    </span>
  );
}

function useToasts() {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => toasts,
    () => toasts,
  );
}

/* ───────────────────────── view ───────────────────────── */

const ICONS: Record<ToastType, ReactNode> = {
  info: <Info aria-hidden />,
  success: <CheckCircle2 aria-hidden />,
  warning: <AlertTriangle aria-hidden />,
  error: <AlertCircle aria-hidden />,
};
const MAX_VISIBLE = 3;
const GAP = 8;

/**
 * Toaster (§5.7, §4.2): bottom-right stack (bottom-centre < 900px), max 3 visible. Cards behind the newest sit at
 * y −8n, scale 1−0.05n, opacity 1−0.2n; hovering expands the stack with 8px gaps. Timers pause on hover, focus-within
 * and window blur. Swipe right to dismiss (45% width or 0.11px/ms). ⌘⇧. focuses the newest toast.
 */
export function Toaster() {
  const list = useToasts();
  const [expanded, setExpanded] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [windowBlur, setWindowBlur] = useState(false);
  const heights = useRef(new Map<string, number>());
  const [, force] = useState(0);
  const root = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const onBlur = () => setWindowBlur(true);
    const onFocus = () => setWindowBlur(false);
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "." || e.code === "Period")) {
        const items = root.current?.querySelectorAll<HTMLElement>(".emp-toast");
        const newest = items?.[items.length - 1];
        if (newest) {
          e.preventDefault();
          newest.focus();
        }
      }
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    if (list.length === 0) setExpanded(false);
  }, [list.length]);

  const visible = list.slice(-MAX_VISIBLE);
  const paused = expanded || focusWithin || windowBlur;
  // newest last → index from newest = n
  const ordered = [...visible].reverse();
  let offset = 0;
  const offsets = ordered.map((t) => {
    const o = offset;
    offset += (heights.current.get(t.id) ?? 64) + GAP;
    return o;
  });
  const frontHeight = heights.current.get(ordered[0]?.id ?? "") ?? 64;

  return (
    <section aria-label="Notifications" aria-live="polite">
      <ol
        ref={root}
        className="emp-toaster"
        style={{ height: expanded ? Math.max(offset - GAP, 0) : frontHeight + Math.min(visible.length - 1, 2) * 8, listStyle: "none", margin: 0, padding: 0 }}
        onMouseEnter={() => setExpanded(true)}
        onMouseLeave={() => setExpanded(false)}
        onFocus={() => setFocusWithin(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setFocusWithin(false);
        }}
      >
        <AnimatePresence initial={false}>
          {ordered.map((t, n) => (
            <ToastCard
              key={t.id}
              t={t}
              n={n}
              expanded={expanded}
              offsetY={offsets[n]}
              frontHeight={frontHeight}
              paused={paused}
              onHeight={(h) => {
                if (heights.current.get(t.id) !== h) {
                  heights.current.set(t.id, h);
                  force((x) => x + 1);
                }
              }}
            />
          ))}
        </AnimatePresence>
      </ol>
    </section>
  );
}

function ToastCard({
  t,
  n,
  expanded,
  offsetY,
  frontHeight,
  paused,
  onHeight,
}: {
  t: ToastRecord;
  n: number;
  expanded: boolean;
  offsetY: number;
  frontHeight: number;
  paused: boolean;
  onHeight: (h: number) => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const reduced = useReducedMotionPref();
  const progress = useMotionValue(1);
  const remaining = useRef(t.duration);
  const startedAt = useRef(Date.now());

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => onHeight(el.offsetHeight));
    ro.observe(el);
    onHeight(el.offsetHeight);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    remaining.current = t.duration;
    progress.set(1);
  }, [t.version, t.duration, progress]);

  // Auto-dismiss timer with pause/resume.
  useEffect(() => {
    if (!Number.isFinite(t.duration)) return;
    if (paused) return;
    startedAt.current = Date.now();
    const id = window.setTimeout(() => dismiss(t.id), remaining.current);
    const bar = animate(progress, 0, { duration: remaining.current / 1000, ease: "linear" });
    return () => {
      window.clearTimeout(id);
      bar.stop();
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current));
    };
  }, [paused, t.id, t.duration, t.version]);

  // Collapsed: cards behind are clipped to the front card's height so the stack looks even.
  const collapsedY = -8 * n;
  const y = expanded ? -offsetY : collapsedY;
  const scale = expanded ? 1 : 1 - 0.05 * n;
  const opacity = n >= MAX_VISIBLE ? 0 : expanded ? 1 : 1 - 0.2 * n;
  const hiddenBehind = !expanded && n > 0;

  const onDragEnd = (_: unknown, info: PanInfo) => {
    const w = ref.current?.offsetWidth ?? 360;
    const velocity = info.velocity.x / 1000; // px/ms
    if (info.offset.x > w * 0.45 || velocity > 0.11) dismiss(t.id);
  };

  return (
    <m.li
      ref={ref}
      layout={false}
      className="emp-toast"
      data-type={t.type}
      role={t.type === "error" ? "alert" : "status"}
      aria-atomic="true"
      tabIndex={0}
      style={{ zIndex: 10 - n, height: hiddenBehind ? frontHeight : undefined }}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.96 }}
      animate={{ opacity, y, scale, transition: spring.ui }}
      exit={reduced ? { opacity: 0, transition: { duration: 0.12 } } : { opacity: 0, x: 24, transition: { duration: 0.16, ease: [0.4, 0, 1, 1] } }}
      drag={reduced ? false : "x"}
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={{ left: 0.05, right: 0.9 }}
      dragTransition={{ bounceStiffness: 300, bounceDamping: 28 }}
      onDragEnd={onDragEnd}
      onKeyDown={(e) => {
        if (e.key === "Escape") dismiss(t.id);
      }}
    >
      <span className="emp-toast-icon" style={{ opacity: hiddenBehind ? 0 : 1 }}>
        {t.icon ?? ICONS[t.type]}
      </span>
      <div className="emp-toast-body" style={{ opacity: hiddenBehind ? 0 : 1 }}>
        <div className="emp-toast-title">{t.title}</div>
        {t.description ? <div className="emp-toast-desc">{t.description}</div> : null}
      </div>
      <div className="emp-toast-actions" style={{ opacity: hiddenBehind ? 0 : 1 }}>
        {t.action ? (
          <Button
            size="sm"
            variant="ghost"
            className="text-primary"
            onClick={() => {
              t.action?.onClick();
              dismiss(t.id);
            }}
          >
            {t.action.label}
          </Button>
        ) : null}
        <IconButton icon={X} label="Dismiss" size="xs" noTooltip onClick={() => dismiss(t.id)} />
      </div>
      {t.action && Number.isFinite(t.duration) ? (
        <m.span className="emp-toast-progress" style={{ scaleX: progress }} />
      ) : null}
    </m.li>
  );
}
