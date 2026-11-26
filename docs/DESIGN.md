# EMP Design Language v2 — "Slab"

**Status:** binding. Per CLAUDE.md override 5, this document supersedes SPEC §3–§5 for materials, depth, colour usage
and motion. These SPEC rules still apply unchanged: token *names* (`--bg-*`, `--text-*`, `--accent-*`, `--gain*`, `--elev-*`,
`--dur-*`, `--ease-*`, sizes, radii, z-index), component *APIs*, reduced motion, contrast and tabular numbers.
Data and IPC contracts remain SPEC §11.

**Reference material** (all in `docs/design/`, opened over `file://`, no server needed):

| File | What it is | How to use it |
|---|---|---|
| `prototype.html` | **The winning prototype** ("Tactile Monochrome"): every control × every state, wells, machined panels, net-worth hero, sidebar, dialog, palette and toast. Query params: `?theme=light\|dark\|midnight&motion=reduced&effects=reduced`. The ⌘K palette, dialog → toast flow, chart scrub, slider and Replay all work. | **Material reference.** Where a pixel question is not answered here, match this file. §11 lists where it deviates from this spec; the spec wins. |
| `prototype-motion.html` | The "Kinetic" study: Money HQ window with overlays opening from their origin, KPI → detail morph, the goal burst, pen-dot chart, odometer and icon micro-moves. Flags: `?themes=dark,light,midnight`, `?rm` (reduced motion), `?fx` (reduced effects), `?static`. It needs `node_modules` (it loads the Inter and JetBrains Mono fonts from `../../node_modules`). | **Choreography reference.** Copy its timing and its feel, not its CSS: its slab DOM (`.face` span) is *not* the chosen recipe. |
| `ref-01-slab-matrix-light.png` | Button matrix (rest, hover, pressed, focus, disabled) in light | Acceptance image for the slab |
| `ref-02-wells-controls-dark.png` | Toggles, wells, fields and chips in dark | Acceptance image for wells |
| `ref-03-light-depth-hero-dark.png` | The "Depth" study's hero card: canvas halo, lit panel, end-dot ping | Reference for the light model (§3). Its green line is **not** adopted (§5.6). |
| `ref-04-glass-overlays-dark.png` | Glass palette, destructive dialog glow and toast with a draining bar | Reference for glass-2 and the destructive glow |
| `ref-05-goal-celebration-strip.png` | Goal reached, 0–1200 ms | Reference for signature moment S8 |
| `ref-06-kpi-detail-morph-strip.png` | KPI tile → detail morph, 0–550 ms | Reference for signature moment S10 |

---

## 1. Decision record

Three art-direction studies were scored from their prototypes, stills, frame strips and videos (5 = best; for
performance risk, 5 = lowest risk):

| Criterion | Tactile Monochrome | Light & Depth | Kinetic Precision |
|---|---|---|---|
| Wow factor | 4 | 4.5 | **5** |
| Coherence with the slab icon | **5** | 4 (cool halo casts blue onto light; green glows) | 4.5 |
| Legibility in dense productivity and finance UI | **5** | 4 (aurora and halo behind data) | 4.5 |
| Accessibility (contrast, reduced motion) | 4 (destructive face and switch track need fixes) | 4 | 4 |
| Performance risk | **5** (pseudo-layers, transform/filter only) | 3 (aurora, six light layers, `@property`) | 3 (glass + morph dropped frames in headless runs) |
| Implementability with Tailwind v4 + motion + Radix | **5** (no new DOM) | 3.5 (sheen span, `@property`, many layers) | 3.5 (face span, FLIP machinery) |
| **Total / 30** | **28** | 23 | 24.5 |

**Synthesis.** EMP v2 = **Tactile's material** (every control is part of the slab family) + **Depth's light** (one key
light, a canvas halo, edge light, glass reserved for overlays) + **Kinetic's choreography** (one spring table, things come
from somewhere, numbers roll, charts are drawn).

Rejected or limited, and why:
- **Aurora blobs.** Dropped: a looping decoration behind financial data hurts legibility and costs GPU time all the time.
- **Cursor magnet on buttons.** Dropped everywhere except the single primary CTA on cinematic screens (onboarding, life-app
  wizard finish): it moves click targets.
- **3D tilt.** Limited to the cards listed for it (KPI tiles, life-app gallery tiles, ChoiceCard), at most 3°.
- **Sheen sweep.** Limited to `primary` buttons at `lg`/`xl`, once per hover.
- **Blue halo tint.** Kept only in dark and midnight, at very low alpha, because the icon uses it. Light stays neutral.

---

## 2. Principles

1. **Everything is a slab.** The icon is three machined slabs, and the UI uses the same three forms:
   - **Raised** (*slab*): buttons, keycaps, thumbs, selection indicators.
   - **Recessed** (*well*): inputs, tracks, the beds of segmented controls, checkboxes at rest.
   - **Machined plate** (*panel*): cards, sidebars, tiles.

   Floating layers are **glass**, and glass is reserved for overlays.
2. **One light, top-front.** Highlights sit on top edges and the darkest shading at the bottom, in every theme. Light
   *reacts* to the pointer (edge light, specular), but geometry barely moves (hover lift is 1px).
3. **Monochrome first; colour means something.** Graphite is the brand. Colour is reserved for gain/loss,
   destructive actions, warning and info, block and tag colours, categorical data, and app tiles. Single-series trend
   lines are ink, and only the delta pill carries gain/loss colour.
4. **Press with physics, not colour.** Pressing moves the face down onto its side in 70 ms with no bounce. Release springs
   back with a little overshoot. A latched key stays half-down.
5. **Things come from somewhere.** Overlays grow from their trigger, pages morph from the row that opened them,
   numbers roll and charts are drawn. Nothing pops in without an origin.
6. **Compositor only.** Animate `transform`, `opacity` and `filter` only. Shadows are pre-baked on pseudo-layers that move
   or fade as a whole. No `box-shadow`, `width`, `height`, `top`/`left` or `background-position` animation.
7. **Degrade gracefully, never break.** Three independent switches, `data-motion=reduced`, `data-effects=reduced` and
   `data-contrast=more`, each yield a complete, beautiful app (§5.9).

---

## 3. Light model and canvas

- **Key light:** above the window, slightly in front. In dark and midnight it is tinted with the icon's halo
  `rgb(201 210 255)`; in light it is pure white.
- **Canvas** (`.emp-main` background; owned by shell):
  - Light: `radial-gradient(1200px 600px at 50% -220px, #ffffff, transparent 70%), var(--bg-canvas)`
  - Dark: `radial-gradient(1100px 520px at 50% -140px, rgba(201,210,255,.055), transparent 70%), radial-gradient(1200px 600px at 50% -200px, #17171c, transparent 70%), var(--bg-canvas)`
  - Midnight: `radial-gradient(1100px 520px at 50% -140px, rgba(201,210,255,.04), transparent 70%), #000`
  - All three are static: never animate the canvas, except during the theme "re-light" (S12).
- **Grain** is `src/styles/grain.png` (180px tile), on panels and the sidebar only, via `::before`:
  - Light: `multiply` at `.022`
  - Dark: `overlay` at `.07`
  - Midnight: `overlay` at `.05`
  - Off under reduced effects and higher contrast.
- **Sidebar:** a single panel plate flush to the window edge. Its right edge is a 1px groove (§4.9) instead of a border.

---

## 4. Material system

All material tokens live in **`src/styles/material.css`** (new; imported by `src/styles/index.css` after `tokens.css`).
They are additive: no existing token is renamed. The `--elev-*` tokens are kept for back-compat and are now *derived*
from the panel and glass shadows below.

### 4.1 Tokens per theme

