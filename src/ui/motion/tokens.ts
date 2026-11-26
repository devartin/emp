/**
 * Motion tokens (docs/DESIGN.md §5.1–§5.2). Durations are seconds (motion's unit).
 * The spring table is shared with CSS: `material.css` holds the same springs as `linear()` curves (`--spring-*`),
 * generated from these parameters by docs/design/springs.py. Change both together.
 */
export const duration = {
  instant: 0,
  press: 0.07,
  micro: 0.08,
  fast: 0.12,
  base: 0.16,
  hover: 0.18,
  moderate: 0.22,
  slow: 0.32,
  deliberate: 0.48,
  chart: 0.7,
  draw: 1.1,
  cinematic: 2.0,
} as const;

export const ease = {
  out: [0.2, 0, 0, 1],
  outExpo: [0.16, 1, 0.3, 1],
  in: [0.4, 0, 1, 1],
  inOut: [0.65, 0, 0.35, 1],
  press: [0.3, 0, 0.6, 1],
  sheen: [0.3, 0.7, 0.2, 1],
  linear: [0, 0, 1, 1],
} as const;

const s = (stiffness: number, damping: number, mass = 1) => ({ type: "spring" as const, stiffness, damping, mass });

/**
 * One spring table (§5.2). New names first; legacy names stay as aliases so every existing import keeps working.
 *   release  slab release, Kbd release, icon nudges           (11.5% overshoot, 490ms)
 *   thumb    switch thumb, checkbox pop, radio dot, toast in   (11.3%, 490ms)
 *   pop      success moments only                             (21.6%, 710ms)
 *   glide    indicators: segmented, tabs, sidebar, highlight   (0.9%, 440ms)
 *   settle   dialogs, sheets, cards entering                   (2.3%, 460ms)
 *   morph    shared-element morphs, reorder, layout shifts     (0%, 380ms)
 *   roll     odometer digits                                   (0.6%, 600ms)
 *   magnet   tilt return, magnet CTA                           (10.8%, 630ms)
 *   drag     drag release with velocity                        (1.3%, 520ms)
 */
const table = {
  release: s(700, 30),
  thumb: s(520, 26),
  pop: s(520, 20),
  glide: s(420, 34),
  settle: s(380, 30),
  morph: s(380, 36),
  roll: s(200, 24),
  magnet: s(240, 16, 0.8),
  drag: s(300, 28),
} as const;

export const spring = {
  ...table,
  /** @deprecated alias of `release` */
  snappy: table.release,
  /** @deprecated alias of `glide` */
  ui: table.glide,
  /** @deprecated alias of `settle` */
  gentle: table.settle,
  /** @deprecated alias of `morph` */
  layout: table.morph,
  /** @deprecated alias of `pop` (celebrations only) */
  bouncy: table.pop,
} as const;

export type SpringName = keyof typeof table;

/** Cubic-bezier tuple typed for motion's `ease` option. */
export type Bezier = readonly [number, number, number, number];

/** CSS mirrors for inline styles and WAAPI. */
export const css = {
  easeOut: "cubic-bezier(.2,0,0,1)",
  easeOutExpo: "cubic-bezier(.16,1,.3,1)",
  easeIn: "cubic-bezier(.4,0,1,1)",
  easeInOut: "cubic-bezier(.65,0,.35,1)",
  easePress: "cubic-bezier(.3,0,.6,1)",
  easeSheen: "cubic-bezier(.3,.7,.2,1)",
  /** `var(--spring-*)` curves for CSS transitions; pair with `var(--dur-*)`. */
  spring: (name: SpringName) => `var(--dur-${name === "drag" || name === "magnet" ? "release" : name}) var(--spring-${name === "drag" || name === "magnet" ? "release" : name})`,
} as const;

/** Stagger steps (§5.3) in seconds, and the caps. */
export const stagger = { cards: 0.04, rows: 0.016, digits: 0.028, bars: 0.024, maxCards: 8, maxRows: 12, maxTotal: 0.32 } as const;

/** Tooltip delay group (§4.2). */
export const tooltipDelay = { open: 500, skip: 300 } as const;
