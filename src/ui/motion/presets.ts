/**
 * Reusable motion presets built from the tokens (docs/DESIGN.md §5.3). Use with `m.*` components:
 *   <m.div {...presets.rise} />        <m.div variants={staggerList()} initial="hidden" animate="show">
 * Under MotionConfig reducedMotion, motion drops transforms automatically; opacity remains.
 *
 * Timing grammar: exits run at ~0.65× the entrance with `ease.in` and no spring; press is pure CSS (`.slab:active`),
 * so `pressMd` / `pressSm` / `pressCard` are deprecated no-ops kept for API compatibility.
 */
import type { Transition, Variants } from "motion/react";
import { duration, ease, spring, stagger } from "./tokens";

const t = (d: number, e: readonly [number, number, number, number]): Transition => ({ duration: d, ease: e });

export const transitions = {
  hoverIn: t(duration.fast, ease.out),
  hoverOut: t(duration.base, ease.out),
  menuIn: spring.glide,
  menuOut: t(0.1, ease.in),
  tooltipIn: t(duration.fast, ease.out),
  tooltipOut: t(duration.micro, ease.in),
  crossfade: t(duration.base, ease.out),
  pageIn: t(0.22, ease.out),
  pageOut: t(0.09, ease.in),
  dialogOut: t(0.15, ease.in),
  sheetOut: t(0.18, ease.in),
  toastOut: t(duration.base, ease.in),
  chartMorph: { duration: 0.62, ease: ease.outExpo } as Transition,
  chartEntry: t(duration.chart, ease.outExpo),
  countUp: t(1.3, ease.outExpo),
} as const;

export const presets = {
  fade: {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: transitions.crossfade },
    exit: { opacity: 0, transition: t(0.11, ease.in) },
  },
  /** Scrim: opacity only, 300ms in / 150ms out, never blurred (§6.3). */
  scrim: {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: t(0.3, ease.out) },
    exit: { opacity: 0, transition: t(0.15, ease.in) },
  },
  /** `drop` (§5.4): used when a dialog has no pointer origin. */
  dialogPanel: {
    initial: { opacity: 0, scale: 0.955, y: 14, filter: "blur(6px)" },
    animate: { opacity: 1, scale: 1, y: 0, filter: "blur(0px)", transition: { ...spring.settle, opacity: t(0.12, ease.out), filter: t(0.2, ease.out) } },
    exit: { opacity: 0, scale: 0.97, filter: "blur(0px)", transition: transitions.dialogOut },
  },
  sheetPanel: {
    initial: { x: "100%" },
    animate: { x: 0, transition: spring.settle },
    exit: { x: "100%", transition: transitions.sheetOut },
  },
  menu: {
    initial: { opacity: 0, scale: 0.96, y: -4 },
    animate: { opacity: 1, scale: 1, y: 0, transition: spring.glide },
    exit: { opacity: 0, scale: 0.98, transition: transitions.menuOut },
  },
  page: {
    initial: { opacity: 0, x: 12 },
    animate: { opacity: 1, x: 0, transition: transitions.pageIn },
    exit: { opacity: 0, x: -8, transition: transitions.pageOut },
  },
  /** `rise` entrance (§5.3). */
  rise: {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0, transition: spring.settle },
  },
  /** `rise-blur` entrance (overlays and hero only). */
  riseBlur: {
    initial: { opacity: 0, y: 10, scale: 0.985, filter: "blur(4px)" },
    animate: { opacity: 1, y: 0, scale: 1, filter: "blur(0px)", transition: { ...spring.settle, filter: t(0.26, ease.out), opacity: t(0.2, ease.out) } },
  },
  cardEnter: {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0, transition: spring.settle },
  },
  /** @deprecated press is CSS (`.slab:active`); kept as a no-op for API compatibility. */
  pressMd: {},
  /** @deprecated press is CSS. */
  pressSm: {},
  /** @deprecated press is CSS (`.panel[data-raise]:active`). */
  pressCard: {},
} as const;

/** Stagger children (cards 40ms, rows 16ms — §5.3). Pair with `staggerItem`. */
export const staggerList = (step: number = stagger.cards): Variants => ({
  hidden: {},
  show: { transition: { staggerChildren: step } },
});
export const staggerItem: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: spring.settle },
};

/** Wrong-password shake (§4.2). */
export const shake = {
  x: [0, -8, 8, -6, 6, -3, 3, 0],
  transition: t(0.4, ease.out),
};
