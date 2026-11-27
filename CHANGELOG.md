# Changelog

All notable changes to Ultra Note are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] — 2026-11-26

The v3 redesign, a simpler structure built around Home, and a round of finance and tax corrections. Workspaces
created with 0.1.0 still open.

### Design: v3 "paper, ink and keys"
- A new visual language replaces v2 "Slab" ([docs/DESIGN.md](docs/DESIGN.md)). Warm paper with graphite ink as the
  only accent, IBM Plex Sans with tabular figures, hairline rules instead of nested boxes, and depth only on things
  you press (the primary key, shortcut hints, switch and segmented thumbs). Glass at rest, grain, edge light, tilt,
  magnet and sheen are gone.
- Motion is earned. Typing, tab and sidebar changes, route changes and keyboard-opened menus and palette are
  instant. Numbers are final from the first frame and roll only after your own edit. Three signature moments remain:
  vault unlock, life-app build and reconcile success. Arrival choreography, the animated greeting, confetti and the
  burst are removed. Reduced motion turns the three moments into a short crossfade.
- One monochrome icon set (curated Lucide) replaces emoji in the app's chrome, copy, defaults, life-app manifests
  and most of the demo data. The page icon picker offers about 120 glyphs in 8 searchable groups. Existing emoji
  icons are mapped to glyphs (288 entries) and older workspaces still load. Text you type in your own pages is
  untouched.
- Money is typeset like a statement: amounts and changes are set as plain figures instead of pills, with a true
  minus, the currency symbol at full size and dimmed cents in ledgers. Gain and loss colour appears only on changes
  and over-budget amounts.
- Charts are drawn in ink without gridlines or gradient fills. Budget rings, goal rings and the spending donut are
  replaced by bars. Markets open on a line chart; candles remain one click away.
- Copy is plain and in sentence case, without coach voice, exclamation marks or touch verbs on desktop.