```css
/* ── light (default) ─────────────────────────────────────────────── */
:root {
  /* panel (machined plate) */
  --panel-top: #ffffff; --panel-bot: #fafafb;
  --panel-rim: rgba(16,16,24,.075); --panel-hl: #ffffff; --panel-lo: rgba(16,16,24,.03);
  --panel-shadow: 0 1px 1px rgba(16,16,24,.035), 0 2px 5px -1px rgba(16,16,24,.05), 0 14px 32px -14px rgba(16,16,24,.16);
  --panel-raise:  0 1px 1px rgba(16,16,24,.04), 0 4px 10px -2px rgba(16,16,24,.08), 0 28px 60px -18px rgba(16,16,24,.28);
  --grain-op: .022; --grain-blend: multiply;
  --edge-light: rgba(16,16,24,.20);              /* pointer rim light colour */
  --specular: rgba(255,255,255,.55);

  /* well (recessed) */
  --well-bg: #f0f0f3; --well-in: rgba(16,16,24,.085); --well-rim: rgba(16,16,24,.085); --well-lip: #ffffff;
  --well-rim-state: rgba(16,16,24,.42);           /* ≥3:1 boundary for checkbox / radio / switch-off (WCAG 1.4.11) */

  /* groove (engraved lines: tab baselines, dividers, sidebar edge) */
  --groove-dark: rgba(16,16,24,.09); --groove-lite: rgba(255,255,255,.95);

  /* secondary slab */
  --slab-s-face-a: #ffffff; --slab-s-face-b: #f1f1f4; --slab-s-hl: #ffffff; --slab-s-lo: rgba(16,16,24,.05); --slab-s-rim: rgba(16,16,24,.12);
  --slab-s-side-a: #cdcdd4; --slab-s-side-b: #b9b9c3; --slab-s-side-rim: rgba(16,16,24,.10);
  --slab-s-contact: rgba(16,16,24,.18); --slab-s-ambient: rgba(16,16,24,.14); --slab-s-fg: var(--text-primary);
  --slab-s-press: brightness(.955); --slab-s-hover: brightness(1.035);

  /* primary slab — graphite (default accent) */
  --slab-p-face-a: #4b4b53; --slab-p-face-b: #222226; --slab-p-hl: rgba(255,255,255,.26); --slab-p-lo: rgba(0,0,0,.30); --slab-p-rim: rgba(0,0,0,.60);
  --slab-p-side-a: #141417; --slab-p-side-b: #050506; --slab-p-side-rim: rgba(0,0,0,.35);
  --slab-p-contact: rgba(16,16,24,.32); --slab-p-ambient: rgba(16,16,24,.30); --slab-p-fg: #ffffff;
  --slab-p-press: brightness(.86); --slab-p-hover: brightness(1.06); --slab-p-sheen: rgba(255,255,255,.10);

  /* destructive slab (contrast-corrected vs the prototype: ≥4.9:1 at label centre) */
  --slab-d-face-a: #e0474b; --slab-d-face-b: #bb2c2c; --slab-d-hl: rgba(255,255,255,.30); --slab-d-lo: rgba(80,0,0,.22); --slab-d-rim: rgba(110,10,8,.5);
  --slab-d-side-a: #8e211e; --slab-d-side-b: #6c1513; --slab-d-side-rim: rgba(80,0,0,.25);
  --slab-d-contact: rgba(120,20,16,.30); --slab-d-ambient: rgba(160,30,26,.26); --slab-d-fg: #ffffff;
  --slab-d-press: brightness(.88);

  /* ghost / plate states */
  --ghost-hover: rgba(16,16,24,.05); --ghost-press: rgba(16,16,24,.085);

  /* thumbs (switch, slider) and lit fills */
  --thumb-a: #ffffff; --thumb-b: #ececf0;
  --lit-a: #2c2c31; --lit-b: #45454c; --lit-glow: transparent;   /* switch on-track, slider fill, checkbox fill (graphite) */

  /* glass */
  --glass-fill-a: rgba(255,255,255,.86); --glass-fill-b: rgba(250,250,251,.82);
  --glass-blur: blur(24px) saturate(1.8);
  --glass-shadow: 0 0 0 .5px rgba(16,16,24,.10), 0 10px 24px -8px rgba(16,16,24,.14), 0 40px 90px -20px rgba(16,16,24,.28);
  --glass-rim: rgba(255,255,255,.9);
  --scrim: rgba(18,18,24,.28);

  /* focus */
  --ring: rgba(19,19,23,.72); --ring-halo: rgba(16,16,24,.10);

  /* glow (used by name only — §4.8) */
  --glow-loss: 0 0 0 4px color-mix(in oklab, var(--loss) 16%, transparent), 0 8px 26px -8px color-mix(in oklab, var(--loss) 45%, transparent);
  --glow-gain: 0 0 24px 2px color-mix(in oklab, var(--gain) 30%, transparent);
  --glow-pool: none;                                 /* light pool under primary — dark only */

  /* charts */
  --chart-line: #131317; --chart-fill-top: rgba(16,16,24,.13);
}

/* ── dark ────────────────────────────────────────────────────────── */
:root[data-theme="dark"], :root[data-theme="midnight"] {
  --panel-top: #1b1b20; --panel-bot: #141418;
  --panel-rim: rgba(255,255,255,.06); --panel-hl: rgba(255,255,255,.075); --panel-lo: rgba(0,0,0,.35);
  --panel-shadow: 0 0 0 1px rgba(0,0,0,.55), 0 2px 4px rgba(0,0,0,.35), 0 18px 40px -16px rgba(0,0,0,.70);
  --panel-raise:  0 0 0 1px rgba(0,0,0,.60), 0 6px 14px -2px rgba(0,0,0,.50), 0 40px 80px -20px rgba(0,0,0,.85);
  --grain-op: .07; --grain-blend: overlay;
  --edge-light: rgba(255,255,255,.22); --specular: rgba(255,255,255,.07);

  --well-bg: #0c0c0f; --well-in: rgba(0,0,0,.60); --well-rim: rgba(0,0,0,.55); --well-lip: rgba(255,255,255,.055);
  --well-rim-state: rgba(255,255,255,.34);
  --groove-dark: rgba(0,0,0,.55); --groove-lite: rgba(255,255,255,.045);

  --slab-s-face-a: #34343b; --slab-s-face-b: #26262c; --slab-s-hl: rgba(255,255,255,.12); --slab-s-lo: rgba(0,0,0,.30); --slab-s-rim: rgba(255,255,255,.045);
  --slab-s-side-a: #101013; --slab-s-side-b: #070709; --slab-s-side-rim: rgba(0,0,0,.70);
  --slab-s-contact: rgba(0,0,0,.70); --slab-s-ambient: rgba(0,0,0,.55);
  --slab-s-press: brightness(.88); --slab-s-hover: brightness(1.12);

  /* primary = the icon's lit top face on grey sides */
  --slab-p-face-a: #ffffff; --slab-p-face-b: #d2d2d9; --slab-p-hl: #ffffff; --slab-p-lo: rgba(0,0,0,.14); --slab-p-rim: rgba(0,0,0,.18);
  --slab-p-side-a: #8b8b95; --slab-p-side-b: #5b5b64; --slab-p-side-rim: rgba(0,0,0,.60);
  --slab-p-contact: rgba(0,0,0,.70); --slab-p-ambient: rgba(0,0,0,.60); --slab-p-fg: #0b0b0e;
  --slab-p-press: brightness(.88); --slab-p-hover: brightness(1.03); --slab-p-sheen: rgba(255,255,255,.60);

  --slab-d-face-a: #e5484d; --slab-d-face-b: #b82a2a; --slab-d-hl: rgba(255,255,255,.28); --slab-d-lo: rgba(60,0,0,.30); --slab-d-rim: rgba(60,0,0,.5);
  --slab-d-side-a: #6e1613; --slab-d-side-b: #4e0e0c; --slab-d-side-rim: rgba(0,0,0,.60);
  --slab-d-contact: rgba(0,0,0,.70); --slab-d-ambient: rgba(0,0,0,.50);

  --ghost-hover: rgba(255,255,255,.06); --ghost-press: rgba(255,255,255,.10);
  --thumb-a: #3a3a42; --thumb-b: #24242a;           /* on-state thumb in dark */
  --lit-a: #f3f3f6; --lit-b: #c9c9d0; --lit-glow: rgba(255,255,255,.18);

  --glass-fill-a: rgba(30,30,36,.88); --glass-fill-b: rgba(22,22,27,.90);
  --glass-blur: blur(28px) saturate(1.7) brightness(.92);
  --glass-shadow: 0 0 0 .5px rgba(0,0,0,.85), 0 10px 24px -8px rgba(0,0,0,.55), 0 40px 90px -20px rgba(0,0,0,.85);
  --glass-rim: rgba(255,255,255,.10);
  --scrim: rgba(0,0,0,.55);
  --ring: rgba(237,237,240,.62); --ring-halo: rgba(255,255,255,.10);
  --glow-pool: 0 10px 26px -10px rgba(201,210,255,.22);
  --chart-line: #f2f2f5; --chart-fill-top: rgba(255,255,255,.16);
}

/* ── midnight (true black, OLED) — must read clearly different from dark ── */
:root[data-theme="midnight"] {
  --panel-top: #0f0f12; --panel-bot: #0a0a0c;
  --panel-rim: rgba(255,255,255,.075); --panel-hl: rgba(255,255,255,.08); --panel-lo: rgba(0,0,0,.5);
  --panel-shadow: 0 0 0 1px rgba(255,255,255,.02), 0 18px 40px -16px rgba(0,0,0,.9);
  --panel-raise: 0 0 0 1px rgba(255,255,255,.03), 0 40px 80px -20px #000;
  --grain-op: .05;
  --well-bg: #050506; --well-lip: rgba(255,255,255,.065);
  --slab-s-face-a: #26262b; --slab-s-face-b: #1a1a1e; --slab-s-hl: rgba(255,255,255,.11); --slab-s-rim: rgba(255,255,255,.06);
  --slab-s-side-a: #050506; --slab-s-side-b: #000000;
  --glass-fill-a: rgba(18,18,22,.92); --glass-fill-b: rgba(10,10,12,.92);
  --scrim: rgba(0,0,0,.64);
}
```

**Accents.** Graphite is the default: primary slabs are monochrome as above. Any other `data-accent` re-derives only the
**primary slab, the lit fills (switch on, checkbox, radio, slider fill), focus ring and selection.** Indicators
(segmented, sidebar, tabs) stay neutral slabs.

```css
:root[data-accent]:not([data-accent="graphite"]) {
  --slab-p-face-a: color-mix(in oklab, var(--accent-solid) 80%, white);
  --slab-p-face-b: color-mix(in oklab, var(--accent-solid) 92%, black);
  --slab-p-side-a: color-mix(in oklab, var(--accent-solid) 52%, black);
  --slab-p-side-b: color-mix(in oklab, var(--accent-solid) 38%, black);
  --slab-p-hl: rgba(255,255,255,.30); --slab-p-lo: rgba(0,0,0,.22); --slab-p-rim: rgba(0,0,0,.35);
  --slab-p-fg: var(--accent-contrast); --slab-p-sheen: rgba(255,255,255,.22);
  --lit-a: color-mix(in oklab, var(--accent-solid) 85%, black); --lit-b: var(--accent-solid);
  --lit-glow: color-mix(in oklab, var(--accent-solid) 30%, transparent);
  --ring: var(--accent-ring); --ring-halo: color-mix(in oklab, var(--accent-ring) 18%, transparent);
}
```

Validation is required: for each accent × theme, the label at face midpoint must be ≥ 4.5:1. Amber already uses dark
`--accent-contrast`; if any pair fails, darken `face-a` to 70% white.

### 4.2 Recipe `slab-raised` (the keycap)

There is no new DOM. The element is the hit area and carries the label. `::before` is the **side** and `::after` is the
**face**. Both sit behind the content because the element has `isolation: isolate`.

```css
.slab {
  /* per-size */  --edge: 2px;                         /* 1.5px xs/sm/kbd/chips · 2px md · 3px lg/xl */
  /* per-variant (default = secondary) */
  --fa: var(--slab-s-face-a); --fb: var(--slab-s-face-b); --hl: var(--slab-s-hl); --lo: var(--slab-s-lo); --rim: var(--slab-s-rim);
  --sa: var(--slab-s-side-a); --sb: var(--slab-s-side-b); --srim: var(--slab-s-side-rim);
  --contact: var(--slab-s-contact); --amb: var(--slab-s-ambient);
  --pressf: var(--slab-s-press); --hoverf: var(--slab-s-hover); --sheen: transparent;
  position: relative; isolation: isolate; background: transparent; border: 0; color: var(--slab-s-fg);
  transform: translateY(0) scale(1);
  transition: transform var(--dur-release) var(--spring-release);
}
.slab::before, .slab::after { content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; }
.slab::before {                                   /* SIDE: hangs --edge below the box; layout height unchanged */
  z-index: -2;
  background: linear-gradient(180deg, var(--sa), var(--sb));
  box-shadow: 0 0 0 1px var(--srim), 0 1px 1.5px var(--contact), 0 6px 12px -5px var(--amb);
  transform: translateY(var(--edge));
  transition: transform var(--dur-release) var(--spring-release);
}
.slab::after {                                    /* FACE */
  z-index: -1;
  background:
    radial-gradient(120% 140% at 50% -40%, var(--sheen), transparent 55%),
    linear-gradient(180deg, var(--fa), var(--fb));
  box-shadow: inset 0 1px 0 var(--hl), inset 0 -1px 0 var(--lo), inset 0 0 0 1px var(--rim);
  transition: filter 220ms var(--ease-out);
}
```

**States.** Exact values; durations come from §5.

