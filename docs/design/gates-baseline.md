# Phase 0 gates: how to run them, and the BEFORE numbers

The v3 programme ([PROGRAMME-v3.md](PROGRAMME-v3.md), K6) has two kinds of guardrail:

- **CI checks** fail the build: the style, copy and emoji ratchets and the token contrast test (vitest,
  `src/test/guards/`), and the bundle budget (`scripts/bundle-budget.mjs`, after `npx vite build`).
- **Local phase-exit gates** are run by hand before a phase closes: the census and settle scripts below. They are not
  in CI because they need a browser and their timings depend on the machine.

Numbers below were measured on 2026-11-26 on the shared agent sandbox (Chromium headless via the global Playwright,
1440×900, `?seed=demo&freeze=2026-11-26T15:30:00Z`, graphite accent).

## Running the local gates

Start a mock dev server on a free port, then run the scripts from anywhere with the global Playwright on `NODE_PATH`
(Playwright is not a project dependency; never run `playwright install`):

```sh
VITE_ALLOW_MOCK=1 npx vite --port 1702 --strictPort &
NODE_PATH=/opt/node-tools/node_modules node scripts/gates/census.js --port 1702
NODE_PATH=/opt/node-tools/node_modules node scripts/gates/settle.js --port 1702 --runs 3
NODE_PATH=/opt/node-tools/node_modules node scripts/gates/settle.js --port 1702 --runs 3 --reduced-motion
```

Options shared by both scripts:

| Option | Default | Meaning |
|---|---|---|
| `--port N` | 1420 | Port of the mock dev server |
| `--routes a,b` | `home,money` | Route paths (`/calendar`) or aliases: `home`, `money` (Money HQ), `portfolio`, `taxes`, `markets`, `calendar`, `lifeapps` |
| `--routes-file f.json` | | A JSON array of route paths, e.g. the 59-route list |
| `--themes light,dark` | `light,dark` | Colour schemes to measure |
| `--reduced-motion` | off | Emulate `prefers-reduced-motion: reduce` |
| `--out f.json` | | Also write the full results as JSON |
| `--runs N` | 1 | Settle only: runs per route; the table shows the median |
| `--window ms` | 3000 | Settle only: how long to watch after route-ready |

Each route is loaded fresh in a new browser context and measured after `emp:route-ready` (docs/design/KIT.md §6).

### census.js

After route-ready plus 1.5 s (the resting state), it counts on the whole window, with the route pane alone in brackets:

- **shadows:** elements, including `::before`/`::after`, with a computed `box-shadow`;
- **gradients:** elements, including pseudo-elements, with a gradient `background-image`;
- **radii:** distinct non-zero `border-radius` values on visible boxes;
- **weights** and **sizes:** distinct font weights and font sizes on elements that render text;
- **nested:** bordered or filled boxes of at least 40×24 px inside another bordered box, in the route pane;
- **blur:** elements with a `backdrop-filter` at rest.

**Phase exit (Home and Money HQ):** shadows ≤ 12, gradients ≤ 1, radii ≤ 5, weights ≤ 4. Flow's kill bar for Home
is nested = 0.

### settle.js

It records DOM mutations and animation frames from page load, then evaluates the window that starts at route-ready
(`detail.at`), with no user input:

- **settle:** ms from route-ready to the last DOM mutation or finite animation frame. A value marked `+ (live)` means
  the DOM was still changing in the last 300 ms of the window.
- **idle:** infinite animations still running at the end of the window.
- **changed:** numbers on screen at route-ready whose text changed later. This is a count-up, or data arriving late.
  "At route-ready" is the frame `detail.at` names, not the event, which arrives at least 100 ms later. Number
  snapshots run from page load (every frame during the idle hold, every 50 ms otherwise), so a change made during
  the hold counts.
- **late:** numbers that appeared after route-ready, counted per parent element.
- **rolling:** elements holding a number that animated after route-ready, through a style mutation or WAAPI.

**Phase exit (chair resolution):** settle ≤ 300 ms after route-ready must pass, and ≤ 150 ms is the target. Changed,
rolling and idle must all be 0 (no count-up on arrival).

## BEFORE numbers (2026-11-26, before Phase 1)

### Census

