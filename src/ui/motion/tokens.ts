/**
 * Motion tokens (docs/DESIGN.md §7). Durations are seconds (motion's unit). Every animation belongs to a frequency
 * class in register.ts; these tokens are its building blocks. CSS mirrors live in tokens.css / material.css
 * (`--dur-*`, `--spring-*`, all ease-out without overshoot). Change both together.
 */
export const duration = {
  instant: 0,
  press: 0.06,
  micro: 0.06,
  fast: 0.1,
  base: 0.14,
  hover: 0,
  moderate: 0.2,
  slow: 0.24,
  deliberate: 0.22,
  chart: 0.3,
  draw: 0.3,
  cinematic: 0.6,
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

/** A tween on the v3 ease-out: critically damped feel, no overshoot (register.ts). */
const tw = (d: number) => ({ type: "tween" as const, duration: d, ease: [0.2, 0, 0, 1] as [number, number, number, number] });

/**
 * One curve table. v3 retires overshooting springs outside the three C3 moments (register.ts): every name is now a
 * short ease-out tween, so existing imports keep working and nothing bounces.
 *   release  key release, Kbd release                         C1 100ms
 *   thumb    switch thumb, checkbox, radio, toast in            C1 140ms
 *   pop      confirmations                                     C2 180ms
 *   glide    indicators (kept for API; v3 selection is instant) C1 140ms
 *   settle   dialogs, sheets, peeks                            C2 200ms
 *   morph    shared-element morphs, reorder, layout shifts     C2 220ms
 *   roll     digits after the user's own edit                  C2 240ms
 *   magnet   retired (tilt / magnet)                           0
 *   drag     drop after a drag                                 C2 200ms
 */
const table = {
  release: tw(0.1),
  thumb: tw(0.14),
  pop: tw(0.18),
  glide: tw(0.14),
  settle: tw(0.2),
  morph: tw(0.22),
  roll: tw(0.24),
  magnet: tw(0),
  drag: tw(0.2),
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

/** Stagger steps in seconds: all 0 in v3 (no arrival choreography). Kept so existing imports compile. */
export const stagger = { cards: 0, rows: 0, digits: 0, bars: 0, maxCards: 0, maxRows: 0, maxTotal: 0 } as const;

/** Tooltip delay group (§4.2). */
export const tooltipDelay = { open: 500, skip: 300 } as const;