| State | Element `transform` | `::before` (side) | `::after` (face) | Timing |
|---|---|---|---|---|
| rest | `translateY(0) scale(1)` | `translateY(var(--edge))` | — | — |
| hover | `translateY(-1px)` | `translateY(calc(var(--edge) + 1px))` (side stays put in world space, so the visible bevel grows by 1px) | `filter: var(--hoverf)` | 180ms `--ease-out` |
| active (press) | `translateY(var(--edge)) scale(.985)` (`.94` icon-only) | `translateY(0)` | `filter: var(--pressf)` | 70ms `--ease-press`; face filter 60ms |
| release | back to hover/rest | back | back | `--spring-release` 490ms (11% overshoot) |
| latched (`aria-pressed=true`, `data-active`, `data-state=on`) | `translateY(calc(var(--edge) - 1px))` | `translateY(1px)` | `filter: var(--pressf)`; add `inset 0 1px 2px rgba(0,0,0,.18)` to the shadow list | glide |
| focus-visible | add `outline: 1.5px solid var(--ring); outline-offset: 3px` that lands from `outline-offset: 7px` | — | — | 220ms ease-out |
| disabled | none; no hover or press | `translateY(1px); opacity:.5; box-shadow: 0 0 0 1px var(--srim)` | `filter: saturate(.2) opacity(.6)` | — |
| loading (`aria-busy`) | as rest. The label fades to 0 and the Spinner overlay fades in at 120ms. | — | the face keeps its colour | — |
| success | the label lifts out (`y:-6, opacity 0`) and a drawn check comes in (pathLength 0→1, 280ms) | — | — | 1200ms hold |

**Variants:**
- **primary:** `--fa…--amb` from `--slab-p-*`. Adds `--sheen: var(--slab-p-sheen)`, and in dark `box-shadow: var(--glow-pool)` on `::before`.
- **secondary:** the default above.
- **destructive:** `--slab-d-*`.
- **soft:** a low slab. `--edge:1px`; the face is `color-mix(in oklab, var(--accent-soft), var(--slab-s-face-a) 60%)`, the side is `color-mix(in oklab, var(--accent-solid) 30%, var(--slab-s-side-a))`, and the foreground is `--accent-text`.
- **ghost:** no slab at rest. `--edge:0`, `::before{opacity:0}`, and `::after` is a flat plate:
  - `background: var(--ghost-hover)`, `box-shadow:none`, `opacity:0`, `transform: scale(.92)`.
  - Hover: `opacity 1; scale(1)`, 140ms ease-out.
  - Press: background `var(--ghost-press)` plus `inset 0 1px 2px rgba(0,0,0,.12)` (it becomes a *well*), with the element at `scale(.97)`.
  - Latched: the press look, held.
- **destructive-ghost:** ghost, with `--loss-soft` / `color-mix(--loss 18%)` plates and `--loss-text`.
- **link:** no material. The underline is a 1px `::after` that scales `scaleX(0→1)` from the left on hover over 180ms.

**Icon-only keycaps** (IconButton, secondary) get a dished face: prepend
`radial-gradient(80% 70% at 50% 62%, rgba(0,0,0,.035), transparent 70%)` (dark: `.22`) to the face background.

**Layout rule.** The side hangs `--edge` (≤ 3px) below the box. Rows of slabs need ≥ 4px of vertical room below them
(toolbars `padding-block-end: 4px`). Tables and grids never use raised slabs inside rows: row actions are ghost.

### 4.3 Recipe `keycap-kbd`

`<Kbd>` is a 20px slab with `--edge:1.5px`, `font: 600 11px/1 var(--font-ui)`, colour `--text-secondary`, radius 5. It uses
the same side and face pseudo-layers as the secondary slab. **It physically depresses when the real key is pressed** (S1):
- `[data-down]` → `transform: translateY(1.5px)` and side `translateY(0)`, 50ms ease-out.
- Release: `--spring-release` at 300ms.

### 4.4 Recipe `well-recessed`

```css
.well {
  background: var(--well-bg);
  box-shadow: inset 0 1px 2px var(--well-in), inset 0 0 0 1px var(--well-rim), 0 1px 0 var(--well-lip);
  transition: box-shadow 160ms var(--ease-out), background-color 160ms var(--ease-out);  /* discrete state swap, not animated geometry */
}
.well:hover { box-shadow: inset 0 1px 2px var(--well-in), inset 0 0 0 1px color-mix(in oklab, var(--well-rim), var(--text-primary) 12%), 0 1px 0 var(--well-lip); }
.well:focus-within {
  background: color-mix(in oklab, var(--well-bg), var(--panel-top) 55%);
  box-shadow: inset 0 1px 2px var(--well-in), inset 0 0 0 1px var(--ring), 0 0 0 4px var(--ring-halo), 0 1px 0 var(--well-lip);
}
.well[aria-invalid="true"] { box-shadow: inset 0 1px 2px var(--well-in), inset 0 0 0 1px var(--loss), 0 0 0 4px color-mix(in oklab, var(--loss) 18%, transparent); }
.well:disabled, .well[data-disabled] { opacity: .55; box-shadow: inset 0 0 0 1px var(--well-rim); }
.well[readonly] { background: transparent; box-shadow: inset 0 0 0 1px var(--well-rim); }
```

The focus ring is a *state swap* of the inset rim. That is the one place a `box-shadow` changes on interaction: it is a
single discrete swap on a small element, never a continuous animation. Placeholder text uses `--text-tertiary` (≥ 4.5:1
on the well); `--text-disabled` must not be used for placeholders.

### 4.5 Recipe `panel` (machined plate) and `panel-raised`

```css
.panel {
  position: relative; isolation: isolate; border-radius: var(--radius-xl);
  background: linear-gradient(180deg, var(--panel-top), var(--panel-bot));
  box-shadow: inset 0 1px 0 var(--panel-hl), inset 0 -1px 0 var(--panel-lo), inset 0 0 0 1px var(--panel-rim), var(--panel-shadow);
}
.panel::before {                     /* grain */
  content:""; position:absolute; inset:0; border-radius:inherit; pointer-events:none; z-index:-1;
  background: url("/src/styles/grain.png") 0 0 / 180px; mix-blend-mode: var(--grain-blend); opacity: var(--grain-op);
}
.panel[data-raise]::after {         /* lift shadow pre-baked, fades with opacity */
  content:""; position:absolute; inset:0; border-radius:inherit; pointer-events:none; z-index:-2;
  box-shadow: var(--panel-raise); opacity:0; transition: opacity 220ms var(--ease-out);
}
.panel[data-raise]:hover { transform: translateY(-2px); transition: transform 220ms var(--ease-out); }
.panel[data-raise]:hover::after { opacity: 1; }
.panel[data-raise]:active { transform: translateY(0) scale(.99); transition: transform 70ms var(--ease-press); }
```

Interactive panels (KPI tiles, gallery tiles, choice cards, home widgets with a click target) use `data-raise`. Static
panels never lift.

### 4.6 Recipe `edge-light` (pointer-tracked rim) and `specular`

Opt-in with `data-light` on a panel or glass surface. One global module, `src/ui/motion/pointerLight.ts`, handles it:
- It registers one `pointermove` listener on `document` and coalesces it with rAF.
- It writes `--mx`/`--my` in px, and only on the `[data-light]` element under the pointer (`closest`).
- On `pointerleave` it sets `data-lit="0"`.

```css
[data-light] { --mx: 50%; --my: -40%; }
[data-light] > .emp-edge {          /* one absolutely-positioned span, aria-hidden, rendered by Card/KpiTile/etc. */
  position:absolute; inset:0; border-radius:inherit; pointer-events:none; padding:1px;
  background: radial-gradient(260px circle at var(--mx) var(--my), var(--edge-light), transparent 70%);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor;
          mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0);
  opacity: 0; transition: opacity 280ms var(--ease-out);
}
[data-light][data-lit="1"] > .emp-edge { opacity: 1; }
[data-light][data-specular] > .emp-edge::after {     /* broad specular wash, hero cards & KPI only */
  content:""; position:absolute; inset:-1px; border-radius:inherit;
  background: radial-gradient(420px circle at var(--mx) var(--my), var(--specular), transparent 62%);
  -webkit-mask: none; mask: none;
}
```

This is a span rather than a pseudo-element because panels already use `::before` (grain) and `::after` (raise).
Allowed surfaces: hero cards, KpiTile, ChoiceCard, life-app tiles, dialog and palette panels, and home widgets.
**Never** on table rows, list items or sheet cells.

**Primary CTA specular and sheen** apply to `primary` at `lg`/`xl` only:
- Button renders `<span class="emp-btn-sheen" aria-hidden>`: a 46%-wide skewed band (`skewX(-20deg)`) with a
  `linear-gradient(90deg, transparent, rgba(255,255,255,.35), transparent)` background and `mix-blend-mode: soft-light`.
- On hover-in it travels `translateX(-170%) → translateX(340%)` over 820ms `cubic-bezier(.3,.7,.2,1)`, once per hover.
- Clip it with `overflow: clip` on a wrapper span inside the face radius. Do not put `overflow: hidden` on the button
  itself, because the side must hang below the box.

### 4.7 Recipe `glass-1/2/3`

| Level | Used by | Fill | Filter | Shadow | Radius |
|---|---|---|---|---|---|
| **glass-1** | Menu, ContextMenu, Popover, Select/Combobox listbox, DatePicker popover, Toast, EmojiPicker | `linear-gradient(180deg, var(--glass-fill-a), var(--glass-fill-b))` | `backdrop-filter: blur(20px) saturate(1.6)` | `var(--elev-2)` derived: `0 0 0 .5px` rim + `0 12px 32px -10px` | 10–12 |
| **glass-2** | CommandPalette, Dialog, AlertDialog, Sheet, SidePeek, Google setup sheet | same fill | `var(--glass-blur)` | `var(--glass-shadow)` + `inset 0 1px 0 var(--glass-rim)` | 14 |
| **glass-3** | Lock screen veil, onboarding stage, wizard "build" stage | `rgba(bg-window, .55)` | `blur(40px) saturate(1.4)` over a frozen app snapshot | none | full-bleed |

Rules:
- **≤ 2 backdrop-filter layers visible at once.** A menu opened inside a dialog renders as **opaque** glass-1: when
  `useInOverlay()` is true, use fill alpha 1 and drop the filter.
- **The scrim never blurs.** Remove the current `backdrop-filter: blur(2px)` from `.emp-scrim`.
- The chart tooltip is *faux glass*: the glass fill at alpha .96 with no backdrop-filter.
- The tooltip itself stays a solid ink pill (`--tooltip-bg`), for contrast.
- Text on glass must sit on a fill of alpha ≥ .80 (light) or ≥ .86 (dark). Never lower it.

