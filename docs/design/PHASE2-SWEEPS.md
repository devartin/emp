# Phase 2 — area sweeps (v3 "paper, ink & keys")

Phase 1 is merged on `main`. It covers:
- the v3 kit (tokens, IBM Plex Sans, `<Text>`, `<Amount>`, `<Delta>`, keys, icon picker, motion register);
- the structure work (Home = the day, sidebar, first run, ⌘K);
- the finance truth fixes;
- the backend contract.

Phase 2 brings every remaining area up to that standard. There are five sweeps, each run in its own session on its own branch.

Read first, in this order:
- `docs/DESIGN.md` (v3)
- `docs/design/PROGRAMME-v3.md` (council decisions and chair resolutions)
- `CLAUDE.md`
- this file

## Binding owner rulings
1. **Direction A, "paper, ink & keys".**
   - Warm paper; graphite ink is the only accent.
   - Ruled, not boxed: hairlines under 14/600 heads, one container level.
2. **Subtle keys.** Depth (bevel and press) goes only on things you press. Everything else is flat.
3. **Home = the day.**
4. **Earned motion.**
   - Frequent actions are instant. Numbers never roll on arrival.
   - Keyboard-invoked overlays open without animation.
   - The only signature moments are vault unlock, life-app build and reconcile success.
   - Use `src/ui/motion/register.ts`.
5. **No emoji anywhere in the app.** This covers chrome, copy, seed or demo data, defaults and icons.
   - Use lucide glyphs through `src/ui/icons`.
   - Text a user types inside their own documents is left untouched.

## The v3 anatomy every screen must meet
- **Weights:** {400, 500, 600, 700}.
- **Radii:** {4, 6, 10, 12} plus full. Use the `--radius-*` tokens.
- **Colours:** no raw colours outside tokens.
- **Gradients:** none, except the primary ink key and the app mark.
- **Shadows:** none at rest, except keys (at most 12 per screen) and floating layers (E2/E3/E4 tokens).
- **Blur:** no backdrop blur at rest.
- **Containers:** no bordered container inside another bordered container.
- **Money:** always use `<Amount role="hero|lg|row|axis">` and `<Delta>`.
  - Tabular figures and a true minus (U+2212).
  - Deltas are text, not pills.
- **Copy:** plain desktop register.
  - Avoid coach voice, "we", "Consider…", "Common guideline", "Nice work", Title Case buttons, uppercase eyebrows, stat-banner rows, filler and touch verbs (tap or long-press).
  - Sentence case everywhere. British spelling as the app already uses it ("Uncategorised", "categorise").
  - " · " is allowed as a separator.
- **Icons:** 16 px at 1.25 stroke in rows, 14 px inline, 40 px in page headers, always `absoluteStrokeWidth`. Monochrome: secondary ink in chrome, ink in page headers.
- **Rows:** 28 px for list rows, 36 px for table rows.

## Rules for every sweep session
- **Edit only the files your area owns** (table below).
  - The kit (`src/ui/**`, `src/styles/tokens.css`, `src/styles/material.css`, `src/styles/theme.css`, `src/charts/**`) is frozen in Phase 2.
  - If you need a kit change, work around it locally and list the request in your report.
  - `src/backend/types.ts`, `docs/SPEC.md` and `crates/**` may be changed only by the sweeps that own them. Any IPC change must be additive and applied to both Rust and the mock.
- **Shared mock files** not listed under any area (for example `src/backend/mock/seed/shell.ts` or `persist.ts`): change them only when you must, keep the change minimal, and mention it in your report.
- **Do not run** `npm run guards:update` or `npm run budget:update`. The orchestrator rebaselines after merging all five branches.
  - The ratchet tests still pass when your counts go down. They fail only if a count rises.
- **Checks you must run and pass before pushing:**
  - `npx tsc --noEmit`
  - `npx vitest run` (includes `src/test/guards`)
  - `npx vite build`
  - If you touched Rust: `cargo fmt --all`, `cargo clippy --workspace --all-targets -- -D warnings` and `cargo test -p <crates>`.
