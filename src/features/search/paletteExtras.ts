/**
 * The parts of ⌘K that only some queries need — the capture grammar and its commit (t / n / −12.50 …) and the
 * places index — loaded as their own chunk the moment the palette (or Home's capture field) first opens, so the
 * palette itself stays small (scripts/bundle-budget.mjs).
 */
export { captureAccount, describeCapture, loadMoneyTarget, parseCapture } from "./capture";
export { placesFor } from "./places";
export { runCapture } from "./runCapture";

export type PaletteExtras = typeof import("./paletteExtras");