### 4.8 Recipe `glow` (sparingly, by name)

| Glow | Where | Value |
|---|---|---|
| `--glow-loss` | Destructive button focus inside AlertDialog; destructive confirm | 4px soft red ring + red pool |
| `--glow-gain` | Goal ring at completion (S8), streak flame | 24px gain halo fading over 1.2s |
| `--glow-pool` | Dark-mode primary slab, on `::before` | `0 10px 26px -10px rgba(201,210,255,.22)` |
| end-dot halo | Chart end dot (S5) | 3 pulses, then static |

There is no other glow, and there are no neon effects or coloured shadows on neutral components.

### 4.9 Recipe `groove` (engraved line)

```css
.groove-h { height: 2px; background: linear-gradient(180deg, var(--groove-dark) 0 1px, var(--groove-lite) 1px 2px); }
```

Grooves are used for the tabs baseline, the sidebar's right edge (vertical variant), Separator, the toast progress
track, and dividers inside panels.

### 4.10 Recipe `dome` (thumbs)

Switch and slider thumbs:
- `background: linear-gradient(180deg, var(--thumb-a), var(--thumb-b))`.
- `box-shadow`:
  - light: `inset 0 1px 0 rgba(255,255,255,.9), inset 0 0 0 .5px rgba(0,0,0,.06), 0 1px 0 rgba(0,0,0,.12), 0 1px 2px rgba(0,0,0,.22), 0 3px 6px -1px rgba(0,0,0,.18)`
  - dark: `inset 0 1px 0 rgba(255,255,255,.14), 0 0 0 .5px rgba(0,0,0,.6), 0 1px 2px rgba(0,0,0,.6), 0 3px 6px -1px rgba(0,0,0,.5)`
- In dark, the off-state thumb is lighter (`#5a5a63 → #3e3e46`) so it reads against the recessed track.

### 4.11 Higher contrast (`data-contrast="more"`)

- Rims ×2 alpha (`--panel-rim`, `--slab-*-rim`, `--well-rim`). `--well-rim-state` becomes solid `--text-secondary`.
- Focus: `outline: 3px solid var(--accent-ring); outline-offset: 2px`, with no halo or glow.
- Glass becomes opaque (`--glass-fill-*` alpha 1, no backdrop-filter). Grain, edge light, specular and sheen are off.
- Gradients on slab faces stay, and every label pair is already AA.

### 4.12 Reduced effects (`data-effects="reduced"`)

Set by the frame monitor or by Settings.
- **Off:** backdrop-filter (glass becomes opaque), grain, edge light, specular, sheen, tilt, magnet, particles,
  `--glow-pool`, end-dot pulses, the live ping, and blur in entrances (they keep opacity and translate).
- **Shadows capped:** `--panel-shadow` loses its third layer and `--panel-raise` uses `--panel-shadow`.
- **Kept:** slabs, wells, panels and grooves (static gradients are cheap). Depth survives.

---

## 5. Motion system

### 5.1 Durations and eases

These are CSS (`tokens.css`) and TS (`motion/tokens.ts`). Existing names are kept, and new names are added.

| Token | Value | Use |
|---|---|---|
| `--dur-press` / `duration.press` | 70ms | key going down |
| `--dur-micro` | 80ms | tooltip out, colour flicks |
| `--dur-fast` | 120ms | hover-in on flat things, crossfades |
| `--dur-hover` / `duration.hover` | 180ms | slab hover lift and filter |
| `--dur-base` | 160ms | hover-out, menu exit |
| `--dur-moderate` | 220ms | focus ring landing, edge-light fade |
| `--dur-slow` | 320ms | sheet content, larger crossfades |
| `--dur-deliberate` | 480ms | dialog morphs (cap) |
| `--dur-chart` | 700ms | bars, donuts, standard chart entry |
| `--dur-draw` / `duration.draw` | 1100ms | hero line draw (pen dot) |
| `--dur-cinematic` / `duration.cinematic` | 1600–2400ms | unlock, life-app build only; always skippable |

| Ease | Value | Use |
|---|---|---|
| `--ease-press` | `cubic-bezier(.3,0,.6,1)` | press-in |
| `--ease-out` | `cubic-bezier(.2,0,0,1)` | hovers, fades |
| `--ease-out-expo` | `cubic-bezier(.16,1,.3,1)` | draws, count-ups, menu-in |
| `--ease-in` | `cubic-bezier(.4,0,1,1)` | exits (always faster than entrances) |
| `--ease-in-out` | `cubic-bezier(.65,0,.35,1)` | theme crossfade |
| `--ease-sheen` | `cubic-bezier(.3,.7,.2,1)` | sheen sweep |

### 5.2 Springs: one table for JS and CSS

`src/ui/motion/tokens.ts` holds `spring` (motion configs). `material.css` holds the equivalent CSS `linear()` curves,
generated by the same parameters. The legacy names stay as aliases, so every existing import keeps working.

| Name (legacy alias) | k / c / m | ζ | Overshoot | Settle | Used for |
|---|---|---|---|---|---|
| `release` (`snappy`) | 700 / 30 / 1 | .57 | 11.5% | 490ms | slab release, Kbd release, icon nudges |
| `thumb` | 520 / 26 / 1 | .57 | 11.3% | 490ms | switch thumb, checkbox pop, radio dot, toast in |
| `pop` (`bouncy`) | 520 / 20 / 1 | .44 | 21.6% | 710ms | **success moments only**: checkbox burst, goal check, celebrate badge |
| `glide` (`ui`) | 420 / 34 / 1 | .83 | 0.9% | 440ms | indicators: segmented, tabs, sidebar slab, palette highlight, sheet selection rect |
| `settle` (`gentle`) | 380 / 30 / 1 | .77 | 2.3% | 460ms | dialogs, sheets, cards entering, panel drops |
| `morph` (`layout`) | 380 / 36 / 1 | .92 | 0% | 380ms | shared-element morphs, reorder, layout shifts |
| `roll` | 200 / 24 / 1 | .85 | 0.6% | 600ms | odometer digits |
| `magnet` | 240 / 16 / .8 | .58 | 10.8% | 630ms | tilt return, magnet CTA (cinematic screens only) |
| `drag` | 300 / 28 / 1 | .81 | 1.3% | 520ms | drag release with velocity |

```css
:root {
  --spring-release: linear(0, 0.047, 0.163, 0.316, 0.482, 0.641, 0.783, 0.9, 0.991, 1.053, 1.092, 1.111, 1.114, 1.107, 1.092, 1.074, 1.055, 1.037, 1.021, 1.009, 0.999, 0.993, 0.989, 0.987, 0.987, 0.988, 0.99, 0.992, 0.994, 0.996, 0.998, 0.999, 1, 1.001, 1.001, 1.002, 1.001, 1.001, 1.001, 1.001, 1);
  --dur-release: 490ms;
  --spring-thumb: linear(0, 0.036, 0.126, 0.249, 0.389, 0.531, 0.665, 0.785, 0.887, 0.968, 1.03, 1.072, 1.098, 1.111, 1.112, 1.106, 1.095, 1.08, 1.064, 1.048, 1.033, 1.02, 1.01, 1.001, 0.995, 0.991, 0.988, 0.987, 0.987, 0.988, 0.99, 0.992, 0.993, 0.995, 0.997, 0.998, 0.999, 1, 1.001, 1.001, 1);
  --dur-thumb: 490ms;
  --spring-pop: linear(0, 0.052, 0.183, 0.36, 0.554, 0.743, 0.908, 1.039, 1.133, 1.19, 1.214, 1.211, 1.188, 1.153, 1.111, 1.07, 1.032, 1.001, 0.978, 0.962, 0.955, 0.954, 0.957, 0.964, 0.973, 0.982, 0.99, 0.998, 1.003, 1.007, 1.009, 1.01, 1.01, 1.008, 1.007, 1.005, 1.003, 1.001, 1, 0.999, 0.998, 0.998, 0.998, 0.998, 0.998, 0.999, 0.999, 1, 1);
  --dur-pop: 710ms;
  --spring-glide: linear(0, 0.028, 0.096, 0.187, 0.288, 0.392, 0.491, 0.583, 0.664, 0.736, 0.796, 0.846, 0.887, 0.92, 0.946, 0.965, 0.98, 0.991, 0.999, 1.004, 1.007, 1.009, 1.009, 1.009, 1.009, 1.008, 1.007, 1.006, 1.005, 1.004, 1.003, 1.003, 1.002, 1.002, 1.001, 1.001, 1);
  --dur-glide: 440ms;
  --spring-settle: linear(0, 0.025, 0.088, 0.174, 0.272, 0.375, 0.475, 0.569, 0.654, 0.73, 0.795, 0.849, 0.894, 0.931, 0.959, 0.981, 0.997, 1.008, 1.015, 1.02, 1.022, 1.023, 1.022, 1.02, 1.018, 1.016, 1.014, 1.012, 1.009, 1.008, 1.006, 1.004, 1.003, 1.002, 1.001, 1.001, 1, 1, 1);
  --dur-settle: 460ms;
  --spring-morph: linear(0, 0.025, 0.086, 0.167, 0.258, 0.35, 0.439, 0.523, 0.598, 0.665, 0.723, 0.774, 0.816, 0.852, 0.882, 0.907, 0.927, 0.943, 0.956, 0.967, 0.975, 0.981, 0.986, 0.99, 0.993, 0.995, 0.997, 0.998, 0.999, 1, 1, 1);
  --dur-morph: 380ms;
  --spring-roll: linear(0, 0.014, 0.051, 0.104, 0.168, 0.238, 0.309, 0.382, 0.451, 0.518, 0.58, 0.637, 0.69, 0.737, 0.779, 0.816, 0.848, 0.877, 0.901, 0.921, 0.939, 0.953, 0.965, 0.975, 0.983, 0.989, 0.994, 0.998, 1.001, 1.003, 1.005, 1.006, 1.006, 1.006, 1.006, 1.006, 1.006, 1.006, 1.005, 1.005, 1.004, 1.004, 1.003, 1.003, 1.003, 1.002, 1.002, 1.002, 1);
  --dur-roll: 600ms;
  --ease-spring-ui: var(--spring-glide);   /* legacy name now points at glide */
}
@supports not (transition-timing-function: linear(0, 1)) {
  :root { --spring-release: cubic-bezier(.34,1.4,.64,1); --spring-thumb: cubic-bezier(.34,1.4,.64,1); --spring-pop: cubic-bezier(.34,1.8,.64,1);
          --spring-glide: var(--ease-out-expo); --spring-settle: var(--ease-out-expo); --spring-morph: var(--ease-out-expo); --spring-roll: var(--ease-out-expo); }
}
```

