/** Motion tokens — SPEC §4.1, verbatim. Durations are seconds (motion's unit). */
export const duration = { instant: 0, micro: 0.08, fast: 0.12, base: 0.16, moderate: 0.22, slow: 0.32, deliberate: 0.48, chart: 0.7 } as const;

export const ease = {
  out: [0.2, 0, 0, 1],
  outExpo: [0.16, 1, 0.3, 1],
  in: [0.4, 0, 1, 1],
  inOut: [0.65, 0, 0.35, 1],
  linear: [0, 0, 1, 1],
} as const;

export const spring = {
  snappy: { type: "spring", stiffness: 600, damping: 35, mass: 0.6 }, // press, toggles, checkbox (~180ms)
  ui: { type: "spring", stiffness: 420, damping: 36, mass: 1 }, // indicators, sidebar, toasts (~220ms)
  gentle: { type: "spring", stiffness: 260, damping: 30, mass: 1 }, // dialogs, sheets, cards entering (~270ms)
  layout: { type: "spring", stiffness: 500, damping: 40, mass: 1 }, // reorder, layout shifts (~200ms)
  bouncy: { type: "spring", stiffness: 400, damping: 22, mass: 1 }, // celebrations ONLY
  drag: { type: "spring", stiffness: 300, damping: 28, mass: 1 }, // drag release with velocity
} as const;

/** Cubic-bezier tuple typed for motion's `ease` option. */
export type Bezier = readonly [number, number, number, number];

/** CSS mirrors for inline styles. */
export const css = {
  easeOut: "cubic-bezier(.2,0,0,1)",
  easeOutExpo: "cubic-bezier(.16,1,.3,1)",
  easeIn: "cubic-bezier(.4,0,1,1)",
  easeInOut: "cubic-bezier(.65,0,.35,1)",
} as const;

/** Tooltip delay group (§4.2). */
export const tooltipDelay = { open: 500, skip: 300 } as const;
