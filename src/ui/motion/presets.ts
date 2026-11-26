/**
 * Reusable motion presets built from the tokens (§4.2). Use with `m.*` components:
 *   <m.div {...presets.dialogPanel} />
 * Under MotionConfig reducedMotion, motion drops transforms automatically; opacity remains.
 */
import type { Transition, Variants } from "motion/react";
import { duration, ease, spring } from "./tokens";

const t = (d: number, e: readonly [number, number, number, number]): Transition => ({ duration: d, ease: e });

export const transitions = {
  hoverIn: t(duration.fast, ease.out),
  hoverOut: t(duration.base, ease.out),
  menuIn: t(duration.base, ease.outExpo),
  menuOut: t(0.1, ease.in),
  tooltipIn: t(duration.fast, ease.out),
  tooltipOut: t(duration.micro, ease.in),
  crossfade: t(duration.base, ease.out),
  pageIn: t(0.2, ease.out),
  pageOut: t(duration.micro, ease.in),
  dialogOut: t(0.14, ease.in),
  sheetOut: t(0.18, ease.in),
  toastOut: t(duration.base, ease.in),
  chartMorph: t(0.4, ease.inOut),
  chartEntry: t(duration.chart, ease.outExpo),
  countUp: t(0.6, ease.outExpo),
} as const;

export const presets = {
  fade: {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: transitions.crossfade },
    exit: { opacity: 0, transition: t(0.11, ease.in) },
  },
  scrim: {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: t(0.18, ease.out) },
    exit: { opacity: 0, transition: t(0.14, ease.in) },
  },
  dialogPanel: {
    initial: { opacity: 0, scale: 0.96, y: 8 },
    animate: { opacity: 1, scale: 1, y: 0, transition: spring.gentle },
    exit: { opacity: 0, scale: 0.98, transition: transitions.dialogOut },
  },
  sheetPanel: {
    initial: { x: "100%" },
    animate: { x: 0, transition: spring.gentle },
    exit: { x: "100%", transition: transitions.sheetOut },
  },
  menu: {
    initial: { opacity: 0, scale: 0.96, y: -4 },
    animate: { opacity: 1, scale: 1, y: 0, transition: transitions.menuIn },
    exit: { opacity: 0, scale: 0.98, transition: transitions.menuOut },
  },
  page: {
    initial: { opacity: 0, y: 6 },
    animate: { opacity: 1, y: 0, transition: transitions.pageIn },
    exit: { opacity: 0, transition: transitions.pageOut },
  },
  cardEnter: {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0, transition: spring.gentle },
  },
  pressMd: { whileTap: { scale: 0.97 }, transition: spring.snappy },
  pressSm: { whileTap: { scale: 0.92 }, transition: spring.snappy },
  pressCard: { whileTap: { scale: 0.985 }, transition: spring.snappy },
} as const;

/** Stagger children (life-app generation, lists entering). */
export const staggerList = (step = 0.04): Variants => ({
  hidden: {},
  show: { transition: { staggerChildren: step } },
});
export const staggerItem: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: spring.gentle },
};

/** Wrong-password shake (§4.2). */
export const shake = {
  x: [0, -8, 8, -6, 6, -3, 3, 0],
  transition: t(0.4, ease.out),
};