### Structure
- **Home is the day.** The date, a capture field, the agenda, what is due (Life OS tasks plus unchecked to-dos in
  today's note), a habits line, one money line and recent pages. It replaces the widget grid and is not
  customisable. <kbd>j</kbd>/<kbd>k</kbd>, <kbd>x</kbd> and <kbd>Enter</kbd> work on its rows.
- **Sidebar.** Primary rows are Search, Home and Calendar, and can be hidden or reordered. Settings moves to the
  footer. Life apps lists installed apps, with an "Add a life app" row. Today's note is reached from Home,
  <kbd>⌘⌥D</kbd>, `@today` in the palette or the Journal page.
- **One "Today".** Life OS (Tasks, Projects, Review) and Habits (Check-in, Habits, Stats) lose their Today tabs;
  Home is the only view of the day.
- **Money HQ** has five tabs: Overview, Transactions, Budget, Accounts (with net worth) and Plan (recurring, debt,
  forecast, goals). It always opens on Overview, and links to the old tabs redirect.
- <kbd>⌘1</kbd> to <kbd>⌘9</kbd> switch tabs in any life app.
- **Command palette.** It indexes every life-app tab, opens without animation from the keyboard, and buffers keys
  typed before it appears, so none are lost. Capture by prefix: `t` adds a task, `n` appends to today's note, and
  `-12.50 coffee` or `spent 12.50 coffee` records an expense. Unreadable amounts show a row explaining why instead of
  creating a page.
- **First run** has three steps (Welcome, Track, Protect) and lands on Home. The life apps picked in Track are built
  straight away in Quick mode, with real progress, instead of leaving an empty "0 of 6 set up" screen.
- **One Import dialog** detects the file. Bank files go to Money HQ's import wizard. The Notion note now says plainly
  that relations and formulas may not come across.

### Finance and tax
- The desktop importer now writes `cleared`, `source = import` and `reviewed = false` on every imported transaction,
  as the demo already did. Before this, reconciliation on desktop could not see which rows had cleared.
- Money HQ's transactions database gains a Reviewed property. Transactions opens on a **To review** lane while it
  has rows; *Mark reviewed* clears them, and Home shows the same count.
- **Reconcile** asks for the statement balance instead of pre-filling the app's own figure. When the last OFX import
  reported a closing balance, it is offered with its date. The difference against cleared rows updates live, an
  amount owed is entered as the statement prints it, and finishing locks the reconciled rows.
- Every headline money figure has one label and one definition, with its inputs one click away. This replaces the
  "Show math" panels, which disagreed with each other in places. Net worth has one definition across screens on
  desktop and in the demo.
- The effective tax rate is total tax divided by AGI in the demo as well as on desktop.
- Tax estimates report what itemising would come to, and the Taxes hub uses that figure, so the 7.5% medical floor
  and the SALT cap are applied there too.
- US federal tax pack 1.1.0: the non-itemiser cash charity deduction ($1,000, or $2,000 married filing jointly), the
  0.5% of AGI charitable floor for itemisers, and Roth IRA contributions no longer treated as deductible. The pack
  lists its IRS and SSA sources and the date they were checked; tax figures use the pack's currency.
- The estimated-payments message now states the result plainly ("No penalty expected") with the next amount and
  date.
- Debt planner: the strategy and extra payment are saved only after a real edit, so Overview keeps "at minimum
  payments" until then.
- Portfolio uses one sign convention on the today line, and the deductions meter reads on one scale.

### Fixes
- Copying a figure copies its value, never the digit strips of a rolling number.
- Shortcut hints move only when their exact shortcut fires, never while you type in a field.
- Hubs no longer show "All caught up", "0 open" or similar before their data has loaded.
- Habits says "click" and "right-click" on desktop instead of tap and long-press.
- Auto-lock listens for native sleep and screen-lock signals on macOS and Windows as well as Linux.
- One clock across Home, Life OS and the calendar; search results show snippets from page content.
- A Transparency setting (Auto, On, Off), with probing on Linux.

### Project
- The product name is Ultra Note in the app, installers and repository links
  ([github.com/devartin/ultra-note](https://github.com/devartin/ultra-note)). Internal identifiers keep the `emp`
  prefix.
- Guards run with `npm test`: style, copy, emoji and contrast ratchets, plus a bundle budget (`npm run budget`) and
  local gates for census, settle time and a 59-route smoke test (`npm run gates:*`).
- The browser demo is deterministic: `&freeze=` pins the clock, market ticks are seeded, `?seed=empty` shows first
  run and `&locked=1` starts at the lock screen.
- README screenshots and clips are generated from the demo with `npm run media:capture`; the banner, feature strip
  and social preview with `npm run media:art`.

## [0.1.0] — 2026-11-26

First public release, as Ultra Note (developed under the codename EMP). Local-first: everything runs on your device, and every connection is optional.

### Workspace
- Block editor with slash menu, mentions, backlinks, page history, covers and drag-and-drop blocks.
- Databases with table, board, list, calendar and chart views, filters, sorts, grouping and row pages.
- Spreadsheets with a formula engine, CSV/XLSX import and export, and workbook versions.
- Command palette and full-text search across pages, rows and sheets.

### Money and markets
- Money HQ: budget envelopes, transactions with rules, accounts, recurring bills, debt planner, forecast, goals and net worth.
- Portfolio: holdings, allocation and drift, rebalance planner, dividends.
- Markets: watchlists, quotes and candlestick charts.
- Tax Year: document organizer, deductions, deadlines and a running estimate.
- Imports from OFX/QFX, CSV and XLSX.

### Life apps
- Guided setups (Money HQ, Portfolio, Tax Organizer, Spreadsheet Studio, Life OS, Habits) that build the pages,
  databases and dashboards for you, with best-practice defaults and "show the math" explanations.

### Integrations (optional)
- Google Calendar sync, plus Google Docs/Sheets and Excel import/export.

### Security
- Optional vault encryption: XChaCha20-Poly1305 with Argon2id key derivation, HKDF subkeys, a BIP39 recovery phrase,
  PADMÉ padding and an integrity manifest.
- Strict Tauri isolation, CSP and a generated command allowlist. Auto-lock after inactivity (and on sleep or screen lock on Linux).

### Design
- Design language v2 "Slab": tactile keycap buttons, recessed inputs, machined panels with pointer-tracked edge light,
  glass overlays, one spring system for all motion, and signature moments such as the vault unlock, life-app build
  and rolling numbers. Reduced-motion, reduced-transparency and higher-contrast modes are honoured throughout.

[Unreleased]: https://github.com/devartin/ultra-note/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/devartin/ultra-note/releases/tag/v0.3.0
[0.1.0]: https://github.com/devartin/ultra-note/blob/main/CHANGELOG.md#010--2026-11-26
