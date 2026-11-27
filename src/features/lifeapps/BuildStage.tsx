/**
 * S6 — "Life-app install builds the workspace" (docs/DESIGN.md §7). A glass-3 veil covers the content area and the
 * plan builds itself in front of the user: the app tile flies in from the wizard header, then every plan item drops in
 * as a wireframe slab (`settle`) and fills with its real content (crossfade). Cadence is 90ms per item, capped at
 * 2.4s, and the reveal can never run ahead of the real install progress. The progress groove is driven by real
 * progress events. On finish the tile pops a check with the mini-slab burst, an edge-light sweep crosses the header,
 * and the stage hands off to the app page (handoff.ts) — the veil lifts off the new hub and the tile lands in its
 * header. Skippable at any time; under reduced motion everything crossfades in place.
 */
import { Bell, Database, Eye, FileText, LayoutDashboard, Repeat, Sheet as SheetIcon, Target, Wand2 } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { GenerationPlanItem } from "@/backend/types";
import { Button } from "@/ui/Button";
import { celebrate } from "@/ui/motion/Celebrate";
import { RollingNumber } from "@/ui/motion/RollingNumber";
import { spring } from "@/ui/motion/tokens";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { AppTile } from "./AppTile";
import { appVars } from "./identity";

const KIND: Record<GenerationPlanItem["kind"], { label: string; plural: string; icon: typeof FileText }> = {
  dashboard: { label: "Dashboard", plural: "dashboards", icon: LayoutDashboard },
  page: { label: "Page", plural: "pages", icon: FileText },
  database: { label: "Database", plural: "databases", icon: Database },
  sheet: { label: "Spreadsheet", plural: "spreadsheets", icon: SheetIcon },
  goal: { label: "Goal", plural: "goals", icon: Target },
  view: { label: "View", plural: "views", icon: Eye },
  rule: { label: "Rule", plural: "rules", icon: Wand2 },
  recurring: { label: "Recurring", plural: "recurring items", icon: Repeat },
  reminder: { label: "Reminder", plural: "reminders", icon: Bell },
};
const ORDER: GenerationPlanItem["kind"][] = ["dashboard", "page", "database", "sheet", "goal", "view", "rule", "recurring", "reminder"];
const PRIMARY = new Set<GenerationPlanItem["kind"]>(["dashboard", "page", "database", "sheet", "goal"]);
const MAX_CARDS = 8;
const CADENCE = 90;
const CAP = 2400;
const FILL_DELAY = 420;
const HOLD = 1150;

export interface BuildStageProps {
  appId: string;
  title: string;
  items: GenerationPlanItem[];
  /** Real install progress, 0..1. */
  progress: number;
  /** Latest progress label from the backend. */
  label: string;
  /** The install job has returned. */
  done: boolean;
  error: string | null;
  /** The wizard header tile's rect when Create was pressed (the tile flies from here). */
  origin: DOMRect | null;
  /** Land in the app (the stage passes its veil rect and tile for the hand-off). */
  onLand: (stage: { rect: DOMRect; tile: HTMLElement | null }) => void;
  onBack: () => void;
}

/** The content area the stage covers (below the topbar, beside the sidebar); the window as a fallback. */
function contentRect(): DOMRect {
  const el = document.querySelector('[data-region="content"]');
  return el ? el.getBoundingClientRect() : new DOMRect(0, 0, window.innerWidth, window.innerHeight);
}