| Route | Theme | Shadows | Gradients | Radii | Weights | Sizes | Nested | Blur | Gate |
|---|---|---|---|---|---|---|---|---|---|
| Home `/home` | light | 122 (97) | 86 (59) | 11 (9) | 10 (9) | 10 | 14 | 0 | fail |
| Home `/home` | dark | 122 (97) | 87 (59) | 11 (9) | 10 (9) | 10 | 14 | 0 | fail |
| Money HQ `/app/01a0f6b1-2757-…` | light | 102 (75) | 87 (58) | 10 (9) | 11 (10) | 13 | 7 | 0 | fail |
| Money HQ `/app/01a0f6b1-2757-…` | dark | 102 (75) | 89 (59) | 10 (9) | 11 (10) | 13 | 7 | 0 | fail |

Detail:
- **Radii in use.** Home: 3, 4, 5, 6, 7, 9, 13, 14, 16, 999 and 9999 px. Money HQ: 3, 5, 6, 7, 8, 9, 10, 12, 14 and
  9999 px.
- **Weights in use.** Home: 400, 500, 550, 560, 600, 630, 650, 660, 680 and 700. Money HQ adds 620 and 640.
- **Nested boxes.** On Home, `.hm-widget.panel` contains `.hm-habits.well`, `.la-insight.panel` (×3) and
  `.hm-cell.well` (×4). On Money HQ, `.fh-card` contains `.emp-seg` and `.fh-insight`.

### Settle (median of 3 runs)

| Route | Theme | Motion | Route-ready after mount | Settle | Idle | Changed | Late | Rolling | Gate |
|---|---|---|---|---|---|---|---|---|---|
| Home | light | default | 1.60–1.65 s | 486 ms | 0 | 0 | 0 | 3 | fail |
| Home | dark | default | 1.61–1.73 s | 500 ms | 0 | 0 | 0 | 3 | fail |
| Money HQ | light | default | 1.67–1.73 s | 1,561 ms | 0 | 0 | 0 | 0 | fail |
| Money HQ | dark | default | 1.69–1.75 s | 1,559 ms | 0 | 0 | 0 | 0 | fail |
| Home | light | reduced | | 513 ms | 0 | 0 | 0 | 1 | fail |
| Home | dark | reduced | | 506 ms | 0 | 0 | 0 | 1 | fail |
| Money HQ | light | reduced | | 0 ms | 0 | 0 | 0 | 0 | pass |
| Money HQ | dark | reduced | | 0 ms | 0 | 0 | 0 | 0 | pass |

Readings:
- **Home rolls its numbers on arrival.** Three `RollingNumber` groups animate after route-ready, and one still does
  under reduced motion. Its digit columns mount about 1 s after the widgets.
- **Money HQ's settle is all animation.** Only 2 DOM mutations follow route-ready, but a finite animation runs about
  1.5 s longer. Under reduced motion it is instant.
- **Both routes take about 1.6–1.7 s from mount to idle** (mock backend, demo seed). Home toggles skeletons more than
  once while its widgets load.
- **Variance between runs** is ±20 ms for settle and 0 for the census counts.
- **Re-checked with the `detail.at` number baseline** (same day, after the settle script stopped taking its first
  number snapshot at the event): Home 491 / 495 ms with 3 rolling, Money HQ 1,596 / 1,606 ms; reduced motion Home
  524 / 506 ms with 1 rolling, Money HQ 0 ms. Changed and late stay 0, so neither route rewrites number text during
  the hold.

## CI baselines at the same point

These snapshots are committed and may only fall (`npm run guards:update` lowers them; it refuses if anything rose):

- `src/test/guards/style-baseline.json`
- `src/test/guards/copy-baseline.json`
- `src/test/guards/emoji-baseline.json`
- `scripts/bundle-baseline.json`, refreshed with `npm run budget:update` after an intended change.

Their totals are in each file's `totals` field.

## Bundle rebaselines

| Date | Reason | Before → after |
|---|---|---|
| 2026-11-26 | Phase 1 re-split chunks | JS 1,343 → 1,348.4 KB (+0.4%), CSS 131.6 → 113.1 KB (-14.0%), Home boot 446.5 → 349.5 KB (-21.7%). Eight chunks failed the +5% per-chunk rule only because Rollup moved shared modules between chunks (for example the 29.5 KB `IconButton.js` chunk no longer exists on its own while `toasts.js` went from 13.5 to 40.9 KB; total JS is flat). The largest new chunk is `glyphs.js` at 17.8 KB, well under 50 KB. |
| 2026-11-26 | Phase 2 kit pass: icon registry re-split shared lucide chunks (user.js 1.7 to 2.3 KB) | JS 1336.8 KB (-0.9%), CSS 101.3 KB, Home boot 353.5 KB |
