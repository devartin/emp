# README media pipeline

`scripts/media/capture.mjs` regenerates every screenshot and motion clip used by the project README from the live
browser-mock app, so the README always shows the current UI.

```bash
npm run media:capture                              # everything, into docs/screenshots and docs/media
npm run media:capture -- --only home,money         # only these shots (see --list)
npm run media:capture -- --only stills --theme both # every still in both themes
npm run media:capture -- --out-dir /tmp/media      # write somewhere else (screenshots/ and media/ inside it)
npm run media:capture -- --list
```

It starts its own mock dev server (`VITE_ALLOW_MOCK=1 vite --port 1490 --strictPort`) unless something already
answers on `--port`, and stops it when done. A full run takes about ten minutes.

## Requirements

- **Playwright** with Chromium. It is not a project dependency: the script finds it in the project, on `NODE_PATH`,
  in the global npm root, or in `/opt/node-tools/node_modules`. Don't run `playwright install` in this repo's
  container; on your own machine `npm i -g playwright && npx playwright install chromium` is enough.
- **ffmpeg** on `PATH` (with libx264). Needed for clips and for optimising stills.

## What it produces

| Output | Format |
|---|---|
| `docs/screenshots/<name>-<theme>.png` | 1440x900 CSS px rendered at 2x, resampled to 2400x1500, rounded window corners with a hairline, optimised PNG (palette-quantised only if the truecolour file would pass 600 KB) |
| `docs/media/<clip>.gif` | 960px wide, 18 fps, looping, palettegen/paletteuse; steps down (15 fps, fewer colours, 880px) until it fits 3 MB |
| `docs/media/<clip>.mp4` | 1920px wide, 30 fps, H.264, yuv420p, `+faststart`, no audio |

Stills: `home`, `money-hq`, `money-budget`, `portfolio`, `markets`, `tax-estimator`, `database-table`,
`database-board`, `page`, `sheet`, `calendar`, `life-os`, `habits`, `life-apps`, `command-palette`, `first-run`. Each
is captured only in the theme the README shows it in (the screenshot table is light on the left, dark on the right),
so a default run writes exactly the 16 files the README uses. `lock-screen` is optional: it is captured only when
named in `--only`, since the `unlock` clip already shows that screen.

Clips: `unlock`, `life-app-build`, `capture`, `command-palette`, `money`, `database`. Each is 6 to 12 seconds,
recorded in the light theme (`--clip-theme dark` for dark).

`command-palette` is both a still and a clip; use `still:command-palette` or `clip:command-palette` to pick one.

## How it stays deterministic

- `?seed=demo&freeze=2026-11-26T15:30:00Z` (the `empty` seed for first run, `&locked=1` for the lock screen, password
  `demo`), UTC time zone, `en-US` locale, a seeded `Math.random`, a fresh browser context for every shot.
- Page and app ids are looked up by title from the seed (`Client CRM`, `Project tracker`, `Website relaunch`,
  `Household budget 2026`, life apps by app id), not hard-coded.
- Every still waits for the app's `emp:route-ready` event (`src/app/routeReady.ts`), web fonts, no loading markers
  (`.emp-skeleton`, `[aria-busy]` and friends) and no running finite animation; the text caret and selection are hidden.
- Clips slow page time while recording (`--slowmo 3`): `performance.now`, `Date`, rAF timestamps and timer delays are
  scaled in the page and the CSS/WAAPI timeline is slowed over CDP, so 2x frames can be grabbed fast enough. Each
  frame is stamped with page time and ffmpeg rebuilds real-speed video from the stamps. Typing is 40 to 80 ms per key
  from a seeded generator; a drawn pointer stands in for the mouse, which headless capture doesn't show.
- Routes a clip will open are visited once before recording, so no loading frames appear mid-clip.

## Adding a shot

Stills live in the `STILLS` array in `capture.mjs`:

```js
{ name: 'reading-list', theme: 'light', route: (ids) => `/page/${ids.page('Reading list')}` },
```

- `theme` is the theme the README shows the still in (`light` or `dark`); `--theme` overrides it.
- `optional: true` leaves the still out of a default run and the `stills` group.

- `route(ids)` returns the hash route; `ids.page(title)` and `ids.app(appId)` resolve seed ids.
- `seed: 'empty'` or `params: { locked: '1' }` change the query string.
- `ready(page)` replaces the route-ready wait for screens that aren't routes (lock screen, first run).
- `prepare(page)` runs after the page settles (open a menu, type a query); the page settles again before the shot.

Clips live in `CLIPS`: `setup(h)` runs at normal speed and is not recorded; `run(h)` is recorded; `warm(ids)` lists
routes to visit before recording. Helpers take page-time milliseconds: `h.hold(ms)`, `h.type(text)`, `h.press(key)`,
`h.moveTo(locatorOrPoint, ms)`, `h.click(locator)`, `h.routeReady(k)` (the k-th route-ready since recording began).
Prefer role and label locators (`getByRole('tab', { name: 'By stage' })`) over classes so UI restyles don't break
the script. Keep typed text free of emoji.

Then run `npm run media:capture -- --only <name>` and look at the result before committing it.

## Flags

| Flag | Default | |
|---|---|---|
| `--only a,b` | all | shot names, `still:<name>`, `clip:<name>`, or the groups `stills` and `clips` |
| `--out-dir DIR` | `docs/` | writes `DIR/screenshots` and `DIR/media` |
| `--port N` | 1490 | mock server port |
| `--no-server` | | use a server you started yourself; fail if none answers |
| `--theme T` | per still | `light`, `dark` or `both` for stills (default: each still's README theme); a single theme also applies to clips |
| `--clip-theme T` | light | |
| `--slowmo N` | 3 | page-time slow-down while recording |
| `--no-chrome` | | plain rectangular stills |
| `--keep-frames` | | keep raw clip frames and print where |
| `--list` | | print shot names |

The script exits non-zero if any shot fails; on a failed clip it saves a screenshot of the page and prints the path.
