# Ultra Note UI kit v2 "Slab" — guide for feature teams

The binding spec is `docs/DESIGN.md`. This page is the short version: **which primitive or class to use for what**.
Live reference: `http://localhost:1420/ui-gallery.html` (add `?theme=dark|midnight&effects=full`); every component in
every state, plus the Materials and Motion lab sections. All existing component APIs still work — v2 only adds props.

## 1. Materials (CSS classes, `src/styles/material.css`)

| Need | Use | Notes |
|---|---|---|
| Something you press | `<Button>` / `<IconButton>` — or `.slab` on your own element | `.slab` = keycap. Variants: `.slab-primary`, `.slab-danger`, `.slab-soft`, `.slab-ghost`; latched: `.slab-latched` / `aria-pressed="true"` / `data-active`. Set `--edge` (1.5px small, 2px md, 3px lg). Leave ≥ 4px below rows of slabs. |
| A recessed bed (input, track, bed of a control) | `.well` (or `.well-groove` for thin tracks) | `data-invalid`, `data-disabled`, `data-readonly`, `data-static` (no hover/focus swap). |
| A card / tile / widget / sidebar plate | `<Card>` or `.panel` | `data-raise` = interactive lift; `data-light` + `<EdgeLight/>` = pointer rim light; `data-specular` = broad wash (hero & KPI only); `data-tilt="3"` = ≤3° tilt. **Never on table rows or list items.** |
| Floating layer | `.glass-1` (menus, popovers, toasts) · `.glass-2` (dialogs, sheets, palette) · `.glass-3` (full-bleed veils) | Add `data-opaque` when it opens inside another overlay (≤ 2 blur layers). Reduced effects / more contrast make glass opaque automatically. |
| Divider | `.groove-h` / `.groove-v`, or `.groove-top` / `.groove-bottom` on a container | Engraved 2px line — use instead of 1px borders inside panels. `<Separator/>` renders one. |
| Thumb / dot / pip | `.dome` (neutral) · `.dome-lit` (selected, accent-aware) | |
| Page background | `.canvas-halo` or `background: var(--canvas-bg)` | The one key light; never animate it. |
| Film grain on a custom surface | `.grain` | Panels already have it. |

Tailwind utilities: `bg-well`, `bg-panel`, `bg-glass`, `bg-ghost`, `text-chart-line`, `shadow-panel`, `shadow-raise`,
`shadow-glass`, `shadow-glass-1`, `shadow-well`, `shadow-glow-gain`, `shadow-glow-loss`, `ease-release`, `ease-thumb`,
`ease-pop`, `ease-glide`, `ease-settle`, `ease-morph`, `ease-press`, `ease-sheen`; variants `more-contrast:`,
`midnight:`, `reduced-motion:`, `reduced-effects:`.

Key tokens: `--panel-*`, `--well-*`, `--slab-{s,p,d}-*`, `--lit-a/b/fg/glow`, `--glass-*`, `--ring`, `--ring-halo`,
`--groove-dark/lite`, `--chart-line`, `--chart-fill-top`, `--glow-gain`, `--glow-loss`, `--canvas-bg`.
`--elev-1…4` still exist and are now derived from panel/glass shadows.

```tsx
// a custom clickable tile
<div className="panel p-4" data-raise data-light data-tilt="3" role="button" tabIndex={0}>
  <EdgeLight />
  …
</div>
// a toolbar of latched keys (note the 4px bottom room for the slab edge)
<div className="flex gap-1 pb-1">
  <IconButton variant="secondary" size="sm" icon={Bold} label="Bold" active={isBold} aria-pressed={isBold} />
</div>
```

## 2. Components (what changed, what to pass)

- **Button** — `iconMotion="plus|arrow|trash|bell|download|upload|send|settings|refresh|search|sparkle"` for a hover
  micro-motion (not in menus, tables or sidebars). `sheen` (auto on primary lg/xl). `active` = latched. Press is CSS —
  do not wrap buttons in `whileTap`.