export function BuildStage({ appId, title, items, progress, label, done, error, origin, onLand, onBack }: BuildStageProps) {
  const reduced = useReducedMotionPref();
  const [rect] = useState(contentRect);
  const ordered = useMemo(() => [...items].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind)), [items]);
  const total = ordered.length;
  const [revealed, setRevealed] = useState(0);
  const [filled, setFilled] = useState(0);
  const [skip, setSkip] = useState(false);
  const [ready, setReady] = useState(false);
  const tileRef = useRef<HTMLSpanElement>(null);
  const flyRef = useRef<HTMLSpanElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const landed = useRef(false);

  // Never run ahead of the real install: the target is what the backend has actually built.
  const target = done || skip ? total : Math.min(total, Math.floor(progress * (total + 1)));
  const step = Math.max(24, Math.min(CADENCE, CAP / Math.max(1, total)));

  useEffect(() => {
    if (revealed >= target) return;
    if (reduced || skip) {
      setRevealed(target);
      return;
    }
    const h = window.setTimeout(() => setRevealed((n) => Math.min(target, n + 1)), revealed === 0 ? 380 : step);
    return () => window.clearTimeout(h);
  }, [revealed, target, step, reduced, skip]);

  useEffect(() => {
    if (filled >= revealed) return;
    const h = window.setTimeout(() => setFilled(revealed), reduced || skip ? 0 : FILL_DELAY);
    return () => window.clearTimeout(h);
  }, [revealed, filled, reduced, skip]);

  // Finish: everything built and filled → check pop + mini-slab burst + sweep, then hand off.
  useEffect(() => {
    if (!done || error || ready || filled < total) return;
    const h = window.setTimeout(() => {
      setReady(true);
      if (tileRef.current) celebrate(tileRef.current, { particles: 20, badge: false });
    }, reduced || skip ? 0 : 160);
    return () => window.clearTimeout(h);
  }, [done, error, ready, filled, total, reduced, skip]);

  const land = () => {
    if (landed.current) return;
    landed.current = true;
    onLand({ rect, tile: tileRef.current });
  };
  useEffect(() => {
    if (!ready) return;
    const h = window.setTimeout(land, skip ? 260 : HOLD);
    return () => window.clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // The tile flies in from the wizard header (FLIP on the wrapper, transform only).
  useLayoutEffect(() => {
    const el = flyRef.current;
    if (!el || !origin || reduced) return;
    const to = el.getBoundingClientRect();
    const s = origin.width / Math.max(1, to.width);
    const dx = origin.left - to.left;
    const dy = origin.top - to.top;
    const easing = getComputedStyle(document.documentElement).getPropertyValue("--spring-settle").trim() || "cubic-bezier(.16,1,.3,1)";
    el.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${s})`, transformOrigin: "0 0" }, { transform: "translate(0,0) scale(1)", transformOrigin: "0 0" }], { duration: 560, easing });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  const primary = ordered.filter((i) => PRIMARY.has(i.kind));
  const cards = primary.slice(0, MAX_CARDS);
  const more = primary.length - cards.length;
  const indexOf = new Map(ordered.map((it, k) => [it.key, k] as const));
  const secondary = ORDER.filter((k) => !PRIMARY.has(k))
    .map((k) => {
      const list = ordered.filter((i) => i.kind === k);
      const shown = list.filter((i) => (indexOf.get(i.key) ?? 0) < revealed).reduce((s, i) => s + (i.count ?? 1), 0);
      return { kind: k, shown, total: list.reduce((s, i) => s + (i.count ?? 1), 0) };
    })
    .filter((g) => g.total > 0);

  const pct = done ? 1 : Math.max(0.04, progress);
  const current = revealed > 0 ? ordered[Math.min(revealed, total) - 1] : null;
  const building = current ? `Creating ${current.title} · ${KIND[current.kind].label.toLowerCase()}` : label;
  const status = error ? "Something went wrong" : ready ? `${title} is ready` : `Building ${title}`;
  const sub = error ?? (ready ? "Everything is on this device. Taking you there…" : building || "Preparing…");

  const node = (
    <div
      ref={rootRef}
      className="la-stage"
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height, ...appVars(appId) } as CSSProperties}
      role="dialog"
      aria-modal="true"
      aria-label={status}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !error) {
          e.preventDefault();
          if (ready) land();
          else setSkip(true);
        }
      }}
    >
      <m.div className="la-stage-veil glass-3" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: reduced ? 0.12 : 0.32, ease: [0.2, 0, 0, 1] } }} />
      <div className="la-stage-inner">
        <m.header className="la-stage-head panel" initial={reduced ? { opacity: 0 } : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0, transition: { ...spring.settle, delay: 0.06 } }}>
          <span ref={flyRef} className="relative inline-flex flex-none">
            <AppTile ref={tileRef} appId={appId} size="hero" />
            <AnimatePresence>
              {ready ? (
                <m.span key="ok" className="la-stage-check" initial={reduced ? { opacity: 0 } : { scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1, transition: spring.pop }}>
                  <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden>
                    <m.path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: reduced ? 1 : 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.26, delay: 0.12, ease: [0.2, 0, 0, 1] }} />
                  </svg>
                </m.span>
              ) : null}
            </AnimatePresence>
          </span>
          <div className="min-w-0 flex-1">
            <AnimatePresence mode="wait" initial={false}>
              <m.h2 key={status} className="la-stage-title" initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0, transition: spring.settle }} exit={{ opacity: 0, y: reduced ? 0 : -6, transition: { duration: 0.12, ease: [0.4, 0, 1, 1] } }} aria-live="polite">
                {status}
              </m.h2>
            </AnimatePresence>
            <p className="la-stage-label truncate">{sub}</p>
          </div>
          {error ? (
            <Button variant="primary" onClick={onBack}>
              Back to setup
            </Button>
          ) : ready ? (
            <Button variant="primary" size="lg" onClick={land}>
              Open {title}
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setSkip(true)} kbd="esc">
              Skip
            </Button>
          )}
          <div className="la-groove" aria-hidden>
            <m.i initial={false} animate={{ scaleX: pct }} transition={reduced ? { duration: 0 } : { duration: 0.32, ease: [0.2, 0, 0, 1] }} style={{ originX: 0 }} />
          </div>
          <span className="la-sweep" data-run={ready ? "" : undefined} aria-hidden />
        </m.header>

        <ul className="la-stage-grid" aria-label="What’s being created">
          {cards.map((it) => {
            const k = indexOf.get(it.key) ?? 0;
            const shown = k < revealed;
            return <BuildCard key={it.key} item={it} shown={shown} filled={k < filled} reduced={reduced} />;
          })}
          {more > 0 ? <BuildCard item={{ key: "__more", kind: "page", title: `${more} more`, optional: false, enabled: true }} shown={revealed >= total} filled={filled >= total} reduced={reduced} more /> : null}
        </ul>

        {secondary.length ? (
          <div className="la-stage-chips" aria-label="Also created">
            {secondary.map((g) => {
              const K = KIND[g.kind];
              return (
                <m.span key={g.kind} className="la-schip" initial={false} animate={{ opacity: g.shown ? 1 : 0.35 }} transition={{ duration: 0.2 }}>
                  <K.icon size={13} aria-hidden />
                  <b>
                    <RollingNumber value={g.shown} format={(n) => String(Math.round(n))} />
                  </b>
                  {g.total === 1 ? K.label.toLowerCase() : K.plural}
                </m.span>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
  return createPortal(node, document.body);
}

function BuildCard({ item, shown, filled, reduced, more }: { item: GenerationPlanItem; shown: boolean; filled: boolean; reduced: boolean; more?: boolean }) {
  const K = KIND[item.kind];
  return (
    <m.li
      className="la-bcard"
      data-kind={more ? "more" : item.kind}
      data-filled={filled ? "" : undefined}
      initial={false}
      animate={shown ? { opacity: 1, y: 0, scale: 1 } : reduced ? { opacity: 0 } : { opacity: 0, y: -18, scale: 0.96 }}
      transition={shown ? (reduced ? { duration: 0.14 } : { ...spring.settle, opacity: { duration: 0.18 } }) : { duration: 0 }}
      aria-hidden={!shown}
    >
      <div className="la-bcard-layer la-bcard-wire" aria-hidden>
        <div className="flex items-center gap-2">
          <span className="w h-[26px] w-[26px] rounded-lg" />
          <span className="w h-2 w-2/5" />
        </div>
        <div className="mt-auto flex flex-col gap-1.5">
          <span className="w h-1.5 w-4/5" />
          <span className="w h-1.5 w-3/5" />
          <span className="w h-1.5 w-2/3" />
        </div>
      </div>
      <div className="la-bcard-layer la-bcard-real panel">
        <div className="la-bcard-top">
          <span className="la-bcard-ico">
            <K.icon size={14} aria-hidden />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="la-bcard-kind">{more ? "And" : K.label}</span>
            <span className="la-bcard-title">{item.title}</span>
          </span>
          {item.count && item.count > 1 ? <span className="la-count ml-auto">×{item.count}</span> : null}
        </div>
        <div className="la-bcard-art">{more ? <Lines n={3} /> : <KindArt kind={item.kind} />}</div>
      </div>
    </m.li>
  );
}

function Lines({ n }: { n: number }) {
  const w = ["86%", "64%", "74%", "52%"];
  return (
    <>
      {Array.from({ length: n }, (_, k) => (
        <span key={k} className={k === 0 ? "ln is-app" : "ln"} style={{ width: w[k % w.length] }} />
      ))}
    </>
  );
}

function KindArt({ kind }: { kind: GenerationPlanItem["kind"] }): ReactNode {
  switch (kind) {
    case "dashboard":
      return (
        <div className="flex items-end gap-4">
          <div className="la-bcard-dash flex-1">
            <span className="k" />
            <span className="k" />
            <span className="k" />
            <span className="k" />
          </div>
          <div className="la-bcard-bars w-[38%]">
            {[0.5, 0.78, 0.62, 0.9, 0.7, 1, 0.84].map((h, k) => (
              <span key={k} style={{ ["--h" as string]: h, ["--i" as string]: k } as CSSProperties} />
            ))}
          </div>
        </div>
      );
    case "database":
      return (
        <div className="la-bcard-table">
          {Array.from({ length: 12 }, (_, k) => (
            <span key={k} className={k < 3 ? "is-h" : k % 3 === 1 ? "is-app" : undefined} />
          ))}
        </div>
      );
    case "sheet":
      return (
        <div className="la-bcard-sheetgrid">
          {Array.from({ length: 18 }, (_, k) => (
            <span key={k} className={k < 6 ? "is-h" : k === 8 || k === 9 || k === 17 ? "is-app" : undefined} />
          ))}
        </div>
      );
    case "goal":
      return (
        <div className="flex flex-col gap-2">
          <span className="ln" style={{ width: "58%" }} />
          <div className="la-groove h-1.5">
            <i style={{ transform: "scaleX(.62)" }} />
          </div>
        </div>
      );
    default:
      return <Lines n={3} />;
  }
}