The curves were produced by `docs/design/springs.py`, a semi-implicit Euler integration with dt = 0.1ms, settling when
|x−1| < .002 and |v| < .02. If a spring changes, regenerate its curve and the `spring` object together.

### 5.3 Timing grammar

- **Asymmetry:** exits run at 0.6–0.7× entrance duration with `--ease-in` and no spring. Hover-in 140–180ms, hover-out 160–200ms.
- **Press** is pure CSS (`:active`), so feedback lands within 1 frame. The motion `whileTap` scale is **removed** from
  Button, IconButton and cards. JS never drives press.
- **Stagger:**
  - cards 40ms
  - list, menu and palette rows 16ms
  - digits 28ms, right to left
  - chart bars 24ms
  - **Cap:** at most 8 cards or 12 rows animate. Later items appear with the last group, and the total stagger is ≤ 320ms.
- **Entrance vocabulary:**
  - `rise`: `opacity 0, y 8 → settle`
  - `rise-blur` (overlays and hero only): `opacity 0, y 10, scale .985, blur(4px) → settle`
  - `drop`: dialogs; see §5.4
  - Never more than 3 concurrent `filter: blur` animations.
- **Hierarchy order** for a page entrance: header → hero → KPI column → secondary panels → lists. Typical total 300–420ms.
  The page is usable from frame 1: entrances never block input.

### 5.4 Choreography rules

1. **Origin-aware overlays.**
   - Menu, Popover, Select, Combobox, DatePicker and ContextMenu scale from Radix's
     `var(--radix-*-content-transform-origin)`: `scale .96 → 1`, `opacity 0 → 1`, `y ∓4 → 0` (toward the trigger), on glide.
     They exit in 100ms ease-in.
   - **Dialog and AlertDialog grow from their trigger.** On open, read the trigger's rect (the
     `document.activeElement` at open time, or `Dialog`'s new optional `originRef`). Set `--ox/--oy` to the trigger
     centre minus the panel centre, and `--os = clamp(.3, triggerW / panelW, .9)`. Animate
     `translate(var(--ox), var(--oy)) scale(var(--os)) → none` on settle, with opacity 0 → 1 in the first 120ms and the
     content rows staggered at 16ms after 80ms. Close reverses into the trigger if it is still connected and visible;
     otherwise it uses `scale .97 + fade`, 150ms ease-in.
   - Without a pointer origin (keyboard shortcut, or the trigger is off-screen) the dialog uses `drop`:
     `opacity 0, y 14, scale .955, blur(6px) → settle`.
   - The **CommandPalette** grows from the sidebar Search row when that was clicked. Opened via ⌘K, it drops from the
     top centre with `y -10, scale .965, blur(6px)`.
2. **Shared-element morphs** use the **View Transitions API** (`document.startViewTransition`) with `view-transition-name`
   pairs, because the source and target live in different lazy routes.
   - It is available in WebView2 and in WKWebView on Safari 18+. Where it is missing, or under reduced motion, use the
     plain route crossfade.
   - Within one mounted tree (KPI → detail, sidebar slab, tabs, segmented), use motion's `layoutId` with the `morph` spring.
   - Names: `vt-page-icon-<id>`, `vt-page-title-<id>`, `vt-kpi-<id>`, `vt-app-tile-<appId>`.
   - The old and new snapshots are timed with `::view-transition-group(*) { animation-duration: 380ms; animation-timing-function: var(--spring-morph); }`.
3. **Route transitions with direction.** The shell keeps a navigation index in `history.state` and sets
   `:root[data-nav-dir="forward|back|lateral"]`. `lateral` covers tab and sibling switches, which also set
   `--nav-sign` (±1) from the tab index delta.

   | Direction | Outgoing | Incoming |
   |---|---|---|
   | forward | `opacity 0`, `x -8px`, 90ms ease-in | `opacity 0 → 1`, `x 12px → 0`, 220ms ease-out |
   | back | mirrored | mirrored |
   | lateral | `x calc(var(--nav-sign) * -16px)`, 90ms ease-in | `x calc(var(--nav-sign) * 16px) → 0`, 220ms ease-out |

   The route content is the snapshot root (`view-transition-name: route`), and the sidebar and topbar are excluded
   (they stay live).
4. **Indicators glide.** Segmented, Tabs, the sidebar selection slab and the palette highlight use `layoutId` + glide.
   Moving indicators **squash with speed**: `scaleX = 1 + min(|v| / 5200, .14)`, with border-radius counter-scaled by
   motion's layout projection. A **hover ghost** (ghost plate at `--ghost-hover`) follows the pointer with the `morph`
   spring; the selection slab follows on click.
5. **Lists reorder** with `layout` + morph. Insertions use `rise`. Deletions collapse (`opacity → 0` 120ms, then height via
   layout morph). Don't animate `height` directly: wrap the row in a `layout` container.
6. **Nothing loops forever** except Spinner, the Skeleton shimmer, and the Markets live ping. All three pause when off-screen
   (IntersectionObserver) or when `document.hidden`.

### 5.5 Number animation (RollingNumber v2)

- Each digit is a column of 0–9 glyphs in a `translateY` strip, with `font-variant-numeric: tabular-nums`. Separators
  and currency marks are static glyphs.
- **Only changed digits roll**, in the direction of change (an increase rolls up), using the `roll` spring at 600ms
  with a 28ms right-to-left stagger. Columns are masked top and bottom with
  `mask: linear-gradient(transparent, #000 18%, #000 82%, transparent)`, which gives a motion-blur feel.
- **A gained digit column** rises in (`y 60% → 0`, opacity, settle), and a lost column collapses. Never flash zeros.
- **Count-up** from 0 happens once per session per `countUpKey` (an in-memory Set). After that, values roll from their
  previous value.
- **Scrub mode** (`scrubbing` prop, used while a chart is hovered): 90ms `--ease-out`, no stagger. Leaving the chart
  springs back to the live value on `roll`.
- **Masked or Sensitive** values never roll: they swap instantly behind the mask.
- **Accessibility:** `aria-label` carries the final formatted value. Use `aria-live="off"` while scrubbing and
  `polite` for real changes.
- **Reduced motion:** a 140ms crossfade to the final value.

### 5.6 Charts

- **Colour.** Single-series trend charts (net worth, portfolio value, balances, sparklines in KPI tiles) draw in
  `--chart-line` (ink). The area fill runs from `--chart-fill-top` to transparent. Direction colour lives in the
  DeltaPill and the end-dot halo tint. Candles, P/L bars, waterfalls and gain/loss heatmaps keep `--gain`/`--loss`.
  Multi-series charts use the `--cat-*` palette.
- **Hero line draw (pen dot):**
  - `stroke-dashoffset` runs from length to 0 over 1100ms `--ease-out-expo`.
  - A 6px pen dot rides the path tip (`getPointAtLength` per frame; JS rAF, hero charts only).
  - The area fades in at 650ms over 400ms.
  - At the end, the dot becomes the **end-dot keycap**: an 8px face with a 1px side, plus **3 halo pulses**
    (`scale 1 → 2.6`, `opacity .35 → 0`, 900ms each, 300ms apart), then it rests.
- **Other line and area charts** use a clip reveal: a `<clipPath><rect>` whose `transform: scaleX(0 → 1)`, 700ms expo.
- **Range morph.** Resample old and new series to the same N (120). Interpolate the points and the y-domain together on
  glide over 620ms (JS rAF, one SVG `d` write per frame). Axis ticks crossfade with `y ±6px`. Only charts that are visible
  (IntersectionObserver) morph; the rest swap.
- **Bars** grow `scaleY 0 → 1` from the baseline (`transform-origin: bottom`) on settle, 24ms stagger, max 24 bars staggered.
- **Donut and Ring** sweep via dashoffset over 700ms expo. Segments enter in order, with a 40ms stagger.
- **Scrub:**
  - A 1px crosshair in `rgba(text, .35)` plus a 6px dot on the series.
  - A faux-glass tooltip that follows on glide (≤ 1 frame lag) and flips at edges.
  - The hero RollingNumber enters scrub mode.
- **Reduced motion:** charts render complete. Range change crossfades in 140ms. There is no pen and no pulses.

### 5.7 Icon micro-motions

Only on hover of the icon's own button, with transform only, ≤ 300ms on `release`. These are opt-in through
`data-icon-motion` on lucide wrappers:

