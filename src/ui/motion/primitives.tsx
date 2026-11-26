/**
 * Motion primitives for feature teams (docs/DESIGN.md §5, docs/design/KIT.md). All of them honour reduced motion
 * (MotionConfig drops transforms; CSS fallbacks are static) and animate transform / opacity / filter only.
 *
 *   <Reveal>            one element rises in (rise | rise-blur | fade | scale | drop), on mount or when scrolled into view
 *   <Stagger>           children cascade in (cards 40ms / rows 16ms), capped at 8 cards / 12 rows, total ≤ 320ms
 *   <StaggerItem>       manual item for <Stagger manual>
 *   <Magnetic>          ≤ 3px pull toward the pointer — the single primary CTA on cinematic screens only
 *   <Tilt>              ≤ 3° pointer tilt (KPI, gallery tiles, choice cards) via the global pointer tracker
 *   <Specular>          edge light + optional specular wash on any surface
 *   <Morph>             shared-element morph inside one mounted tree (layoutId on the `morph` spring)
 *   <Pressable>         makes any element press like a key (CSS :active, no JS)
 */
import { m, useMotionValue, useSpring, type HTMLMotionProps, type Variants } from "motion/react";
import { Children, createContext, isValidElement, useContext, useRef, type CSSProperties, type ElementType, type ReactNode, type Ref } from "react";
import { cn } from "@/lib/cn";
import { EdgeLight } from "./EdgeLight";
import { duration, ease, spring, stagger as STAGGER } from "./tokens";
import { useReducedEffects, useReducedMotionPref } from "./useReducedEffects";

/* ───────────────────────── entrance vocabulary (§5.3) ───────────────────────── */

export type RevealVariant = "rise" | "rise-blur" | "fade" | "scale" | "drop" | "slide-left" | "slide-right";

const hidden: Record<RevealVariant, Record<string, number | string>> = {
  rise: { opacity: 0, y: 8 },
  "rise-blur": { opacity: 0, y: 10, scale: 0.985, filter: "blur(4px)" },
  fade: { opacity: 0 },
  scale: { opacity: 0, scale: 0.96 },
  drop: { opacity: 0, y: 14, scale: 0.955, filter: "blur(6px)" },
  "slide-left": { opacity: 0, x: 16 },
  "slide-right": { opacity: 0, x: -16 },
};
const shown = { opacity: 1, x: 0, y: 0, scale: 1, filter: "blur(0px)" };

function enterTransition(variant: RevealVariant, delay = 0) {
  if (variant === "fade") return { duration: duration.base, ease: ease.out, delay };
  return { ...spring.settle, delay, opacity: { duration: 0.2, ease: ease.out, delay }, filter: { duration: 0.26, ease: ease.out, delay } };
}

export function revealVariants(variant: RevealVariant = "rise"): Variants {
  return { hidden: hidden[variant], show: shown };
}

export interface RevealProps extends Omit<HTMLMotionProps<"div">, "initial" | "animate" | "whileInView"> {
  variant?: RevealVariant;
  /** Seconds. */
  delay?: number;
  /** Wait until ≥ 20% is visible (once). */
  inView?: boolean;
  /** Element to render (div by default). */
  as?: "div" | "section" | "li" | "span" | "article" | "header";
  ref?: Ref<HTMLDivElement>;
}

/** One element entering with the house vocabulary. Usable from frame 1: entrances never block input. */
export function Reveal({ variant = "rise", delay = 0, inView, as = "div", children, ...rest }: RevealProps) {
  const reduced = useReducedMotionPref();
  const Comp = m[as] as typeof m.div;
  const v = reduced ? "fade" : variant;
  const tr = enterTransition(v, delay);
  if (inView) {
    return (
      <Comp initial={hidden[v]} whileInView={{ ...shown, transition: tr }} viewport={{ once: true, amount: 0.2 }} {...rest}>
        {children}
      </Comp>
    );
  }
  return (
    <Comp initial={hidden[v]} animate={{ ...shown, transition: tr }} {...rest}>
      {children}
    </Comp>
  );
}

/* ───────────────────────── stagger ───────────────────────── */

const StaggerCtx = createContext<{ step: number; cap: number; variant: RevealVariant; delay: number }>({ step: STAGGER.cards, cap: STAGGER.maxCards, variant: "rise", delay: 0 });

export interface StaggerProps {
  children: ReactNode;
  /** "cards" (40ms, cap 8) or "rows" (16ms, cap 12), or a custom step in seconds. */
  kind?: "cards" | "rows";
  step?: number;
  cap?: number;
  variant?: RevealVariant;
  /** Seconds before the first item. */
  delay?: number;
  /** Wait until in view. */
  inView?: boolean;
  /** Don't wrap children: render <StaggerItem index> yourself. */
  manual?: boolean;
  className?: string;
  itemClassName?: string;
  style?: CSSProperties;
  as?: "div" | "ul" | "ol" | "section";
  itemAs?: "div" | "li";
}

/**
 * Cascading entrance. Items past the cap appear with the last group; the total never exceeds 320ms.
 *   <Stagger className="grid grid-cols-3 gap-4">{widgets}</Stagger>
 */
