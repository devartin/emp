# Ultranote 1.0 — product and design brief

**Status:** binding for all 1.0 work. Where this brief disagrees with `docs/SPEC.md`, `docs/DESIGN.md` or
`docs/design/KIT.md`, this brief wins. IPC shapes stay SPEC §11 except for the additions listed in §3 and §9, which
both backends (Rust and the browser mock) implement identically.

**Owner's goals, in their words:** drastically simplify everything so a person who has never used Notion can start
right away; a sidebar that can be closed and opened; a layout organised around projects, documents, spreadsheets and
apps, where a project can contain an app; much simpler settings (today they are information overload); everything
fully built with no bugs; more work done in Rust so the app is as fast as possible; animations, micro-animations and
the overall feel as good as we can make them; the product is called **Ultranote**.

---

## 0. The rule that matters most: the desktop app is the product

0.3.0 shipped with Home and five of six apps crashing on desktop, while the browser demo looked fine. The browser mock
(`src/backend/mock`) is a separate TypeScript implementation that has drifted from the Rust backend in dozens of
places (option ids, database roles, page kinds, manifests, validation limits, defaults).

- **Rust is the source of truth.** When the mock and Rust disagree, change the mock (and the frontend) to match Rust,
  unless Rust is wrong, in which case fix Rust and the mock together.
- **Every change is verified in the real desktop app**, not only in the browser demo. See §10 for the tooling.
- **Every request shape change is made in three places together:** `src/backend/types.ts` + `contract.ts`, the mock
  handler, and the Rust DTO/command (`#[serde(rename_all = "camelCase", deny_unknown_fields)]` rejects unknown
  fields, so a frontend-only field breaks desktop).

## 1. Words

Use plain words a newcomer already knows. Never show the left-hand word in the UI.

| Don't say | Say |
|---|---|
| Ultra Note | Ultranote |
| vault | workspace |
| life app | app |
| workbook | spreadsheet |
| Life OS | Tasks |
| Life OS "Projects" (its database/tab) | Lists |
| Money HQ | Money |
| Portfolio (the app) | Investments |
| Tax Organizer / Tax Year 2026 | Taxes |
| Track / Protect (onboarding step names) | (no step names) |
| XChaCha20-Poly1305, Argon2id, Diceware, KDF | only inside "How encryption works" details |

App ids (`life-os`, `money-hq`, `portfolio`, `tax-organizer`, `spreadsheet-studio`, `habits`) and internal `emp`
identifiers do not change. Display names come from one place (the app identity map) so older workspaces show the new
names without a data migration. Spreadsheet Studio, Habits and Markets keep their names.

## 2. Layout and navigation

### 2.1 Sidebar (top to bottom)

```
[■ Personal ▾]                    [+ New ▾] [« Hide]
  Search                       Ctrl K
  Home
  Calendar
Favorites                (only when there are any)
Projects                                        +
  ▸ Website relaunch          (expands to its contents)
  ▸ Lisbon in March
Documents                                       +
  Getting Started
  Journal        (children nest under their parent)
Spreadsheets                                    +
  Household budget 2026
Apps                                            +
  Tasks · Habits · Money · Investments · Taxes · Spreadsheet Studio · Markets
──────────────
  Trash                                   ⚙ Settings
  ● Local · Not encrypted
```

- **Sections** (Favorites, Projects, Documents, Spreadsheets, Apps) collapse with a caret and remember their state.
  An empty section shows a single quiet line explaining what goes there and how to add one (no empty section is
  hidden, except Favorites).
- **What goes where (top level only; children always nest under their parent regardless of kind):**
  - Projects: pages with `flags.project`.
  - Documents: top-level `doc` and `database` pages that are not projects and not owned by an app.
  - Spreadsheets: top-level `sheet` pages not owned by an app.
  - Apps: installed app instances whose hub page is at the top level, plus Markets. "+" opens the app gallery.
  - Anything inside a project appears only under that project. An app's hub shows as **one row** wherever it lives
    (its generated pages never list in the sidebar; they are reached from the app).
- **"+ New" menu** (header button, also `Ctrl+N` for a document): Document, Spreadsheet, Database, Project, App…,
  From a template…, Import…. Templates and Import leave the sidebar body.
