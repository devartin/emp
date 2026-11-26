# EMP Brainstorm

> Record of the brainstorming session behind EMP, the local-first productivity super app.
> Inputs: six specialist lenses (Notion parity, life apps, design, security, architecture, integrations and extras), merged and de-duplicated here by the lead product architect.
> Companion document: [`SPEC.md`](./SPEC.md), the v1 build spec. Where this document and SPEC.md disagree, **SPEC.md wins**.
> Date: 2026-11-26.

---

## 1. Vision

**EMP is Notion's flexibility, a spreadsheet's power and a personal CFO's discipline in one fast, private app that lives on your computer.**

The user asked for three things, and EMP's identity comes from holding all three at once:

1. **Notion parity**: pages, blocks, databases, views, templates, the slash menu, drag handles, backlinks, everything a Notion power user reaches for without thinking.
2. **A productivity super app**: personal finance, investing and stocks, taxes, Excel-grade spreadsheets, and Google Calendar, Docs and Sheets, all first-class rather than bolted on.
3. **Application-driven setup**: "life apps" ask a few questions and then *build* a working system that follows best practices (a budget, a tax organizer, a portfolio policy, a weekly review), which the user then owns and can edit like any other page.

Wrapped around all of it:

- **Local-first.** It works fully offline. Zero network traffic until the user turns on an integration, and every request after that is logged where the user can see it.
- **Private by construction.** Optional at-rest encryption (XChaCha20-Poly1305 + Argon2id), secrets that are always encrypted, auto-lock, privacy blur, no telemetry.
- **Beautiful and fast.** A calm canvas, exact typography, physical micro-animations, finance charts worth showing off, budgets measured in milliseconds.

### 1.1 One-line positioning options
- "Your notes, money, plans and life admin, in one private place on your device." (chosen for onboarding)
- "Notion, a spreadsheet and a financial planner walk into a laptop. Nothing walks out."
- "The workspace that sets itself up."

### 1.2 Who it is for
| Persona | Job to be done | What wins them |
|---|---|---|
| The Notion power user | Leave Notion without losing databases, views and muscle memory | Notion zip import, identical shortcuts, speed, no "load more" |
| The spreadsheet budgeter | Get off a fragile Google Sheet budget | Money HQ wizard, bank CSV/OFX import, rules, real charts, xlsx round-trip |
| The DIY investor | Track holdings, performance and allocation without handing data to an aggregator | Portfolio app, XIRR/TWR, drift and rebalance planner, candlesticks; only symbols leave the device |
| The freelancer | Invoices, quarterly taxes, receipts | Tax Organizer (P0) and Freelance app (P1), set-aside sinking fund |
| The privacy-conscious organiser | Journal, medical, documents, passwords-adjacent info | Encryption, per-section re-auth, emergency binder (P1), no cloud |
| The "life admin" overwhelmed | Wants someone to just set it up properly | Life apps with "Set it up for me", start-here checklists, advisor insights |

---

## 2. Product principles (tie-breakers)

1. **Local is the default, network is a choice.** Every outbound request is user-initiated or user-enabled, goes through Rust, and is visible in the network log.
2. **Generated content is ordinary content.** A life app produces normal pages, databases and formulas that the user can edit, restyle, detach or delete. There is no proprietary lock-in, even inside EMP.
3. **Explain every number.** Every computed figure has "Show math" with its inputs, sources and, for jurisdiction data, the pack version and verified date.
4. **Guided, never gated.** Every life app has "Set it up for me" and "Start blank". Every wizard previews what it will build before it builds it.
5. **Calm canvas, loud meaning.** Neutrals carry about 95% of the screen. Colour is reserved for the accent, semantic state (gain/loss, warnings) and user-applied block colours.
6. **Physical, fast motion.** Feedback starts on pointer-down. Springs are near-critically damped, bounce is reserved for celebration, and nothing in a work flow runs longer than 320 ms.
7. **Honest security.** Strong, conservative cryptography, plain-language limits, no "military-grade" or "unhackable" claims (see §8.6).
8. **Measured performance.** Every budget has an automated measurement in CI, so it can't quietly regress.
9. **Keyboard-complete.** Everything reachable without a pointer. Notion-compatible shortcuts by default.
10. **Informational, never imperative.** Finance, tax and health copy says "common guideline", "consider" and "estimate". It never says "you should buy" or "you owe". EMP never files, trades or pays.

---

## 3. Feature catalogue

Priority legend:
- **P0**: v1.0. Without it EMP doesn't fulfil the brief.
- **P1**: v1.x point releases.
- **P2**: later or experimental.
- **N/A**: doesn't apply to a single-user local app; the alternative is noted.

### 3.1 Editor and blocks

| Feature | Pri | Notes |
|---|---|---|
| Nested block model: any block can have children (Tab/Shift-Tab) | P0 | BlockNote-style `blockContainer` schema (decision D-07 in SPEC). Retrofitting later would be a rewrite. |
| Stable block IDs, regenerated on paste/duplicate/template | P0 | Basis for block links, backlinks, comments, history diffs, search hits |
| Text, H1–H3, toggle headings, bulleted, numbered, to-do, toggle, quote, callout, divider | P0 | Notion input rules (`#`, `-`, `1.`, `[]`, `>`, `"`, `---`) |
| H4 | P1 | EMP extra |
| Code block with lazy grammars, copy, wrap, caption | P0 | lowlight, grammars loaded per language |
| Block and inline equations (KaTeX, local fonts) | P0 | `trust:false`, errors shown inline |
| Simple table (header row/col, resize, cell colours) | P0 | "Turn into database" P1 |
| Columns 2–5 via slash | P0 | Drag-to-side to create columns P1 |
| Sub-page and link-to-page blocks (live title/icon) | P0 | Different delete/move semantics |
| Image, file attachments (encrypted blob store) | P0 | EXIF/GPS stripped on import (toggle) |
| Video, audio (Range-capable streaming decrypt) | P1 | |
| PDF inline viewer | P1 | pdf.js, JS disabled |
| Web bookmark cards | P1 | Opt-in metadata fetch in Rust |
| Embeds (YouTube, Vimeo, Figma…) | P1 | v1: link cards only; P1 click-to-load allowlisted iframes |
| Inline, full-page and linked databases | P0 | |
| Table of contents block + floating TOC rail | P0 / P1 | |
| Breadcrumb block | P1 | |
| Synced blocks | P1 | The hardest block; own record, nested editor |
| Button block (insert template, add row, open page) | P1 | Shared action DSL with automations |
| Mentions: page, date (NL parsing), reminder | P0 / P0 / P1 | |
| Emoji autocomplete and picker | P0 | Lazy-loaded data |
| EMP blocks: chart, KPI card, stock ticker/watchlist, sheet embed, finance widget, progress bar | P0 (chart, KPI, sheet embed, watchlist) / P1 | Slash category "EMP" |
| Mermaid diagrams | P1 | `securityLevel: strict`, rendered to `<img>` |
| Footnotes, sub/superscript, `<kbd>` | P1 / P2 | |
| Tabs block, AI block | P2 | |
| Rich marks: bold, italic, underline, strike, code, link, 10 text + 10 background colours | P0 | |
| Inline comments, page comments, threads, resolve | P1 | Single-user annotations |
| Slash menu (fuzzy, grouped, actions as well as blocks, IME-safe) | P0 | |
| Block handle `+` / `⋮⋮` with drag to reorder and nest | P0 | |
| Block selection (Esc, Shift-arrows, Cmd-A twice) | P0 | Marquee selection P1 |
| Turn into (Cmd+Alt+0–9), turn into page | P0 | |
| Clipboard: internal JSON, HTML (Docs/Word/web/Notion), markdown, plain | P0 | Fallback for WebKitGTK MIME drops |
| Autosave (400 ms idle / 2 s max), "Saved" indicator | P0 | |
| Find & replace in page (Notion lacks it) | P0 | Regex P1 |
| Spellcheck (native) | P0 | Linux enchant hint |
| Drag files from OS | P0 | |
| Word count / reading time | P1 | |
| Focus/zen mode, RTL per block | P1 | |
| Vim mode, block "last edited" | P2 | |
| Typography autoreplace with toggle (→ ≥ ≠ — …) | P0 | Notion's isn't configurable |