export function Stagger({ children, kind = "cards", step, cap, variant = "rise", delay = 0, inView, manual, className, itemClassName, style, as = "div", itemAs = "div" }: StaggerProps) {
  const ctx = {
    step: step ?? (kind === "rows" ? STAGGER.rows : STAGGER.cards),
    cap: cap ?? (kind === "rows" ? STAGGER.maxRows : STAGGER.maxCards),
    variant,
    delay,
  };
  const Comp = m[as] as typeof m.div;
  const props = inView ? { initial: "hidden", whileInView: "show", viewport: { once: true, amount: 0.15 } } : { initial: "hidden", animate: "show" };
  let i = 0;
  return (
    <StaggerCtx.Provider value={ctx}>
      <Comp className={className} style={style} {...props}>
        {manual
          ? children
          : Children.map(children, (c) => {
              if (c === null || c === undefined || c === false) return c;
              const idx = i++;
              return (
                <StaggerItem index={idx} className={itemClassName} as={itemAs} key={isValidElement(c) && c.key !== null ? c.key : idx}>
                  {c}
                </StaggerItem>
              );
            })}
      </Comp>
    </StaggerCtx.Provider>
  );
}

export function StaggerItem({ index = 0, children, className, style, as = "div" }: { index?: number; children: ReactNode; className?: string; style?: CSSProperties; as?: "div" | "li" | "span" }) {
  const { step, cap, variant, delay } = useContext(StaggerCtx);
  const reduced = useReducedMotionPref();
  const v = reduced ? "fade" : variant;
  const d = delay + Math.min(Math.min(index, cap - 1) * step, STAGGER.maxTotal);
  const Comp = m[as] as typeof m.div;
  return (
    <Comp className={className} style={style} variants={{ hidden: hidden[v], show: { ...shown, transition: enterTransition(v, reduced ? 0 : d) } }}>
      {children}
    </Comp>
  );
}

/* ───────────────────────── magnetic CTA ───────────────────────── */

/** ≤ 3px pull toward the pointer, returning on the `magnet` spring. Cinematic screens' single primary CTA only (§1). */
export function Magnetic({ children, strength = 3, className }: { children: ReactNode; strength?: number; className?: string }) {
  const reduced = useReducedMotionPref();
  const fxOff = useReducedEffects();
  const x = useSpring(useMotionValue(0), spring.magnet);
  const y = useSpring(useMotionValue(0), spring.magnet);
  const ref = useRef<HTMLSpanElement>(null);
  const off = reduced || fxOff;
  return (
    <m.span
      ref={ref}
      className={cn("inline-flex", className)}
      style={off ? undefined : { x, y }}
      onPointerMove={(e) => {
        if (off || !ref.current) return;
        const r = ref.current.getBoundingClientRect();
        const dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
        const dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
        x.set(Math.max(-1, Math.min(1, dx)) * Math.min(3, strength));
        y.set(Math.max(-1, Math.min(1, dy)) * Math.min(3, strength) * 0.6);
      }}
      onPointerLeave={() => {
        x.set(0);
        y.set(0);
      }}
    >
      {children}
    </m.span>
  );
}

/* ───────────────────────── tilt / specular / press ───────────────────────── */

type BoxProps = { children?: ReactNode; className?: string; style?: CSSProperties; as?: ElementType; ref?: Ref<HTMLElement> };

/** Pointer tilt up to `max` (≤ 3°) through the global tracker; returns on the magnet spring. */
export function Tilt({ children, className, style, as: Comp = "div", max = 3, ref }: BoxProps & { max?: number }) {
  return (
    <Comp ref={ref} className={cn("emp-tilt", className)} style={style} data-tilt={Math.min(3, max)}>
      {children}
    </Comp>
  );
}

/** Pointer-tracked edge light (and optional broad specular) on any surface with a border radius. */
export function Specular({ children, className, style, as: Comp = "div", wash = false, ref }: BoxProps & { wash?: boolean }) {
  return (
    <Comp ref={ref} className={cn("relative isolate", className)} style={style} data-light="" data-specular={wash ? "" : undefined}>
      <EdgeLight specular={wash} />
      {children}
    </Comp>
  );
}

/** Make any element press like a keycap (`.emp-pressable` CSS — transform only, 1-frame feedback). */
export function Pressable({ children, className, style, as: Comp = "div", ref }: BoxProps) {
  return (
    <Comp ref={ref} className={cn("emp-pressable", className)} style={style}>
      {children}
    </Comp>
  );
}

/* ───────────────────────── shared element ───────────────────────── */

export interface MorphProps extends HTMLMotionProps<"div"> {
  /** Shared id; the same id in another mounted place morphs between them. */
  id: string;
  ref?: Ref<HTMLDivElement>;
}

/** layoutId morph on the `morph` spring (KPI → detail, indicators, reorders). Crossfades under reduced motion. */
export function Morph({ id, children, transition, ...rest }: MorphProps) {
  return (
    <m.div layoutId={id} transition={transition ?? spring.morph} {...rest}>
      {children}
    </m.div>
  );
}