- **Hide/show:** a visible "Hide sidebar" button in the header, `Ctrl/⌘+\`, and the palette command. When hidden, a
  "Show sidebar" button sits at the left of the top bar, and hovering the left edge peeks the sidebar as an overlay.
  The state is remembered per device. Below 900 px the sidebar is an overlay. The loading skeleton respects the
  hidden state.
- The sidebar stays resizable. F6 cycles sidebar → top bar → content correctly whether the sidebar is open or not.
- Detached app hubs never show as apps.

### 2.2 Projects

A project groups related documents, spreadsheets, databases and apps ("Website relaunch", "Move to Lisbon").

- **Data:** a project is a `doc` page with `flags.project: true` (no new page kind, no migration). Its document body
  holds the project's notes. Its children are its contents.
- **Project view** (a `page` route whose meta has `flags.project`): the title and icon, a short line of what is
  inside ("3 documents · 1 spreadsheet · 1 app"), then **Contents** grouped as Documents, Spreadsheets, Databases and
  Apps (rows with icon, title and last edited; click opens). An **Add** menu: New document, New spreadsheet, New
  database, Add an app…, Move an existing page here…. Below Contents, the project's notes (the normal editor).
  Empty project: one sentence and the four add buttons.
- **Apps in projects:** "Add an app…" inside a project installs the app with `parentId = project` (or, when it is
  already installed, offers to move it into the project). An installed app's page menu has **Move to project…**.
  One instance per app stays the rule (Rust enforces it; the frontend assumes it in ~15 places).
- Page menu on any document: **Turn into project** / **Turn back into a document**. "Move to…" lists projects first.
- Deleting a project moves it and its contents to Trash (existing behaviour). Restoring restores both.

### 2.3 Top bar

Back/forward, breadcrumbs (for app pages and project contents, the real parent chain), then page actions. The
"hide numbers" eye shows only on screens that show money.

### 2.4 Settings

Settings opens as a **large dialog** over the app (about 960×680, its own left list), not a page beside the sidebar,
so there is never a second navigation rail. `#/settings/<section>` deep links open the dialog at that section; old
section ids redirect (aliases). Five sections, each showing only what most people need, with one **More options**
disclosure at the bottom for the rest:

1. **General:** your name, region (one choice that sets number, date and time formats; time zone and first day of
   week detected from the OS and shown as editable), currency, start page.
2. **Appearance:** theme (Light, Dark, Midnight, Match system), accent, text size, reduce motion. More options:
   density, page font defaults, spell check, number display options.