### 3.2 Pages and navigation

| Feature | Pri | Notes |
|---|---|---|
| Title, icon (emoji / lucide tinted / upload), cover (gallery / upload / reposition) | P0 | Covers are local, no Unsplash in v1 |
| Page options: font (Sans/Serif/Mono), small text, full width | P0 | Workspace defaults |
| Sidebar tree: unlimited depth, DnD reorder/reparent, inline rename, keyboard ARIA tree | P0 | Fractional sort keys |
| Favorites, recents, Home | P0 | |
| Breadcrumbs, back/forward | P0 | |
| Side peek for database rows | P0 | Centre peek P1 |
| Trash with 30-day retention, restore subtree, secure purge | P0 | |
| Page history: snapshots, preview, restore | P0 | Visual diff and single-block restore P1 |
| Tabs | P1 | |
| Split view (two pages side by side) | P1 | Notion lacks it |
| Multiple windows | P1 | All windows lock together |
| Workspaces (separate vaults/DEKs) | P1 | Replaces Notion workspaces/teamspaces |
| Lock page (read-only) | P1 | |
| Reminders and Inbox, OS notifications | P1 (P0 for life-app bill/deadline reminders while app runs) | |
| Daily notes (`⌘⌥D`) | P0 | Template with agenda, tasks, habits |
| Quick capture global hotkey | P1 | Wayland caveat |
| Graph view | P2 | |

### 3.3 Databases

| Feature | Pri | Notes |
|---|---|---|
| Property types: title, text, number, money, select, multi-select, status, date (range/time/tz), checkbox, URL, email, phone, files, relation (two-way), rollup, formula, created/updated time, unique ID, rating, progress, ticker, recurrence, secret, computed | P0 | money/ticker/recurrence/secret/computed are EMP extras the life apps need |
| Button property, duration, quantity, colour | P1 | |
| Person / contact | P2 | Maps to a local Contacts database |
| Place / map | P2 | Network-gated |
| Views: table, board, list, calendar (month), gallery, chart | P0 | Calendar week P1, timeline P1, feed/map/form P2 |
| Advanced filters (AND/OR, 3 levels), multi-sort, grouping, footer calculations | P0 | Relative dates re-evaluated at midnight |
| Formula language (Notion 2.0 dialect) evaluated in Rust | P0 core, P1 full | Typed, cached, cycle-safe |
| Formula editor with autocomplete, docs panel, live preview, inline type errors | P0 basic / P1 rich | Notion's is weak; a chance to be noticeably better |
| Row templates, default template | P0 | Life apps depend on them |
| Repeating templates | P1 | Catch-up of missed runs |
| Type conversion with snapshot first | P0 | |
| CSV/XLSX import into new/existing DB with type inference | P0 | |
| CSV export P0, XLSX export P1 (P0 for life-app finance workbooks) | P0 / P1 | |
| Sub-items | P1 | Self-relation |
| Dependencies (timeline arrows) | P2 | |
| Automations (triggers, actions, loop guard, run log) | P1 | Webhooks P2, off by default |
| Conditional colour rules, row history | P1 | Notion lacks proper rules |
| Database lock | P1 | |
| 100k rows with no "load more" | P0 | Rust query engine plus virtualisation |

### 3.4 Spreadsheets (emp-sheets)

