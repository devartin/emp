/**
 * S10 "KPI → detail" (docs/DESIGN.md §7): a KPI plate morphs (shared layoutId) into a detail panel; its label and
 * number travel as shared elements on the same `morph` spring while the page behind recedes (scale .97, opacity .22).
 * Detail bars spring up with a 24ms stagger. Esc, the close key or a click outside reverses the morph.
 *
 * Plates use the individual `translate`/`scale` CSS properties for hover/press so they compose with motion's
 * projection transform instead of fighting it.
 */
import { X } from "lucide-react";
import { AnimatePresence, LayoutGroup, m } from "motion/react";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { IconButton } from "@/ui/IconButton";
import { EdgeLight } from "@/ui/motion/EdgeLight";
import { spring } from "@/ui/motion/tokens";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";

interface MorphCtx {
  open: string | null;
  setOpen: (id: string | null) => void;
}
const Ctx = createContext<MorphCtx>({ open: null, setOpen: () => undefined });

/** Wrap the page region that should recede; detail panels render inside it, above the receding content. */
export function KpiMorphStage({ children, details }: { children: ReactNode; details: (open: string, close: () => void) => ReactNode }) {
  const [open, setOpen] = useState<string | null>(null);
  const reduced = useReducedMotionPref();
  const close = useCallback(() => setOpen(null), []);
  const ctx = useMemo(() => ({ open, setOpen }), [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);
  return (
    <Ctx.Provider value={ctx}>
      <LayoutGroup id="money-kpi">
        <div className="relative">
          <m.div
            animate={open ? (reduced ? { opacity: 0.22 } : { scale: 0.97, opacity: 0.22, filter: "saturate(0.6)" }) : { scale: 1, opacity: 1, filter: "saturate(1)" }}
            transition={reduced ? { duration: 0.14 } : spring.morph}
            style={{ transformOrigin: "50% 0%", pointerEvents: open ? "none" : undefined }}
            aria-hidden={open ? true : undefined}
            inert={open ? true : undefined}
          >
            {children}
          </m.div>
          <AnimatePresence>
            {open ? (
              <m.button
                key="scrim"
                type="button"
                aria-label="Close detail"
                tabIndex={-1}
                className="absolute inset-0 z-10 cursor-default"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={close}
              />
            ) : null}
          </AnimatePresence>
          <AnimatePresence>{open ? details(open, close) : null}</AnimatePresence>
        </div>
      </LayoutGroup>
    </Ctx.Provider>
  );
}

export function useKpiMorph(): MorphCtx {
  return useContext(Ctx);
}

/** A KPI plate that can open into a detail panel. */
export function KpiMorphTile({ id, label, value, sub, visual, className }: { id: string; label: ReactNode; value: ReactNode; sub?: ReactNode; visual?: ReactNode; className?: string }) {
  const { open, setOpen } = useKpiMorph();
  const ref = useRef<HTMLButtonElement>(null);
  const [h, setH] = useState<number | null>(null);
  const wasOpen = useRef(false);
  const isOpen = open === id;
  useLayoutEffect(() => {
    if (wasOpen.current && !isOpen) {
      // return focus once the plate is back
      const t = window.setTimeout(() => ref.current?.focus({ preventScroll: true }), 30);
      wasOpen.current = false;
      return () => window.clearTimeout(t);
    }
    wasOpen.current = isOpen;
  }, [isOpen]);
  if (isOpen) return <div className={cn("fh-metric-ph", className)} style={{ height: h ?? 88 }} aria-hidden />;
  return (
    <m.button
      ref={ref}
      type="button"
      layoutId={`kpi-${id}`}
      transition={spring.morph}
      className={cn("fh-metric fh-kpi panel", className)}
      style={{ borderRadius: 14 }}
      data-light=""
      aria-haspopup="dialog"
      aria-expanded={false}
      onClick={() => {
        setH(ref.current?.offsetHeight ?? null);
        setOpen(id);
      }}
    >
      <EdgeLight specular />
      <span className="min-w-0 flex-1 text-left">
        <m.span layoutId={`kpi-${id}-label`} layout="position" transition={spring.morph} className="block text-caption text-secondary" style={{ fontWeight: 500 }}>
          {label}
        </m.span>
        <m.span layoutId={`kpi-${id}-value`} layout="position" transition={spring.morph} className="block fh-metric-value tabular">
          {value}
        </m.span>
        {sub ? <span className="block text-caption text-tertiary truncate" style={{ fontWeight: 400 }}>{sub}</span> : null}
      </span>
      {visual ? (
        <m.span layoutId={`kpi-${id}-visual`} layout="position" transition={spring.morph} className="flex-none">
          {visual}
        </m.span>
      ) : null}
    </m.button>
  );
}

/** The detail panel a KpiMorphTile opens into. */
export function KpiDetail({ id, label, value, visual, onClose, children, aside }: { id: string; label: ReactNode; value: ReactNode; visual?: ReactNode; onClose: () => void; children: ReactNode; aside?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotionPref();
  useEffect(() => {
    const t = window.setTimeout(() => ref.current?.focus({ preventScroll: true }), 60);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <m.div
      ref={ref}
      layoutId={`kpi-${id}`}
      transition={spring.morph}
      role="dialog"
      aria-modal="false"
      aria-label={typeof label === "string" ? label : "Detail"}
      tabIndex={-1}
      className="fh-kpi-detail panel"
      style={{ borderRadius: 20 }}
      data-light=""
    >
      <EdgeLight specular />
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <m.span layoutId={`kpi-${id}-label`} layout="position" transition={spring.morph} className="block text-caption text-secondary" style={{ fontWeight: 500 }}>
            {label}
          </m.span>
          <m.span layoutId={`kpi-${id}-value`} layout="position" transition={spring.morph} className="block fh-metric-value tabular" style={{ fontSize: "calc(28rem / 14)", lineHeight: "36px" }}>
            {value}
          </m.span>
        </div>
        {visual ? (
          <m.span layoutId={`kpi-${id}-visual`} layout="position" transition={spring.morph} className="flex-none">
            {visual}
          </m.span>
        ) : null}
        <IconButton icon={X} size="sm" variant="ghost" label="Close" onClick={onClose} />
      </div>
      <m.div
        className="mt-4 fh-kpi-detail-body"
        initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0, transition: { delay: reduced ? 0 : 0.12, duration: 0.22, ease: [0.2, 0, 0, 1] } }}
        exit={{ opacity: 0, transition: { duration: 0.08 } }}
      >
        <div className="min-w-0 flex-1">{children}</div>
        {aside ? <div className="fh-kpi-aside">{aside}</div> : null}
      </m.div>
    </m.div>
  );
}

export interface DetailBar {
  key: string;
  label: string;
  value: number;
  display: string;
  tone?: "gain" | "loss" | "ink" | "muted";
}

/** Bars that spring up from the baseline (scaleY, settle, 24ms stagger) with a dashed guide line. */
export function DetailBars({ bars, guide, guideLabel, height = 150 }: { bars: DetailBar[]; guide?: number; guideLabel?: string; height?: number }) {
  const reduced = useReducedMotionPref();
  const max = Math.max(guide ?? 0, ...bars.map((b) => Math.abs(b.value)), 0.0001);
  return (
    <div className="fh-dbars" style={{ height: height + 40 }}>
      {guide !== undefined ? (
        <div className="fh-dbars-guide" style={{ bottom: 22 + (guide / max) * height }}>
          <span>{guideLabel}</span>
        </div>
      ) : null}
      {bars.map((b, i) => (
        <div key={b.key} className="fh-dbar">
          <span className="fh-dbar-val tabular" data-sensitive="">
            {b.display}
          </span>
          <div className="fh-dbar-track" style={{ height }}>
            <m.i
              data-tone={b.tone ?? "ink"}
              style={{ height: `${(Math.max(0, b.value) / max) * 100}%`, originY: 1 }}
              initial={reduced ? false : { scaleY: 0 }}
              animate={{ scaleY: 1 }}
              transition={{ ...spring.settle, delay: 0.16 + i * 0.024 }}
            />
          </div>
          <span className="fh-dbar-label">{b.label}</span>
        </div>
      ))}
    </div>
  );
}