- **FilterChip** (`@/ui/Tag`) — tag-shaped keycap for filter rows: `<FilterChip active={on} count={12} onClick>Over $100</FilterChip>`.
- **Checkbox** `celebrate` — to-dos / Today / habits: ray burst + drawn strike-through (S13).
- **NumberField** `steppers` — mini keycap steppers with hold-to-repeat.
- **Ring** `completeMoment` — glow + centre check at 100% (default on for ≥ 40px rings without children).
- **KpiTile** — clickable tiles get edge light, specular and tilt automatically; `countUpKey` for once-per-session count-up; sparkline defaults to ink (`sparkColor="ink"`).
- **Card** — `light`, `specular`, `tilt` props (in addition to `interactive`).
- **Dialog** `originRef` — the element to grow from / close into (defaults to the control pressed just before opening). AlertDialog danger confirms glow (`--glow-loss`).
- **Sheet** — header drag-to-dismiss is built in.
- **EmptyState** `art="slab"|"icon"` — default is the animated slab glyph with your icon on a keycap badge.
- **FileDropZone** `progress` — progress groove; omit `icon` to get the exploding slab glyph on drag-over.
- **Badge** `live` — breathing LED dot; numeric children roll.
- **Tabs** — counts roll; panels slide laterally. **Segmented** — squash glide. Both need no changes.
- **LineChart / AreaChart** — single-series trends are **ink** by default; pass `colorBySign` to colour the line. `HeroAreaChart` draws with a pen, pulses the end dot, scrubs the number, counts up once per session (`countUpKey`).
- **Sparkline** `color="ink"`.
- **SlabGlyph** — the icon's 3-slab stack, theme-toned: `<SlabGlyph size={40} animate exploded tint="var(--block-blue-text)" />`.
- **GlideHighlight** — drop inside any positioned list container to get the gliding highlight plate:
  `<GlideHighlight selector='[aria-selected="true"]' tone="slab" />` (palette / sidebar style).

## 3. Motion (`@/ui/motion/*`)

Tokens (`motion/tokens.ts`): `duration.{press,micro,fast,base,hover,moderate,slow,deliberate,chart,draw,cinematic}`,
`ease.{out,outExpo,in,inOut,press,sheen}`, `spring.{release,thumb,pop,glide,settle,morph,roll,magnet,drag}` (legacy
`snappy/ui/gentle/layout/bouncy` still work), `stagger.{cards,rows,digits,bars}`. CSS mirrors: `var(--spring-X)` with
`var(--dur-X)` — e.g. `transition: transform var(--dur-release) var(--spring-release)`.

| Want | Use |
|---|---|
| One element enters | `<Reveal variant="rise|rise-blur|fade|scale|drop|slide-left|slide-right" delay inView>` |
| A grid/list cascades in | `<Stagger kind="cards|rows" variant inView className="grid …">{items}</Stagger>` (caps at 8 cards / 12 rows, ≤ 320ms) |
| Presets for `m.*` | `presets.rise`, `presets.riseBlur`, `presets.dialogPanel`, `staggerList()`, `staggerItem` |
| Tilt / light any surface | `<Tilt max={3}>`, `<Specular wash>` |
| Press-like feedback on a non-button | `<Pressable>` / `.emp-pressable` |
| Magnet CTA (onboarding / wizard finish only) | `<Magnetic><Button variant="primary" size="lg">…</Button></Magnetic>` |
| Shared element in one tree (KPI → detail) | `<Morph id="kpi-x">` or `m.* layoutId` + `spring.morph` |
| Shared element across routes (page open, app install) | `vtStyle(vt.pageIcon(id))` on source + target, navigate inside `withViewTransition(() => navigate(…))` |
| Numbers | `<RollingNumber value format countUpKey scrubbing sensitive />` (alias `NumberRoll`) |
| Success | `celebrate(el)` (goal: mini-slabs + gain check), `confetti(el)`, `burst(el)` (8 rays), `<Celebrate fire={n}/>` |
| Theme change | `switchThemeWithReveal(apply, toggleEl)` (480ms circular re-light) |

