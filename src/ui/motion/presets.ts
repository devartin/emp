/**
 * Reusable motion presets built from the tokens (docs/DESIGN.md §7, register.ts). Use with `m.*` components:
 *   <m.div {...presets.fade} />
 * Under MotionConfig reducedMotion, motion drops transforms automatically; opacity remains.
 *
 * v3 rules: content is present at frame 1. Arrival presets (`rise`, `riseBlur`, `cardEnter`, `page`, `staggerItem`)
 * are kept for API compatibility but no longer move anything. Overlays use C1 (menus, 120ms) or C2 (dialogs and
 * sheets, ≤ 220ms). Nothing blurs, nothing overshoots, nothing staggers.
 */
import type { Transition, Variants } from "motion/react";
import { duration, ease, spring } from "./tokens";

const t = (d: number, e: readonly [number, number, number, number]): Transition => ({ duration: d, ease: e });
/** "Already there": the initial state equals the final one, so mounting animates nothing. */
const still = { opacity: 1, x: 0, y: 0, scale: 1 };

export const transitions = {
  hoverIn: t(0, ease.out),
  hoverOut: t(0.12, ease.out),
  menuIn: t(0.12, ease.out),
  menuOut: t(0.08, ease.in),
  tooltipIn: t(0.08, ease.out),
  tooltipOut: t(0.06, ease.in),
  crossfade: t(duration.fast, ease.out),
  pageIn: t(0, ease.out),
  pageOut: t(0, ease.in),
  dialogOut: t(0.1, ease.in),
  sheetOut: t(0.14, ease.in),
  toastOut: t(0.1, ease.in),
  chartMorph: t(0.2, ease.out),
  chartEntry: t(duration.chart, ease.out),
  /** @deprecated count-up is retired (register.ts); kept for API compatibility. */
  countUp: t(0, ease.out),
} as const;

export const presets = {
  fade: {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: transitions.crossfade },
    exit: { opacity: 0, transition: t(0.08, ease.in) },
  },
  /** Scrim: opacity only, 150ms in / 100ms out, never blurred. */
  scrim: {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: t(0.15, ease.out) },
    exit: { opacity: 0, transition: t(0.1, ease.in) },
  },
  /** Dialog (C2): 160ms fade + .98 → 1. */
  dialogPanel: {
    initial: { opacity: 0, scale: 0.98 },
    animate: { opacity: 1, scale: 1, transition: t(0.16, ease.out) },
    exit: { opacity: 0, scale: 0.99, transition: transitions.dialogOut },
  },
  /** Side sheet / peek (C2): slides in 200ms, critically damped. */
  sheetPanel: {
    initial: { x: "100%" },
    animate: { x: 0, transition: spring.settle },
    exit: { x: "100%", transition: transitions.sheetOut },
  },
  /** Mouse-opened menu (C1): .97 → 1 in 120ms. Keyboard-opened menus should pass `initial={false}`. */
  menu: {
    initial: { opacity: 0, scale: 0.97 },
    animate: { opacity: 1, scale: 1, transition: transitions.menuIn },
    exit: { opacity: 0, transition: transitions.menuOut },
  },
  /** @deprecated route changes are instant (C0). Kept as a no-op. */
  page: { initial: still, animate: still, exit: { opacity: 1 } },
  /** @deprecated arrival choreography is retired. Kept as a no-op. */
  rise: { initial: still, animate: still },
  /** @deprecated arrival choreography is retired. Kept as a no-op. */
  riseBlur: { initial: still, animate: still },
  /** @deprecated arrival choreography is retired. Kept as a no-op. */
  cardEnter: { initial: still, animate: still },
  /** @deprecated press is CSS (`.slab:active`); kept as a no-op for API compatibility. */
  pressMd: {},
  /** @deprecated press is CSS. */
  pressSm: {},
  /** @deprecated press is CSS. */
  pressCard: {},
} as const;

/** @deprecated stagger is 0 in v3. Kept so existing variants compile; children appear together. */
export const staggerList = (_step = 0): Variants => {
  void _step;
  return { hidden: {}, show: {} };
};
/** @deprecated arrival choreography is retired: items are visible in both states. */
export const staggerItem: Variants = {
  hidden: still,
  show: still,
};

/** Wrong-password shake (feedback, C1). */
export const shake = {
  x: [0, -6, 6, -3, 3, 0],
  transition: t(0.3, ease.out),
};
