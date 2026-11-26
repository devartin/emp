/**
 * Motion primitives for feature teams (docs/DESIGN.md §7, docs/design/KIT.md, register.ts).
 *
 * v3 retired arrival choreography, stagger, magnet, tilt and edge light. The components stay so feature code keeps
 * compiling, but content is present at frame 1:
 *   <Reveal>, <Stagger>, <StaggerItem>   render their children in place (no entrance)
 *   <Magnetic>, <Tilt>, <Specular>       plain wrappers
 *   <Pressable>                          presses 0.5px like a key (CSS :active)
 *   <Morph>                              shared-element morph (C2 continuity, 220ms, no overshoot)
 */
import { m, type HTMLMotionProps, type Variants } from "motion/react";
import { Children, isValidElement, type CSSProperties, type ElementType, type ReactNode, type Ref } from "react";
import { cn } from "@/lib/cn";
import { spring } from "./tokens";

/* ───────────────────────── entrance vocabulary (§5.3) ───────────────────────── */

export type RevealVariant = "rise" | "rise-blur" | "fade" | "scale" | "drop" | "slide-left" | "slide-right";

const shown = { opacity: 1, x: 0, y: 0, scale: 1 };

/** @deprecated entrances are retired: both states are the final state. */
export function revealVariants(_variant: RevealVariant = "rise"): Variants {
  void _variant;
  return { hidden: shown, show: shown };
}

export interface RevealProps extends Omit<HTMLMotionProps<"div">, "initial" | "animate" | "whileInView"> {
  variant?: RevealVariant;
  /** @deprecated ignored. */
  delay?: number;
  /** @deprecated ignored. */
  inView?: boolean;
  /** Element to render (div by default). */
  as?: "div" | "section" | "li" | "span" | "article" | "header";
  ref?: Ref<HTMLDivElement>;
}

/** Renders its child in place. Kept for API compatibility: v3 has no arrival choreography (register.ts C0). */
export function Reveal({ variant: _v, delay: _d, inView: _i, as = "div", children, ...rest }: RevealProps) {
  void _v;
  void _d;
  void _i;
  const Comp = m[as] as typeof m.div;
  return (
    <Comp initial={false} {...rest}>
      {children}
    </Comp>
  );
}

/* ───────────────────────── stagger (retired: children appear together) ───────────────────────── */

export interface StaggerProps {
  children: ReactNode;
  kind?: "cards" | "rows";
  step?: number;
  cap?: number;
  variant?: RevealVariant;
  delay?: number;
  inView?: boolean;
  /** Don't wrap children: render <StaggerItem index> yourself. */
  manual?: boolean;
  className?: string;
  itemClassName?: string;
  style?: CSSProperties;
  as?: "div" | "ul" | "ol" | "section";
  itemAs?: "div" | "li";
}

/** Renders the list in place (stagger is 0 in v3). Items keep their wrapper element so layouts do not change. */
export function Stagger({ children, manual, className, itemClassName, style, as = "div", itemAs = "div" }: StaggerProps) {
  const Comp = as as ElementType;
  let i = 0;
  return (
    <Comp className={className} style={style}>
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
  );
}

export function StaggerItem({ children, className, style, as = "div" }: { index?: number; children: ReactNode; className?: string; style?: CSSProperties; as?: "div" | "li" | "span" }) {
  const Comp = as as ElementType;
  return (
    <Comp className={className} style={style}>
      {children}
    </Comp>
  );
}

/* ───────────────────────── magnetic CTA (retired) ───────────────────────── */

/** @deprecated the magnetic pull is retired; renders its children in an inline-flex span. */
export function Magnetic({ children, className }: { children: ReactNode; strength?: number; className?: string }) {
  return <span className={cn("inline-flex", className)}>{children}</span>;
}

/* ───────────────────────── tilt / specular / press ───────────────────────── */

type BoxProps = { children?: ReactNode; className?: string; style?: CSSProperties; as?: ElementType; ref?: Ref<HTMLElement> };

/** @deprecated pointer tilt is retired; a plain wrapper. */
export function Tilt({ children, className, style, as: Comp = "div", ref }: BoxProps & { max?: number }) {
  return (
    <Comp ref={ref} className={className} style={style}>
      {children}
    </Comp>
  );
}

/** @deprecated edge light and specular are retired; a plain wrapper. */
export function Specular({ children, className, style, as: Comp = "div", ref }: BoxProps & { wash?: boolean }) {
  return (
    <Comp ref={ref} className={cn("relative", className)} style={style}>
      {children}
    </Comp>
  );
}

/** Make any element press like a key (`.emp-pressable` CSS: 0.5px travel, 1-frame feedback). */
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

/** layoutId morph (C2 continuity, 220ms ease-out). Crossfades under reduced motion. */
export function Morph({ id, children, transition, ...rest }: MorphProps) {
  return (
    <m.div layoutId={id} transition={transition ?? spring.morph} {...rest}>
      {children}
    </m.div>
  );
}