Route transitions are automatic (`src/app/routes.tsx`): forward / back / lateral from the nav store, `:root[data-nav-dir]`
mirrors it. Tabs set `data-nav-dir=lateral` and `--nav-sign`.

## 4. Rules that keep it fast and accessible

- Animate **transform, opacity, filter** only. No `box-shadow`/`width`/`height`/`top` animation (pre-bake shadows on a pseudo-element and fade it).
- Never more than 2 `backdrop-filter` layers and 3 concurrent blur animations. Glass inside a dialog → `data-opaque`.
- No raised slabs inside table rows or virtualised lists — row actions are ghost.
- Nothing loops except Spinner, Skeleton shimmer and the live ping.
- Reduced motion (`data-motion=reduced`): CSS recipes drop travel automatically; `m.*` uses MotionConfig. Make your own JS animations check `isReducedMotion()`.
- Reduced effects (`data-effects=reduced`, set by the frame monitor): glass/grain/light/tilt/particles go away automatically for kit classes.
- Money: tabular numbers, U+2212, `data-sensitive` / `<Sensitive>`; masked values never roll.
- Single-series trend lines are ink; colour lives in the DeltaPill and the end-dot halo.

## 5. Requests to the shell team (`src/features/shell/**`)

- `.emp-main { background: var(--canvas-bg); }` (canvas halo, §3); sidebar as a `.panel`-like plate with grain and a
  `.groove-v` right edge; topbar `.glass-1` once scrolled.
- Sidebar selection: a `.emp-glide` / `<GlideHighlight tone="slab" selector='[aria-current="page"]'>` slab (S11).
- Command palette: `<GlideHighlight tone="slab" />` in the list and `<Kbd>` footers (living keycaps, S1/S7).

## 6. Route-ready mark (`emp:route-ready`)

The main outlet emits one signal per route mount when the route's data has loaded and its first content has painted.
Tests, gates and visual baselines wait on it instead of sleeping.

- **What fires:** `window.dispatchEvent(new CustomEvent('emp:route-ready', { detail }))` and
  `performance.mark('emp:route-ready', { detail })`, with `detail = { route, ms, timedOut }` (`route` is the route key,
  `ms` the time from the route's content mounting to the mark).
- **When:** `src/app/routeReady.ts`, called once from `src/app/routes.tsx` (`RouteReadyMark`, inside the route's
  Suspense boundary, so the lazy chunk has resolved). After two animation frames it waits until the route pane holds no
  loading marker, then waits two more frames and emits. If a marker never clears, it emits after 8 s with
  `timedOut: true`.
- **Loading markers** (any of these inside the route pane holds the mark back): `.emp-route-skeleton` (`<RouteSkeleton>`),
  `.emp-skeleton` (`<Skeleton>`, including `<SkeletonSwap>`'s hidden pending state), `[aria-busy="true"]`, and
  `[data-route-busy]`. A feature that loads its main data without a skeleton should put `data-route-busy` on its root
  while loading. A number that animates after the mark counts as motion on arrival in the settle gate.
- **Cost:** two `requestAnimationFrame`s per navigation, plus a `MutationObserver` on the route pane only while a
  marker is present. Side peeks (`<RouteView>` without `readyHost`) don't emit, and nor do sub-target changes that
  keep the route key (a hub tab, a settings section, a block anchor): those don't remount the route. To measure a tab,
  load its URL fresh.
- **Listening:** `addEventListener('emp:route-ready', (e) => …)`, or after the fact
  `performance.getEntriesByName('emp:route-ready')`. Playwright: add an init script that records the events, then
  `page.waitForFunction(...)`, as `scripts/gates/lib.js` does.