| Feature | Pri | Notes |
|---|---|---|
| Workbook pages with sheets, canvas grid, formula bar, fill handle | P0 | |
| Excel-compatible formula engine (~230 functions) | P0 | See SPEC §14 |
| Dynamic arrays (FILTER, SORT, UNIQUE, SEQUENCE) with spill, LET | P0 | Spreadsheet Studio templates need them |
| LAMBDA/MAP/REDUCE, structured refs, 3-D refs | P1 | |
| Number formats (Excel codes), conditional formats, data validation | P0 / P0 / P1 | |
| xlsx/xls/ods/csv import (calamine + styles.xml), xlsx export (rust_xlsxwriter) with charts | P0 | |
| Sheet linter (hard-coded constants, inconsistent formulas, #REF!) | P1 | P0 inside Spreadsheet Studio as "Checks" |
| `STOCK`, `STOCKHISTORY`, `FX`, `DBLOOKUP` functions | P0 (STOCK, FX) / P1 | Never block recalculation |
| Pivot tables | P1 | |
| Google Sheets import/export | P0 import / P0 export (one-way) | Linked two-way P2 |

### 3.5 Finance, investing, taxes

| Feature | Pri | Notes |
|---|---|---|
| Accounts, transactions, splits, transfers | P0 | |
| CSV/OFX/QFX/QIF import with mapping profiles, payee cleanup, dedupe, transfer detection | P0 | OFX 1.x is SGML, not XML |
| Rule-based categorisation + "always categorise X as Y?" learning | P0 | Naive Bayes suggestions P1 |
| Budgets: 50/30/20, zero-based, pay-yourself-first, envelopes, track-only; rollover | P0 | |
| Recurring bills/income, subscription detector | P0 | |
| Debt payoff simulator (avalanche/snowball/hybrid) | P0 | |
| 90-day cash-flow forecast with low-balance alerts | P0 | |
| Net worth snapshots and series | P0 | |
| Goals / sinking funds | P0 | |
| Portfolio: positions, transactions, lots (FIFO, average), XIRR, TWR, allocation, drift, rebalance planner | P0 | HIFO/LIFO/specific-ID, wash-sale flags, UK s104 P1 |
| Watchlist with price alerts | P0 | |
| Candlestick charts with SMA/EMA/Bollinger/RSI/MACD | P0 (candles + SMA) / P1 (rest) | |
| Tax Organizer: US federal estimator, generic/custom pack, document checklist, deadlines, quarterly payments | P0 | UK/CA/AU estimator P1 |
| FX conversion with cached ECB rates | P0 | |
| Live bank sync (SimpleFIN, GoCardless) | P2 | BYO credentials; never screen scraping |
| Brokerage CSV presets (Fidelity, Schwab, Vanguard, IBKR, Robinhood) | P1 | Generic mapping P0 |
| FI/retirement Monte Carlo | P1 | |
| Invoicing | P1 | Freelance app |
| Shared expenses / split | P1 | |

### 3.6 Search and command

| Feature | Pri | Notes |
|---|---|---|
| Quick find: titles (fuzzy), content (BM25), properties, attachment names, snippets with highlights | P0 | In-memory index only |
| Operators `in:`, `type:`, `db:`, `edited:` | P0 | Phrase and exclusion P1 |
| Command palette with prefixes (`>` commands, `#` tags/dbs, `$AAPL` quotes, `=` calculator, `?` help) | P0 | Notion lacks a true one |
| Inline calculator with unit/currency conversion | P0 in palette / P1 inline in text | |
| Saved smart views across databases | P1 | |

### 3.7 Import and export

| Feature | Pri |
|---|---|
| Markdown file/folder import (wikilinks, front matter, Obsidian callouts) | P0 |
| Notion export zip (HTML preferred, nested zips, 32-hex ids, two-pass link resolution) | P0 |
| CSV / XLSX / ODS to database or sheet | P0 |
| .ics import/export | P0 |
| Notion API importer | P1 |
| Obsidian/Logseq, Evernote .enex, Todoist, HTML, .docx | P1 |
| Trello, Bear, Apple Notes, Roam, BibTeX, Apple Health | P2 |
| Markdown / CSV / JSON / XLSX export, "Export everything" zip | P0 |
| PDF export (print path) | P0 |
| Self-contained HTML export | P1 |
| Encrypted backups `.empbackup` + automatic snapshots `.empsnap` with rotation | P0 |
| Portable `age`-encrypted export readable with the `age` CLI | P1 |
| DOCX export, static site | P2 |

### 3.8 Integrations

| Integration | Pri | Notes |
|---|---|---|
| Google OAuth (BYO Desktop client, PKCE, loopback 127.0.0.1) | P0 | Guided setup wizard; 7-day Testing-mode warning |
| Google Calendar read (sync tokens) | P0 | |
| Google Calendar two-way | P1 | etag conflicts, outbox |
| Google Docs import by URL, export as new Doc | P0 | `documents.readonly`, `drive.file` |
| Google Sheets import by URL, export | P0 | `GOOGLEFINANCE` → `STOCK` mapping |
| ICS URL subscriptions, offline holiday dataset | P1 | |
| CalDAV (iCloud, Fastmail, Nextcloud) | P1/P2 | |
| Microsoft Graph (Outlook) | P2 | BYO Entra app |
| Market data: Frankfurter, Stooq, CoinGecko (keyless); Finnhub, Tiingo (keys) | P0 | |
| Twelve Data, Alpha Vantage, FMP, Polygon, FRED, SEC EDGAR | P1 | |
| Yahoo (unofficial) | P1, off by default, labelled "Community source" | |
| AI: Ollama local, BYOK cloud | P1, off by default | Proposals only, never auto-apply |
| Signed auto-updates | P0 mechanism, opt-in at onboarding | |
| Deep links, file associations | P1 | |
| Local CLI, MCP server, plugins (WASM) | P2 | Off by default, token-gated |

### 3.9 Notion features that don't apply, and EMP's alternative

| Notion | EMP |
|---|---|
| Real-time multiplayer, presence | P2: folder-based encrypted CRDT sync for one person's devices |
| Sharing, guests, permissions, teamspaces | Per-workspace vaults; P2 encrypted share bundles |
| Publish to web / Notion Sites | P2 static-site export |
| Page analytics | N/A |
| Notion AI | P1 optional local LLM or BYOK, off by default |
| Notion API and marketplace | P2 local plugin API |
| Notion Mail | Out of scope |
| Mobile apps | Out of scope (desktop-only fixed decision) |
| Web clipper extension | P2 via native messaging; P1 paste-URL "Clip article" |

---

## 4. Where Notion falls short, and EMP's answer

| # | Notion weakness | EMP answer |
|---|---|---|
| 1 | Slow cold start, spinners, "load more" | Rust core, local SQLite, virtualised everything, measured budgets |
| 2 | Offline is an afterthought | 100% local by default |
| 3 | No end-to-end encryption, telemetry | Optional at-rest encryption, secrets always encrypted, zero telemetry |
| 4 | Lossy export, hash-suffixed filenames | Clean Markdown + CSV + XLSX + lossless JSON, automatic encrypted backups |
| 5 | Version history paywalled and coarse | Unlimited local history with thinning, named versions, diff (P1) |
| 6 | Destructive ops hard to undo | Global undo stack, snapshot before lossy conversions, deleted properties/views restorable |
| 7 | No real spreadsheets | emp-sheets with Excel formulas, xlsx round-trip |
| 8 | Basic charts | Area, scatter, combo, waterfall, Sankey, treemap, candles, running balances |
| 9 | Formula editor hard to debug | Autocomplete, inline type errors, live preview, docs panel |
| 10 | No find & replace | Find & replace with match count |
| 11 | Backlinks lack context | Snippets, unlinked mentions, hover previews |
| 12 | Clunky synced blocks | Synced blocks plus read-only transclusion (P1) |
| 13 | Weak recurring tasks and desktop reminders | RRULE recurrence, OS notifications, Inbox |
| 14 | Month-centric calendar | Week + month calendars, Google overlay, timeline P1 |
| 15 | No footnotes/sub/superscript | Footnotes P1, sub/sup P2 |
| 16 | Light/dark only | Light/Dark/Midnight, 7 accents, density, fonts |
| 17 | No split view | Tabs, split view, windows (P1) |
| 18 | Weak keyboard-only use | Command palette, full keyboard nav, cheat sheet |
| 19 | Search is slow, few operators | In-memory index with operators and block deep links |
| 20 | Electron memory footprint | Tauri system webview, ≤ 150 MB idle target |
| 21 | Upload limits | Disk is the only limit |
| 22 | Static templates | Life apps: parameterised wizards that generate best-practice systems and can be re-run (tune-up) |
| 23 | No money semantics | Decimal money, currency property, FX |
| 24 | Timezone drift on dates | All-day dates stored as local `YYYY-MM-DD`; DST tests |
| 25 | Automations limited, cloud-only, paid | Local automations with run log (P1) |
| 26 | Sidebar clutter | Life Apps section, collapsible sections, pinned views |
| 27 | Slow, uncancellable imports | Background Rust jobs with progress, cancel, single-step undo |
| 28 | Accessibility gaps | WCAG 2.2 AA tokens, ARIA everywhere, reduced motion |
| 29 | No automatic local backup | Scheduled encrypted snapshots with rotation |
| 30 | Upsells | Everything included locally; integrations use the user's own keys |

---

## 5. Life apps catalogue

A **life app** is a declarative, versioned bundle: a wizard (questions), a generator (pages, databases, views, formulas, dashboards, reminders), metrics (Rust computations over the generated databases), and an advisor (deterministic, explainable insight rules). Everything generated is ordinary EMP content.

### 5.1 Framework ideas (all P0)
- **Quick vs Guided** modes: 3–5 questions with defaults, under 3 minutes to first value, vs the full flow.
- **Live preview** pane that "materialises" pages and databases as answers change, plus a "What we'll create" list with a per-item opt-out toggle.
- **Deterministic IDs** (UUIDv5 of instance + template key) make re-runs idempotent. One undo entry covers a whole install.
- **Tune-up**: reopen the wizard pre-filled, see a diff plan, never overwrite user-touched fields.
- **Upgrade migrations**: additive only, previewed.
- **Detach / uninstall** (keep content by default).
- **Start-here checklist** that ticks itself as the user does each thing.
- **Sample data** mode, tagged and removable.
- **Jurisdiction packs** as versioned data with `source_url` and `verified_on` for every value; stale-pack warnings; overrides with a "custom" badge.
- **Advisor** rules phrased as "consider", with "Show math", mute and snooze.
- **Privacy**: high-sensitivity apps prompt to enable encryption and default to masked values.
- **Cross-app glue**: typed metrics and relations, with source chips such as "from Portfolio".

### 5.2 Catalogue

| App | Pri | One-line value | Key generated artefacts |
|---|---|---|---|
| **Money HQ** (personal finance) | P0 | A complete budgeting system set up from 6–12 questions | Accounts, Transactions, Categories, Budgets, Recurring, Goals, Net worth, Subscriptions, Rules, Payees; dashboard with Sankey, budget bars, net worth, cash-flow forecast, debt payoff |
| **Portfolio** (investing) | P0 | A written investment policy plus live tracking | Securities, Investment transactions, Lots, Holdings, Target allocation, Watchlist, Dividends; IPS page; rebalance planner; candlestick holding pages |
| **Tax Organizer** | P0 | Never miss a document, deadline or quarterly payment | Document checklist, Deductions, Estimated payments, Deadlines, Mileage; estimator; preparer packet |
| **Spreadsheet Studio** | P0 | Best-practice spreadsheet models in one click | Loan calculator, decision matrix, split expenses, timesheet, inventory, compound interest; Inputs/Calc/Output/Checks structure |
| **Life OS** (planner) | P0 | GTD/PARA/time-blocking system with a weekly review | Tasks, Projects, Areas, Resources, Daily notes; Today page; weekly review |
| **Habits** | P0 | Tiny habits, streaks with grace, heatmaps | Habits, Habit log; dashboard with heatmaps and streaks |
| Freelance & Invoicing | P1 | Clients, time, invoices, AR aging, tax set-aside | Clients, Projects, Time entries, Invoices, Line items, Payments, Expenses |
| Financial Independence / Retirement | P1 | FI number, Monte Carlo success odds | Scenarios, Milestones, fan chart |
| Goals & OKRs | P1 | Measurable goals linked to metrics from other apps | Objectives, Key results, Check-ins |
| Journal | P1 | Private reflection with mood tracking and "on this day" | Journal DB, templates per style, year-in-pixels |
| Health & Fitness | P1 | Training programs, progressive overload, meds, appointments | Exercises, Workouts, Sets, Body metrics, Medications |
| Meal Planner & Groceries | P1 | Plan around the pantry; aisle-grouped lists | Recipes, Ingredients, Meal plan, Grocery list, Pantry |
| Job Search | P1 | Pipeline, STAR stories, offer comparison | Applications, Companies, Contacts, Interviews, Offers |
| Travel Planner | P1 | Timezone-aware itinerary, packing, settle-up | Itinerary, Budget, Packing, Documents |
| Emergency Binder | P1 | The "if something happens to me" kit; security showcase | Documents, Insurance, Accounts directory, Medical, Contacts; sealed export |
| Home & Household | P2 | Maintenance schedule, inventory for insurance | Maintenance, Inventory, Warranties, Chores |
| Vehicle | P2 | Dual-trigger maintenance, fuel economy, TCO | Vehicles, Service log, Fuel log |
| Events & Wedding | P2 | Budget allocation by priority, guests, vendors | Budget, Guests, Vendors, timeline |
| Learning (spaced repetition) | P2 | FSRS flashcards and pacing | Courses, Flashcards, Sessions |
| Reading & Media | P2 | Goodreads/Kindle import, goal projection | Library, Sessions, Quotes |
| Home buying / big purchases | P2 | Affordability, rent vs buy, 30-day list | Calculators, Home search |
| Personal CRM | P2 | Keep-in-touch cadences, birthdays | People, Interactions |
| Mini apps: Moving, Pets, Family/Allowance, Garden, Side project launch, Document expiry & warranties | P2 | Template-level | |

### 5.3 Best practices the apps encode (sample)
- **Money:** budget on take-home pay; give every unit a job or a bucket; sinking funds for predictable irregular costs; emergency fund sized on *essential* spending (3 / 6 / 9–12 months as common guidelines); starter fund before aggressive debt payoff; avalanche saves the most interest, snowball can help motivation; credit utilisation under 30% as a common guideline; reconcile weekly; net worth monthly, not daily; monthly subscription audit; income buffer for irregular earners; a "financial order of operations" checklist.
- **Investing:** a written IPS first; diversification; low costs (fees-per-year KPI); rebalance by rule (5/25 bands, cash-flow first); separate watchlist from holdings; show both money-weighted and time-weighted returns; concentration warning above 10%. EMP never places trades.
- **Taxes:** one place for every document; track deductions as they happen; compare standard vs itemised; safe-harbour quarterly payments framed as "commonly used"; set aside a share of self-employment income; retention schedule; preparer packet; every number labelled *estimate* with pack source and date. EMP never files.
- **Spreadsheets:** separate Inputs/Calculations/Output/Checks sheets; inputs styled distinctly; no constants inside formulas; one formula per column; checks sheet with green/red status; frozen headers; no merged cells in data.
- **Life OS:** one inbox; next physical action; projects always have a next action; Top 3 per day; time-block deep work in the peak window; weekly review as the keystone; shutdown ritual.
- **Habits:** start tiny (two-minute version); stack onto existing routines; "never miss twice"; level up only after 21 days at ≥ 90%.

### 5.4 Cross-app flows
Money HQ ⇄ Portfolio (investment values into net worth), Portfolio → Tax (realised gains, dividends), Freelance → Tax (net SE income), Tax → Money HQ (set-aside sinking fund, estimated payments as bills), Tax → Life OS / Calendar (deadlines), every app → Life OS Today (insights, due items), Habits ⇄ Goals (habit rate as a KR). No cross-app link sends anything off-device.

---

## 6. Ideas the user didn't think of

Ranked by value ÷ effort within each priority. V = value 1–5, E = effort 1–5.

### 6.1 P0, ship in v1
| Idea | Why it matters | V | E |
|---|---|---|---|
| Global undo + action toasts ("Deleted 3 rows · Undo") everywhere, including databases and finance | Fearless editing | 5 | 1 |
| Trash with 30-day restore and secure purge | Trust | 5 | 1 |
| Auto-lock (idle, sleep, screen lock) + panic lock `⌘⇧L` | The encryption is only as good as the lock | 5 | 1 |
| Recovery key ceremony (24 BIP39 words, verify 3, printable emergency sheet) | Forgotten passwords are otherwise unrecoverable | 5 | 1 |
| **Hide numbers** mode `⌘⇧H` (mask amounts, keep chart shapes) | Screen sharing, coffee shops | 4 | 1 |
| Secure clipboard (auto-clear secrets after 30 s, exclude from clipboard history) | Leak prevention | 4 | 1 |
| Network activity log + offline "airplane mode" `⌘⇧O` | Makes "local-first" verifiable | 5 | 2 |
| Security Center page (status hero, every control in plain language) | Turns security into a visible feature | 5 | 2 |
| Command palette with calculator, date math and currency conversion | Daily delight | 5 | 2 |
| Smart paste of tables from Excel/Sheets/HTML ("as table / database / sheet") | Removes a top Notion annoyance | 5 | 2 |
| Daily notes with agenda, tasks and habit strip | Daily-use anchor | 5 | 2 |
| RRULE recurring tasks ("last business day", "3 days after done") | Real recurrence, not template hacks | 5 | 2 |
| Natural-language input with live chips ("tomorrow 5pm #errands !high") | Speed | 4 | 2 |
| Universal import drop zone (detects format, routes to the right wizard) | One consistent importer | 5 | 3 |
| Home dashboard widgets (agenda, tasks, net worth, budget burn, bills, watchlist, habits) | The super-app front door | 5 | 3 |
| Chart block bound to any database or sheet range | Finance graphs everywhere | 5 | 3 |
| Encrypted backups to a user-chosen sync folder with rotation and restore preview | Local-first without fear of disk loss | 5 | 3 |
| "Show math" on every computed number | Trust in finance and tax figures | 5 | 2 |
| "Data leaving this device" panel per connector, generated from its manifest | Informed consent | 4 | 2 |
| Freshness badges on market numbers (Live / 15m delayed / EOD) | Honesty | 4 | 1 |
| Celebrations (restrained particle burst for budget goals, debt paid off, checklist done) with a toggle | Emotional payoff | 3 | 1 |

### 6.2 P1
| Idea | V | E |
|---|---|---|
| Hide from screen capture (content protection) on sensitive views | 3 | 1 |
| Guided weekly review ritual (inbox zero → spending vs budget → goals → top 3 → reflect) | 5 | 2 |
| Meeting notes from calendar events (attendees, agenda, action items → tasks) | 5 | 2 |
| Inline math chips in text (`= 1200*12*0.3`, `100 USD in EUR`) | 4 | 2 |
| Focus timer with time logged to the task | 4 | 2 |
| Document expiry and warranty tracker with 90/30/7-day reminders | 4 | 2 |
| Bills calendar + 90-day danger-zone forecast notifications | 5 | 3 |
| Per-page lock (separate key, excluded from search/AI until unlocked) | 4 | 3 |
| Saved smart views across databases | 5 | 3 |
| Goals with automatic progress from any metric | 4 | 3 |
| Time blocking (drag tasks onto the week view) | 4 | 3 |
| Retirement Monte Carlo fan chart | 4 | 3 |
| PDF viewer with highlights extracted to blocks | 4 | 3 |
| Custom keybindings + searchable cheat sheet | 3 | 2 |
| Security audit log (unlocks, failures, exports, token use) | 3 | 2 |
| AI setup copilot that personalises life-app plans (schema-validated JSON, diff preview, never auto-apply) | 5 | 3 |
| Ask-your-workspace RAG with local embeddings (vectors encrypted, in memory after unlock) | 4 | 4 |
| Split expenses / settle up | 3 | 3 |
| Unlinked mentions, hover page previews | 4 | 2 |
| Deep links `emp://page/<id>#<block>` and file associations | 3 | 2 |

### 6.3 P2
| Idea | V | E |
|---|---|---|
| Encrypted multi-device sync via a folder (Yjs/`yrs` for docs, HLC LWW for rows) | 5 | 5 |
| Legacy kit with Shamir shares of the recovery key (2-of-3) | 4 | 4 |
| OS-native OCR for receipts and scans | 4 | 4 |
| WASM plugin API (wasmtime, capability-based) | 4 | 5 |
| Self-decrypting shared HTML page (share a budget with a partner without a cloud) | 3 | 3 |
| Quick capture while locked via an X25519 sealed-box outbox | 3 | 3 |
| Holdings obfuscation (decoy tickers in market requests) | 2 | 2 |
| Voice notes with local whisper.cpp | 3 | 4 |
| Spaced-repetition flashcards from `Q :: A` toggles | 3 | 3 |
| Local CLI (`emp capture`, `emp add-tx`) and MCP server, off by default | 3 | 3 |
| Graph view | 3 | 3 |
| Tray mini-app, optional UI sounds (off by default) | 2 | 2 |

### 6.4 Deliberately not doing
- A multi-user collaboration server (conflicts with "completely local").
- Telemetry of any kind, including "anonymous" stats.
- Shipping OAuth client secrets or shared API keys in the binary (extractable, ToS breach).
- Bank screen-scraping with stored bank passwords.
- Storing TOTP seeds next to passwords.
- Loading remote scripts or fonts at runtime.
- Executing spreadsheet macros (VBA), DDE, `WEBSERVICE`, external workbook links.
- Marketing claims such as "military-grade", "unhackable", "zero-knowledge".

---

## 7. Design language

### 7.1 Feel
Brand in three words: **composed, exact, warm.** Voice: plain, confident, second person, sentence case everywhere ("Create budget"). Exclamation marks only in celebration toasts. Numbers always formatted, never raw.

### 7.2 Visual system summary (exact values in SPEC §3)
- **Themes:** Light, Dark, Midnight (true-black OLED), plus System.
- **Accents:** Iris (default `#5E5CE6`), Ocean, Jade, Amber, Ruby, Orchid, Graphite. Each defines solid / hover / contrast / text / soft / border / ring per theme, with all solid/contrast pairs ≥ 4.5:1.
- **Semantic and finance colours:** gain/loss with four modes: Standard, Colour-blind safe (blue/orange), East Asian (red up), Monochrome. Gain or loss is never shown by colour alone; it always has a sign (U+2212 minus) and an arrow.
- **Block colours:** Notion's 9 + default, with dark-mode variants that meet contrast.
- **Data viz:** an 8-colour categorical palette with a stable hash per category, plus sequential (accent alpha ramp) and diverging (loss → neutral → gain) ramps.
- **Typography:** Inter Variable for UI and body, Newsreader for the serif page font, JetBrains Mono (already installed) for code and IDs, Atkinson Hyperlegible Next as a readability option. UI base 14 px, editor 16/26, tabular numerals for every number.
- **Grid:** 4 px base, control heights 24/28/32/40/48, radii 4/6/8/10/14/20/full with a nested-radius rule.
- **Elevation:** four levels. Dark themes use a ring plus a top highlight because shadows vanish on dark backgrounds.
- **Glass:** only the sidebar (macOS vibrancy, Windows 11 Mica), the scrolled top bar, the command palette and the dialog scrim. Never on Linux. At most two backdrop-filter layers on screen at once.
- **Aurora gradient + 2.5% grain:** only on onboarding, the lock screen, empty-state heroes and the app icon.
- **Icons:** lucide at 16 px / 1.75 stroke by default. Life-app identity tiles: 40 px, radius 10, app colour at 12%.

### 7.3 Motion
- **Tokens:** durations 80/120/160/220/320/480/700 ms; easings out, outExpo, in, inOut; springs snappy (600/35/0.6), ui (420/36), gentle (260/30), layout (500/40), bouncy (400/22, celebrations only), drag (300/28).
- **Signature moments:**
  - press scale 0.97 on pointer-down
  - menus scale from 0.96 at the trigger origin
  - shared-layout segmented and tab indicators
  - rolling digits for changing KPIs
  - live price flash
  - to-do check with a strike-through drawn left to right
  - theme switch as a circular reveal from the toggle
  - unlock that blurs from 12 px to 0 as the app scales 1.02 → 1
  - life-app generation where items fly into the sidebar with a 40 ms stagger
  - chart draw-in with a clip-path sweep
- **Reduced motion:** System / Reduced / Full. Reduced means opacity crossfades of at most 120 ms only: no transforms, shimmer, count-ups, confetti or reveal.
- **Performance:** animate transform and opacity only; at most 4 ms of JS per animation frame; virtualise anything over 100 items; Linux "reduced effects" by default.

### 7.4 Signature screens
- **Lock screen:** aurora, a 360 px card, with no app content rendered behind it.
- **Onboarding:** 8 steps (welcome → make it yours → protect → recovery key → what should EMP help with → quick setup per app with live preview → connect services → building your workspace checklist → into the app).
- **Home:** greeting, Today (agenda, tasks, habits), money snapshot, watchlist, recent pages, suggestions.
- **Life-app header pattern:** a 120 px tinted banner, icon tile, KPI row, underline tabs.
- **Security Center:** a status hero with chips, cards for encryption, password, auto-lock, backups, integrations, network, integrity and privacy.
- **Finance charts:**
  - horizontal gridlines only, the y-axis on the right for time series
  - linear lines for prices, monotone for net worth, step-after for balances
  - range-relative gain/loss colouring with a dashed start reference
  - the header readout pattern while scrubbing (Robinhood-style)
  - candlesticks with a volume histogram

### 7.5 Accessibility
WCAG 2.2 AA throughout, AAA for editor body text. Focus rings appear instantly. F6 cycles regions. Every drag has a keyboard alternative. Charts have aria summaries, "View as table" and keyboard scrubbing. Forced-colours support. 24×24 minimum targets. RTL through logical properties.

---

## 8. Security model

### 8.1 Goals
- **Confidentiality at rest** against a stolen disk or backup.
- **Integrity at rest:** tampering, swapping and per-record rollback are detected.
- **Contained rendering:** malicious notes, imports and templates can't run script, reach IPC beyond the UI's own reach, read files or reach the network.
- **A least-privilege UI process.**
- **Local-first networking.**
- **Recoverability without a backdoor.**
- **A verifiable supply chain.**

### 8.2 Non-goals (stated plainly)
- Malware running as the same user while EMP is unlocked.
- Root or kernel attackers, or a tampered binary.
- Hiding that a vault exists.
- Guaranteed erasure of plaintext that existed before encryption was enabled.
- Formal certification (FIPS, Common Criteria).

### 8.3 Threats considered
- T1: stolen laptop, locked
- T2: unlocked laptop
- T3: cloud or backup provider
- T4: same-user unprivileged process
- T5: malicious note content and XSS
- T6: malicious imported files
- T7: network attacker
- T8: hostile provider
- T9: supply chain
- T10: loopback OAuth poking
- T11: shoulder surfing and clipboard history
- T12: root, out of scope

Each has its defences mapped in SPEC §9.

### 8.4 Architecture in one paragraph
A random 256-bit **DEK** always exists. With encryption on, it is wrapped by **KEK_pw** (Argon2id, 256 MiB, t=3, p=4, calibrated, floor 64 MiB) and by **KEK_rec** (HKDF of a 24-word recovery key) in LUKS-style keyslots. With encryption off, it is wrapped by a device key in the OS keychain so that secrets stay encrypted. HKDF-SHA256 derives per-purpose subkeys (records, assets, secrets, manifest, blob ids, backup MAC). Each record payload is sealed with XChaCha20-Poly1305 using a random 192-bit nonce and an AAD binding vault, table, id, rev and header. Payloads are zstd-compressed and PADMÉ-padded. Attachments use STREAM chunks of 64 KiB with per-blob keys. A keyed multiset hash over all rows detects deletion and per-row rollback. Keys are zeroized on lock, and the webview is fully reloaded. The webview never sees keys, secrets, raw paths or the network.

### 8.5 Hardening themes
- **Tauri:**
  - isolation pattern
  - strict CSP: no eval, no remote origins, `connect-src ipc:` only
  - command allowlist through AppManifest
  - no fs/shell/http/opener/dialog permissions exposed to JS
  - navigation guard
  - devtools off
  - file grants instead of paths
  - `open_external` with a scheme allowlist and punycode display
- **Content:**
  - the TipTap schema as the boundary
  - DOMPurify on paste, ammonia in Rust on import
  - ESLint bans on `innerHTML`/`eval`
  - KaTeX `trust:false`
  - SVG only through `<img>`
- **Imports:**
  - zip-bomb and zip-slip checks
  - no XXE
  - VBA never executed, DDE imported as text
  - CSV formula-injection protection
  - `catch_unwind` around parsers
  - fuzzing
- **Formula engine:**
  - a pure function of its inputs
  - no IO functions
  - operation budget, recursion and spill caps
  - linear-time regex
- **Network:**
  - NetGuard: HTTPS only, per-integration host allowlists, credentials bound to hosts, private IPs blocked for user-content fetches, size and time caps, offline switch, network log
  - rustls only
- **OAuth:**
  - PKCE S256
  - `state` compared in constant time
  - loopback on `127.0.0.1:0` only, with Host validation
  - system browser
  - minimal incremental scopes
  - revoke on disconnect
- **Supply chain:**
  - lockfiles, cargo-deny/audit, npm audit
  - install scripts disabled
  - Actions pinned by SHA, least-privilege tokens
  - SBOMs, provenance attestations, SHA256SUMS
  - minisign-signed updater
- **Process:**
  - `PR_SET_DUMPABLE=0`
  - hardened runtime without get-task-allow
  - no crash dumps
  - log redaction
  - `mlock` for keys (best effort)

### 8.6 "Military grade": the honest position
"Military grade" is a marketing phrase, not a standard. EMP uses 256-bit XChaCha20-Poly1305 and Argon2id with conservative parameters; the RustCrypto AEAD implementation has an independent audit. It is not on NSA CNSA 2.0 (which names AES-256) and has no government certification. The user asked for "military grade"; we deliver the strongest practical engineering and describe it accurately. The app will:
- use approved copy only ("256-bit XChaCha20-Poly1305, key protected by your password with Argon2id");
- answer "Is EMP military-grade?" in an FAQ entry that explains why we don't use the term;
- label encryption "v1 (unaudited)" in Security Center until an external review is done.

### 8.7 Residual risks (documented openly)
1. Malware running while the vault is unlocked.
2. Weak passwords (mitigated by policy, a passphrase generator and education).
3. Metadata leakage: counts, tree shape, timestamps, padded sizes.
4. Old plaintext remnants after encryption is enabled on an existing vault.
5. Whole-vault rollback can't be detected (an optional keychain freshness hint helps).
6. The webview heap can't be zeroized.
7. `style-src 'unsafe-inline'`.
8. Unsigned builds until certificates exist.
9. Platform gaps: no screen-capture protection on Linux; Windows same-user memory reads.
10. Providers see the symbols requested and the user's IP.
11. No independent audit at launch.

---

## 9. Architecture summary

- **Crates:**
  - `emp-crypto`: KDF, envelope, keyslots, STREAM, HKDF
  - `emp-store`: SQLite, schema, repositories, query engine, doc model, search, life-app engine, backups
  - `emp-sheets`: formula engine, number formats, xlsx/csv, plus the Notion-formula and metric dialects
  - `emp-finance`: money, import, budgets, debt, forecast, portfolio, tax
  - `emp-integrations`: NetGuard, OAuth, Google, ICS, market providers
  - `src-tauri` (`emp-app`): commands, state, autolock, protocol, jobs, scheduler
- **Pure crates compile to WASM**, so the browser mock runs the real Rust logic for screenshots and contract tests.
- **One TipTap JSON document per page**, encrypted as one record. Indexes (links, backlinks, block ids, search) are built in memory after unlock.
- **Databases are decrypted once into typed columns.** Filter, sort, group and aggregate run in Rust; the UI asks for windows.
- **Sheets** are stored in 256-row bands with cached values (no recalculation on open), drawn on a canvas grid with tiled fetches.
- **IPC:** a single `req` argument, ts-rs generated types, `{ jobId }` plus a Channel for long jobs, columnar payloads for bars and cells, binary data through raw-body invoke or the `emp-asset://` scheme.
- **Frontend:**
  - zustand stores per concern
  - controller classes outside React for hot views
  - plain-DOM node views for hot blocks
  - `content-visibility` on long docs
  - LazyMotion
  - route-level code splitting

---

## 10. Integrations notes worth remembering

- **Google:**
  - the user brings their own Desktop OAuth client (ID + secret, which Google documents as non-confidential)
  - Testing-mode refresh tokens expire after 7 days, so the wizard recommends publishing to Production; unverified is fine for personal use
  - use the system browser, never an embedded webview
  - Calendar uses sync tokens: on `410 Gone`, resync
  - all-day events have no timezone
  - import Docs and Sheets by pasted URL with `documents.readonly` / `spreadsheets.readonly`, which avoids restricted Drive scopes
  - map `GOOGLEFINANCE` to `STOCK`
- **Bank files:**
  - OFX 1.x is SGML with unclosed tags
  - QIF dates are ambiguous
  - credit-card CSV signs are often inverted
  - transfers must be excluded from spending
- **Excel:**
  - the 1900 leap-year bug and the 1904 date system
  - calamine doesn't expose number formats, so parse `styles.xml`
- **Notion export:**
  - nested zips
  - 32-hex ids in filenames
  - two-pass relation resolution
  - the HTML export has higher fidelity than the Markdown one
- **Market data:**
  - IEX Cloud is dead
  - Alpha Vantage free tier is 25 calls per day
  - Finnhub candles are paid
  - Yahoo is unofficial (off by default)
  - Binance's main API is geo-blocked in the US
  - SEC EDGAR requires a declared User-Agent, which the user supplies
  - caches are encrypted, because the set of tickers reveals holdings
- **Linux:**
  - Wayland blocks global shortcuts, so use the XDG portal or the CLI fallback
  - WebKitGTK has NVIDIA DMABUF issues (`WEBKIT_DISABLE_DMABUF_RENDERER=1`)
- **Notifications:** need a running process (tray + autostart opt-in) and catch-up on launch.

---

## 11. Decisions taken where specialists disagreed

Full table with rationale in SPEC §0.3. Headlines:

| Topic | Options on the table | Decision |
|---|---|---|
| Storage layout | Generic `records` table (security) vs typed tables (architecture) | Typed tables. Structural metadata (parent, sort key, kind, timestamps) is plaintext and documented; all human-written content is in payloads |
| Subkey KDF | BLAKE3 derive_key vs HKDF-SHA256 | HKDF-SHA256 (already a dependency, RFC test vectors) |
| Envelope | Security's 1-byte header vs architecture's 4-byte header | 4-byte header (version, flags, key epoch) + 24-byte nonce; AAD includes vault id, table, id, rev, header |
| Padding | Bucket sizes vs PADMÉ | PADMÉ |
| Recovery key | Base32 groups vs BIP39 24 words | BIP39 24 words; verify 3 random words |
| Asset scheme name | `empblob:` / `emp://blob` / `emp-asset:` | `emp-asset` |
| Lock shortcut | `⌘⇧L` (lock) vs Notion's `⌘⇧L` (dark mode) | `⌘⇧L` locks; theme toggle `⌘⇧D` |
| Hide numbers | `⌘⇧H` vs Notion's "last colour" | `⌘⇧H` hides numbers; last colour moves to `⌘⌥H` |
| Palette | `⌘K` vs `⌘P` | `⌘K` = palette (link popover when text is selected in the editor); `⌘P` = quick find alias; `⌘⇧P` = commands mode |
| Life-app manifest format | TOML vs JSON | JSON (serde `deny_unknown_fields`, shared with templates, embedded in emp-store so the WASM mock has it) |
| Advisor expressions | A separate Pratt parser vs the formula engine | emp-sheets "Metric" dialect (one parser) |
| Embeds | Allowlisted iframes in v1 vs `frame-src 'none'` | v1: link cards only; P1: click-to-load allowlist |
| Dynamic arrays | v1 vs v1.1 | v1, because Spreadsheet Studio templates rely on them |
| Mono font | Geist Mono vs installed JetBrains Mono | JetBrains Mono (already in `package.json`, OFL) |
| Release panic strategy | `abort` (current Cargo.toml) vs `unwind` | `unwind`, so parser and formula failures are isolated with `catch_unwind` |
| Package manager | pnpm (architecture lens) vs npm (repository) | npm (lockfile exists) with `ignore-scripts` |
| Update checks | On by default and disclosed vs opt-in | Asked during onboarding; off until consent |
| Type generation | specta vs ts-rs | ts-rs |
| Popovers | tippy.js (installed) vs floating-ui | `@floating-ui/react`; remove tippy.js |
| Tax depth in v1 | US/UK/CA/AU estimators | US federal + generic/custom estimator; US organizer checklist; UK/CA/AU P1 |

---

## 12. Risks and open questions

### 12.1 Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Scope: Notion parity + sheets + finance + 6 life apps is very large for v1 | High | High | Strict v1 scope in SPEC §1, acceptance criteria per area, P1 list kept visible |
| BlockNote-style nesting in TipTap is harder than stock lists | Medium | High | Build it first with property tests on random edit sequences |
| WebKitGTK performance and rendering quirks | High | Medium | Linux reduced effects, ×1.5 budgets, real-webview perf runs |
| Keyless market sources change ToS or break | High | Medium | Provider chain, keyed providers first-class, caching, stale flags |
| Tax data correctness and liability | Medium | High | Packs carry source and verified date; tests from official examples; persistent disclaimer; never "you owe" |
| Google Testing-mode token expiry confuses users | High | Low | Detect `invalid_grant`, guide to publish, one-click reconnect |
| Unsigned first releases trigger Gatekeeper/SmartScreen | High | Medium | First-launch instructions, SHA256SUMS, provenance attestations; signing secrets slot in later |
| Isolation-pattern IPC overhead on hot paths | Low | Medium | Measured in perf CI |
| Big single documents (write amplification) | Low | Low | 2 MB warning, assets never inline, zstd |
| Users lose password and recovery key | Medium | High | Recovery ceremony, verification, reminders in Security Center, snapshots |
| "Military grade" expectation vs honest copy | Medium | Low | FAQ explanation; emphasise concrete parameters |

### 12.2 Open questions (to confirm during implementation)
1. Ship Linux aarch64 in v1? It depends on runner availability for `devartin/ultra-note`. Default: build it if `ubuntu-22.04-arm` is available, otherwise defer.
2. Argon2 default on machines with < 8 GiB RAM: auto-downgrade to 128 MiB t=4? (Calibration handles it; confirm the UX copy.)
3. A custom UniqueID plugin vs the TipTap UniqueID extension (licence and behaviour on paste). Default: custom plugin.
4. Whether `style-src 'unsafe-inline'` can be removed once the editor is built (verify TipTap/motion behaviour).
5. Which brokerages get CSV presets first. Default: Fidelity, Schwab, Vanguard.
6. Do Spreadsheet Studio templates ship with sample numbers by default, or blank? Default: sample numbers, clearly tagged.
7. Should Midnight theme ship in v1? Default: yes; it is tokens only.
8. Tray icon and "keep running in background" default. Default: off, offered when the user enables reminders.
9. Apple Developer ID and Windows signing: will the user provide certificates? The pipeline signs automatically when secrets exist.