3. **Privacy & security:** a plain status line with at most one next action ("Your workspace isn't encrypted. Turn on
   encryption"), password, recovery key, auto-lock, lock now, hide numbers, offline mode. More options: the security
   checklist, network log, clipboard and screen settings. An unencrypted workspace is a choice, not a failure: no red
   score, no warning badge.
4. **Backups & data:** automatic backups (on/off, where, how many), back up now, restore from a backup, Import…
   (the one shared import dialog), Export everything, Trash retention.
5. **Connections:** Google (set up, calendars, docs/sheets), market data providers and keys.

**About** is a link at the foot of the settings list (version, check for updates, licences, data folder, logs,
diagnostics, FAQ). Keyboard shortcuts live only in the `Ctrl+/` overlay. Delete the controls for visual effects,
transparency and glass (v3 removed glass; the descriptions are false) and the code behind them.

### 2.5 First run

Two screens, then Home. The window appears immediately (no 8 s wait).

1. **Welcome to Ultranote.** "Your notes, spreadsheets, tasks and money in one private place on this computer."
   Optional first name. **"What would you like to use it for?"** cards (multi-select, all optional): Notes and
   documents (always included, shown checked and disabled), Tasks, Habits, Money, Investments, Taxes, Spreadsheets.
   Button: **Continue**.
2. **Keep it private?** Two choices of equal weight: **Lock with a password** (password + confirm on the same
   screen, strength hint in words, "Suggest one"; then the recovery key shown with Copy and **Save to a file…**
   (native save dialog) and one checkbox "I've saved my recovery key") or **Not now** ("You can turn this on any time
   in Settings"). Button: **Start using Ultranote**. Region, time zone and week start are detected and saved.

The chosen apps build in the background with real progress on Home. Import (Notion, Markdown, bank files) is offered
on Home, not in first run.

### 2.6 Home

Home stays "the day" (date, capture, agenda, due, habits line, money line, recent) and gains, for new workspaces, a
**Start here** strip: New document, New spreadsheet, New project, Add an app, Import. It can be dismissed and goes
away on its own once the workspace has a few pages. The Getting Started checklist must be completable (only items
that make sense for this workspace) and dismissible. The capture field accepts plain text: with Tasks installed it
becomes a task, otherwise it is appended to today's note; prefixes keep working.

## 3. Contract additions (both backends)

```ts
interface PageFlags { /* … */ project?: boolean }
api.page.create({ /* existing */ flags?: Partial<PageFlags> })
api.lifeapp.install({ /* existing */ parentId?: Id })     // hub page created under parentId
```

Rust: `PageFlags.project: bool` (`#[serde(default)]`), the optional fields on the request DTOs, and validation that
`parentId` is a live doc page in the same workspace. Rust refuses a second instance of the same app
(`ALREADY_INSTALLED`), as the mock does.

## 4. Motion and feel (amends DESIGN.md §7)

v3's "earned motion" made the app feel static. 1.0 keeps frequent actions fast but lets the interface respond:

- **Instant (0 ms):** typing, caret, selection, scrolling, keyboard navigation in lists.
- **Micro (100–160 ms, ease-out, opacity/transform only):** hover and press states (fade in 100 ms; press 0.98 scale
  on keys and cards), caret rotation on disclosures (120 ms), section and toggle expand/collapse (160 ms height +
  opacity), checkbox tick draw and task strike-through (160 ms), list row insert/remove (160 ms fade + 4 px),
  menus/popovers/tooltips (scale 0.98→1 + fade, 120 ms), tab underline slide (140 ms).
- **Small (180–240 ms):** sidebar hide/show (200 ms transform), dialogs and the palette (180 ms scale 0.98→1 +
  fade; keyboard-opened palette stays instant), toasts (200 ms slide-up), route change (120 ms crossfade of the
  content only), skeleton→content (120 ms fade), the page icon and title morph from sidebar to page header.
- **Signature (unchanged):** vault unlock, app build, reconcile success.
- Numbers roll only after the user's own edit (`markUserEdit()` must be wired).
- No idle loops: nothing animates when nothing changes (remove the always-on frame monitor).
- **Reduced motion:** everything above becomes instant or a ≤ 80 ms opacity fade.
- All durations come from the motion register; the register test covers TS as well as CSS. Guards may be updated to
  allow the motion above; keep the copy, emoji and contrast guards.

Visual consistency: finish the v3 sweep for Settings, vault, integrations, life apps and calendar (no uppercase
labels, radius ≤ 12, no gradients, grain or 2 px grooves, no staggered arrival animations). Default accent is
graphite on both backends (Rust currently defaults to iris).

## 5. Performance (Rust does the heavy lifting)

Targets on a release build: window visible ≤ 1 s after launch; Home interactive ≤ 1.5 s; database warm query
≤ 25 ms and scroll window ≤ 8 ms at 10k rows; Money HQ Overview ≤ 300 ms with 20k transactions; no idle CPU.

- Show the window without waiting for `requestAnimationFrame` (hidden WebKitGTK windows never run it); report
  `app_ready` from every phase; set the window background colour; fallback 2 s.
- Page tree child-count subquery uses the index (`c.workspace_id = p.workspace_id`): 1,270 ms → 4.5 ms at 5k pages.
- `db_query` world cache keyed by `(db, data_rev, schema_rev)`; accept `limit: 0` for group-only queries; no
  quadratic paging (stream or keyset).
- Ledger cache and batch commands for finance; Money, Investments, Taxes and Habits read compact, pre-computed views
  from Rust instead of pulling every row and recomputing in TypeScript (TS ledger maths uses floats).
- `PRAGMA optimize` on close and periodically; sensible cache sizes; open the vault after creating the window.
- Frontend: no Editor chunk on Home's first render; palette title folding cached; remove dead code (`src/App.tsx`,
  `src/App.css`, glass probe/policy); bundle within budget.

## 6. Quality bar for 1.0

- No feature is offered that does not work on desktop. If something cannot be finished for 1.0 it is removed from
  the UI, not left failing (README updated to match).
- Every app works end to end on desktop: create, edit, compute correct numbers, persist across restart.
- No console errors in normal use. No dead buttons. No "Coming soon".
- Contrast, reduced motion and tabular figures rules still apply.

## 7. Ownership during implementation

Lanes own directories as stated in their task. Shared files (`src/backend/types.ts`, `src/backend/contract.ts`,
`src-tauri/src/lib.rs`, `src-tauri/src/commands/mod.rs`, `src/app/commands.ts`) are edited **surgically and
append-only** (add your entries, never reformat or reorder others'). Never revert or rewrite another lane's work.

## 8. Words in the code

User-facing strings follow §1 and the copy guard (sentence case, no exclamation marks, plain verbs). Internal names
(`emp-*`, `lifeapp`, `vault` in Rust) stay as they are.

## 9. Desktop-only fixes known before implementation

From the mapping reports in the session scratchpad (`understand/*.md`) and the desktop audit (`audit/*.md`):
life-app roles missing in Rust manifests (Tasks/Habits "database not found"), no `review` step in Rust manifests
(wizard cannot create), option ids vs keys (Money accounts, transactions, reconcile, tax status), Spreadsheet Studio
template names, Markets demo tickers, rules editor `timesApplied`, `lifeapp_event`, recurring task respawn, calculated
columns, setup bank import, duplicate install guard, grouped views `limit: 0`, Rust settings defaults (UTC, en-US,
Sunday, iris), update check, snapshot folder, backup password for unencrypted workspaces, recovery key file save,
built-in templates in Rust, duplicate of database/sheet pages, deep duplicate, export of sheets, xls/ods import,
desktop drop zones, stale favourites, F6 focus cycle, the PDF shortcut label.

## 10. How to test on desktop

- `target/devurl/debug/emp-app` is a debug desktop binary that loads the running Vite dev server
  (`http://localhost:1420`) with the **real Rust backend**: frontend edits show after a reload, no rebuild. Rebuild
  it after Rust changes with `CARGO_TARGET_DIR=target/devurl cargo build -p emp-app`.
- `npx tauri build --debug --no-bundle` builds `target/debug/emp-app` with the production frontend embedded (what
  ships). Use it for final checks.
- `scripts/e2e/` drives either binary over WebDriver (`ULTRANOTE_BIN=…`). See its README. Specs must check content,
  not only the absence of crashes (0.3.x's smoke test passed while Tasks showed "database not found").
