/**
 * The motion register (docs/DESIGN.md §7; PROGRAMME-v3 K3). Every animation in Ultranote belongs to exactly one
 * frequency class, and the class sets its budget. Motion is earned: the more often something happens, the less it
 * moves. register.test.ts enforces the budgets against this table and against the kit's CSS.
 *
 *   C0 instant     typing, hover-in, row focus/select, tab / segmented / sidebar selection, route change,
 *                  keyboard-opened palette and menus, Home      0ms in; out ≤ 120ms; content present at frame 1
 *   C1 feedback    key press, checkbox tick + strike-through, switch, mouse-opened menus and popovers (.97 → 1),
 *                  toast in / out                               ≤ 160ms in and out; ease-out; no overshoot
 *   C2 continuity  side peek, dialog, sheet, drag lift / drop, reorder, chart range morph, a number rolling after
 *                  the user's own edit                          ≤ 220ms in, ≤ 200ms out; critically damped; interruptible
 *   C3 moment      exactly three: vault unlock, life-app build (its length is the real work), reconcile success
 *                                                              ≤ 600ms; skippable; a crossfade under reduced motion
 *
 * Input never waits on motion: nothing here delays focus, typing or a click target.
 */

export type MotionClass = "C0" | "C1" | "C2" | "C3";

export interface ClassBudget {
  label: string;
  /** Longest allowed entrance, ms. */
  maxIn: number;
  /** Longest allowed exit, ms. */
  maxOut: number;
  /** Overshooting springs allowed. */
  overshoot: boolean;
}

export const CLASSES: Record<MotionClass, ClassBudget> = {
  C0: { label: "instant", maxIn: 0, maxOut: 120, overshoot: false },
  C1: { label: "feedback", maxIn: 160, maxOut: 160, overshoot: false },
  // Exits may take 200ms: the 1.0 brief §4 makes sidebar hide / show a 200ms transform both ways ("small" motion).
  C2: { label: "continuity", maxIn: 220, maxOut: 200, overshoot: false },
  C3: { label: "moment", maxIn: 600, maxOut: 300, overshoot: false },
};

export interface MotionEntry {
  cls: MotionClass;
  /** Entrance duration, ms. */
  in: number;
  /** Exit duration, ms. */
  out: number;
  /** Where it lives. */
  where: string;
}

/** Every named animation in the kit, with its class. Add an entry before adding an animation. */
export const REGISTER = {
  typing: { cls: "C0", in: 0, out: 0, where: "everywhere" },
  hover: { cls: "C0", in: 0, out: 120, where: "--dur-hover / --dur-hover-out" },
  rowSelect: { cls: "C0", in: 0, out: 0, where: "lists, tables, sidebar" },
  tabSwitch: { cls: "C0", in: 0, out: 0, where: "ui/Tabs.tsx" },
  segmented: { cls: "C0", in: 0, out: 0, where: "ui/Segmented.tsx" },
  routeChange: { cls: "C0", in: 0, out: 0, where: "app/routes.tsx RouteOutlet" },
  keyboardOverlay: { cls: "C0", in: 0, out: 80, where: ":root[data-input=keyboard] .emp-pop; ⌘K" },
  highlightPlate: { cls: "C0", in: 0, out: 0, where: "ui/GlideHighlight.tsx" },
  keyPress: { cls: "C1", in: 60, out: 100, where: "material.css .slab:active" },
  kbdPress: { cls: "C1", in: 40, out: 120, where: "motion/keycaps.ts (full-chord matches only)" },
  checkboxTick: { cls: "C1", in: 120, out: 80, where: ".emp-check-tick" },
  strikeThrough: { cls: "C1", in: 150, out: 150, where: ".emp-check-label::after" },
  switchThumb: { cls: "C1", in: 140, out: 140, where: ".emp-switch-thumb" },
  menuOpen: { cls: "C1", in: 120, out: 80, where: ".emp-pop (mouse-opened)" },
  tooltip: { cls: "C1", in: 80, out: 60, where: ".emp-tip" },
  toast: { cls: "C1", in: 150, out: 100, where: "ui/Toast.tsx" },
  dialog: { cls: "C2", in: 160, out: 100, where: "presets.dialogPanel" },
  sheet: { cls: "C2", in: 200, out: 140, where: "presets.sheetPanel" },
  sidePeek: { cls: "C2", in: 200, out: 140, where: "shell side peek" },
  dragDrop: { cls: "C2", in: 200, out: 120, where: "spring.drag" },
  reorder: { cls: "C2", in: 220, out: 0, where: "spring.morph (FLIP)" },
  chartMorph: { cls: "C2", in: 200, out: 0, where: "charts: range change" },
  chartFirstDraw: { cls: "C2", in: 220, out: 0, where: "charts: first data load only" },
  numberRoll: { cls: "C2", in: 200, out: 0, where: "RollingNumber, only after markUserEdit() from an edit handler" },
  confirmation: { cls: "C2", in: 180, out: 160, where: "motion/Celebrate.tsx celebrate()" },
  // Shell and projects (1.0 brief §2.1, §4)
  sidebarToggle: { cls: "C2", in: 200, out: 200, where: "shell.css .emp-sidebar[data-motion] (show and hide 200); shellMotion.ts FLIP of the main column / top bar" },
  shellHover: { cls: "C1", in: 100, out: 100, where: "shell.css .emp-sb-row / .emp-sb-new, projects.css rows (background fade)" },
  disclosureCaret: { cls: "C1", in: 120, out: 120, where: "shell.css .emp-sb-head .caret, .emp-sb-chevron svg, .emp-sb-new .caret" },
  sectionExpand: { cls: "C1", in: 160, out: 160, where: "Sidebar/Section.tsx .emp-sb-sec-body (grid rows + opacity)" },
  rowInsert: { cls: "C1", in: 160, out: 0, where: "shell.css .emp-sb-row[data-fresh] (fade + 4px)" },
  rowRemove: { cls: "C1", in: 0, out: 160, where: "shell.css .emp-sb-row[data-leaving]; stores/tree.ts trash() (fade + 4px)" },
  showSidebarButton: { cls: "C1", in: 160, out: 0, where: "shell.css .emp-sb-show (emp-sub-in)" },
  favoritesDropZone: { cls: "C1", in: 120, out: 0, where: "shell.css .emp-sb-favdrop (fades in while a row is dragged and there are no favourites)" },
  vaultUnlock: { cls: "C3", in: 600, out: 200, where: "features/vault (signature)" },
  lifeAppBuild: { cls: "C3", in: 600, out: 200, where: "features/lifeapps BuildStage (per step; length = real work)" },
  reconcileSuccess: { cls: "C3", in: 600, out: 200, where: "finance reconcile (signature)" },
} as const satisfies Record<string, MotionEntry>;

export type MotionName = keyof typeof REGISTER;

/** The register entry for a named animation. */
export function motionFor(name: MotionName): MotionEntry {
  return REGISTER[name];
}

/** Entrance duration in seconds for motion's `transition.duration` (0 under reduced motion except C3 crossfades). */
export function motionSeconds(name: MotionName, reduced = false): number {
  const e = REGISTER[name];
  if (reduced) return e.cls === "C3" ? 0.15 : 0;
  return e.in / 1000;
}

/** The three signature moments (C3). Nothing else may claim C3. */
export const SIGNATURE_MOMENTS: MotionName[] = ["vaultUnlock", "lifeAppBuild", "reconcileSuccess"];