- **Browser checks:**
  - Start the mock with `VITE_ALLOW_MOCK=1 npx vite --port 1420 --strictPort`.
  - Use Playwright with `NODE_PATH` pointing at the global install. Never run `playwright install`.
  - Smoke test: `PORT=1420 npm run gates:smoke` runs 59 routes in light and dark. It needs 0 page errors, 0 console errors, 0 error boundaries, 0 not-found pages, 0 overflow and 0 emoji.
  - Census: `npm run gates:census -- --routes <your routes>`.
  - Settle: `npm run gates:settle -- --routes <your routes>`. It must be ≤ 300 ms (target 150 ms) after `emp:route-ready`.
  - Before and after screenshots: light and dark, at 1440×900, with `?seed=demo&freeze=2026-11-26T15:30:00Z`.
- **Scope:** do not add new editor or database features. Phase 2 is restyling, copy and bug fixes only.
- **Commits:** small and scoped. Push only to your own branch.
- **Report:** end with what changed, what you deferred and why, check results with numbers, before and after census/settle numbers, and requests for other areas or the kit.

## Area ownership and known leftovers

### 1. `shell-home`: shell, Home, search/⌘K, first run
**Owns:**
- `src/features/shell/**`, `src/features/home/**`, `src/features/search/**`
- `src/features/vault/Onboarding/**`, `src/features/vault/AppMark.tsx`
- `src/app/**`

**Leftovers:**
- **First run:**
  - The progress bar shows 6 segments while the counter reads "Step 1 of 5". Make it a real 3-screen first run: Welcome → Track → Protect → land on Home.
  - Remove the dotted, vignetted backdrop and the raised card.
- **Dark sidebar colour:** it uses canvas `#1a1a19`. The spec says `--bg-window` (`#1f1f1e`). Decide and make it consistent.
- **Home:**
  - "Habits · 3 of 6 done" sits about 1 px off the "Check in" baseline.
  - `home/data.ts` `dailyNoteTitles` / `NOTE_FOLDERS` can drop the old "November 26, 2026" / "Daily notes" variant. Both backends now write "Thursday, Nov 26, 2026" under "Journal".
- **Glyph names that render nothing:** `engine/manifests.ts` (life apps) uses names missing from the kit registry: `list-ordered`, `calendar-clock`, `pie-chart`, `chart-area`, `sliders-horizontal`, `sparkle`.
  - Map them to registered names inside your files, for example the sidebar/app icon resolver.
  - Otherwise, list them as a kit request.
- **Deferred from Phase 1, do now if they fit:**
  - ⌘1–9 for hub tabs;
  - hiding and reordering the primary sidebar rows.
- **AppMark:** keep the gradient app-mark tile. It is the one allowed brand gradient; the owner may revisit it.

### 2. `lifeapps-calendar`: life apps, Life OS, Habits, calendar, Spreadsheet Studio hub
**Owns:**
- `src/features/lifeapps/**` (including `engine/manifests.ts`, `mock/**`)
- `src/features/calendar/**`
- `crates/emp-store/lifeapps/*.json`
- `crates/emp-store/src/lifeapps/**`
- `src/backend/mock/commands/{lifeapp,daily,calendar,gcal,ics,reminder}.ts`

**Leftovers:**
- **Life OS:** j/k/x keyboard triage inside task lists (Home already has it).
- **Habits and check-in:** finish the restyle. The `Checkbox celebrate` rays are gone in the kit; check there are no local bursts.
- **Calendar:** still carries v2 styling. Apply the full anatomy.
- **Life-app catalogue and gallery** (`/lifeapps`): no coloured tiles; glyph rows.
- **Life-app build:** keep it as one of the three signature moments, ≤ 600 ms, using the C3 register.
- **Parity:** keep the TS manifests and the Rust JSON in step. A test that compares the two would be welcome.

### 3. `money`: Money HQ, Portfolio, Markets, Taxes
**Owns:**
- `src/features/finance/**`, `src/features/portfolio/**`, `src/features/markets/**`, `src/features/taxes/**`
- `src/backend/mock/commands/{finance,tax,market,portfolio,watchlist,fx}.ts`, `src/backend/mock/market.ts`
- `crates/emp-finance/**`

**Leftovers:**
- **Restyle:** sweep every finance tab (Transactions, Budget, Accounts, Plan with Debt/Forecast/Goals/Recurring), Portfolio (all tabs), Markets and Taxes.
  - Remaining `fh-*` / `pf-*` / `mk-*` gradients, shadows, off-scale weights and radii go.
  - Use `<Amount>` and `<Delta>`; superscript-cents rules are in DESIGN.md.
  - Replace `DeltaPill` with `Delta`.
