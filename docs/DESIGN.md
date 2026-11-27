# Ultranote Design Language v3 — "Paper, ink and keys"

**Status:** binding for all UI work from Phase 1 of the v3 programme (`docs/design/PROGRAMME-v3.md`). It supersedes
v2 "Slab" and SPEC §3–§5 for materials, depth, colour use and motion (CLAUDE.md override 5). Token **names** and
component **APIs** stay compatible with SPEC; reduced motion, contrast and tabular-number rules still apply; IPC and
data contracts remain SPEC §11.

**Short version for feature teams:** `docs/design/KIT.md`. **Live reference:** `ui-gallery.html` (the gallery shows
every token, the type scale, keys, money typesetting, the glyph set and the motion register in light, dark and
midnight).

**Owner rulings this document encodes** (PROGRAMME-v3, "Your rulings are built in"):

1. Direction A, "paper, ink and keys".
2. **Subtle** keys: depth only on things you press.
3. Home is the day (Flow's spec governs the layout; this document governs how it is drawn).
4. Earned motion: frequent actions are instant; no numbers roll on arrival; three signature moments only.
5. **No emoji anywhere in the app.** Text a user types into their own documents is the only exception.

---

## 1. What makes it Ultranote (the R-4 signature rules)

These five rules are the identity. Token values can be copied by any theme generator; these cannot.

1. **Only ink.** Graphite ink is the text colour and the only accent: links (a 40% underline), the focus ring, text
   selection, checked fills, the primary key and the chart line. Gain and loss colour appears **only** on deltas and
   over-budget amounts.
2. **Keys answer your hands.** The only raised objects are keys: one ink key per view (the primary action), paper keys
   for secondary actions, Kbd hints and the thumbs of switches and segmented controls. A key presses 0.5px when you
   press it. A Kbd hint goes down only when its exact shortcut fires, never while you type.
3. **Statement numerals.** IBM Plex Sans with tabular figures, the currency symbol at full size, a true minus,
   dimmed cents in ledgers, deltas written as text. Scrubbing a chart rewrites the header figure.
4. **Ruled, not boxed.** Hierarchy comes from four weights, hairlines and space. A section is a 14/600 head over a
   hairline. One container level at most; nothing bordered sits inside something bordered. 13px UI density.
5. **One monochrome glyph language.** Every page, app, habit and category icon is a curated Lucide line glyph in ink.
   The sidebar reads as a typeset index.

**Also always true:**

- Things you summon float (menus, popovers, dialogs, the palette, toasts). Nothing else has a shadow.
- Motion is earned (§7): the more often something happens, the less it moves.
- Warm paper, not cream. The canvas is `#fdfdfc`.

---

## 2. Tokens (`src/styles/tokens.css`)

All values are CSS custom properties on `<html>`. Theme variants: `data-theme="light|dark|midnight"`. Values below
are light / dark; midnight is dark with a true-black canvas (`#000`) and surfaces `#141413` / `#1e1e1d`.
The contrast test (`src/test/guards/contrast.test.ts`) checks every pair: text ≥ 4.5:1, tertiary text, focus ring and
the strong border ≥ 3:1. **Its allowlist is empty.**

### 2.1 Paper and ink

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg-window` | `#f7f6f4` | `#1f1f1e` | window, sidebar |
| `--bg-canvas` | `#fdfdfc` | `#1a1a19` | the page (paper) |
| `--bg-surface-1` | `#fdfdfc` | `#1a1a19` | = canvas (flat) |
| `--bg-surface-2` | `#f1f0ed` | `#252524` | beds, wells, callouts, pressed fills |
| `--bg-surface-3` | `#e8e7e3` | `#2e2e2c` | tracks, rails |
| `--bg-overlay` | `#ffffff` | `#252524` | menus, dialogs, toasts |
| `--text-primary` (ink) | `#262624` | `#ecebe8` | text, links, focus, selection, chart line |
| `--text-secondary` | `#67645e` | `#a8a59f` | labels, meta, chrome icons |
| `--text-tertiary` | `#87847e` | `#8a8781` | placeholders, axis, hints (≥ 3:1) |
| `--text-disabled` | `#b3b0aa` | `#5f5d59` | |
| `--border-subtle` / `--border` | `rgba(40,30,10,.07)` / `.09` | `rgba(255,255,240,.07)` / `.09` | hairlines |
| `--border-field` / `-hover` | `rgba(40,30,10,.14)` / `.24` | `rgba(255,255,240,.14)` / `.24` | input outlines |
| `--border-strong` | `rgba(40,34,24,.5)` | `rgba(255,255,240,.36)` | control boundaries (checkbox, radio) at ≥ 3:1 |
| `--state-hover` / `-active` | `rgba(40,34,24,.05)` / `.08` | `rgba(255,255,240,.055)` / `.09` | ink washes |
| `--state-selected` | `rgba(40,34,24,.06)` | `rgba(255,255,240,.08)` | selected rows (flat, never raised) |
| `--text-selection` | `rgba(40,34,24,.14)` | `rgba(255,255,240,.2)` | |
| `--accent-ring` → `--ring` | `#8e8b86` | `#8a8883` | 2px focus ring, 1px offset (≈ ink at 50%) |

Notion's measured values (`references.md` §1.2) are the calibration: text `#2c2c2b`, secondary `#7d7a75`, dividers
`rgba(42,28,0,.07)`. Ultranote is a shade warmer and its secondary is darker to pass 4.5:1 on every surface.

### 2.2 Accent, semantic and data colour

- **Graphite is the default accent, and it is ink.** The owner's accent picker keeps iris, ocean, jade, amber, ruby
  and orchid; a non-graphite accent re-derives **only** the primary key, checked fills, the focus ring and selection.
  Links and chart lines stay ink.
- **Gain / loss:** `--gain-text #1d7a45` / `#5ccb94`, `--loss-text #b8382f` / `#f2837a`. Used on deltas and
  over-budget amounts only. `data-numbers="cvd" | "eastasian" | "mono"` swap them.
- **Warning** `#8f5800` / `#e3b05a`; **info** `#3d5f84` / `#9dbcdd` (rare).
- **Data colour:** six muted hues (`--cat-1…6`: slate blue, sage, ochre, brick, plum, teal; `--cat-7/8` are greys),
  used only inside multi-series charts and as 6px category dots. The Tailwind-500 set is retired.
- **Block / tag colours** (`--block-*`) are user content (tags, callouts, highlights): a Notion-style low-chroma tint
  ladder.

### 2.3 Type

**Typeface: IBM Plex Sans** (OFL-1.1, `@fontsource-variable/ibm-plex-sans`, latin + latin-ext, one variable file
covering 400–700, preloaded, `font-display: block`). Figures are tabular by default and U+2212 is as wide as "+".
Code and the sheets formula bar use JetBrains Mono. The Newsreader serif remains only as a per-page font choice for
user documents.

Weights: **400, 500, 600, 700 only** (the style ratchet fails anything else). Tracking: 0 below 20px, −0.01em at
20–30px, −0.02em at 40px. **No uppercase eyebrows.** Sentence case everywhere.

| Role (`<Text v>`) | Size / line | Weight | Use |
|---|---|---|---|
| `title` | 30/39 | 600 | app and hub titles |
| `h1` | 24/31 | 600 | |
| `h2` | 20/26 | 600 | |
| `h3` | 16/24 | 600 | dialog titles |
| `section` | 14/20 | 600 + hairline below | a section head (ruled, not boxed) |
| `body` | 14/20 | 400 | UI body |
| `doc` | 16/24 | 400 | document body |
| `ui` | 13/18 | 400 | dense UI, rows, meta |
| `small` | 12/16 | 400 | labels, captions |
| `micro` | 11/14 | 500 | kbd, axis |
| `mono` | 13/20 | 400 | |
| document title | 40/48 | 700 | `.emp-title` (−0.02em) |

Tailwind `text-*` utilities (`theme.css`) carry the same values (`text-h1` = 30/39 600, `text-kpi` = 20/26 500,
`text-kpi-xl` = 32/38 600, `text-caption` = 12/16 400, `text-micro` = 11/14 500, tracking 0).

### 2.4 Space, radii, sizes

- **Radii:** 4 (pills, inline code, Kbd, tags), 6 (controls, rows, buttons), 10 (callouts, cards, menus, popovers,
  toasts), 12 (dialogs, sheets), full (avatars and switch tracks only). Token names keep working: `--radius-xs 4`,
  `-sm 6`, `-md 6`, `-lg 10`, `-xl 12`, `-2xl 12`.
- **Rows:** 28px for sidebar, menu and list rows; 36px for database table rows and their header (chair resolution).
  `--row-list` 36px for ruled lists on hubs.
- **Controls:** 24 / 28 / 32 / 36 / 40 (`--control-xs…xl`).
- **Hairlines:** 1px. Never 2px "engraved" grooves.

### 2.5 Elevation (only for what floats, and for keys)

| Level | Recipe | Use |
|---|---|---|
| E0 | flat | everything at rest |
| E1 | `0 0 0 1px rgba(42,28,0,.07)` | a quiet ring (rare; prefer a border) |
| E2 | `0 8px 12px rgba(25,25,25,.03), 0 2px 6px rgba(25,25,25,.03), 0 0 0 1px rgba(42,28,0,.07)` | menus, popovers, tooltips' cards, chart tooltips |
| E3 | `0 20px 24px rgba(25,25,25,.05), 0 5px 8px rgba(25,25,25,.03), 0 0 0 1px rgba(42,28,0,.07)` | dialogs, ⌘K, toasts |
| E4 | `0 24px 48px rgba(25,25,25,.16), 0 4px 12px rgba(25,25,25,.08), 0 0 0 1px …` | full-height sheets |

Dark themes use the same structure with a `rgba(255,255,240,.09)` ring and heavier blur alphas. Floating layers are
**opaque**; there is no backdrop blur at rest (`--glass-blur: none`).

### 2.6 Keys

| Key | Recipe |
|---|---|
| **Ink key** (`.slab` primary) | face `linear-gradient(#3b3b38, #262624)` (dark: `#f4f3f0 → #dcdad5`), `inset 0 -1.5px 0 rgba(0,0,0,.38), 0 1px 1.5px rgba(30,25,10,.22)`. No pseudo-elements. ≤ 1 per view. |
| **Paper key** (`.slab` secondary) | `--key-paper` face (`#fff` / `#2e2e2c`), `inset 0 0 0 1px` ring at 13%, `inset 0 -1px 0` bottom edge, `0 1px 1px` contact |
| **Press** | `translateY(.5px)`, the bottom edge and contact collapse in 60ms; release 100ms ease-out, no overshoot |
| **Kbd chip** (`.keycap`) | 18px, radius 4, 11/500, a 1px `--border-field` outline with a darker bottom edge; goes down 0.5px for 120ms when its shortcut fires |
| **Thumbs** | paper face, 1px ring, 1px shadow (`--dome-shadow`) |

---

## 3. Materials: v2 names, v3 values (`src/styles/material.css`)

Feature code still uses v2 class and token names. They resolve to v3:

| v2 name | v3 meaning |
|---|---|
| `.slab`, `.slab-primary`, `.slab-ghost`, `.slab-soft`, `.slab-danger`, `.slab-latched` | the key (§2.6); ghost = 5% ink wash, soft = accent-soft wash; latched = pressed |
| `--slab-s-*`, `--slab-p-*`, `--slab-d-*` | paper key, ink key, loss key (gradients collapse to one colour; sides become the bottom edge) |
| `.well`, `--well-*` | a flat field / bed (`--well-bg` = surface-2, no inset shadow) |
| `.panel`, `--panel-*` | a quiet container: hairline border, radius 10, no shadow. **A panel or card inside a panel loses its frame.** |
| `.glass-1/2/3`, `--glass-*` | opaque floating layers (E2 / E3 / scrim). No blur. |
| `.groove-*`, `--groove-*` | 1px hairlines |
| `.dome`, `.dome-lit`, `--lit-*` | paper thumb; ink fill |
| `.canvas-halo`, `--canvas-bg`, `.stage-canvas`, `.emp-aurora`, `.grain` | flat paper (halo, grain and aurora retired) |
| `--glow-*`, `--edge-light`, `--specular`, `[data-light]`, `data-tilt` | retired (resolve to nothing) |
| `--spring-*`, `--dur-*` | ease-out curves without overshoot (§7) |

---

## 4. Components (`src/ui`)

APIs are unchanged unless noted; retired props are accepted and ignored (`@deprecated` in the type).

### 4.1 Actions
- **Button** — variants `primary` (ink key), `secondary` (paper key), `ghost`, `soft`, `destructive`,
  `destructive-ghost`, `link` (ink, 40% underline). Sizes 24/28/32/36/40, 13px labels (14px at lg/xl), weight 500.
  `kbd` adds a Kbd chip. `active` latches. `sheen` and `iconMotion` are retired.
- **IconButton** — ghost by default, 16px glyph at 1.25.
- **Kbd** — `keys="mod+k"`; renders `data-chord` and answers only full-chord matches (`motion/keycaps.ts`).

### 4.2 Inputs
- **Input / Textarea / NumberField / SearchField / MoneyField** — a flat field: canvas fill, 1px `--border-field`,
  radius 6; hover darkens the hairline instantly; focus = 2px ink ring (`--ring`); invalid = loss outline.
- **Select / DatePicker / Combobox triggers** — fields, not keys.
- **Checkbox** — 16px, radius 4, 1.25px `--border-strong` outline; checked fills with ink and draws its tick (120ms);
  `celebrate` keeps the 150ms strike-through only.
- **Radio** — a ring; checked = ink ring + 8px ink dot. **Switch** — 32×18 flat track (ink when on), paper thumb,
  140ms travel. **Slider** — 4px track, ink fill, paper thumb.
- **Segmented** — flat surface-2 bed, paper thumb on the selected option; selection is instant.
- **Tabs** — a hairline with a 2px ink underline on the active tab; counts are tertiary text; switching is instant.

### 4.3 Display
- **Text** (`<Text v tone weight as>`) — the one type primitive (§2.3).
- **Card** — ruled, not boxed: no frame by default, a 14/600 head over a hairline. `framed` gives a hairline frame
  (radius 10) for the one container a view may have. `interactive` = instant ink wash. `light`, `specular`, `tilt`
  are retired.
- **KpiTile** — a labelled figure (label 12/16 secondary, value 20/26 500, `size="xl"` = 32/38 600), text delta,
  optional ink sparkline. No count-up.
- **Badge** — 18px, radius 4, 11/500 tint; **Tag** — Notion's 20px tint pill; **FilterChip** — a small paper key.
- **Avatar** — a flat disc. **Skeleton** — static (no shimmer). **Progress** — 4px track, ink fill.
- **EmptyState** — a 24px tertiary line glyph (optional), a 14/600 title, one 13/18 sentence, at most one key.
- **Banner** — a flat tinted band (warning / danger tints; neutral = surface-2). No coloured left bar.
- **ChoiceCard** — hairline frame; selected = 2px ink frame with an ink check.
- **Dialog / Sheet / AlertDialog** — opaque paper, E3 / E4, radius 12; title 16/24 600.
- **Menu / ContextMenu / Popover / Select list** — opaque paper, E2, radius 10, 28px rows, 16px glyphs in secondary
  ink, shortcuts in 12px tertiary on the right, 1px separators, group labels 12/500 tertiary in sentence case.
- **Tooltip** — an ink pill (inverse), radius 6, 12/500.
- **Toast** — opaque paper, E3, radius 10; success mark is an ink check in a 1.5px ring.

### 4.4 Icons
- **IconPicker** (`src/ui/IconPicker.tsx`) and **Glyph / PageGlyph** (`src/ui/icons/Icon.tsx`). See §8.

---

## 5. Layout anatomy

- Hubs and Home: a 30/600 title (or the date on Home), at most one meta line, then ruled sections: a 14/600 head over
  a hairline, 36px rows with a hairline between, figures right-aligned and tabular. No stat banners, no card grids, no
  coloured tiles, no icons in headings or tabs.
- Documents: a 720px column, 40/48 700 title, 16/24 body, 30px block pitch; callouts are a 10-radius tint with no
  border; covers are uploaded images only (stored v2 gradient covers are not drawn; "Add cover" asks for an image) and
  the page icon sits straight on the cover with no tile behind it.
- One container level per view. A frame inside a frame loses its border automatically (`.panel .panel`,
  `.emp-card .emp-card`).
- At most one ink key per view.

---

## 6. Money typesetting (Money N-MO4 with the chair's resolutions)

### 6.1 Roles (`<Amount role>`)

| Role | Size / line | Weight | Rule |
|---|---|---|---|
| `hero` | 32/38 | **600** | one per view; label 13/18 above, delta line 13/18 below. Summaries ≥ 1,000 drop cents; an exact balance (`exact`) shows superscript cents at 0.55em, `vertical-align: .42em`, secondary ink |
| `lg` | 20/26 | 500 | secondary figures (replaces KPI cards); label 12/16 sentence case; ≥ 1,000 drops cents |
| `row` | 14/20 (13/18 dense) | 400; totals 600 | ledgers, right-aligned; cents full size in tertiary ink |
| `axis` | 11/14 | 400 | tertiary |

### 6.2 Number rules
- **Symbol** at full size via `Intl.NumberFormat` `currencyDisplay: 'narrowSymbol'` (`moneyParts`); never concatenate
  "$".
- **Negatives:** U+2212 before the symbol (`−$84.17`). Never parentheses. Never red for ordinary expenses.
- **Cents:** none on summaries of 1,000 or more; never mix 0 and 2 decimals in one card or line.
- **Decimals:** prices ≥ $1 → 2, prices < $1 → 4, return percentages → 1, drift and tax rates → 0. Never "−0.0".
- **Deltas** (`<Delta>`): written as text with an arrow: `↗ $1,342 (4.6%)` + a secondary label ("vs last
  month"). No pill, no fill. The arrow is drawn (Lucide `arrow-up-right` / `arrow-down-right`, 0.85em,
  `absoluteStrokeWidth`), because the UI face's subsets carry no U+2197 / U+2198 and a fallback font would set it in
  another weight. Copied and spoken text is plain words: "Up $1,342 (4.6%) vs last month". Differences between rates are **points**: `↗ 1.2 pts`. `invert` swaps colour
  meaning for spending and debt; the arrow stays truthful. `<DeltaPill>` keeps its API and renders the same text
  (the ratchet counts its imports; new code imports `Delta`).
- **Date ranges** carry years when they cross a year boundary.
- **Hide numbers** masks every `data-sensitive` value; masked values never roll.

### 6.3 Charts (`src/charts`)
- **One ink line on nothing.** A single series is a 1.75px ink line (`--chart-line`), no gridlines, no gradient fill,
  y-axis on the right in tertiary 11px with 3–5 ticks, a dotted 1px reference line at the start value, a 3px end dot.
- **Colour only for multi-series** (muted `--cat-*`, 1.5px lines, an 8% flat fill if `area`).
- **Bars start at zero.** The donut becomes a sorted list of 4px bars; Money, Portfolio and Tax use **no rings**.
- **Crosshair scrub** (1px tertiary line, a 4px dot with a paper ring) rewrites the header figure, delta and date in
  place (`HeroAreaChart`, `onScrub`). Charts are keyboard-focusable.
- **Heights:** 220 for the hero chart, 140 for card charts.
- **Motion:** lines reveal in 220ms on the first data load only; a data change morphs for 200ms; nothing pulses,
  halos or rides a pen.

---

## 7. Motion register (`src/ui/motion/register.ts`)

Every animation belongs to exactly one class. `register.test.ts` fails when an entry leaves its budget, when anything
but the three signature moments claims C3, when a JS curve overshoots, or when kit CSS runs a finite animation or
transition longer than 600ms.

| Class | What | Budget |
|---|---|---|
| **C0 instant** | typing, hover-in, row focus / select, tab / segmented / sidebar selection, route change, keyboard-opened ⌘K and menus, Home | 0ms in; out ≤ 120ms; content present at frame 1 |
| **C1 feedback** | key press (60ms), Kbd chip (120ms), checkbox tick (120ms) + strike-through (150ms), switch (140ms), mouse-opened menus and popovers (.97 → 1, 120ms), tooltip (80ms), toast (150ms in, 100ms out) | ≤ 160ms; ease-out; no overshoot |
| **C2 continuity** | dialog (160ms), sheet and side peek (200ms), drag and drop, reorder (220ms), chart morph (200ms) and first draw (220ms), a number rolling **after your own edit** (200ms), the quiet confirmation check | ≤ 220ms; critically damped; interruptible |
| **C3 moment** | exactly three: **vault unlock**, **life-app build** (its length is the real work), **reconcile success** | ≤ 600ms; skippable; a crossfade under reduced motion |

**Rules**
- **Route transitions are 0ms. Stagger is 0.** `presets.rise / riseBlur / cardEnter / page`, `<Reveal>`,
  `<Stagger>` and `staggerItem` are kept for API compatibility and no longer move anything.
- **Keyboard-invoked overlays open with no animation** (`html[data-input="keyboard"]`, set by `MotionProvider`):
  ⌘K, menu keys and dialogs opened from a shortcut appear at once; mouse-opened menus grow from their origin.
- **Input never waits on motion.** Nothing delays focus, typing or a click target.
- **Numbers never count up on arrival.** `RollingNumber` puts the final value in the DOM from the first frame (the
  copied text and the accessibility text are the plain value). Rolling is opt-in per edit: with
  `roll="edit"` (default) a change rolls only when the owning component called `markUserEdit()` in its edit handler
  just before committing the value (a typed amount, a ticked box); `roll="always"` is for explicit edit surfaces only.
  There is no global input listener, so navigation clicks, tab / range / month switches and data refreshes never roll.
  The roll is an `aria-hidden`, `user-select: none` overlay that moves the changed digits for 200ms over transparent
  real text. Scrubbing, Hide numbers and reduced motion never roll. `countUp`, `countUpKey`, `from` are accepted and ignored.
- **No overshoot** outside C3: `spring.*` in `motion/tokens.ts` are ease-out tweens; `--spring-*` in CSS are
  `var(--ease-out)`.
- **No idle animation** 1s after settle: no live halos, no breathing dots, no shimmer. Spinners and indeterminate
  progress are the only loops, and only while something is actually loading.
- **Retired:** arrival choreography, count-up on view, the word-blur greeting, the 8-ray burst (`burst()` is a no-op),
  confetti (`confetti()` is a no-op), the page-open morph, velocity squash, tilt, magnet, sheen, pointer edge light,
  halo pulses, the chart pen.
- `celebrate(el)` is now the C2 confirmation: an ink check fades in and out over 900ms in total (180ms in).
- **Reduced motion** (`data-motion="reduced"` or the OS setting): state changes stay, travel goes; C3 moments become
  a 150ms crossfade.

**Gates:** `scripts/gates/settle.js` (settle ≤ 300ms after `emp:route-ready`, target ≤ 150ms; 0 rolling numbers, 0
idle animations) and `scripts/gates/census.js` (≤ 12 shadows, ≤ 1 gradient, ≤ 5 radii, ≤ 4 weights on Home and
Money HQ). See `docs/design/gates-baseline.md`.

---

## 8. Icons and no emoji

- **One family:** curated Lucide (ISC), always `absoluteStrokeWidth`.

  | Where | Size | Stroke | Colour |
  |---|---|---|---|
  | sidebar, breadcrumb, rows, menus (`context="row"`) | 16px | 1.25 | secondary ink |
  | inline (`context="inline"`) | 14px | 1.25 | current |
  | page header (`context="header"`) | 40px | 1.75 | ink |

- **No Sparkles** anywhere (the style ratchet counts `Sparkles` / `Sparkle` imports). No icons in tabs or headings.
- **The picker** (`<IconPicker>`, `src/ui/icons/pageIcons.ts`): 120 curated glyphs in 8 searchable groups (documents,
  work, money, home & life, travel, health, learning, objects). Pages store `{ t: 'lucide', v: name }` (SPEC §11.2
  already has the variant).
- **The emoji map** (`src/ui/icons/emoji-map.json`): 288 emoji → Lucide names, a flat `{ "emoji": "icon-name" }`
  object with NFC keys and variation selectors stripped. The Rust backend `include_str!`s this exact file for the
  store migration, the importers and generated callouts. `pageIcons.test.ts` validates every name against
  lucide-react. ✨ maps to `star` (never a sparkle).
- **Rendering legacy data:** `PageGlyph` (React) and `iconSvg` / `glyphSvg` (plain DOM, `src/ui/icons/domGlyph.ts`)
  map `{ t: 'emoji' }` through the map at render time. **Unmapped:** the page header shows nothing; the sidebar,
  recents and links show a neutral `file-text` glyph in tertiary ink so rows stay aligned (chair resolution).
- **Existing data** keeps loading: `Icon` still deserialises `{ t: 'emoji' }`; export can round-trip the original.
- **The app never offers emoji:** no emoji picker, no `:` emoji inserter, no "Emoji" slash item. Text users type in
  their own documents is untouched.
- **The emoji lint** (`npm run guards`) fails on any `\p{Extended_Pictographic}` in `src/**`, the seed, defaults and
  life-app manifests (©, ®, ™ and typographic arrows without VS16 are allowed; the emoji map is exempt).

---

## 9. What not to do (the AI tells)

Measured against `scratchpad/v3/research/ai-tells.md` (47 tells). The kit already prevents most of them; sweeps must
not reintroduce any:

- **Colour:** purple / indigo gradients; gradient fills on buttons, panels or chips; glow, halo and neon; glass at
  rest; a rainbow of identity colours (coloured app tiles, coloured tags as decoration); cream `#F4F1EA`; terracotta.
- **Depth:** shadows and raised controls on everything; cards wrapping everything; nested cards; identical card grids;
  over-rounded corners (> 12) and pills everywhere; coloured left bars on cards.
- **Data:** a hero-metric (stat banner) row on every screen; decorative sparklines; rings and donuts everywhere;
  badge and pill overload; fake precision.
- **Type:** uppercase letter-spaced eyebrows; heavy bold display type; a serif display on warm paper; Title Case
  labels; Inter-everywhere defaults.
- **Icons:** emoji as UI icons; the sparkles icon for things that aren't magic; an icon on every heading, tab and
  button; a trailing arrow on every link; a coloured app icon next to every page title.
- **Structure:** a dashboard as the front door of everything; identical page anatomy for every area; duplicate
  navigation; the greeting hero.
- **Copy** (`docs/design/PROGRAMME-v3.md` K2): coach voice, cheerleading, taglines under every title, explaining the
  obvious, hedging boilerplate, "Show math" controls, em dashes, "we", self-praise, exclamation marks, "Tap".
- **Motion:** choreographed entrances; springy overshoot on frequent actions; looping ambient animation; celebrations
  and pointer effects for routine moments.

---

## 10. Guards and where they live

| Guard | File | What fails |
|---|---|---|
| Style ratchet | `src/test/guards/style-rules.ts` (+ `style-baseline.json`) | per-file counts rising: raw colours, literal shadows, gradients, blur, keyframes, infinite animations, `transition: all`, weights off {400,500,600,700}, radii off {4,6,10,12,full}, uppercase, inline styles, "USD", Sparkles and DeltaPill imports |
| Copy lint | `src/test/guards/copy-rules.ts` | banned phrases, Title Case labels |
| Emoji lint | `src/test/guards/emoji-rules.ts` | any emoji outside the map |
| Contrast | `src/test/guards/contrast.test.ts` | any token pair below 4.5:1 / 3:1 (empty allowlist) |
| Motion register | `src/ui/motion/register.test.ts` | budgets, C3 count, overshoot, CSS durations > 600ms, count-up on mount, Kbd chips on partial chords |
| Icon data | `src/ui/icons/pageIcons.test.ts` | map shape, unknown Lucide names, registry drift, sparkles |
| Bundle budget | `scripts/bundle-budget.mjs` | a chunk +5% (gzip), a new chunk > 50 KB, Home boot +3% |
| Census / settle (local) | `scripts/gates/` | §7 gates |

`npm run guards` must pass; `npm run guards:update` only lowers baselines. Tokens freeze after Phase 1: sweep lanes
may not edit `tokens.css`, `material.css` or `theme.css`.

---

## 11. Checklist for an area sweep

1. Delete what K4 deletes first; never restyle a screen that is going away.
2. Replace emoji with `PageGlyph` / `Glyph` (or the map for data); no Sparkles; no icons in headings or tabs.
3. Containers: one level. Swap card grids for ruled sections (`<Text v="section">`, 36px rows, hairlines).
4. One ink key per view; everything else secondary or ghost.
5. Numbers: `<Amount role>` and `<Delta>`; a hero only if the view has one figure that matters most.
6. Motion: remove `<Reveal>` / `<Stagger>` wrappers when touching a file; no new keyframes; register anything new.
7. Copy: sentence case, no coach voice, no em dashes, no "we".
8. Run `npm run guards`, the census and settle gates on the area's top routes, and compare light and dark shots.