| Icon | Motion |
|---|---|
| plus | rotate 90° |
| arrow-right / chevron-right | x +2px |
| trash | lid lifts (the top path's `translateY(-1.5px) rotate(-8deg)`) |
| bell | swings ±10° in 3 decaying steps |
| download | bobs y +2px |
| settings | rotates 45° |
| refresh | rotates 180° |
| search | scales 1.08 |
| sparkle | rotates 20° + scale 1.1 |
| eye ↔ eye-off | crossfade 120ms |

They are never applied to icons inside menus, tables or sidebars, where they would be noise.

### 5.8 Reduced motion (`data-motion="reduced"` or the OS setting)

- **Kept:** state changes. Keys still go down and come up, but in 0ms, with the face filter swapping. Focus rings,
  selection and colour changes stay, as do 120–140ms opacity crossfades.
- **Removed:** springs and overshoot, translate and scale entrances, stagger, odometer rolls, line draws, pulses,
  parallax, tilt, magnet, sheen, particles, shared-element morphs (they become crossfades), route slides (crossfade
  120ms), the indicator glide (it jumps), and the theme circular reveal (it becomes a 120ms crossfade).
- **Implementation:**
  - motion's `MotionConfig reducedMotion="user"` is already in `MotionProvider`. In addition, every `.slab`,
    `.panel[data-raise]`, `.sw`, `.emp-kbd` and indicator transition is overridden to `0ms` or `120ms` opacity under
    `:root[data-motion="reduced"]`.
  - Spinner keeps spinning. Skeleton keeps a static tint.
- **Acceptance:** every screen is complete and static by 200ms after navigation.

### 5.9 Performance budgets and degrade path

| Budget | Limit |
|---|---|
| Frame time during any transition | ≤ 16.7ms p95 on an integrated GPU (M1 / Intel Iris Xe); no long task > 50ms during a transition |
| Press feedback | 1 frame (CSS `:active`) |
| Route transition | ≤ 300ms total; the new route is interactive at frame 1 |
| Concurrent `backdrop-filter` layers | ≤ 2 |
| Concurrent `filter: blur()` animations | ≤ 3, each ≤ 300ms |
| Pointer-reactive effects | 1 global listener, rAF-coalesced; CSS vars written only on the element under the pointer |
| Animated elements per entrance | ≤ 12 (stagger cap) |
| `will-change` | set only for the duration of an animation (motion does this); never permanently on slabs |
| JS-per-frame animations | hero chart pen, range morph, celebration particles only; all others are CSS/WAAPI |
| Infinite animations | Spinner, Skeleton shimmer, live ping only; paused off-screen or hidden |
| Particles | ≤ 22, transform/opacity only, ≤ 1100ms, one burst at a time |

**Degrade ladder** (`src/lib/perf.ts` frame monitor, unchanged trigger: > 10% dropped frames over 5s while the pref is `auto`):

| Tier | Trigger | Changes |
|---|---|---|
| Full | default | everything |
| Reduced effects | the monitor or the Settings pref | §4.12 |
| Reduced motion | OS or Settings | §5.8 (independent of effects) |

Animations already running finish. The new tier applies from the next interaction.

---

## 6. Component specification (`src/ui`)

Every component keeps its current props. *Internal DOM additions* are noted where needed. "Slab", "well", "panel",
"glass" and so on refer to §4.

### 6.1 Actions

- **Button** — slab-raised.
  - Variants map per §4.2.
  - Sizes and edges: xs 24/1.5px, sm 28/1.5px, md 32/2px, lg 40/3px, xl 48/3px. Radii: xs/sm 6→7, md 9, lg 11, xl 13.
  - Weight 550; xl 600. Label letter-spacing −0.005em.
  - Remove `whileTap`.
  - `kbd` renders an inline mini-keycap (§4.3, 16px, `--edge:1px`) at 70% opacity, which depresses with the shortcut.
  - Loading: Spinner overlay, with the label fading to 0 over 120ms.
  - Success morph per §4.2.
  - Primary lg/xl adds the sheen span.
  - The `active` prop maps to latched.
  - `disabledReason` wrapper unchanged.
- **IconButton** — Button `data-icon-only`.
  - Secondary uses the dished keycap face, press `scale(.94)`. Ghost uses the flat plate.
  - The tooltip carries label plus Kbd.
  - Opt-in icon micro-motion (§5.7).
- **Kbd** — keycap-kbd (§4.3).
  - A module-level `keydown`/`keyup` listener normalises keys (`Meta`/`Control` → `mod`, arrows, `Enter`, `Escape`) and
    toggles `data-down` on every rendered `.emp-kbd[data-key="…"]`. Clear all on `blur`.
  - *Internal DOM:* each key renders `data-key`.
- **Menu / ContextMenu / menuParts** — glass-1, radius 10, padding 4, origin-aware scale (§5.4.1), rows stagger 16ms on
  first open only (not on submenu hover).
  - Items: the highlight is a ghost plate that glides between items (`layoutId` per menu), 32px rows.
  - Destructive items use `--loss-text` with a `--loss-soft` plate.
  - Submenus slide `x ±4px`, 120ms.
  - Checkmarks draw over 180ms.
  - Shortcuts render as mini-keycaps.

### 6.2 Inputs

- **Input / Textarea / SearchField / SecretField / NumberField / MoneyField** — well-recessed.
  - Heights 28/32/40; radius 9 (sm 8, lg 10).
  - Focus per §4.4, plus the caret colour `--text-primary`.
  - Invalid: the rim swaps to `--loss` and the helper text rises in (`y -4 → 0`, 160ms).
  - Affixes (`$`, `USD`, the search icon) use `--text-tertiary`. The SearchField's trailing Kbd fades out on focus (120ms).
  - SecretField: the eye toggle is a ghost icon keycap, and the mask ↔ text crossfade is 120ms.
  - NumberField steppers are 2 stacked mini-keycaps (`--edge:1px`) inside the well's right end, with a 400ms→60ms
    auto-repeat on hold.
  - MoneyField: tabular, right-aligned. On blur the formatted value settles with a 120ms crossfade (no roll).
  - Textarea auto-grows via a `layout` morph (not a height transition).
- **Field** — label 12/16 550 `--text-secondary`, 6px above the control; helper and error 6px below. The error icon pops in
  with `thumb`.
- **Select / Combobox** — the trigger is a **secondary slab** at full width (value left, chevron right). The chevron
  rotates 180° on open (glide).
  - Listbox: glass-1 with origin-aware open.
  - The highlight plate glides. The selected item's check draws in.
  - Combobox input: a well inside the glass, with the type-ahead highlight as a 2px underline groove.
- **Checkbox** — at rest it is a 16px well (radius 4), with an inner rim of `--well-rim-state` for ≥ 3:1.
  - Checked: it pops into a mini primary slab (`--edge:1px`, face from `--lit-*`) with `scale .6 → 1` on `thumb`; the tick
    draws via `pathLength` over 220ms with a 60ms delay.
  - Indeterminate: the bar draws.
  - Press squashes `scale(.9)`.
  - In task lists (editor to-do, Today, habits) the parent passes `celebrate` to enable the **8-ray burst** (S13).
  - The hit area is 24×24.
- **Radio** — a 16px circular well with a `--well-rim-state` rim. Checked: a 6px dome dot (`--lit-*`) scales in on `thumb`.
  The group's focus ring lands on the checked item.
- **Switch** — the track is a well:
  - Sizes 36×20 (sm 28×16); in light, `#e2e2e7` with an inset rim of `--well-rim-state`.
  - The lit on-fill crossfades via `::before` (`linear-gradient(--lit-a, --lit-b)` plus `0 0 12px var(--lit-glow)`), 180ms.
  - The thumb is a dome. It moves on `thumb` (16px travel). While held it stretches `scaleX(1.28)` from the leading edge
    (160ms ease-out).
  - Focus: outline offset 3px.
- **Slider** — the track is a 6px well groove with engraved tick marks every 10% (1px grooves). The fill uses `--lit-*` via
  `scaleX(var(--v))` (transform, not width).
  - The thumb is an 18px dome keycap that scales to 1.12 while dragging.
  - The value tooltip is a solid ink pill that rises in 120ms.
  - Arrow keys: the thumb glides; dragging is 1:1.
- **Segmented** — the bed is a well (radius 10, padding 3), and the indicator is a secondary slab (`--edge:1.5px`) that
  glides via `layoutId` with velocity squash.
  - Press squashes the indicator `scale(.975)`.
  - Labels: `--text-tertiary`, and the selected label is `--text-primary` (120ms colour).
  - **Do not animate `width`**: the indicator is positioned by layout projection.
- **Tabs** — an engraved 2px groove baseline (§4.9). The indicator is an **extruded 3px bar** (ink top face + 1px darker
  side), which glides with **leading-edge-first elasticity**:
  - The leading edge moves first (40% of the duration), then the trailing edge catches up.
  - Implement it as `layoutId` + a WAAPI keyframe on `scaleX` / `transform-origin` (460ms).
  - Hovered tabs get a ghost plate. Count badges roll on change.
  - Switching tabs sets `data-nav-dir=lateral` for the panel content (§5.4.3).
- **DatePicker / Calendar** — the popover is glass-1.
  - Day cells are ghost plates.
  - The selected day is a primary mini-slab (`--edge:1.5px`), and today has a 1px ring.
  - The range fill is a well band.
  - Month change slides `x ±16px` with direction (lateral rule).
- **ColorPicker / accent swatches** — swatches are 20px domes with block-colour faces. The selected swatch is latched with
  an outer 2px `--ring` that lands from offset 4px. Hovering scales 1.08 on `release`.
- **EmojiPicker / EmojiPickerPanel** — glass-1 popover with a well search field. Cells are ghost plates. Hovering scales
  the emoji 1.15 on `release`. Category tabs follow the Tabs spec at small size.
- **FileDropZone** — at rest it is a well with a 1.5px dashed `--border-strong` rim (radius 14) and the isometric slab
  glyph (the icon's top slab, 40px).
  - On drag-over the well **inverts to a raised panel**: the glyph lifts `y -4px` and its slabs separate by 3px
    (an exploded view), the rim goes solid `--ring`, on settle.
  - On drop the slabs re-stack (`release`) and a progress groove fills.
- **ChoiceCard** — a panel with `data-raise data-light` and at most 3° tilt.
  - Selected: it becomes latched (presses 1px, inset top shadow, rim `--ring`), and a check badge pops on `thumb`.
  - In a radio group the selection does **not** glide between cards: each card latches on its own.
- **StrengthMeter** — 4 well segments, each 4px with a 4px gap. Lit segments fill via `scaleX` (transform), coloured
  loss/warning/gain, 24ms stagger.

### 6.3 Display

- **Card** — panel (§4.5), radius 14, padding 16/12/20. Interactive cards get `data-raise`; hero cards get `data-light data-specular`.
  - Header: 15/22 600 title with a 12px gap.
  - *Internal DOM:* an optional `<span class="emp-edge">` when `light`.
- **KpiTile** — a panel with `data-raise data-light data-specular` when clickable.
  - Tilt: `rotateX/rotateY` up to 3° following the pointer, with `perspective: 800px`, returning on `magnet`.
  - Value: RollingNumber. Label: `--text-secondary`. Sparkline in ink.
  - Click → detail morph (S10).
- **Amount** — tabular, U+2212 negatives, gain/loss colour when signed.
  - Inside RollingNumber it follows §5.5.
  - Hide-numbers: the mask is a 6px-radius well chip with dot glyphs that crossfades (120ms), and hovering reveals it
    (when Settings allows).
- **DeltaPill** — a 20px pill with a `--gain-soft`/`--loss-soft` face, a 1px rim at 30% of the semantic colour, an inset
  top highlight, and a 12px arrow. The arrow nudges `y ∓1px` on value change. Mono mode stays neutral.
- **PriceFlash** — on a tick, only changed digits roll (`roll` at 300ms, no stagger), and the text tint flashes
  `--gain-text`/`--loss-text` then fades back over 600ms (colour only, never a background block).
- **Badge** — an 18px pill, raised half-slab (`--edge:1px`), 11/14 600, using semantic soft faces. A count change rolls.
- **Tag** — 20px, radius 5, block-colour face with a 1px inner rim and no edge (it is *printed*, not raised).
  - Removable tags show an ✕ ghost keycap on hover.
  - When a tag is added it rises from the input caret.
  - Filter chips (used in databases and Money HQ) are **Tag-shaped keycaps**: `--edge:1.5px`. Active = latched, with a
    check sliding in (`x -4 → 0`, 120ms) and the width change handled by layout morph.
- **Avatar** — a dome with a hashed block-colour face, inset top highlight and 1px rim. Stacked avatars overlap −6px with a
  2px canvas ring.
- **Banner** — 40px. It is a **well** band (recessed into the page) with a semantic soft tint and a 2px semantic left
  groove. It enters by sliding down (`y -100% → 0` inside a clip) on settle. The dismiss ✕ is a ghost keycap.
- **EmptyState** — max-width 360. The 48px icon tile is the **isometric slab glyph** (drawn from the icon geometry) in ink
  tones, on a 64px well disc.
  - On mount the slabs settle in from `y -8` with a 60ms stagger (3 slabs), once.
  - Title 15/22 600; body 14/20 `--text-secondary`. The primary action is a slab.
- **Progress** — the track is a well groove (2/4/8px) and the fill is `--lit-*` via `scaleX` on glide.
  - Indeterminate: a 30% bar slides with `translateX` (1.2s ease-in-out, looping only while mounted and visible).
- **Ring** — the track is an engraved groove ring and the fill is the lit stroke.
  - Dashoffset animates on settle over 700ms.
  - At 100% the ring emits `--glow-gain` once and its centre check pops (`pop`). Used by S8.
- **Skeleton** — a well-tinted block (`rgba(text,.06)`, inset 0 1px 1px `--well-in` at 50%). The shimmer is a skewed
  highlight band moving by `translateX` (1.6s linear) and is removed under reduced motion.
- **Spinner** — a 270° arc, stroke 1.5, 700ms linear rotation, ink. It always spins.
- **Separator** — a groove (§4.9), horizontal or vertical.
- **Sensitive** — the mask is a frosted well chip (glass-1 effect inline only when effects are full; otherwise opaque well).
  Reveal is a 160ms blur(6px → 0) + opacity.
- **Tooltip** — a solid ink pill (`--tooltip-bg`), radius 6, 12/16 500. It rises `y 2 → 0` with opacity over 120ms and
  exits in 80ms. Delay 500ms, skip 300ms. Shortcut keys render as inverse mini-keycaps.
- **Toast** — glass-1, radius 12, at the bottom centre.
  - Enter: rises from the dock (`y 24 → 0`, `scale .92 → 1`) on `thumb`.
  - The success icon is a gain dome with a tick that draws at +300ms.
  - A **groove progress bar drains** via `scaleX` over the toast lifetime and pauses on hover or focus.
  - Toasts stack Sonner-style: older ones go `y -8px, scale .95` per level, with their content fading at ≥ 2 deep.
  - Undo is a secondary sm slab.
  - Exit: `y 8, opacity 0`, 160ms ease-in.
- **Dialog / AlertDialog** — glass-2, radius 14, padding 20.
  - Origin-aware grow and close (§5.4.1).
  - Scrim: an opacity fade, 300ms in and 150ms out, with no blur.
  - AlertDialog destructive: the 40px icon tile is a well with `--loss` glyph, and the confirm slab is focused by default
    with `--glow-loss`.
  - The close ✕ is a ghost keycap.
- **Sheet** — glass-2, inset 8, radius 14, from the right: `x 100% → 0` on settle, exit 180ms ease-in. Content rows rise
  with a 16ms stagger after 120ms. Drag-to-dismiss uses `drag` for the release.
- **Popover** — glass-1, origin-aware. Forms inside use padding 16.
- **ScrollArea** — the thumb is a 6px dome (8px on hover, 120ms), fading out 800ms after scroll stops. The track is
  invisible until hovered, then a faint well groove.
- **Resizable** — the handle is a 1px groove that becomes a 4px dome bar on hover (120ms) with a `col-resize` cursor.
  The pressed handle is latched.
- **Gallery** (UI-kit gallery page `ui-gallery.html`) — must showcase every component in every state in all three themes,
  plus switches for `data-motion`, `data-effects` and `data-contrast`. It is the visual regression target.
- **SanitizedHtml** — no visual change (security boundary).
- **Motion helpers:**
  - **`Celebrate`:** isometric mini-slabs instead of coloured confetti (S8).
  - **`RollingNumber`:** §5.5.
  - **`themeTransition`:** S12.
  - **`MotionProvider`:** also installs `pointerLight` and the Kbd key listener once.
  - **`presets`:** retuned to §5 names, with `pressMd`/`pressSm`/`pressCard` deprecated in favour of the CSS press.
  - **`features`, `layer`, `expression`, `emoji-data`:** unchanged.

### 6.4 Charts (`src/charts`)

`ChartFrame` provides the panel, title row, range Segmented, legend and faux-glass `Tooltip`.

| Chart | Behaviour |
|---|---|
| `Line` / `Area` | §5.6, pen draw only when the chart is a `hero` |
| `Sparkline` | clip reveal 500ms; ink |
| `Bar` / `Waterfall` | settle grow, 24ms stagger |
| `Donut` / `Gauge` | sweep |
| `Candles` | wicks fade, then bodies grow `scaleY` from the open price, 12ms stagger, max 60 |
| `Treemap` / `Heatmap` | cells fade with a 6ms diagonal stagger |
| `Sankey` | links draw via dashoffset after the nodes settle |
| `Fan` | median draws first, then the bands fade outward |

`theme.ts` exports `--chart-line` / `--chart-fill-top` per theme. `a11y.ts` is unchanged: every chart keeps its table
fallback.

---

## 7. Signature moments

Each moment is skippable (any key, click or Esc jumps to the end state), honours reduced motion with a crossfade to the
end state, and honours reduced effects (no particles, glow or blur).

| # | Moment | Area / owner | Spec |
|---|---|---|---|
| S1 | **Living keycaps** | ui/Kbd (every shortcut hint) | Every visible Kbd depresses when the real key is pressed (⌘, K, ↑↓, ↵, esc, …) and springs back on release. In the palette footer, pressing ↑/↓ makes the on-screen keys go down in sync with the highlight glide. |
| S2 | **Vault unlock cinematic** | vault/LockScreen, AppMark | **Intro:** the three icon slabs drop into a stack (bottom → top, 70ms stagger, settle, each landing with a 1px contact-shadow squash). The password well rises (+160ms). **Correct password:** the stack *presses* (all slabs compress 2px over 70ms) then releases (`release`). The glass-3 veil lifts (`blur 40 → 0`, `opacity 1 → 0`, 520ms expo) while the app behind scales `1.02 → 1`. Sidebar and content then rise with the standard stagger. Total ≤ 1.2s. **Wrong password:** the shake preset plus the slabs jolting out of alignment (±3px, then re-stacking on `release`). |
| S3 | **Onboarding: forge your vault** | vault/Onboarding | Each step is a panel that slides laterally with direction. On the "create vault" step, the slab glyph assembles from 3 exploded slabs as the key-derivation progress groove fills (progress is real). The final CTA is the one place the magnet button is allowed (≤ 3px pull). |
| S4 | **Recovery ceremony** | vault/RecoveryCeremony | The 24 words are keycaps that flip up one by one (`rotateX(-90°) → 0`, perspective 600px, 40ms stagger, settle). Verification words latch down as they are confirmed. |
| S5 | **Net-worth hero** | finance/MoneyHQ, portfolio/PortfolioDashboard, home widget | **First view per session:** the RollingNumber counts up (1300ms) while the pen draws the line (1100ms), then the end-dot keycap gives 3 halo pulses. **Scrubbing** drives the number in scrub mode and the DeltaPill updates live. **Range change** morphs line, axis and number together over 620ms. |
| S6 | **Life-app install builds the workspace** | lifeapps/WizardSheet, PlanPreview, Gallery, shell Sidebar | **Pressing "Create":** the wizard sheet compresses into the app tile, and the tile flies (`view-transition-name: vt-app-tile-<id>`) into a slot that opens in the sidebar's Life Apps list (layout morph). **The build:** the content area shows glass-3 over the empty app page, and the plan's items (pages, databases, widgets, budget envelopes) *build* in order. Each is a skeleton slab that drops in (settle) then fills from wireframe to real content (opacity crossfade). The cadence is 90ms per item, cap 2.4s. A progress groove fills, driven by real progress events. **Finish:** an edge-light sweep crosses the new AppHeader (one `translateX` pass, 700ms) and the first CTA gets the sheen. |
| S7 | **Command palette** | search/CommandPalette | Origin-aware open (§5.4.1). Rows rise at 16ms. The highlight slab glides with velocity squash. Matched characters get a 2px groove underline that draws in (`scaleX`, 120ms). On Enter, the highlighted row presses (keycap) for 70ms, then the palette shrinks toward the destination (`scale .98`, fade 140ms) while the route transition runs. A "Calculator" result rolls its number. |
| S8 | **Goal reached** | finance goals, habits streaks, taxes "paid" | The ring fills (settle), the number rolls (e.g. 4.7 → 6.0), and the centre check pops (`pop`) with `--glow-gain`. Then **16–22 isometric mini-slabs** burst (the icon's slab geometry: a top rhombus plus 2 side faces, 6–10px, ink tones with one in `--gain`). They use precomputed parabolas in WAAPI (gravity, 1100ms, random spin ≤ 540°). A toast follows at +400ms. See `ref-05`. |
| S9 | **Page open morph** | shell Sidebar, home, databases rows, search | Clicking a page row morphs its icon and title (`vt-page-icon/title-<id>`) into the page header's icon and H1 (380ms morph). The body content rises in after 80ms. Back reverses the morph into the row if it is visible. |
| S10 | **KPI → detail** | finance, portfolio, home | KpiTile morphs (`layoutId`) into a detail panel. The label and number travel as shared elements on one timeline. The page behind recedes (`scale .97`, `opacity .22`). Detail bars spring up with a 24ms stagger. Close reverses the morph. See `ref-06`. |
| S11 | **Sidebar selection slab** | shell Sidebar | The selected row is a secondary slab (`--edge:1.5px`) that glides between rows with velocity squash and a hover ghost that lags. The slab presses as you click. Collapsing a section folds rows with a layout morph and a chevron rotate. |
| S12 | **Theme re-light** | settings, topbar toggle (`themeTransition`) | A circular View Transition reveal from the toggle (480ms expo). Under it, slabs swap from lit face to side face. The canvas halo crossfades. In reduced motion: a 120ms crossfade. |
| S13 | **Task completion** | editor to-do blocks, Today, habits | Checkbox pop plus an **8-ray burst** (1px ink rays, 10px, 280ms, transform/opacity). The label gets a strike-through drawn left to right (`scaleX` of a 1px line, 220ms), and the text fades to `--text-tertiary`. The row settles to the "done" group with a layout morph after 600ms (if the view sorts). |
| S14 | **Board drag** | databases/views (board, gallery), calendar events | Pickup: the card lifts (`--panel-raise`, `scale 1.03`, `rotate 1.5°` in the drag direction) on release. Other cards glide out of the way (morph). Drop: the card lands (settle) with a contact-shadow squash. Column counts roll. |
| S15 | **Sheet selection glide** | sheets/GridView (canvas overlay layer) | The selection rectangle and the active-cell border glide between cells on glide (transform only, DOM overlay above the canvas). The fill handle shows a ghost range while dragging. Committed formula results roll if numeric. The formula bar's fx keycap depresses on Enter. |
| S16 | **Markets live** | markets/Watchlist, QuoteTile, CandleChart | Ticks roll only the changed digits with a tint fade (PriceFlash). The live end-dot pings every 2.4s while the market is open and the chart is visible. The candle range morph eases the price axis over 620ms. |
| S17 | **Rebalance preview** | portfolio/RebalancePlanner | Allocation bars show a "before" ghost (well-tinted) while lit bars spring to the targets (settle, 40ms stagger). Trade amounts roll. Drift badges change colour over 200ms. |
| S18 | **Tax estimator scrub** | taxes/Estimator, QuarterlyPlan | Dragging an income or deduction slider drives the refund/owe RollingNumber (scrub mode). The bracket waterfall morphs live. Crossing from "owe" to "refund" flips the DeltaPill colour, and the number does one `pop` scale (1 → 1.04 → 1). |
| S19 | **Home arrival** | home/HomePage, widgets | The greeting rises, then widgets cascade (40ms, max 8). The Today ring fills, net worth counts up (first session view only), and the next calendar event's time chip pulses once. |
| S20 | **Connect Google** | integrations/GoogleSetupSheet, ProvidersPanel | On OAuth success, two slab glyphs (EMP and the provider mark) slide together and *click*: a 2px press, a contact flash, then a check pop. Sync progress is a groove. The first synced item count rolls. |
| S21 | **Database view switch** | databases/ViewTabs | Switching Table → Board → Calendar uses a lateral route-style transition inside the view area. Rows and cards rise with a 16ms stagger (cap 12). Filter chips latch with a sliding check, and the row count rolls. |
| S22 | **Editor slash and block moves** | editor/menus, nodeviews | The slash menu grows from the caret (origin = caret rect). Block drag shows a 2px insertion groove that glides between blocks. A dropped block lands with settle. A new page's cover fades in with a 1.02 → 1 scale. |

---

## 8. Per-area application checklists

These are written to be ticked by each implementation team. "Material" means the §4 recipes, not ad-hoc shadows.

### 8.1 Shell, home, vault and search

- [ ] Canvas halo per theme (§3). The sidebar is a panel plate with grain and a groove right edge; the topbar becomes glass-1 when scrolled.
- [ ] Sidebar selection slab with glide, velocity squash and hover ghost (S11). Section collapse uses a layout morph.
- [ ] `data-nav-dir` plumbing and View-Transition route changes (§5.4.2–3). Page open morph (S9).
- [ ] Breadcrumbs: ghost plates, with chevrons nudging on hover.
- [ ] PageActions and WindowControls use ghost IconButtons. Topbar icons have no micro-motion.
- [ ] RouteSkeleton uses Skeleton v2 and holds for at least 150ms to avoid flash.
- [ ] Home: arrival choreography (S19). Widgets are `data-raise data-light` panels; the net-worth widget follows S5.
- [ ] Vault: LockScreen cinematic (S2), onboarding (S3), recovery ceremony (S4). PasswordField is a well, and its strength meter follows §6.2.
- [ ] CommandPalette is glass-2 with S7; footer keycaps follow S1; the calculator result rolls.
- [ ] Shortcut dialog: every shortcut rendered as living keycaps.
- [ ] Verify in light, dark and midnight × reduced motion, reduced effects and higher contrast.

### 8.2 Editor and databases

- [ ] Editor chrome: floating format toolbar is glass-1 with latched keycaps for active marks (B/I/U…), plus the slash menu (S22).
- [ ] To-do blocks use the checkbox with burst and strike-through (S13). Callouts are wells with a block-colour tint.
- [ ] Code blocks are wells, and the copy button morphs to a check (success morph).
- [ ] Inline databases and table views: headers on a groove baseline; row hover is a ghost plate. **No raised slabs in rows.**
- [ ] Board and gallery: cards are panels `data-raise`, with drag per S14.
- [ ] ViewTabs follow the Tabs spec; view switch follows S21. Filter and sort chips are tag keycaps, latched when active.
- [ ] FormulaEditor is a well with a mono font; error helpers rise in.
- [ ] Row page: the open morph (S9) from the row title. Property fields are wells.
- [ ] Templates and Import dialogs are glass-2 with origin-aware open.

### 8.3 Sheets, calendar, settings and integrations

- [ ] Sheets: the grid canvas stays flat for perf. Selection and active cell use the DOM overlay glide (S15). The formula bar is a well with an fx keycap. SheetTabs follow the Tabs spec at small size. StatusBar figures roll. CondFormat and Find panels are glass-1.
- [ ] Sheet toolbar: latched keycaps (bold, alignment) and Segmented for alignment groups, with 4px row padding for slab edges.
- [ ] Calendar: day and week cells are wells; events are tinted panels (`--edge` 0) that lift while dragged (S14). Period change slides with direction. The today marker is a primary mini-slab; the now-line is a 1px loss line with a 6px dome.
- [ ] Settings: sections are panels. Toggles follow the Switch spec, and the accent picker uses latched domes. The theme picker uses S12; changing text size or density previews live with a 160ms crossfade. JobProgress uses progress grooves.
- [ ] Integrations: ProvidersPanel cards are `data-raise` panels. The connect flow uses S20. NetworkLog is a table (flat, ghost rows). The OpenExternalPrompt dialog is glass-2 and origin-aware.

### 8.4 Finance, portfolio, markets and taxes

- [ ] Money HQ: hero per S5, KPI column per S10, budget envelope rings per Ring v2, the to-be-assigned number rolls. The Assign button is a primary sm slab.
- [ ] Transactions table: tabular amounts with gain/loss text. The categorise chip is a tag keycap. Bulk actions bar is glass-1 rising from the bottom.
- [ ] ImportWizard: FileDropZone v2 (exploded slabs), with step transitions lateral. The "48 rows imported" toast drains.
- [ ] Rules, DebtPlanner and Forecast: charts follow §5.6. The debt-free date rolls when inputs change, and Forecast fan bands fade outward.
- [ ] Goals: S8 on completion.
- [ ] Portfolio: S5 on the dashboard hero. Holdings table flat. HoldingPage opens with the S9 morph from the ticker. Rebalance follows S17. Dividends calendar cells are wells.
- [ ] Markets: S16, watchlist rows with PriceFlash, SymbolSearch is glass-1, CandleChart per §6.4.
- [ ] Taxes: TaxHub KPI tiles, Estimator S18, QuarterlyPlan rows latch as "paid" with S8-lite (ring and check, no particles).
- [ ] All money: tabular, U+2212, masked under privacy, and never rolled while masked.

### 8.5 Life apps

- [ ] Gallery: app tiles are panels with `data-raise data-light`, tilt ≤ 3° and the icon's slab glyph, using the app colour as the face tint only.
- [ ] StartHere and the WizardSheet steps are glass-2, with lateral step transitions and ChoiceCards latching.
- [ ] PlanPreview: items listed as skeleton slabs, ready for the S6 build.
- [ ] Install and build per S6, with the sidebar slot opening and a shared-element tile.
- [ ] AppHeader: an edge-light sweep once after install, plus the Insights cards KPI behaviour (S10).
- [ ] Habits: streak completion S13, plus S8 at streak milestones (7, 30, 100).
- [ ] Every life app inherits the area checklist of the area it renders (finance apps → 8.4, and so on).

---

## 9. Implementation map (suggested ownership)

| Piece | File(s) | Notes |
|---|---|---|
| Material tokens and recipes | `src/styles/material.css` (new), `tokens.css` (durations/eases), `components.css` (`.emp-btn`, wells, …) | Design-system team |
| Springs | `src/ui/motion/tokens.ts`, `presets.ts`, `material.css` | Keep legacy names as aliases |
| Pointer light | `src/ui/motion/pointerLight.ts` (new), installed by `MotionProvider` | One listener |
| Kbd key listener | `src/ui/Kbd.tsx` | Module-level, ref-counted |
| Origin-aware Dialog | `src/ui/Dialog.tsx`, `AlertDialog.tsx` (optional `originRef` prop: additive, API-compatible) | |
| Route transitions | `src/app/router.ts`, shell | `data-nav-dir` + View Transitions |
| RollingNumber v2, Celebrate v2, themeTransition | `src/ui/motion/*` | |
| Chart motion | `src/charts/*` | |
| Feature moments | each feature folder per §7 | |

---

## 10. QA and acceptance

- **Screenshot matrix.** For the UI-kit gallery and five key routes (Home, Money HQ, a page, a database board, a sheet):
  light, dark and midnight × (default, `data-motion=reduced`, `data-effects=reduced`, `data-contrast=more`). Compare
  against `docs/design/ref-*.png` and `prototype.html` for material fidelity.
- **Motion capture.** Frame strips (20× slow-mo via `Animation.setPlaybackRate`) for press/release, switch, tabs, dialog
  origin, palette, S5, S8 and S10. Check there is no jitter of slab edges and no layout shift.
- **Performance.**
  - A Chrome performance trace of: route change, dialog open, palette open and the hero draw. Each must show no
    layout/paint storm and ≤ 2 backdrop layers.
  - Frame monitor: force `data-effects=reduced` and verify that depth survives.
- **Contrast.** Automated check of all label/face pairs per theme and accent (≥ 4.5:1 for text, ≥ 3:1 for control boundaries).
- **Reduced motion.** Every screen is complete and static by 200ms. No translate or scale animation is observed.
- **Checks.** `npx tsc --noEmit`, `npx vitest run`, and occasionally `npx vite build`.

---

## 11. Where `prototype.html` deviates from this spec (the spec wins)

1. **Destructive face colours.** The prototype uses `#ef5d61→#cc3531`, which is about 4.1:1 at the label. The spec uses
   `#e0474b→#bb2c2c` (light) and `#e5484d→#b82a2a` (dark).
2. **Switch, checkbox and radio rims.** The prototype's off-state boundaries are below 3:1. The spec adds `--well-rim-state`.
3. **Midnight.** The prototype's midnight is barely distinguishable from dark. The spec deepens the panel lows and shadow
   and lowers grain (§4.1).
4. **Segmented indicator.** The prototype animates `width`; the spec uses `layoutId` projection.
5. **Canvas halo.** The prototype uses a neutral glow only. The spec adds the icon's cool halo at ≤ .055 in dark and
   midnight (from the Depth study).
6. **Overlay origin.** The prototype's dialog drops from centre; the spec grows it from the trigger (from
   `prototype-motion.html`).
7. **Placeholders.** The prototype uses a lighter tone; the spec uses `--text-tertiary`.
8. **Not in the prototype at all:** signature moments S2–S4, S6, S9 and S12–S22, the pointer specular and the sheen.
   Follow this spec and `prototype-motion.html`.
