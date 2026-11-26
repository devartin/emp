# Ultra Note UI kit v3 "Paper, ink and keys": guide for feature teams

The binding spec is `docs/DESIGN.md` (v3). This page is the short version: **which primitive or class to use for
what**. Live reference: `ui-gallery.html` (add `?theme=dark|midnight`). Every v2 component API still compiles;
retired props are accepted and ignored (marked `@deprecated`).

## 1. Surfaces and depth (`src/styles/material.css`)

| Need | Use | Notes |
|---|---|---|
| The primary action (≤ 1 per view) | `<Button variant="primary">` | the ink key |
| Any other action | `<Button>` (paper key), `variant="ghost"` (ink wash), `<IconButton>` | no lifts, no glows; press is CSS |
| A section | `<Text v="section">` or `<Card title>` | a 14/600 head over a hairline. Cards have **no frame** by default |
| The one framed container in a view | `<Card framed>` or `.panel` | hairline, radius 10, no shadow. A frame inside a frame loses its border |
| A field / bed | `<Input>` etc., or `.well` | flat; focus = 2px ink ring |
| Something you summoned | `<Menu>`, `<Popover>`, `<Dialog>`, `<Sheet>`, `toast()` | opaque paper with E2 / E3; `.glass-1/2` resolve to the same |
| A divider | a 1px `border-default` / `<Separator>` | `.groove-*` now renders a 1px hairline |
| A selected row | `bg-selected` (`--state-selected`) | flat. Never a raised slab |

Retired and inert: `.grain`, `.canvas-halo` (= canvas colour), `.emp-aurora`, `.stage-canvas` (= window colour),
`data-light`, `<EdgeLight/>`, `data-tilt`, `<Tilt>`, `<Specular>`, `<Magnetic>`, `--glow-*`, the button sheen.

## 2. Type and numbers

- `<Text v="title|h1|h2|h3|section|body|doc|ui|small|micro|mono" tone weight as>` — the only type primitive.
  Weights 400 / 500 / 600 / 700; no uppercase eyebrows; sentence case.
- `<Amount value role="hero|lg|row|axis" total exact colored dimCents align />` — money set like a statement:
  tabular, symbol at full size, U+2212, ≥ 1,000 drops cents on summaries, ledger cents in tertiary, `exact` hero
  balances get superscript cents (the decimal stays in the DOM, visually hidden, so copy and screen readers get
  "4,218.37"). One `hero` per view.
- `<Delta money percent points text dir invert label digits arrow />` — "↗ $1,342 (4.6%) vs last month", text with a
  drawn arrow; it copies as "Up $1,342 (4.6%) vs last month".
  Use `points` for differences between rates. `<DeltaPill>` still works (it renders the same text) but new code
  imports `Delta`; the ratchet counts DeltaPill imports.
- `<KpiTile>` is a labelled figure now (20/26 500; `size="xl"` = the 32/38 600 hero).
- `<RollingNumber value format />` — the final value is in the DOM at frame 1. It never rolls on its own: call
  `markUserEdit()` (same module) in the edit handler right before committing a user-typed value and the next change
  rolls (`roll="edit"`, default); `roll="always" | "never"` override. `countUp*` props are ignored.
- Charts: one ink line, no gridlines, no gradient fill, dotted start reference, crosshair rewrites the header
  (`HeroAreaChart`, `onScrub`). Colour only for multi-series. `Sparkline` is a line and a dot.

## 3. Icons (no emoji)

```tsx
import { Glyph, PageGlyph, glyphName } from "@/ui/icons/Icon";
import { IconPicker } from "@/ui/IconPicker";

<PageGlyph icon={page.icon} context="row" />        // 16px @1.25, secondary; file-text in tertiary when no icon
<PageGlyph icon={page.icon} context="header" />     // 40px @1.75, ink; nothing when no icon
<Glyph name="plane" context="inline" />             // any registered glyph
<IconPicker value={glyphName(icon)} onSelect={(v) => save({ t: "lucide", v })}><button>…</button></IconPicker>
```

- `<IconPicker>` lazy-loads its panel (`IconPickerPanel`, with the search keywords) on first hover / focus / open.
  The panel is a combobox → listbox: focus stays in search, `aria-activedescendant` names the active glyph, cells are
  not tab stops, ArrowUp / ArrowDown keep the visual column across groups.

- Plain-DOM node views: `glyphSvg(name, context)` / `iconSvg(icon, context)` from `@/ui/icons/domGlyph`.
- Data: `src/ui/icons/emoji-map.json` (288 emoji → Lucide names; the Rust lane `include_str!`s it) and
  `src/ui/icons/pageIcons.ts` (120 curated glyphs in 8 groups). `src/ui/icons/glyphs.ts` is the static registry of
  both; `pageIcons.test.ts` fails when they drift.
- Never `Sparkles` / `Sparkle`. No icons in headings or tabs. No emoji in UI strings, seeds or manifests.

## 4. Motion (`src/ui/motion/*`)