- **Portfolio:**
  - The allocation summary says "4 classes are outside the band", but only US equity and Intl developed are coloured. Emerging (−1.6) and Bonds (+0.8) are not. Fix the logic or the colouring so they agree.
  - The "today" line shows "↘ 0.07%" with no minus beside "−$154". Make the signs consistent.
- **Taxes:** the Standard deduction meter fills about 93% when the comparison is $0 itemised against $16,530 standard.
- **Keep:**
  - the "Not tax advice" disclaimer (SPEC §15 mandates it, and a test asserts it);
  - the Debt planner's current persistence behaviour (an owner decision is pending).
- **Out of scope:** the Phase 3 items (reconcile tick list and adjustment row, keyboard review queue) belong to Phase 3. Do not build them here.

### 4. `editor-data`: editor, databases, sheets
**Owns:**
- `src/features/editor/**`, `src/features/databases/**`, `src/features/sheets/**`
- `src/styles/editor.css`
- `crates/emp-sheets/**`
- `crates/emp-store/src/import/**`, `crates/emp-store/src/repo/tour.rs`
- `src/backend/mock/seed/core.ts`, `src/backend/mock/lib/doc.ts`
- `src/backend/mock/commands/{db,row,page,sheet,template,import,export,gdocs,gsheets,asset,version,trash}.ts`

**Leftovers:**
- **Bug-bash only:** no new features. Match Notion's visual values: block spacing, 28 px rows, table 36 px rows, hover handles, selection colour = ink wash.
- **`editor.css`:** still holds the old `.emp-mention-emoji` rule. Remove it and any v2 rings, glows or tilts.
- **`domGlyph.ts` `glyphSvg`:** it uses `flushSync` and fails while React renders. The editor works around it. Keep the workaround local, since the kit is frozen.
- **Getting Started:** shortcut formatting is inconsistent. `Ctrl+N` and `/` are code chips, while Ctrl+K, Ctrl+Shift+H and Ctrl+Shift+L are bold text. Use one style; prefer the kit `Kbd` look via a code mark. Change it in both `mock/seed/core.ts` and `crates/emp-store/src/repo/tour.rs`.
- **Sheets:**
  - The vite build warns about an ineffective dynamic import of `sheets/engine/refs.ts`.
  - Apply the full anatomy to the sheet chrome (toolbar, tabs, formula bar). The grid already reads `--font-ui` and awaits fonts.
- **Databases:** board, list, calendar and chart views, filters, sorts and row pages: v3 anatomy and copy.

### 5. `settings-vault-integrations`: settings, vault/lock, integrations
**Owns:**
- `src/features/settings/**`, `src/features/integrations/**`
- `src/features/vault/**`, except `Onboarding/**` and `AppMark.tsx`
- `src-tauri/**`
- `crates/emp-crypto/**` (never change domain or format constants)
- `crates/emp-integrations/**`
- `src/backend/mock/commands/{settings,vault,security,password,secret,backup,google,network}.ts`

**Leftovers:**
- **Emoji:** `src/features/integrations/mock/sampleCalendar.ts:116` ("Website launch 🚀") and `:126` ("Lisbon trip ✈️") are the last 2 emoji in the app. Remove them.
- **Appearance:**
  - The scheme chips show "↗ +2.4%" / "↘ −1.1%". These are allowed arrows; keep them only if they still read well.
  - The Transparency setting (Auto/On/Off) stays.
- **Settings sections and pickers:** apply the full anatomy. Keys only on pressables; no nested boxes.
- **Vault unlock:** this is a signature moment, ≤ 600 ms, using the C3 register. The lock screen, recovery ceremony and recovery unlock should be calm and ruled.
- **Integrations panel and Google setup sheet:** apply the v3 anatomy and plain copy. The network log stays readable.

## Completion protocol (every session)
1. Run every check above, then commit on your branch and push it with `git push -u origin <branch>`.
2. Send a completion message to the orchestrator session `session_014Ezvb61TQaWfomPUV1akZL` with `send_message`. Include:
   - the branch name and head commit;
   - the check results with numbers;
   - census and settle numbers before and after;
   - what you deferred;
   - requests for the kit or other areas.

   If you are blocked, send a message saying what blocks you instead of guessing.