The register (`motion/register.ts`) is the source of truth: **C0** instant (hover, selection, tabs, routes,
keyboard-opened overlays), **C1** feedback ≤ 160ms (press, tick, switch, mouse-opened menus, toasts), **C2**
continuity ≤ 220ms (dialog, sheet, peek, drag, reorder, chart morph, a roll after `markUserEdit()`), **C3** exactly three
moments ≤ 600ms (vault unlock, life-app build, reconcile success). Add an entry before adding an animation.

| Want | Use |
|---|---|
| A dialog / sheet / menu animation | nothing: the kit components already follow the register |
| A confirmation after an action | `celebrate(el)` (an ink check, C2) |
| A shared element in one tree | `<Morph id>` or `m.* layoutId` (`spring.morph` = 220ms ease-out) |
| Your own JS animation | `motionSeconds("dialog")`, and check `isReducedMotion()` |
| Press feedback on a non-button | `.emp-pressable` |

Gone (no-ops kept for compatibility): `<Reveal>`, `<Stagger>`, `presets.rise/riseBlur/cardEnter/page`,
`staggerItem`, `burst()`, `confetti()`, `<Confetti>`, `iconMotion`, `sheen`. Route transitions are 0ms; stagger is 0.
Keyboard-invoked overlays open at once (`html[data-input="keyboard"]`, set by `MotionProvider`).

## 5. Rules that keep it honest

- Depth only on keys; shadows only on floating layers. One container level. ≤ 1 ink key per view.
- Ink is the only accent: links, focus, selection, chart lines. Gain / loss colour only on deltas and over-budget
  amounts. Categorical colour only inside multi-series charts and 6px dots.
- Radii 4 / 6 / 10 / 12 (+ full for avatars and switch tracks). Weights 400 / 500 / 600 / 700.
- Nothing loops after settle (spinners and indeterminate progress only while loading). Nothing counts up on arrival.
- Kbd hints are bound: a hint that goes down must be a shortcut that fires.
- Money: `<Amount>` / `<Sensitive>`, U+2212, never parentheses, never "USD" literals.
- Run `npm run guards` before handing off; the census and settle gates on your routes before closing a sweep.

## 5b. Requests to the shell team (`src/features/shell/**`)

- Sidebar selection: a flat `--state-selected` wash (`<GlideHighlight tone="slab">` now renders exactly that); the
  sidebar's own `.sb-slab*` key recipe should go.
- `PageIcon` should delegate lucide and emoji icons to `PageGlyph` (asset icons stay as they are).
- Command palette group labels: sentence case (no uppercase).

## 6. Route-ready mark (`emp:route-ready`)

The main outlet emits one signal per route mount when the route's data has loaded and its first content has painted.
Tests, gates and visual baselines wait on it instead of sleeping.

- **What fires:** `window.dispatchEvent(new CustomEvent('emp:route-ready', { detail }))` and
  `performance.mark('emp:route-ready', { startTime: detail.at, detail })`, with `detail = { route, at, ms, timedOut }`:
  `route` is the route key, `at` the `performance.now()` timestamp of the first frame from which the route stayed idle,
  `ms` the time from the route's content mounting to `at`. The mark is backdated to `at`; the event itself fires at
  least 100 ms plus two frames later. Measure from `at` (or the mark's `startTime`), not from when the event arrives.
- **When:** `src/app/routeReady.ts`, called once from `src/app/routes.tsx` (`RouteReadyMark`, inside the route's
  Suspense boundary, so the lazy chunk has resolved). After two animation frames it looks for loading markers in the
  route pane. The first frame with none becomes `at`. The pane must then stay free of markers for a 100 ms hold
  (`QUIET_MS`; chained loads leave short gaps, and a marker that comes back resets `at`). After the hold and two more
  frames it emits. If a marker never clears, it emits after 8 s with `timedOut: true` (`at` is then the last idle
  start, or the time of the timeout).
- **Loading markers** (any of these inside the route pane holds the mark back): `.emp-route-skeleton` (`<RouteSkeleton>`),
  `.emp-skeleton` (`<Skeleton>`, including `<SkeletonSwap>`'s hidden pending state), `[aria-busy="true"]`, and
  `[data-route-busy]`. A feature that loads its main data without a skeleton should put `data-route-busy` on its root
  while loading. A number that animates after the mark counts as motion on arrival in the settle gate.
- **Cost:** a few `requestAnimationFrame`s and one timer per navigation, plus one `MutationObserver` on the route pane
  (`class`, `aria-busy` and `data-route-busy` attributes and child lists) from the route's mount until the mark fires,
  at most 8 s. It is disconnected when the mark fires or the route unmounts. Side peeks (`<RouteView>` without `readyHost`) don't emit, and nor do sub-target changes that
  keep the route key (a hub tab, a settings section, a block anchor): those don't remount the route. To measure a tab,
  load its URL fresh.
- **Listening:** `addEventListener('emp:route-ready', (e) => …)`, or after the fact
  `performance.getEntriesByName('emp:route-ready')`. Playwright: add an init script that records the events, then
  `page.waitForFunction(...)`, as `scripts/gates/lib.js` does.
