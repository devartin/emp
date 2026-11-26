Product renamed to Ultra Note on 2026-11-26; 'EMP' below refers to the same product.

# EMP v1 Build Spec

> **Status:** authoritative for v1.0. Implementers take names and numbers from this file exactly.
> **Companion:** [`BRAINSTORM.md`](./BRAINSTORM.md) records the ideas and rationale. If the two disagree, this file wins.
> **Repository:** `github.com/devartin/ultra-note` · bundle identifier `com.devartin.emp` · product name `EMP`.
> **Date:** 2026-11-26.

Conventions:
- **MUST**, **SHOULD** and **MAY** are used in the RFC 2119 sense.
- Sizes are in CSS px at 100% zoom unless stated otherwise.
- `KiB`, `MiB` and `GiB` are binary units.
- `||` means concatenation. `lp(x)` = `u32be(len(x)) || x`.
- Every IPC type in §11 is the TypeScript view of a Rust struct exported by ts-rs.

---

## 0. Decisions

### 0.1 Fixed technical decisions (not up for debate)
1. **Shell and stack.** The app is built on Tauri 2. The Rust workspace has these crates: `emp-crypto`, `emp-store`, `emp-sheets`, `emp-finance`, `emp-integrations`, plus the app crate in `src-tauri`, named `emp-app`. The frontend uses React 19, TypeScript, Vite, Tailwind CSS v4, `motion`, TipTap 3, Recharts, lightweight-charts, lucide-react, zustand and cmdk.
2. **Storage and encryption.**
   - Data lives in SQLite (rusqlite, `bundled`) in the app data directory.
   - Encryption is an app-level envelope. A random 256-bit DEK encrypts each payload with XChaCha20-Poly1305, using the record id and kind as AAD (§9.5 extends this).
   - The DEK is wrapped by an Argon2id-derived key.
   - With encryption off, payloads are stored as plain JSON.
   - Secrets are always encrypted.
   - The search index is built in memory after unlock and is never persisted.
3. **Spreadsheets.** The formula engine lives in `emp-sheets` and is reached over IPC. xlsx and csv import and export run in Rust, using calamine and rust_xlsxwriter.
4. **Google.**
   - OAuth 2.0 with PKCE and a loopback redirect.
   - The user supplies their own client.
   - No secrets ship in the binary.
5. **Market data** comes from pluggable providers: keyless sources, plus user API keys.
6. **Browser mode.** The frontend also runs in a plain browser against an in-memory mock backend.
7. **Releases** are built by GitHub Actions on macOS, Windows and Linux runners.

### 0.2 Existing repository state (respect it)
- **Already present:** the workspace, crates and `src-tauri` exist. `package.json` already lists TipTap 3.35, motion 14, Recharts 3, lightweight-charts 5, cmdk, zustand 5, dnd-kit, TanStack Virtual, KaTeX, lowlight, zxcvbn, `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono`.
- **Package manager:** npm, with a committed `package-lock.json`.
- **App icon:** already designed, a three-layer stack. Do not replace it.
- **Changes required in v1:**
  1. Set `[profile.release] panic = "unwind"` (currently `abort`). See D-15.
  2. Set `productName` to `EMP` and the window title to `EMP` in `tauri.conf.json`.
  3. Replace the `csp: null` setting with the CSP in §9.12.
  4. Replace `capabilities/default.json` with the files in §9.13.
  5. Add these dependencies. Rust: `rust_decimal`, `zstd`, `rrule`, `chrono-tz`, `unicode-normalization`, `bip39`, `zxcvbn`, `ts-rs`, `nucleo-matcher`, `unicode-segmentation`, `quick-xml`, `zip`, `encoding_rs`, `chardetng`, `ammonia`, `governor`, `keyring`, `tauri-plugin-updater`, `tauri-plugin-global-shortcut` (P1). npm: `@floating-ui/react`, `@radix-ui/react-{dialog,popover,dropdown-menu,context-menu,tooltip,tabs,switch,checkbox,radio-group,slider,scroll-area,toggle-group}`, `@fontsource-variable/newsreader`, `@fontsource/atkinson-hyperlegible-next`, `dompurify`, `decimal.js-light`, `chrono-node`.
  6. Remove `tippy.js` from `package.json`.

### 0.3 Decision log (where specialists disagreed)

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D-01 | Table layout | Typed tables (§10). Plaintext columns hold structure only: ids, parent ids, kind, sort keys, timestamps, revs. Every human-written value lives in `payload`. | SQL indexes for tree and order; one query path for both modes. The leakage is documented (§9.20). |
| D-02 | Subkey KDF | HKDF-SHA256 with `salt = vault_id` and the labels in §9.4 | RFC vectors; already a dependency |
| D-03 | Envelope header | 4-byte header (version, flags, key_epoch u16) followed by a 24-byte random nonce | Room for key rotation and compression flags |
| D-04 | AAD | `"EMP-REC-v1" ‖ vault_id ‖ u8 table_tag ‖ lp(id) ‖ lp(kind) ‖ u64be(rev) ‖ header[0..4] ‖ lp(extra)` | Binds location, kind, version and header |
| D-05 | Padding | PADMÉ | Leaks O(log log n) bits of size, with low overhead |
| D-06 | Recovery key | BIP39 English, 24 words (256-bit). Verification asks for 3 random words. | Standard checksum; easy to transcribe |
| D-07 | Block model | `blockContainer` nesting, BlockNote-style (§7.1) | Any block can have children, as in Notion |
| D-08 | Page content | One TipTap JSON document per page, stored as one record | Matches the ProseMirror model; less metadata leakage |
| D-09 | Asset URL scheme | `emp-asset` (`emp-asset://localhost/<id>` on macOS and Linux, `http://emp-asset.localhost/<id>` on Windows) | One name everywhere |
| D-10 | Shortcuts | `⌘⇧L` lock, `⌘⇧D` theme, `⌘⇧H` hide numbers, `⌘⌥H` last colour, `⌘K` palette (link popover when the editor has a text selection), `⌘P` quick find, `⌘⇧P` palette in commands mode, `⌘⌥D` today's daily note, `⌘⇧O` offline mode | Settles conflicts between lenses (§8.7) |
| D-11 | Life-app manifests and templates | JSON, serde `deny_unknown_fields`, stored in `crates/emp-store/lifeapps/` and embedded with `include_str!` | Shared with the WASM mock |
| D-12 | Advisor and metric expressions | The `emp-sheets` parser in `Dialect::Metric` | Keeps a single parser |
| D-13 | Embeds | v1 shows link cards only (`frame-src 'none'`). Click-to-load allowlisted iframes are P1. | Security first |
| D-14 | Dynamic arrays and spill | Ship in v1 | Spreadsheet Studio templates need them |
| D-15 | Release panic strategy | `unwind`. Parsers and evaluation run inside `catch_unwind`. A panic outside those boundaries triggers lock and an error screen. | Availability, with crash isolation |
| D-16 | Mono font | JetBrains Mono Variable | Already installed, OFL |
| D-17 | Update checks | The question is asked in onboarding. Checks stay off until the user consents. | Local-first |
| D-18 | TS type generation | ts-rs, output to `src/backend/types.gen/` | Simple derive-based |
| D-19 | Floating UI | `@floating-ui/react` together with Radix primitives | Matches TipTap 3 |
| D-20 | Tax depth | US federal TY2026 estimator, a Generic/Custom estimator, and a US organizer checklist. UK, CA and AU are P1. | Achievable and correct |
| D-21 | Money representation | `rust_decimal::Decimal` serialized as a decimal string with scale ≤ 8, plus an ISO-4217 code (or a crypto code) | Precision, including crypto |
| D-22 | Snapshots vs backups | `.empsnap` is the automatic snapshot (an encrypted DB copy plus blobs). `.empbackup` is a user-initiated single-file backup. Portable `.zip.age` export is P1. | Clear naming |
| D-23 | Theme boot cache | `localStorage['emp.boot']` holds `{theme, accent, motion, density, textSize}` only. The source of truth is device-scope settings. | No flash, and nothing sensitive in storage |
| D-24 | Trash and history | Trash is kept 30 days. Page versions: all kept for 24 h at 10-minute granularity, hourly for 7 days, daily for 90 days, then weekly. Cap: 500 per page. | Union of lenses, bounded |

---

## 1. v1 scope

v1.0 is "Notion core + sheets + finance + 6 life apps, local and encrypted, released for 3 OSes". P1 and P2 items **MUST NOT** block a v1.0 release.

### 1.1 In scope (v1.0)

**Shell**
- Lock screen, onboarding (§6.2), sidebar tree, top bar, breadcrumbs, back/forward, side peek, Home dashboard, Trash, Settings, Security Center, the command palette and quick find, daily notes, and Light, Dark and Midnight themes with 7 accents.
- Density, text size and reduced-motion settings.
- macOS vibrancy and Windows 11 Mica.
- Custom Windows caption buttons.

**Editor**
- The D-07 schema with block IDs.
- **Blocks:** text, H1–H3, toggle H1–H3, bullet, numbered, to-do, toggle, quote, callout, divider, code, equation, simple table, columns (2–5, inserted from the slash menu), sub-page, link to page, image, file, TOC, inline/full/linked database, and the EMP blocks `chart`, `kpi`, `sheetEmbed`, `watchlist`.
- **Marks:** bold, italic, underline, strike, code, link, text colour, background colour, inline equation, page mention, date mention, emoji.
- **Editing:** slash menu, block handle with drag-and-nest, block selection, markdown shortcuts, turn-into, clipboard (internal, HTML, markdown, plain), autosave, undo/redo, find & replace, file drop, backlinks with snippets, page history (snapshots and restore).

**Databases**
- **Property types:** title, text, number, money, select, multi_select, status, date, checkbox, url, email, phone, files, relation (two-way), rollup, formula, created_time, updated_time, unique_id, rating, progress, ticker, recurrence, secret, computed.
- **Views:** table, board, list, calendar (month), gallery, chart.
- Filters (AND/OR, 3 levels), multi-sort, group-by, footer calculations, database search, row templates, type conversion, CSV/XLSX import, CSV export.

**Sheets**
- Workbook pages with a canvas grid, formula bar, fill handle, freeze, merge, number formats and conditional formats.
- The function list in §14 including dynamic arrays.
- xlsx/xls/ods/csv import and xlsx/csv export.
- `STOCK` and `FX` functions.

**Finance**
- Import of CSV, OFX, QFX and QIF; rules; dedupe; transfer detection; budgets; recurring; subscriptions; debt simulation; cash-flow forecast; net worth; goals.
- Portfolio: lots (FIFO, average cost), XIRR, TWR, allocation, drift, rebalance planner, watchlist and alerts.
- Candlestick charts with SMA.
- Tax estimator (US federal and Generic) and quarterly plan.

**Life apps**
- Framework (§16.1) plus Money HQ, Portfolio, Tax Organizer, Spreadsheet Studio, Life OS and Habits.

**Integrations**
- Google OAuth setup wizard.
- Calendar read with sync tokens.
- Docs import by URL and export.
- Sheets import by URL and export.
- Market providers: Frankfurter, Stooq, CoinGecko (keyless); Finnhub, Tiingo (with a key).
- `.ics` import and export.

**Import and export**
- Import: Markdown files and folders, Notion export zip, CSV/XLSX.
- Export: Markdown, CSV, JSON, XLSX (sheets and life-app workbooks), PDF via the print path, "Export everything".
- `.empsnap` automatic snapshots and `.empbackup` manual backups.

**Security**
- Everything marked v1 in §9.

**Release**
- CI as described in §19.
- Tag-driven release with macOS universal dmg/app, Windows msi and nsis, Linux deb, rpm and AppImage.
- Updater artifacts, SHA256SUMS, SBOMs and provenance attestations.

### 1.2 Out of scope for v1.0 (P1 unless noted)
- **Pages and views:** tabs, split view, multiple windows, centre peek, calendar week view, timeline view, synced blocks, button block and button property, comments, automations, repeating templates, sub-items, Mermaid, video/audio/PDF blocks, bookmarks, embeds.
- **Workspaces:** multiple workspaces (vaults) and per-page lock.
- **Capture and reminders:** global quick capture and reminders delivered while the app is closed. In v1, reminders fire only while the app is running.
- **Sync and calendars:** Google Calendar two-way, ICS subscriptions, CalDAV.
- **Importers:** Notion API, Evernote, Obsidian, Todoist.
- **Finance extras:** brokerage presets, wash sales, HIFO/LIFO/specific-ID lots, UK/CA/AU tax packs.
- **Other:** AI, key rotation UI, `age` export, content protection toggle, deep links, file associations.
- **P1 life apps:** Freelance, FI, Goals, Journal, Health, Meals, Jobs, Travel, Emergency Binder.
- **P2:** sync, plugins, OCR, Shamir, live bank sync, MS Graph, graph view.

### 1.3 Platforms and minimums
- **macOS:** 12 Monterey or later, universal binary.
- **Windows:** 10 22H2 or later, x64, WebView2 evergreen.
- **Linux:** x64, glibc ≥ 2.35, WebKitGTK 4.1 ≥ 2.42. The AppImage bundles WebKitGTK.
- **Linux arm64:** built only if the `ubuntu-22.04-arm` runner is available.
- **Window minimum size:** 800×560. Default size: 1280×820, centred.

---

## 2. Repository layout

```
emp/
├─ Cargo.toml  Cargo.lock  rust-toolchain.toml  deny.toml  .cargo/config.toml
├─ package.json  package-lock.json  .npmrc (ignore-scripts=true)  vite.config.ts  tsconfig.json  eslint.config.js  .size-limit.json
├─ index.html                      # no inline scripts except the CSP-hashed boot-theme snippet (§3.9)
├─ crates/
│  ├─ emp-crypto/src/{lib,kdf,keys,envelope,stream,keyslot,hkdf_labels,recovery,pad,mac}.rs
│  ├─ emp-store/
│  │  ├─ src/{lib,error,codec,vault,manifest}.rs
│  │  ├─ src/db/{conn,pragmas,migrate,writer,readers}.rs
│  │  ├─ src/repo/{workspaces,pages,docs,databases,rows,views,workbooks,sheets,assets,versions,settings,secrets,kv,sync_links,outbox,reminders,lifeapps,security_log}.rs
│  │  ├─ src/model/*.rs            # pure DTOs (ts-rs exported)
│  │  ├─ src/query/{filter,sort,group,agg,window,columns,rollup}.rs   # pure
│  │  ├─ src/doc/{schema,walk,index,migrate,markdown,html,clipboard}.rs # pure
│  │  ├─ src/search/{tokenize,inverted,titles,rank,snippet}.rs        # pure
│  │  ├─ src/lifeapps/{manifest,plan,apply,tuneup,metrics,advisor,packs,sample}.rs # plan/metrics/advisor pure
│  │  ├─ src/life/{habits,recurrence,nlp_dates,scheduler}.rs          # pure
│  │  ├─ src/import/{markdown,notion,csv_db}.rs
│  │  ├─ src/backup/{snapshot,restore,export}.rs
│  │  ├─ lifeapps/{money-hq,portfolio,tax-organizer,spreadsheet-studio,life-os,habits}.json
│  │  ├─ packs/tax/{us-federal-2026.json,generic.json}  packs/holidays/us.json  packs/accounts/us.json
│  │  └─ tests/fixtures/
│  ├─ emp-sheets/src/{lib,addr,lexer,parser,ast,printer,value,workbook,graph,recalc,eval,spill,numfmt,dates,ops,undo,persist,dialect,lint}.rs
│  │  ├─ src/functions/{math,stat,logic,lookup,text,date,finance,info,array,emp}.rs
│  │  └─ src/io/{xlsx_import,xlsx_styles,xlsx_export,csv}.rs        # feature "io"
│  ├─ emp-finance/src/{lib,money,fx,ledger,budget,rules,payee,dedupe,transfers,recurring,debt,amortize,forecast,networth,goals,insights}.rs
│  │  ├─ src/import/{sniff,csv,ofx,qif}.rs
│  │  ├─ src/portfolio/{lots,perf,alloc,rebalance,dividends,risk,indicators}.rs
│  │  └─ src/tax/{pack,engine,estimated,deadlines,retention}.rs
│  └─ emp-integrations/src/{lib,netguard,netlog,oauth,loopback,outbox}.rs
│     ├─ src/google/{calendar,docs,sheets,drive,convert}.rs
│     ├─ src/ics.rs
│     └─ src/market/{provider,router,cache,frankfurter,stooq,coingecko,finnhub,tiingo,yahoo}.rs   # yahoo behind feature, off
├─ src-tauri/
│  ├─ build.rs (AppManifest allowlist)  tauri.conf.json  capabilities/{main.json,settings.json}
│  ├─ isolation/{index.html,index.js}   # zero-dependency isolation hook
│  └─ src/{main,lib,state,error,events,protocol,jobs,autolock,keychain,scheduler,windows,grants,logging}.rs
│     ├─ src/commands/{app,vault,security,backup,import,export,settings,workspace,page,version,db,sheet,asset,search,lifeapp,finance,portfolio,tax,market,google,ics,reminder,job,net}.rs
│     └─ src/platform/{macos,windows,linux}.rs   # power/lock notifications, dumpable, mlock
├─ src/                            # frontend, see §13
├─ e2e/  scripts/  .github/workflows/{ci.yml,release.yml,nightly.yml}
└─ docs/{BRAINSTORM.md,SPEC.md,SECURITY.md (also at repo root),THREAT_MODEL.md}
```

Dependency direction:
- `emp-app` → {`emp-store`, `emp-sheets`, `emp-finance`, `emp-integrations`, `emp-crypto`}
- `emp-store` → {`emp-crypto`, `emp-sheets`}
- `emp-finance`, `emp-sheets` and `emp-integrations` have no internal dependencies

`#![forbid(unsafe_code)]` applies in every crate except `src-tauri/src/platform`.

**WASM build:** `cargo build -p emp-store --target wasm32-unknown-unknown --no-default-features --features wasm` pulls in the pure modules of emp-store, emp-sheets (without `io`) and emp-finance (without `parallel`). `wasm-bindgen` then produces `src/backend/mock/wasm/`.

---

## 3. Design tokens

All tokens are CSS custom properties defined in `src/styles/tokens.css`. They are exposed to Tailwind v4 via `@theme inline` in `src/styles/theme.css`. These attributes on `<html>` select variants:

- `data-theme`: `light`, `dark` or `midnight`. System mode resolves to `light` or `dark`.
- `data-accent`: `iris`, `ocean`, `jade`, `amber`, `ruby`, `orchid` or `graphite`. Default `iris`.
- `data-density`: `comfortable` or `compact`.
- `data-motion`: `full` or `reduced`.
- `data-contrast`: `normal` or `more`.
- `data-effects`: `full` or `reduced`.
- `data-numbers`: `standard`, `cvd`, `eastasian` or `mono`.
- `data-privacy`: `on` or `off`.

### 3.1 Neutrals

| Token | Light | Dark | Midnight |
|---|---|---|---|
| `--bg-window` | `#F7F7F8` | `#0B0B0E` | `#000000` |
| `--bg-canvas` | `#FFFFFF` | `#111114` | `#000000` |
| `--bg-surface-1` | `#FFFFFF` | `#17171B` | `#0A0A0C` |
| `--bg-surface-2` | `#F4F4F5` | `#1D1D22` | `#121215` |
| `--bg-surface-3` | `#EBEBEE` | `#25252B` | `#1A1A1E` |
| `--bg-overlay` | `#FFFFFF` | `#1B1B20` | `#111114` |
| `--bg-inverse` | `#18181B` | `#F4F4F5` | `#F4F4F5` |
| `--text-primary` | `#18181B` | `#EDEDF0` | `#EDEDF0` |
| `--text-secondary` | `#52525B` | `#A1A1AA` | `#A1A1AA` |
| `--text-tertiary` | `#6E6E77` | `#8A8A94` | `#8A8A94` |
| `--text-disabled` | `#A1A1AA` | `#5A5A63` | `#55555E` |
| `--text-on-inverse` | `#FFFFFF` | `#09090B` | `#09090B` |
| `--border-subtle` | `rgba(24,24,27,.06)` | `rgba(255,255,255,.06)` | `rgba(255,255,255,.07)` |
| `--border` | `rgba(24,24,27,.10)` | `rgba(255,255,255,.10)` | `rgba(255,255,255,.11)` |
| `--border-strong` | `rgba(24,24,27,.18)` | `rgba(255,255,255,.18)` | `rgba(255,255,255,.20)` |
| `--state-hover` | `rgba(24,24,27,.05)` | `rgba(255,255,255,.06)` | `rgba(255,255,255,.07)` |
| `--state-active` | `rgba(24,24,27,.08)` | `rgba(255,255,255,.10)` | `rgba(255,255,255,.11)` |
| `--state-selected` | accent-solid @ .10 | @ .16 | @ .18 |
| `--text-selection` | accent-solid @ .20 | @ .32 | @ .36 |
| `--scrim` | `rgba(9,9,11,.32)` | `rgba(0,0,0,.56)` | `rgba(0,0,0,.64)` |

Alpha-of-accent values are computed as `color-mix(in oklab, var(--accent-solid) N%, transparent)`.

Layering rules:
- **Light:** the sidebar sits on `--bg-window` and the canvas on white.
- **Dark:** the sidebar is darker than the canvas.
- **Separator:** a 1px `--border-subtle` line always runs between the sidebar and the canvas. It becomes `--border` when vibrancy is on.

With `data-contrast="more"`:
- `--border*` alphas are set to .24.
- Tertiary text maps to the secondary value.
- Glass is turned off.
- Focus rings are 3px.

### 3.2 Accents

Each accent defines seven tokens: `--accent-solid`, `--accent-solid-hover`, `--accent-contrast`, `--accent-text`, `--accent-soft`, `--accent-border` and `--accent-ring`.

| Accent | Theme | solid | solid-hover | contrast | text | soft | border | ring |
|---|---|---|---|---|---|---|---|---|
| iris | L | `#5E5CE6` | `#4F4DD4` | `#FFFFFF` | `#4B49C8` | `rgba(94,92,230,.10)` | `rgba(94,92,230,.36)` | `#5E5CE6` |
| iris | D | `#5E5CE6` | `#6E6CF0` | `#FFFFFF` | `#A5A4FF` | `rgba(125,123,245,.16)` | `rgba(125,123,245,.45)` | `#8B8AF8` |
| ocean | L | `#0B6BDF` | `#095DC4` | `#FFFFFF` | `#0A5FC7` | `rgba(11,107,223,.10)` | `rgba(11,107,223,.36)` | `#0B6BDF` |
| ocean | D | `#0B6BDF` | `#1E7CF0` | `#FFFFFF` | `#6CB4FF` | `rgba(56,150,255,.16)` | `rgba(56,150,255,.45)` | `#4DA2FF` |
| jade | L | `#0C7D56` | `#0A6C4A` | `#FFFFFF` | `#0B7550` | `rgba(12,125,86,.10)` | `rgba(12,125,86,.36)` | `#0C7D56` |
| jade | D | `#0C7D56` | `#0F9065` | `#FFFFFF` | `#4FD8A0` | `rgba(61,214,140,.14)` | `rgba(61,214,140,.42)` | `#3DD68C` |
| amber | L | `#F5A524` | `#E69512` | `#1C1400` | `#A15C00` | `rgba(245,165,36,.14)` | `rgba(196,120,0,.40)` | `#B56A00` |
| amber | D | `#F5A524` | `#FFB53D` | `#1C1400` | `#FFC65C` | `rgba(245,165,36,.16)` | `rgba(245,165,36,.45)` | `#F5A524` |
| ruby | L | `#CC3344` | `#B52B3B` | `#FFFFFF` | `#B4232F` | `rgba(204,51,68,.10)` | `rgba(204,51,68,.36)` | `#CC3344` |
| ruby | D | `#CC3344` | `#DB4555` | `#FFFFFF` | `#FF8A94` | `rgba(255,99,105,.16)` | `rgba(255,99,105,.45)` | `#FF6B76` |
| orchid | L | `#A93BBD` | `#9531A8` | `#FFFFFF` | `#9A2DAE` | `rgba(169,59,189,.10)` | `rgba(169,59,189,.36)` | `#A93BBD` |
| orchid | D | `#A93BBD` | `#BA4BCE` | `#FFFFFF` | `#E79BF5` | `rgba(220,130,240,.16)` | `rgba(220,130,240,.45)` | `#D985EE` |
| graphite | L | `#18181B` | `#2A2A2F` | `#FFFFFF` | `#18181B` | `rgba(24,24,27,.07)` | `rgba(24,24,27,.30)` | `#18181B` |
| graphite | D | `#EDEDF0` | `#FFFFFF` | `#09090B` | `#EDEDF0` | `rgba(255,255,255,.10)` | `rgba(255,255,255,.36)` | `#EDEDF0` |

Midnight uses the Dark column.

Changing the accent transitions `background-color, border-color, color, fill, stroke` over 240ms with `--ease-out`.

### 3.3 Semantic and finance colours

| Token | Light | Dark/Midnight |
|---|---|---|
| `--gain` (fill/line) | `#12A150` | `#3DD68C` |
| `--gain-text` | `#0B7F45` | `#3DD68C` |
| `--gain-soft` | `rgba(18,161,80,.10)` | `rgba(61,214,140,.14)` |
| `--loss` | `#E5484D` | `#FF6B6B` |
| `--loss-text` | `#C9302C` | `#FF6B6B` |
| `--loss-soft` | `rgba(229,72,77,.10)` | `rgba(255,107,107,.14)` |
| `--warning` / `--warning-text` / `--warning-soft` | `#F5A524` / `#A15C00` / `rgba(245,165,36,.14)` | `#FFC65C` / `#FFC65C` / `rgba(245,165,36,.16)` |
| `--info` / `--info-text` / `--info-soft` | `#3B82F6` / `#1F6FD1` / `rgba(59,130,246,.10)` | `#6CB4FF` / `#6CB4FF` / `rgba(108,180,255,.14)` |
| `--success*` | same as gain | same as gain |
| `--danger*` | same as loss | same as loss |

The `data-numbers` attribute changes how gain and loss are coloured:

| Value | Effect |
|---|---|
| `cvd` | gain `#1F77E5` (dark `#5AA9FF`), loss `#E8740C` (dark `#FF9F45`) |
| `eastasian` | gain and loss tokens are swapped |
| `mono` | gain and loss both use `--text-primary` |

Gain and loss always render with a sign (`+`, or U+2212 `−`) and an `arrow-up-right` or `arrow-down-right` icon.

### 3.4 Block / tag colours

Use these values for text colour, background highlight, select tags, callouts and calendar chips.

| Name | Light text | Light bg | Dark text | Dark bg |
|---|---|---|---|---|
| default | `--text-primary` | transparent | `--text-primary` | transparent |
| gray | `#6F6E69` | `#F1F1F0` | `#A3A3A3` | `#26262A` |
| brown | `#8A5A3F` | `#F5EEEA` | `#BA8B6E` | `#2E2621` |
| orange | `#B85A00` | `#FCEBDC` | `#F0954A` | `#36261A` |
| yellow | `#9A6700` | `#FBF3D9` | `#E6BE58` | `#342D18` |
| green | `#2F7A4F` | `#EAF4EC` | `#5FB98A` | `#1C2E24` |
| blue | `#1F6FA8` | `#E6F1F9` | `#5AA7E0` | `#182A38` |
| purple | `#7E4FA8` | `#F3EEF9` | `#B28BDE` | `#2A2236` |
| pink | `#B03A78` | `#FBEEF4` | `#E07FB2` | `#33202B` |
| red | `#C23B36` | `#FDECEC` | `#F07A72` | `#3A2022` |

Token names follow the pattern `--block-{name}-text` and `--block-{name}-bg`. Stored documents reference colours by name only, never by hex.

### 3.5 Data-visualisation palettes

**Categorical palette.** Assign colours in this order. A category's colour index is `fnv1a(categoryId) % 8`; on a collision, take the next free index.

| # | Light | Dark |
|---|---|---|
| 1 iris | `#5E5CE6` | `#7D7BF5` |
| 2 sky | `#0EA5E9` | `#38BDF8` |
| 3 teal | `#14B8A6` | `#2DD4BF` |
| 4 amber | `#F59E0B` | `#FBBF24` |
| 5 pink | `#EC4899` | `#F472B6` |
| 6 violet | `#A855F7` | `#C084FC` |
| 7 lime | `#65A30D` | `#A3E635` |
| 8 orange | `#EA580C` | `#FB923C` |
| other | `#A1A1AA` | `#71717A` |

When there are more than 8 categories, show the top 7 and group the rest as "Other".

**Sequential palette.** Accent at alpha .12, .28, .48, .70 and 1.00 over `--bg-surface-1`. A zero value uses `--bg-surface-2`.

**Diverging palette.** Loss at alpha 1.00, .60, .30, then `--bg-surface-2` at the midpoint, then gain at alpha .30, .60, 1.00.

### 3.6 Typography

**Font families**

| Role | Family | Package |
|---|---|---|
| UI, default page | Inter Variable (opsz) | `@fontsource-variable/inter` |
| Serif page font | Newsreader Variable | `@fontsource-variable/newsreader` |
| Mono, code, IDs | JetBrains Mono Variable | `@fontsource-variable/jetbrains-mono` |
| "Readable" option | Atkinson Hyperlegible Next | `@fontsource/atkinson-hyperlegible-next` |

**Loading and rendering**
- Fonts are bundled locally only. Load the latin and latin-ext subsets, with a total woff2 budget of 450 KB.
- Inter uses `font-display: block`. All other fonts use `swap`.
- Inter feature settings: `"cv05" 1, "cv08" 1, "calt" 1`. Use `font-optical-sizing: auto`.
- Every number uses `font-variant-numeric: tabular-nums`. IDs and account numbers also get `slashed-zero`.
- On macOS in dark themes, set `-webkit-font-smoothing: antialiased`.

**Type scale.** Sizes are in rem, where 1rem equals the UI base.

| Token | Size/LH | Weight | Tracking |
|---|---|---|---|
| `display` | 40/48 | 700 | −0.022em |
| `kpi-xl` | 44/48 | 600 | −0.024em |
| `h1` | 30/38 | 650 | −0.021em |
| `kpi` | 28/32 | 600 | −0.020em |
| `h2` | 24/32 | 620 | −0.019em |
| `h3` | 20/28 | 600 | −0.017em |
| `title` | 17/24 | 600 | −0.013em |
| `body-lg` (editor) | 16/26 | 400 | −0.011em |
| `body` | 14/20 | 400 (labels 500) | −0.006em |
| `body-sm` | 13/18 | 400/500 | −0.003em |
| `caption` | 12/16 | 500 | 0 |
| `micro` | 11/14 | 600, uppercase | +0.040em |
| `mono` | 13/20 (code blocks 13.5/21) | 450 | 0 |

**Text size setting.** The setting sets `html { font-size }`:

| Option | UI base | Editor body |
|---|---|---|
| Small | 13px | 15 |
| Default | 14px | 16 |
| Large | 15px | 17.5 |

**Zoom and measure**
- Zoom ranges from 80% to 150% in 10% steps (`⌘+`, `⌘−`, `⌘0`), applied through webview zoom.
- The editor column is at most 720px wide.
- The per-page "small text" option sets the editor body to 14/22.

### 3.7 Spacing, sizes, radii, z-index, breakpoints

**Spacing scale (px):** `0 2 4 6 8 10 12 16 20 24 32 40 48 64 80 96 128`. Tailwind `--spacing: 4px`.

**Control heights:** xs 24 · sm 28 · md 32 (default) · lg 40 · xl 48.

**Density.** Compact mode subtracts 4px from:
- sidebar rows: 28 → 24
- table rows: 36 → 32
- menu items: 32 → 28
- card padding: 16 → 12

The minimum pointer target is 24×24 in every density.

**Radii**

| Token | Value |
|---|---|
| `xs` | 4 |
| `sm` | 6 |
| `md` | 8 |
| `lg` | 10 |
| `xl` | 14 |
| `2xl` | 20 |
| `full` | 9999 |

Heatmap cells use a radius of 3. A nested element's radius is the outer radius minus the padding between them, with a minimum of 4.

**Z-index**

| Layer | z |
|---|---|
| base | 0 |
| sticky | 10 |
| sidebar peek | 20 |
| top bar | 30 |
| menu/popover | 40 |
| scrim | 50 |
| dialog/sheet | 60 |
| popover-in-dialog | 70 |
| toast | 80 |
| tooltip | 90 |
| drag ghost | 95 |
| lock screen | 100 |

**Breakpoints (window width)**

| Name | Width | Behaviour |
|---|---|---|
| compact | < 900 | The sidebar becomes a hover-peek overlay and the right panel becomes a sheet. Editor padding 24. |
| medium | 900–1279 | Editor padding 48. |
| wide | 1280–1679 | Editor padding 96. |
| ultra | ≥ 1680 | Dashboards use a 12-column grid with 4 KPI tiles per row. |

### 3.8 Elevation and glass

**Shadow tokens.** In the light theme, `--ink: 16,16,24`.

```css
--elev-1: 0 0 0 1px rgba(var(--ink),.06), 0 1px 2px rgba(var(--ink),.04), 0 1px 1px rgba(var(--ink),.03);
--elev-2: 0 0 0 1px rgba(var(--ink),.06), 0 4px 8px -2px rgba(var(--ink),.08), 0 12px 24px -6px rgba(var(--ink),.10);
--elev-3: 0 0 0 1px rgba(var(--ink),.06), 0 8px 16px -4px rgba(var(--ink),.10), 0 24px 48px -12px rgba(var(--ink),.18);
--elev-4: 0 0 0 1px rgba(var(--ink),.06), 0 16px 32px -8px rgba(var(--ink),.14), 0 40px 80px -16px rgba(var(--ink),.24);
/* dark + midnight */
--elev-1: 0 0 0 1px rgba(255,255,255,.06), inset 0 1px 0 rgba(255,255,255,.03), 0 1px 2px rgba(0,0,0,.40);
--elev-2: 0 0 0 1px rgba(255,255,255,.08), inset 0 1px 0 rgba(255,255,255,.05), 0 8px 24px -6px rgba(0,0,0,.55);
--elev-3: 0 0 0 1px rgba(255,255,255,.09), inset 0 1px 0 rgba(255,255,255,.06), 0 24px 56px -12px rgba(0,0,0,.65);
--elev-4: 0 0 0 1px rgba(255,255,255,.10), inset 0 1px 0 rgba(255,255,255,.06), 0 40px 80px -16px rgba(0,0,0,.75);
--elev-primary-btn: inset 0 1px 0 rgba(255,255,255,.16), 0 1px 2px rgba(0,0,0,.14);
```

**Usage**
- elev-1: cards and tiles.
- elev-2: menus, popovers and hovered cards.
- elev-3: dialogs, the palette and the side peek.
- elev-4: drag ghosts and toasts.

**Glass is allowed only on these surfaces:**
- **Sidebar on macOS:** `NSVisualEffectMaterial::Sidebar` via the `window-vibrancy` crate. The window is `transparent: true`. CSS background is transparent with an 8% `--bg-window` tint.
- **Sidebar on Windows 11:** Mica.
- **Top bar, once scrolled past 8px:** `background: color-mix(in oklab, var(--bg-canvas) 72%, transparent); backdrop-filter: blur(16px) saturate(180%)`.
- **Command palette:** `--bg-overlay` at 86% with `blur(24px) saturate(180%)`.
- **Dialog scrim:** `blur(2px)`.

**Glass constraints**
- At most 2 `backdrop-filter` layers may be on screen at once.
- Never apply glass to scrolling lists.
- Glass is disabled on Linux, under `data-effects="reduced"`, under `data-contrast="more"`, and when the OS requests reduced transparency. The `app_info.features` field includes `reduced-transparency` in that last case.
- Menus, popovers, tooltips and toasts are always opaque.

**Aurora.** Used only on onboarding, the lock screen, empty-state heroes and the about page.

```css
background:
  radial-gradient(60% 50% at 20% 10%, color-mix(in oklab, var(--accent-solid) 38%, transparent), transparent 70%),
  radial-gradient(50% 45% at 85% 25%, color-mix(in oklab, #A855F7 26%, transparent), transparent 70%),
  radial-gradient(70% 60% at 50% 100%, color-mix(in oklab, #0EA5E9 18%, transparent), transparent 70%),
  var(--bg-window);
```

Overlay grain from `src/assets/grain.png` (128×128, ≤ 6 KB) at 2.5% opacity. With Full motion the grain drifts at 0.3px/s.

### 3.9 Boot without flash
- `index.html` contains one inline script, allowed by a CSP sha256 hash. Before first paint it reads `localStorage['emp.boot']` and sets the `data-*` attributes.
- The Tauri window is created with `visible: false` and `backgroundColor` set to the theme's `--bg-window`. The frontend calls `getCurrentWindow().show()` after its first `requestAnimationFrame`.

---

## 4. Motion spec

### 4.1 Tokens (`src/ui/motion/tokens.ts`)

```ts
export const duration = { instant: 0, micro: 0.08, fast: 0.12, base: 0.16, moderate: 0.22, slow: 0.32, deliberate: 0.48, chart: 0.70 } as const;
export const ease = {
  out: [0.2, 0, 0, 1], outExpo: [0.16, 1, 0.3, 1], in: [0.4, 0, 1, 1],
  inOut: [0.65, 0, 0.35, 1], linear: [0, 0, 1, 1],
} as const;
export const spring = {
  snappy: { type: "spring", stiffness: 600, damping: 35, mass: 0.6 }, // press, toggles, checkbox (~180ms)
  ui:     { type: "spring", stiffness: 420, damping: 36, mass: 1 },   // indicators, sidebar, toasts (~220ms)
  gentle: { type: "spring", stiffness: 260, damping: 30, mass: 1 },   // dialogs, sheets, cards entering (~270ms)
  layout: { type: "spring", stiffness: 500, damping: 40, mass: 1 },   // reorder, layout shifts (~200ms)
  bouncy: { type: "spring", stiffness: 400, damping: 22, mass: 1 },   // celebrations ONLY
  drag:   { type: "spring", stiffness: 300, damping: 28, mass: 1 },   // drag release with velocity
} as const;
```

**CSS mirrors**

```css
--dur-micro: 80ms; --dur-fast: 120ms; --dur-base: 160ms; --dur-moderate: 220ms; --dur-slow: 320ms;
--ease-out: cubic-bezier(.2,0,0,1); --ease-out-expo: cubic-bezier(.16,1,.3,1);
--ease-in: cubic-bezier(.4,0,1,1); --ease-in-out: cubic-bezier(.65,0,.35,1);
--ease-spring-ui: linear(0,.157,.48,.74,.89,.963,.993,1.003,1.004,1.001,1); /* 260ms; fallback --ease-out-expo */
```

**Rules**
- Exits run about 30% shorter than entries and use `ease.in`.
- Hover-in takes 120ms and hover-out takes 160ms.
- Nothing in a work flow may animate for more than 320ms. The exceptions are chart entry (700ms) and onboarding (480ms).
- Wrap the app in `LazyMotion features={domAnimation}` and use only `m.*` components.

### 4.2 Interaction map (exact)

| Interaction | Animation | Timing |
|---|---|---|
| Hover on button or row | Colour only | 120ms in / 160ms out, `ease.out` |
| Hover on interactive card | `y -1`, elev-1→elev-2 via pseudo-element opacity | 160ms `ease.out` |
| Press on md/lg/xl button | Scale 0.97 on `pointerdown` | `spring.snappy` |
| Press on icon, xs or sm button | Scale 0.92 | `spring.snappy` |
| Press on card or choice card | Scale 0.985 | `spring.snappy` |
| Switch | Thumb travels 14px and stretches 14→18 while pressed; track crossfades over 150ms | `spring.snappy` |
| Checkbox | Fill 100ms; check `pathLength 0→1` | 180ms `ease.out` |
| To-do checked | Box scale 0.85→1 (`spring.bouncy`); strike line `scaleX 0→1` from the left over 220ms; text goes to tertiary over 220ms | |
| Radio | Dot scale 0→1 | `spring.snappy` |
| Tabs and segmented indicator | Shared `layoutId` | `spring.ui` |
| Menu, popover or select open | Opacity 0→1, scale 0.96→1, `y ∓4→0`, origin at the trigger | 160ms `ease.outExpo` |
| Menu close | Opacity→0, scale→0.98 | 100ms `ease.in` |
| Submenu | `x -4→0`, opacity | 120ms `ease.outExpo`; 100ms hover intent with a safe triangle |
| Tooltip | Opacity, scale 0.97→1 | In 120ms, out 80ms. Delay 500ms, then 0ms for 300ms after the last tooltip closes. |
| Dialog | Scrim 180ms; panel opacity, scale 0.96→1, `y 8→0` | `spring.gentle`; exit 140ms `ease.in` to scale 0.98 |
| Sheet or side peek | `x 100%→0` | `spring.gentle`; exit 180ms `ease.in` |
| Command palette | Scrim 120ms; panel scale 0.98→1 over 150ms `ease.outExpo`; list height follows `--cmdk-list-height` | 150ms `ease.out` |
| Toast enter | `y 16→0`, scale 0.96→1 | `spring.ui` |
| Toast exit | `x +24`, opacity→0 | 160ms `ease.in`; swipe-dismiss uses `spring.drag` at 45% width or 0.11 px/ms |
| Toast stack | Card n behind: `y −8n`, scale `1−0.05n`, opacity `1−0.2n`. On hover the stack expands with 8px gaps. | `spring.ui` |
| Page navigate | Out: opacity→0, 80ms `ease.in`. In: opacity 0→1, `y 6→0`, 200ms `ease.out`. Skipped if the target renders in under 16ms. | |
| Sidebar collapse/expand | Sidebar `x 0↔−100%`; content opacity changes over the first 60% of travel; main pane uses `layout="position"` | `spring.ui` |
| Sidebar hover-peek | Pointer in the left 8px for 120ms brings in a floating sidebar (elev-3). It leaves 300ms after the pointer exits. | `spring.ui` |
| Tree expand | Chevron rotates 0→90° over 160ms; children animate `height auto` + opacity over 200ms (instant if more than 40 children) | `ease.out` |
| Toggle block | `height 0→auto`, opacity | 200ms `ease.out` |
| DnD lift | Scale 1.02, elev-4, `rotate 1.5°` (board cards only) | `spring.snappy`; siblings `spring.layout`; drop `spring.drag` |
| Drop indicator | 2px accent line with a 6px circle cap; 24px indent per level | Appears within 80ms |
| Block handle | Opacity 0→1 after a 60ms hover rest | 120ms |
| Skeleton → content | Crossfade | 160ms `ease.out` |
| KPI number change | Rolling digits, each column `translateY`, staggered 20ms from the right | `spring.ui` |
| KPI first mount | Count-up from 0 or the cached value; skipped if the value is under 10 | 600ms `ease.outExpo` |
| Live price tick | Background flash of gain/loss soft at .24 fading to 0; at most once per second per symbol | 900ms `ease.out` |
| Chart range change | Path morph after resampling to equal point counts | 400ms `ease.inOut` |
| Wrong password | `x: [0,−8,8,−6,6,−3,3,0]` | 400ms `ease.out` |
| Unlock success | Lock card scale 1→0.96 and opacity→0; app scale 1.02→1, opacity 0→1, blur 12→0 | 320ms `ease.out` |
| Theme switch | View Transitions circular reveal from the toggle centre | 420ms `ease.inOut`; 200ms crossfade fallback |
| Celebration | 10 particles bursting radially 40–80px plus a check badge scale 0→1 (`spring.bouncy`) | 600ms; can be turned off in Settings → Celebrations |
| Life-app generation | Generated items fly into the sidebar staggered 40ms; KPI tiles count up; charts draw in | See §6.5 |
| Focus ring | Appears instantly, never animated | 0 |

### 4.3 Reduced motion
- Settings → Accessibility → Motion offers **System** (the default), **Reduced** and **Full**. Map these to motion's `MotionConfig reducedMotion` values `"user"`, `"always"` and `"never"` respectively, and mirror the resolved state in `html[data-motion]`.
- In reduced mode, the following are removed:
  - Every transform: scale, translate, rotate and height.
  - Shimmer.
  - Count-ups and rolling digits.
  - Price flashes.
  - Confetti and celebration particles.
  - Grain drift.
  - The circular theme-reveal transition.
  - Chart draw-in.
- Remaining motion is an opacity crossfade of 120ms or less. Press feedback becomes a background-colour change.
- These still apply in reduced mode: colour and state changes, focus rings, instant progress values, and spinner rotation.

### 4.4 Animation performance rules
- Animate only `transform` and `opacity`. Animating `clip-path` or `filter` is allowed only where §4.2 lists it.
- Never animate `width`, `height`, `top`, `left`, `box-shadow` or `backdrop-filter` frame by frame. Two exceptions:
  - accordion `height: auto` on contained subtrees
  - FLIP layout transitions
- JavaScript must use no more than 4ms per animation frame.
- Set `will-change` only while an animation is running.
- Apply `contain: layout paint style` to the sidebar, the top bar, dashboard tiles and table row groups.
- Editor blocks get `content-visibility: auto; contain-intrinsic-size: auto 2.5em` when the page has more than 300 blocks.
- Virtualise any list longer than 100 items with `@tanstack/react-virtual`, using an overscan of 8.
- Turn on `data-effects="reduced"` in these cases:
  - by default on Linux
  - automatically when more than 10% of frames drop over a 5s window
  - whenever the user chooses it

  Reduced effects means no glass, shadows capped at elev-2, and no particles.

---

## 5. Component spec

Every primitive lives in `src/ui/`. Radix provides the headless behaviour and this section defines the skin.

Every interactive component implements these states:
- default
- hover
- pressed
- focus-visible
- disabled
- loading (where relevant)
- selected/checked (where relevant)
- error (inputs)

### 5.1 Button

| Size | H | Pad-x | Font | Icon | Gap | Radius |
|---|---|---|---|---|---|---|
| xs | 24 | 8 | 12/16 500 | 14 | 4 | 6 |
| sm | 28 | 10 | 13/18 500 | 14 | 6 | 6 |
| md | 32 | 12 | 14/20 500 | 16 | 6 | 8 |
| lg | 40 | 16 | 15/20 550 | 18 | 8 | 10 |
| xl | 48 | 20 | 16/24 600 | 20 | 8 | 12 |

- Icon-only buttons are square.
- A leading icon reduces padding-left by 2px.

**Variants**

- **primary**
  - Background `--accent-solid`, text `--accent-contrast`.
  - Border 1px `rgba(0,0,0,.08)` in light themes, `rgba(255,255,255,.10)` in dark themes.
  - Shadow `--elev-primary-btn`.
  - Hover: `--accent-solid-hover`.
  - Pressed: `color-mix(in oklab, var(--accent-solid-hover) 92%, black)`.
- **secondary**
  - Background `--bg-surface-1` in light themes, `rgba(255,255,255,.04)` in dark themes.
  - Border 1px `--border`, plus elev-1 in light themes.
  - Hover: border `--border-strong` plus a `--state-hover` overlay.
  - Pressed: `--state-active`.
- **ghost**
  - Transparent, with secondary text.
  - Hover: `--state-hover` and primary text.
  - Pressed: `--state-active`.
- **soft**
  - Background `--accent-soft`, text `--accent-text`.
  - Hover: 1.6× the soft alpha.
  - Pressed: 2× the soft alpha.
- **destructive**
  - Fill `#C9302C` in light themes, `#E5484D` in dark themes.
  - White text, weight 600.
- **destructive-ghost**
  - Loss-text colour.
  - Hover: `--loss-soft`.
- **link**
  - Accent text.
  - Hover: underline 1px at offset 3px.
  - Uses the pointer cursor. Every other control uses the default arrow.

**Focus-visible.** 2px `--accent-ring` outline at a 2px offset.

**Disabled.** Opacity .45 and `pointer-events: none`. Wrap the button in a span so a tooltip can still explain why it is disabled.

**Loading.**
- The label goes to opacity 0 while keeping its width.
- A 16px spinner fades in at 120ms.
- Set `aria-busy`.
- Ignore clicks.

**Success morph (`successFeedback`).** The label crossfades to a `check` icon whose path draws in over 280ms. Hold for 1200ms, then crossfade back.

**Trailing `Kbd` hint.** Uses tertiary colour. On primary buttons it uses `--accent-contrast` at 70%.

### 5.2 Inputs

**Size and rest state**
- Heights: 28, 32 (default) and 40.
- Horizontal padding: 10px (8px for sm, 12px for lg).
- Radius: 8px (10px for lg).
- Background: `--bg-surface-1` in light mode, `rgba(255,255,255,.03)` in dark mode.
- Border: 1px `--border`.

**States**
- **Hover:** border changes to `--border-strong`.
- **Focus:** border changes to `--accent-solid` and adds a ring `0 0 0 3px color-mix(in oklab, var(--accent-solid) 22%, transparent)`, transitioning over 120ms.
- **Error:** border changes to `--loss` with the ring at 20%. Helper text shows in loss-text with a 14px `alert-circle` icon. Set `aria-invalid` and `aria-describedby`.
- **Disabled:** background `--bg-surface-2`.
- **Read-only:** no border, background `--bg-surface-2`.

**Labels and helper text**
- Label: 12/16, weight 500, secondary colour, 6px above the field.
- Helper text: 12/16, tertiary colour, 6px below the field.
- Mark required fields with the word "Required".

**Slots**
- Leading icon: 16px, tertiary colour, 8px gap.
- Prefix and suffix text: tertiary colour.
- Clear button: an xs ghost button that appears on hover or focus when the field has a value.

**Field variants**
- **NumberField and MoneyField**
  - Right-aligned, tabular figures.
  - Arrow keys step ±1. Shift steps ±10, Alt steps ±0.1.
  - Expressions starting with `=` are evaluated on blur by the `sheet_eval` engine in scalar mode. Show the result as a ghost "= 100.00" for 800ms, then commit it.
  - Format by locale on blur. Show the raw value while editing.
- **Secret field**
  - Masked by default, with an eye toggle that crossfades over 120ms.
  - `autocomplete="off"` and `spellcheck=false`.
- **Textarea:** grows automatically from 3 to 12 rows.
- **Search field:** leading `search` icon and a trailing `⌘K` Kbd that hides on focus.

### 5.3 Select, combobox, tags
- The trigger looks like an input with a trailing `chevrons-up-down` icon (14px).
- The list uses the menu skin (§5.6). Its width matches the trigger, with a minimum of 200.
- Typeahead filtering turns on above 8 options. A "Create '…'" row appears at the bottom.
- **Tag pill**: height 20, horizontal padding 6, radius 4, text 12/16 weight 500, colours from §3.4.
  - Shows a 12px remove `x` on hover inside editors.
  - New tags take the next colour in a seeded rotation.

### 5.4 Checkbox, radio, switch, slider
- **Checkbox**
  - 16×16, radius 4, 1.5px `--border-strong` border.
  - Checked: `--accent-solid` fill with a 10px check at stroke 2.25.
  - Indeterminate: an 8×1.75 bar.
  - Hit area: 24×24.
- **Radio**
  - 16px, 1.5px border.
  - Checked: `--accent-solid` fill with a 6px dot in `--accent-contrast`.
- **Switch**

  | Size | Track | Thumb | Inset | Travel |
  |---|---|---|---|---|
  | sm | 26×16 | 12 | 2 | 10 |
  | md | 32×18 | 14 | 2 | 14 |

  - Track off: `--bg-surface-3` in light mode, `rgba(255,255,255,.16)` in dark mode.
  - Track on: `--accent-solid`.
  - Thumb: white, with shadow `0 1px 2px rgba(0,0,0,.2), 0 0 0 .5px rgba(0,0,0,.04)`.
- **Slider**
  - Track 4px, `--bg-surface-3`, accent fill.
  - Thumb 16px, white, 1px `--border-strong`, elev-1. Scales to 1.15 while dragging.
  - Shows a value tooltip above the thumb.

### 5.5 Segmented control and tabs
- **Segmented control**
  - Track: height 32 (sm 28), padding 2, radius 8, `--bg-surface-2`.
  - Items: minimum width 56, horizontal padding 12, radius 6, text 13 weight 500, secondary colour. The selected item uses primary colour.
  - Indicator: `--bg-surface-1` in light mode, `rgba(255,255,255,.10)` in dark mode, elev-1, radius 6, `spring.ui`.
  - Uses `role="radiogroup"`.
- **Underline tabs**
  - Height 36, gap 4, horizontal padding 10, radius 6 (hover shows `--state-hover`).
  - Text 14 weight 500.
  - Indicator: a 2px `--text-primary` bar over a 1px `--border-subtle` baseline.
- **Database view tabs**: underline tabs plus a 14px view icon. Overflowing tabs collapse into "N more".

### 5.6 Menus (dropdown, context, slash, mention)
- **Panel**
  - Width 220–320, max height `min(480px,70vh)`.
  - Padding 4, radius 10, `--bg-overlay`, elev-2.
  - 6px offset from the trigger. Uses floating-ui `flip` and `shift`.
- **Item**
  - Height 32 (compact 28), horizontal padding 8, radius 6, gap 8.
  - Icon 16px, tertiary colour.
  - Label 14 (compact 13).
  - Trailing `Kbd` in tertiary at 12.
  - Highlight is instant (`--state-hover`) and follows whichever input was used last.
  - Destructive items use loss-text colour with a loss-soft highlight.
  - Checked items show a trailing 14px check in the accent colour.
- **Section header**: micro style, tertiary colour, padding 8 8 4.
- **Separator**: 1px `--border-subtle`, margin 4px with −4px horizontal bleed.
- **Slash menu**
  - Width 320.
  - Items are 44px tall with a 32px icon tile (radius 6, `--bg-surface-2`, 18px icon), a title (14 weight 500) and a description (12, tertiary).
  - Groups, in order: Basic, Media, Database, EMP, Advanced, Inline.
  - Fuzzy matching renders matched characters at weight 600.
  - Recently used items appear first.
  - The menu closes after 3 keystrokes with no match, or after a space following them.

### 5.7 Popover, tooltip, dialog, sheet, toast
- **Popover**
  - Padding 12 (16 for forms), radius 10, elev-2, max width 360, offset 6.
  - Closes on outside click, Esc, or blur to outside.
- **Tooltip**
  - Light theme: `#18181B` background with white text.
  - Dark theme: `#2A2A30` background, 1px `rgba(255,255,255,.10)` border, `#EDEDF0` text.
  - Text 12/16 weight 500, padding 5×8, radius 6, max width 240.
  - Opens on focus as well as hover.
- **Dialog**
  - Widths: sm 400, md 560, lg 720, xl 960, full `min(1200, 100vw−64) × min(840, 100vh−64)`.
  - Radius 14, elev-3, positioned 12vh from the top. Alert dialogs are centred.
  - Header padding 20 24 0. Title 17/24 weight 600. Description 14/20 secondary.
  - Body padding 16 24. Footer padding 16 24 20, buttons right-aligned with an 8px gap.
  - Initial focus goes to the first input. In a destructive dialog it goes to Cancel.
  - Irreversible actions (deleting a workspace, disabling encryption, unencrypted export) require typing a confirmation.
- **Sheet**
  - Opens from the right, 480 wide (720 for wizards).
  - Inset 8, radius 14 on the left corners.
- **Toast**
  - Position: bottom-right with a 16px inset (bottom-centre below 900px).
  - Width 360, radius 12, `--bg-overlay`, elev-4, padding 12 14.
  - Duration by type:

    | Type | Duration |
    |---|---|
    | info | 4000ms |
    | success | 3000ms |
    | warning | 6000ms |
    | error | 8000ms |
    | any toast with an action | ≥ 6000ms, with a 2px progress line |

  - Pauses on hover, on focus within, and when the window loses focus.
  - At most 3 visible at once.
  - Uses `role="status"` (errors use `role="alert"`).
  - `⌘⇧.` focuses the newest toast.
  - **Clipboard toast**: "Clipboard clears in 30s" with a live countdown and a "Clear now" action.

### 5.8 Sidebar
- **Width and resizing**
  - Default width 248, resizable from 200 to 420 with a 6px handle.
  - A 1px accent line appears on the handle after 150ms of hover. Double-click resets the width.
- **Collapsing**: `⌘\` collapses the sidebar.
- **Structure, top to bottom**
  1. macOS traffic-light zone: 52px top padding, lights at x 16, y 18, acts as a drag region. Shrinks to 12px in fullscreen.
  2. Workspace row (44px): a 22px avatar at radius 6, the name at 14 weight 600, `chevrons-up-down`, and a lock-state icon. The New page icon button (`⌘N`) sits on the right.
  3. Primary rows (28px): Search `⌘K`, Home, Today, Inbox (P1, hidden in v1), Settings.
  4. Favorites.
  5. Life Apps, each with an 18px identity tile at radius 5.
  6. Pages.
  7. Bottom group: Templates, Import, Trash.
  8. Footer (40px): status dot with text such as "Local · Encrypted" or "Local · Not encrypted", the Hide numbers toggle, the offline toggle, and help.
- **Section headers**: micro style, tertiary colour, 28px tall. A `+` appears on hover, and the header can collapse its section.
- **Rows**
  - Height 28 (compact 24), horizontal padding 8, radius 6, gap 6.
  - A 16px chevron shows on hover when the row has children. Icon 18px. Label 13/18 weight 500, secondary colour.
  - Indent 12px per level, capped at 8 levels.
  - Hover: `--state-hover`, plus `…` and `+` buttons (20×20).
  - Selected: `--state-active` with the label at weight 550 in primary colour.
  - Drop target: `--state-selected` with a 1px inset accent border.
- **Tree semantics**
  - `role="tree"`. Arrow keys navigate, Enter opens, F2 renames, Delete moves to trash with an Undo toast.
  - Database rows never appear in the tree. Databases show their views instead.

### 5.9 Command palette (cmdk)
- **Panel**: width 640, max height 480 (list max 400), positioned 14vh from the top, radius 14, glass per §3.8, elev-3.
- **Input row**
  - Height 52, horizontal padding 16.
  - 20px search icon. Input text 16/24.
  - Trailing scope chip: 22px, radius 6, soft style.
- **Items**: 40px tall (48px with a subtitle), margin-x 6, radius 8, horizontal padding 10, icon 18. Subtitle shows the path at 12, tertiary colour.
- **Footer** (36px): hints `↑↓ Navigate · ↵ Open · ⇧↵ Open in side peek · esc Close`.
- **Prefixes**

  | Prefix | Mode |
  |---|---|
  | (none) | Pages, recent, actions |
  | `>` | Commands |
  | `#` | Tags and databases |
  | `@` | Dates |
  | `$SYM` | Quote row with a 64×20 sparkline and a delta chip |
  | `=` | Calculator with units and currency, shown in a 32/40 tabular row. ↵ copies the result. |
  | `?` | Shortcuts |

- **Empty query** shows Recent (5), Suggested actions (contextual) and Life apps.
- **Ranking**: `score = match × (1 + 0.3·recency + 0.2·frequency + 0.1·favorite)`.

### 5.10 Cards, KPI tile, empty state, skeleton, progress, spinner
- **Card**: radius 14, `--bg-surface-1`, 1px `--border-subtle`, elev-1, padding 16 (compact 12, large 20), header-to-body gap 12.
- **Board card**: radius 10, padding 10, gap 6. Columns are 272 wide with a 12px gap and a 32px header.
- **KPI tile**
  - Minimum 200×112 (128 with a sparkline), radius 14, padding 16.
  - Label: 12/16 weight 500, secondary colour, with an optional 12px info icon.
  - Value: `kpi` style, tabular. The currency symbol renders at 0.7× size, weight 500, secondary colour.
  - Delta chip: 20px tall, horizontal padding 6, full radius, 12/16 weight 600, gain or loss soft background, 12px arrow, followed by "vs last month" in tertiary.
  - Sparkline: 32px tall, stroke 1.5, area gradient .16→0, 4px end dot.
  - Stale data: the value turns secondary and a clock icon appears.
- **Hide numbers (`data-privacy="on"`)**
  - Every `[data-sensitive]` node renders a same-width `•••••` mask.
  - The real value is removed from the accessibility tree.
  - Chart y-axis labels are masked. Chart shapes stay visible.
- **Empty state**
  - Max width 360, vertical padding 48.
  - 48px icon tile: radius 12, `--accent-soft`, 24px icon, with a glow `0 0 0 8px color-mix(in oklab, var(--accent-solid) 6%, transparent)`.
  - Title 15/22 weight 600. Body 14/20 secondary.
  - Life-app contexts show a primary button "Set it up for me" (`sparkles` icon) and a ghost button "Start blank".
- **Skeleton**
  - Fill `rgba(text,.06)` (.07 in dark mode).
  - Shimmer: a 1.6s linear translate.
  - Only shown when loading takes more than 150ms. Once shown, it stays at least 300ms.
- **Progress, linear**: heights 2, 4 and 8, track `rgba(text,.08)`, `scaleX` transition over 300ms.
- **Progress, ring sizes**

  | Diameter | Stroke |
  |---|---|
  | 16 | 2 |
  | 24 | 2.5 |
  | 40 | 3.5 |
  | 64 | 5 |
  | 96 | 7 |

- **Budget progress bar**
  - Below 75%: accent. 75–100%: warning. Over 100%: loss, with the overflow drawn as a second lap at .5.
  - Pace marker: 2×12px in `--text-secondary`, placed at day-of-month ÷ days-in-month.
- **Stepper**: 4px segments with a 4px gap.
- **Spinner**: a 270° arc at stroke 1.5, rotating once every 700ms, linear.

### 5.11 Other primitives
- **Kbd**
  - Height 18, minimum width 18, horizontal padding 4, radius 4.
  - Mono 11/16 weight 500, `--bg-surface-2` background, 1px `--border` with a `--border-strong` bottom edge.
  - macOS shows ⌘⌥⇧⌃. Windows and Linux spell out Ctrl, Alt and Shift.
- **Badge**: 18px, full radius, 11/14 weight 600.
- **Avatar**: sizes 16, 20, 24, 32, 40 and 64. Initials render at 0.42× the size on a hashed block colour.
- **Breadcrumbs**
  - Items 28px tall in ghost-sm style. Separator `/` in tertiary.
  - More than 4 levels collapse the middle into a `…` menu.
- **Banner**: 40px tall, semantic soft background, 1px bottom border at .3 alpha, dismissible.
- **Scrollbars**
  - Overlay style: a 6px thumb that grows to 8px on hover, `rgba(text,.22)`, rising to .36 on hover.
  - Fades out 800ms after scrolling stops.
- **Bubble toolbar**
  - 36px tall, padding 4, radius 10, elev-2, positioned 8px above the selection.
  - Appears after the selection has rested for 150ms.
  - Order: Turn into ▾, B, I, U, S, code, link, colour ▾, `…`.
- **Block handle**: an 18×24 grip plus a 20×24 `+`, placed 24px left of the block.
- **Mention chip**: 1.4em tall, horizontal padding 4, radius 4, `--state-hover` background, 14px icon.
- **Emoji picker**: 352×400, 8-column virtualised grid of 36px cells.
- **Database table grid**
  - Header row 32px. Body rows 36px (compact 32). Cells use 13/18 text with 8px horizontal padding.
  - Numbers are right-aligned and tabular.
  - The active cell gets a 2px inset `--accent-ring`.
  - The header is sticky and shows a `0 1px 0 var(--border)` line once scrolled.
  - The footer row is 32px.
  - Uses `role="grid"`.
- **Sheet grid (canvas)**
  - Column headers 24px tall, row headers 40px wide, both on `--bg-surface-2`. Cells 24px tall.
  - Selection: a 2px accent border with an accent fill at .08 and a 6×6 fill handle.
  - Formula bar 32px tall, in mono 13.
  - Frozen panes are marked by a 2px `--border-strong` line.
- **Calendar view (month)**
  - Cells are at least 112px tall.
  - Today is marked by a 22px accent circle.
  - Event chips are 20px tall at radius 4.
- **File drop zone**
  - 1.5px dashed `--border-strong` border (dash 6, gap 4), radius 14.
  - While a file is dragged over it, the border and background switch to accent / accent-soft.
- **Password strength meter**: 4 segments, each 4px tall with a 4px gap. Score 0–1 shows loss, 2 shows warning, 3–4 shows gain.
- **Choice card**
  - Minimum 160×120, radius 14, padding 16.
  - Selected: a 2px accent inset shadow, `--accent-soft` background, and a 20px check badge that enters with `spring.bouncy`.
  - Recommended options show a ribbon chip.

---

## 6. App shell and key screens

### 6.1 Shell layout
- **Regions**: sidebar (248), top bar (44px tall, drag region), content, and an optional right panel (320, resizable 280–480). The right panel tabs are Outline, Page info and Guide; the Guide tab hosts life-app checklists.
- **Top bar**
  - **Left side**: sidebar toggle (visible only when the sidebar is collapsed), back and forward (`⌘[` / `⌘]`), then breadcrumbs.
  - **Right side**:
    - "Edited 2m ago", shown for 3s after each save
    - Favorite
    - Export menu: PDF, Markdown, HTML (P1), CSV, XLSX
    - Lock indicator. Its tooltip reads "Encrypted · Locks in 12 min · ⌘⇧L to lock now". During the last 60s it becomes a ring countdown.
    - Right-panel toggle
    - `…` page menu
- **Content**: editor padding follows §3.7. Top padding is 64px, or 32px below a cover.
  - The cover is 280px tall (at most 30vh). The 78px icon overlaps the cover by 39px.
  - The title uses the `display` style. Its placeholder, "Untitled", is in disabled text.
- **Editor blocks**
  - Paragraphs: 16/26 with a 2px gap between blocks.
  - Heading top margin: H1 32, H2 24, H3 16. Each heading has 4px below it.
  - Callout: radius 10, padding 16 16 16 12, 20px icon.
  - Quote: 3px left bar in `--text-primary`, padding-left 14, text 18/28.
  - Code: radius 10, `--bg-surface-2`, padding 16.
  - Inline code: 0.875em, padding 2×4, radius 4, background `rgba(text,.07)`.
  - Divider: 1px `--border` with 12px above and below.
  - Multi-block selection: accent at .12 alpha, radius 4.
- **Window chrome**
  - **macOS**: `titleBarStyle: "Overlay"`, `hiddenTitle: true`, traffic lights positioned at (16, 18).
  - **Windows**: `decorations: false` with custom caption buttons, each 46×44 with 10px glyphs.
    - Hover uses `--state-hover`. The close button's hover is `#C42B1C` with a white glyph.
    - Snap layouts work through the maximise button region.
    - Mica is applied on Windows 11.
  - **Linux**: system decorations.

### 6.2 Onboarding
Onboarding shows a full-window aurora behind a centred panel.

**Panel**
- Size 560 wide (720 wide on step 5).
- Corner radius 20.
- Background `--bg-overlay` at 92% with `blur(24px)`.
- Elevation `elev-3`, padding 40.

**Navigation**
- A stepper sits at the top.
- Steps transition by sliding x −24→0, with 160ms out and 240ms in.
- Panel height animates with `spring.gentle`.
- Enter continues. `⌘[` goes back. Esc does nothing.
- On each step, focus moves to that step's heading.

| # | Screen | Exact content and behaviour |
|---|---|---|
| 0 | Launch | Icon glyph layers draw in (stagger 80ms, 480ms `ease.outExpo`), then the "EMP" wordmark fades in (Inter 720, −0.04em). Total ≤ 1.2s. Shown on first run and after updates only. |
| 1 | Welcome | Title "Welcome to EMP". Subtitle "Your notes, money, plans and life admin, in one private place on your device." Primary button (xl) "Get started"; ghost button "Import from Notion, Markdown or CSV". Footer with `shield-check` icon: "Everything stays on this device unless you connect a service." |
| 2 | Make it yours | Name ("What should we call you?"). Theme cards Light / Dark / System (160×100 previews), applied live. 7 accent swatches (28px). Density as a segmented control. Text size S/M/L. |
| 3 | Protect your workspace | Two choice cards. **"Encrypt with a password"** (Recommended, `lock`): "Your data is encrypted with XChaCha20-Poly1305. Without your password or recovery key, nobody, including us, can read it." **"Don't encrypt"** (`lock-open`): "Faster setup. You can turn on encryption later in Settings." |
| 3a | Create password | Password field (xl) with reveal and strength meter. Requires zxcvbn ≥ 3 and ≥ 10 chars. "Generate passphrase" creates 5 EFF-long words joined by a random separator. Confirmation field. Auto-lock choice: 5 / **15** / 30 / 60 min / On sleep only. Continue calls `vault_create`; the button shows loading with "Securing your workspace…" for at least 600ms. |
| 3b | Recovery key | 24 words in a 4×6 grid, mono 18/28, in a well (`--bg-surface-2`, radius 12, padding 20). Buttons: Copy (with the clipboard toast), Save as file…, Print. Warning callout: "Store this somewhere safe. If you lose both your password and this key, your data cannot be recovered." To continue, the user ticks "I've saved my recovery key" and types 3 randomly chosen words (positions shown). "Skip (not recommended)" leaves a "Recovery key not confirmed" status in Security Center. |
| 4 | What should EMP help with? | Multi-select 3×4 grid: Notes & docs, Tasks & projects, Personal finance, Investing, Taxes, Calendar & planning, Health & habits, Home & life admin, Learning, Travel, Career, Spreadsheets. Notes and Tasks are preselected. Live counter "N apps selected". Only the six v1 apps produce installs; the others create a starter page and are marked "More coming". |
| 5 | Quick setup | One sub-step per selected v1 app, at most 3 questions each, each skippable ("Set up later"). The questions are the `quick: true` questions in §16. The right half shows a live preview (KPI row and category list) that crossfades over 160ms. |
| 6 | Connections and updates | Rows for Google (opens the §17.1 explainer sheet), Market data (keyless enabled with a "Delayed data" note; key fields masked), and "Check for updates automatically" (switch, default off; copy: "Contacts github.com once a day. Nothing else is sent."). |
| 7 | Building your workspace | Animated checklist (row stagger 180ms; spinner turns into a drawn check). Each row reflects a real `lifeapp_install` progress event. Total ≥ 180ms per row and ≤ 2s plus the real work. Final primary button (xl) "Open EMP". |
| 8 | Into the app | Panel scales 1→1.04 and fades; the shell scales 0.98→1 with blur 8→0, 480ms. Lands on Home with "Getting started" pinned in Favorites. |

**Getting started** is a page with 7 checklist items that tick themselves as the user does each one:
1. Create a page
2. Try `/`
3. Open `⌘K`
4. Add a transaction
5. Try `⌘⇧H`
6. Lock with `⌘⇧L`
7. Explore Templates

**Coach marks** appear at most 3 times in the first session.

### 6.3 Lock screen
- **What is rendered**
  - Full-window aurora with grain.
  - **No app content is mounted.**
- **Card**
  - Width 360, radius 20, padding 32.
  - Workspace avatar (64), workspace name, a password field (xl, autofocus), a primary "Unlock" button (xl, full width), a ghost "Use recovery key" button, and the caption "Locked automatically after 15 minutes".
- **Feedback**
  - Wrong password: shake animation plus helper text "Incorrect password".
  - Caps Lock on: a warning chip.
  - Backoff (§9.10): a countdown shows inside the disabled button.
- **Unlock**
  - The KDF runs off-thread.
  - The button shows a shimmer while it runs.

### 6.4 Home
Home opens with a greeting at h1 ("Good evening, {name}") and the date in secondary text. Below it are these rows:

1. **Today:** next 5 events (Google and the Life OS Tasks database), tasks due, and a habit strip.
2. **Money snapshot:** Net worth, Spent vs budget (ring), Upcoming bills (7 days) and Portfolio today. These values respect Hide numbers.
3. **Watchlist:** 32px rows showing ticker (weight 600), name, a 64×20 sparkline, price and a delta chip.
4. **Recent pages:** 4 columns of 160×100 cards.
5. **Suggestions:** advisor insights from every installed app. Each can be dismissed.

Rows are rearrangeable with dnd-kit using `spring.layout`. "Customize home" shows a 12-column dotted grid. The layout is stored in `kv` at `ui.home.layout`.

### 6.5 Life-app wizard (reusable)
- **Entry points:**
  - an empty state
  - Life Apps `+`
  - Templates
  - the palette (for example "Set up taxes")
  - the onboarding quick setup
- **Layout:** a right-side sheet, 720 wide.
  - Left column (400): the questions.
  - Right column (320): a live preview plus "What we'll create", with a switch per item so the user can opt out.
- **Recommendations:** each one has a "Why?" chip (20px, `lightbulb` icon at 12px). The popover shows the rationale and the source type, for example "Common guideline: 3–6 months of essential expenses".
- **Final step, "Review & create":** shows counts ("6 pages · 9 databases · 2 dashboards · 14 reminders"). The primary button reads "Create {App} workspace".
- **On create:**
  - generated items fly into the sidebar, 40ms stagger, using `spring.ui`
  - the hub page opens
  - KPI tiles count up and charts draw in
  - a toast offers "Undo {App} setup"
- **App landing header:**
  - a 120px banner with `linear-gradient(180deg, color-mix(in oklab, {appColor} 8%, transparent), transparent)`
  - a 40px icon tile
  - an h1 title and a subtitle
  - a KPI row
  - underline tabs

Life-app identity:

| App | Colour | Icon |
|---|---|---|
| Money HQ | jade | `wallet` |
| Portfolio | ocean | `candlestick-chart` |
| Tax Organizer | amber | `receipt-text` |
| Spreadsheet Studio | iris | `sheet` |
| Life OS | blue (block colour) | `kanban` |
| Habits | ruby | `heart-pulse` |

### 6.6 Security Center (Settings → Security)
- **Hero card:** chips such as "Encrypted · Locks after 15 min idle · Recovery key confirmed · Last snapshot 2 h ago". Each chip is green or amber and animates with `spring.ui` when its state changes.
- **Encryption card:**
  - the cipher, plus the KDF line "Argon2id · 256 MiB · 3 passes · ~0.9 s on this device"
  - a "Strengthen" button
  - the label "Encryption: v1 (unaudited)"
- **Password & recovery card:** change password; view or regenerate the recovery key. Both require re-auth.
- **Auto-lock card:** a switch per trigger (§9.9).
- **Backups card:** schedule, folder, "Verify now" (with a ring), and a list of snapshots.
- **Integrations card:** accounts, scopes, and revoke.
- **Network card:** the offline switch and the request log table (last 1,000).
- **Integrity card:** last check, and "Run now".
- **Privacy card:**
  - Hide numbers on launch
  - Blur when inactive (default off; default on for finance views)
  - Clipboard clear time
  - Remove image location data (default on)
- **"How strong is my password?" table:** values from §9.10.
- **"What encryption protects" table:** contents from §9.20.
- **FAQ:** includes "Is EMP military-grade encryption?", answered with the text in §9.22.
---

## 7. Editor spec

### 7.1 Document schema (D-07)

The ProseMirror schema is defined in `src/features/editor/schema.ts`. A CI test asserts that Rust `emp_store::doc::SCHEMA` matches the exported manifest JSON. Nesting is BlockNote-style.

```
doc            := blockGroup
blockGroup     := blockContainer+
blockContainer := blockContent blockGroup?          attrs { id: string(12, nanoid), color: BlockColor|null, bg: BlockColor|null, dir: 'auto'|'ltr'|'rtl' }
blockContent   := paragraph | heading | bulletItem | numberedItem | todoItem | toggle | quote | callout
                | codeBlock | divider | mathBlock | table | columnList | pageRef | pageLink | image | file
                | toc | databaseView | chart | kpi | sheetEmbed | watchlist
columnList     := column{2,5}                        attrs { widths: number[] }  (sum = 1)
column         := blockGroup                         (columnList inside column is FORBIDDEN)
table          := tableRow+ ; tableRow := tableCell+ ; tableCell := inline*   attrs { headerRow, headerCol, colWidths[], cellColors{} }
```

**Children.** These content types may take a child `blockGroup`: `paragraph`, `heading` (when `toggle:true`), `bulletItem`, `numberedItem`, `todoItem`, `toggle`, `quote` and `callout`. All other types are leaf blocks. A leaf container never has children: pressing Tab on a leaf block is a no-op.

**blockContent attributes**

| Node | Attrs |
|---|---|
| paragraph | — |
| heading | `level: 1\|2\|3`, `toggle: boolean`, `collapsed: boolean` |
| bulletItem | — |
| numberedItem | `start: number\|null` (P1 UI) |
| todoItem | `checked: boolean` |
| toggle | `collapsed: boolean` |
| quote | — |
| callout | `icon: Icon` (default 💡), `color: BlockColor` (default `gray`) |
| codeBlock | `language: string` (default `plain`), `wrap: boolean`, `caption: string` |
| divider | — (atom) |
| mathBlock | `latex: string` (atom) |
| pageRef | `pageId: Id` (sub-page; atom) |
| pageLink | `pageId: Id` (link to page; atom) |
| image | `assetId: Id`, `width: number\|null`, `align: 'left'\|'center'\|'right'`, `caption: string` |
| file | `assetId: Id` |
| toc | — |
| databaseView | `databaseId: Id`, `viewId: Id\|null`, `linked: boolean`, `height: number\|null` |
| chart | `source: {kind:'db', databaseId, viewId?} \| {kind:'sheet', workbookId, range} \| {kind:'metric', instanceId, metric}`, `spec: ChartSpec` |
| kpi | `source` (same union as chart), `agg: AggFn`, `label`, `format` |
| sheetEmbed | `workbookId`, `sheetId`, `range: string` |
| watchlist | `watchlistId: Id` |

**Inline nodes and marks**

- Inline nodes: `text`, `hardBreak`, `mention` (`{kind:'page', pageId}`, `{kind:'date', date: DateValue, reminderId?}`), `emoji` (`{native, shortcode}`), `mathInline` (`latex`).
- Marks: `bold`, `italic`, `underline`, `strike`, `code`, `link` (`href`, validated per §9.15), `textColor` (`color: BlockColor`), `highlight` (`color: BlockColor`), and `comment` (P1).

**Block IDs** come from a custom plugin (`extensions/blockId.ts`) running in `appendTransaction`:
- Every `blockContainer` gets a 12-character nanoid (alphabet `[0-9A-Za-z_-]`).
- Duplicate IDs are regenerated, keeping the first occurrence.
- Paste, duplicate and template instantiation always regenerate IDs.

**Root and invariants**
- The root carries `attrs.schemaVersion = 1`. Rust `doc::migrate` upgrades older documents.
- Property tests (fast-check in TS, proptest in Rust over the doc model) must hold these invariants after 10,000 random operation sequences:
  - IDs are unique.
  - Nesting is valid.
  - There is no `columnList` inside a column.
  - A `columnList` with a single column is unwrapped.

**Node views**
- Hot blocks render with schema `toDOM` or plain-DOM node views.
- React node views are used only for `databaseView`, `chart`, `kpi`, `sheetEmbed`, `watchlist`, `image` (resize handles) and `mathBlock` (editor popover).
- Every React node view:
  - sets `stopEvent` for keyboard and pointer events inside it
  - returns `ignoreMutation: true`
  - mounts lazily through `IntersectionObserver` (rootMargin 400px), showing a skeleton until then

**Editor configuration:** TipTap with `immediatelyRender: true` and `shouldRerenderOnTransaction: false`. Toolbars read state via `useEditorState` with narrow selectors.

### 7.2 Input rules

These never fire inside code, inline code or math, during IME composition, or on paste.

| Input | Result |
|---|---|
| `# ` `## ` `### ` | heading 1/2/3 |
| `- ` `* ` `+ ` | bulletItem |
| `1. ` `a. ` `i. ` | numberedItem (style follows the input in P1; v1 always renders numbers) |
| `[] ` `[ ] ` / `[x] ` | todoItem unchecked / checked |
| `> ` | toggle |
| `" ` | quote |
| `---` | divider |
| ```` ``` ```` or ```` ```lang ```` + space or enter | codeBlock |
| `$$ ` at line start | mathBlock |
| `**x**` `*x*` `_x_` `~x~` `` `x` `` `$$x$$` | bold, italic, italic, strike, code, mathInline |
| `[[` | page link picker (offers "Create page 'x'") |
| `@` | mention picker (pages, dates such as "today", "next fri", "Dec 3 3pm", "in 2 weeks") |
| `:` + 2 characters | emoji autocomplete |
| `->` `<-` `<->` `>=` `<=` `!=` `--` `...` `(c)` | → ← ↔ ≥ ≤ ≠ — … © (Settings → Editor → "Typography replacements", default on) |
| `⌘Z` immediately after an autoreplace | reverts the conversion only |

### 7.3 Keyboard semantics

- **Enter**
  - Splits the block.
  - On an empty list, to-do or toggle item: outdents, or converts to a paragraph when already at the top level.
  - At the end of a toggle or toggle-heading: creates a child when expanded, a sibling when collapsed.
- **Shift+Enter:** inserts a `hardBreak`.
- **Backspace at block start**
  - On a non-paragraph block: converts it to a paragraph first.
  - On a nested block: outdents.
  - Otherwise: merges into the previous block.
- **Tab / Shift+Tab:** indent under the previous sibling, or outdent. Inside a table, Tab moves to the next cell. Inside code, Tab inserts 2 spaces.
- **⌘Enter:** toggles a to-do, expands or collapses a toggle, or opens the link under the cursor.
- **⌘⇧↑ / ⌘⇧↓:** moves the block together with its children.
- **↑ / ↓ across atom blocks:** node-selects the atom block instead of skipping over it.
- **⌘⌥T:** expands or collapses all toggles.
- **Esc:** selects the current block. Pressing Esc again clears the selection.
- **Block selection:**
  - Shift+↑/↓ extends the selection. ⌘A selects the block's text, then all blocks.
  - With blocks selected, these act on the selection: Delete, ⌘C/X/V, ⌘D, Tab and Shift+Tab, ⌘⇧↑/↓ and `⌘/` (block menu).
  - Enter edits the first selected block. Typing replaces the selection.
- Block selection is a plugin with its own state and decorations (an accent overlay at .12). It is cleared by a click.

### 7.4 Turn into

Allowed conversions: paragraph ↔ heading 1–3 ↔ bullet ↔ numbered ↔ to-do ↔ toggle ↔ toggle heading ↔ quote ↔ callout ↔ code.
- Content is preserved.
- Children are kept when the target type allows them.
- Converting to code flattens children into text lines, after a confirmation.

Shortcuts:

| Shortcut | Turns into |
|---|---|
| ⌘⌥0 | paragraph |
| ⌘⌥1–3 | heading 1–3 |
| ⌘⌥4 | to-do |
| ⌘⌥5 | bullet |
| ⌘⌥6 | numbered |
| ⌘⌥7 | toggle |
| ⌘⌥8 | code |
| ⌘⌥9 | page |

"Turn into page" creates a sub-page. The block's text becomes the page title, its children become the page content, and a `pageRef` is left in place. For a multi-block selection, all selected blocks become the content and the title is "Untitled".

### 7.5 Slash menu

- **Trigger:** `/` at the start of a line, or after whitespace. It never triggers inside code, inline code or math, or during IME composition.
- **Groups and items** (fuzzy matching over name, aliases and keywords; recently used first):
  - **Basic:** Text, Heading 1–3, Toggle heading 1–3, To-do, Bulleted list, Numbered list, Toggle, Quote, Callout, Divider, Page, Link to page.
  - **Media:** Image, File.
  - **Database:** Table view, Board view, List view, Calendar view, Gallery view, Chart view, Linked view (`/linked`), Database full page.
  - **EMP:** Spreadsheet, Chart, KPI, Watchlist, Life app…
  - **Advanced:** Table, Columns 2/3/4/5, Code, Equation, Table of contents.
  - **Inline:** Mention page, Date, Emoji, Inline equation.
  - **Actions:** Turn into…, Color…, `/red`, `/blue background` (one entry for each of the 9 colours × text and background), Duplicate, Delete, Move to…
- **Keyboard:**
  - ↑/↓ move the highlight. Enter selects. Tab cycles through groups.
  - Esc closes the menu and leaves the typed text in place.
  - The menu closes automatically after 3 non-matching characters followed by a space.
- **Positioning:** floating-ui, flipping above the line when close to the bottom of the viewport. Opens with scale 0.98→1 over 120ms from the caret.

### 7.6 Block handle and drag

- On hover, a `+` and a `⋮⋮` appear in the gutter, aligned to the baseline of the block's first line.
  - `+` inserts a block below. ⌥-click inserts above.
  - Clicking `⋮⋮` opens the block menu: Delete, Duplicate (⌘D), Turn into ▸, Turn into page, Copy link to block, Move to…, Color ▸.
- **Drag:**
  - The drop line marks the target position. The horizontal offset chooses nesting depth, at 24px per level.
  - Hovering over a collapsed toggle for 500ms auto-expands it.
  - The view auto-scrolls within 48px of an edge, at up to 12px per frame.
  - The drag preview is a clone at 0.6 opacity.
- Dragging onto a sidebar page (moving the block to another page) is P1.

### 7.7 Clipboard

- **Copy** writes three formats:
  - `application/x-emp-blocks`: JSON with `{v:1, vaultId, blocks}`.
  - `text/html`: also embeds the same JSON in a `data-emp` attribute, as a fallback for WebKitGTK.
  - `text/plain`: markdown.
- **Paste** tries these in order:
  1. Internal JSON. Block IDs are regenerated. Asset IDs are reused when `vaultId` matches; otherwise the blocks are dropped and a placeholder is shown.
  2. HTML, sanitised with DOMPurify (§9.15) and then parsed through the schema. Handles Google Docs, Word, web pages and Notion.
  3. Markdown detection on plain text (headings, lists, tables, code fences).
  4. Plain text.
- **Special cases:**
  - Pasted images and files go to the asset store (`asset_import_bytes`).
  - Pasting a URL on its own creates a link. A "Paste as mention" chip is shown for internal links.
  - Pasting a TSV/CSV grid on an empty line, or HTML from Excel or Sheets, offers "Insert as table / database / spreadsheet".
- **⌘⇧V** pastes as plain text.
- **Copy as Markdown** is in the block menu.

### 7.8 Autosave, history, undo

- `useDocSave` marks the document dirty when it changes. It saves after 400ms idle, or at most 2s after the first unsaved change. The save serialises in `requestIdleCallback` (timeout 300ms) and calls `page_save_doc` with `baseRev`.
- Saves are also flushed:
  - on editor blur
  - on route change
  - on `visibilitychange`
  - before lock
  - on `onCloseRequested` (window close waits for the flush, up to 1.5s)
- **Conflict:** when the response is `CONFLICT`, the local draft is saved as a version (`reason: 'pre_restore'`) and a sheet offers "Keep mine / Take theirs".
- **Undo:**
  - Each editor keeps its own ProseMirror history, grouped by typing bursts of 500ms.
  - Histories are kept in an LRU of 8 open pages.
  - Non-editor mutations go through the app command stack (§13.4).
- **Versions (D-24)** are created:
  - when the doc changed by at least 64 characters and the last version is at least 10 minutes old
  - on page close or switch, if the page was edited
  - before turn-into-page, bulk delete, import overwrite, or applying a template to an existing page
  - on manual "Save version" (with a name)

  Thinning runs after unlock as an idle job.

### 7.9 Find & replace

- **Find (⌘F):** incremental search with a match count, ↵ / ⇧↵ for next and previous, and toggles for case-sensitive and whole-word. Matches inside collapsed toggles expand those toggles.
- **Replace (⌘⌥F):** Replace and Replace all. Replace all is a single undo step.
- Regex search is P1.

### 7.10 Backlinks

- After unlock, the doc indexer builds `outgoing: Map<pageId, Set<{targetPageId, blockId}>>` from mentions, `pageLink`, `pageRef` and internal links, and keeps it updated incrementally on save.
- A pill under the page title shows "N backlinks". Expanding it lists each source page with a snippet (±60 characters around the link) and its block ID. Clicking an entry navigates to the block and flashes it (an accent .2 background fading over 900ms).

### 7.11 Other

- **Code:** lowlight, loading languages lazily on first use. Bundled grammars: js, ts, tsx, json, rust, python, go, bash, sql, html, css, markdown, yaml, toml, java, c, cpp, csharp, ruby, php, swift, kotlin.
- **KaTeX:** CSS and fonts bundled locally. Options: `trust:false`, `strict:'warn'`, `maxSize:10`, `maxExpand:1000`. Errors are shown inline in loss-text.
- **Spellcheck:** native, toggled in settings. On Linux, show a hint if no enchant dictionaries are found.
- **Files dropped from the OS:** images become `image` blocks, everything else becomes `file` blocks. While dragging over the window, an overlay is shown.
- **Large documents:** above 2MB of serialised JSON, show a banner suggesting the page be split. Images are never inlined: data URIs are converted into assets.

---

## 8. Databases spec

### 8.1 Property types (v1)

| Type | Stored `CellValue` | Config | Notes |
|---|---|---|---|
| `title` | `{t:'text', v:RichText}` | — | Exactly one per database; it is the row title |
| `text` | `{t:'text', v:RichText}` | — | Filters run on the plain projection |
| `number` | `{t:'number', v:number\|null}` | `format: 'number'\|'comma'\|'percent'`, `decimals: 0..8`, `display: 'number'\|'bar'\|'ring'`, `divideBy?` | Finite f64 only |
| `money` | `{t:'money', v:string\|null, cur:string}` | `currency` (default currency), `perRowCurrency: boolean`, `decimals` | `Decimal`; sums are exact |
| `select` | `{t:'select', v:OptionId\|null}` | `options: {id,name,color}[]`, `sort: 'manual'\|'alpha'` | Options can be created inline |
| `multi_select` | `{t:'multi', v:OptionId[]}` | same as select | |
| `status` | `{t:'status', v:OptionId\|null}` | `options` with `group: 'todo'\|'in_progress'\|'complete'` | Group-by uses groups or options |
| `date` | `{t:'date', v:{start, end?, time:boolean, tz?}\|null}` | `format: 'full'\|'mdy'\|'dmy'\|'ymd'\|'relative'`, `clock: 12\|24` | All-day dates are stored as `YYYY-MM-DD`; timed dates as RFC 3339 with offset plus an IANA tz |
| `checkbox` | `{t:'check', v:boolean}` | — | |
| `url` | `{t:'url', v}` | — | Schemes allowed: http, https, mailto |
| `email` | `{t:'email', v}` | | |
| `phone` | `{t:'phone', v}` | | |
| `files` | `{t:'files', v:{assetId,name}[]}` | — | |
| `relation` | `{t:'relation', v:RowId[]}` | `targetDatabaseId`, `dual: {propertyId}\|null`, `limit: 'one'\|'many'` | Two-way writes happen in one transaction |
| `rollup` | computed | `relationPropId`, `targetPropId`, `fn: RollupFn` | Cached; cycle detection |
| `formula` | computed | `expression` (stored using property ids) | §14.6 |
| `created_time` / `updated_time` | computed | format | `updated_time` changes on property edits and body edits |
| `unique_id` | `{t:'uid', v:string}` | `prefix` | Monotonic `uidSeq`; ids are never reused |
| `rating` | `{t:'rating', v:1..5\|null}` | `max: 5\|10`, `icon: 'star'\|'heart'` | |
| `progress` | `{t:'progress', v:0..1\|null}` | `display: 'bar'\|'ring'` | |
| `ticker` | `{t:'ticker', v:SymbolKey\|null}` | `showQuote: boolean` | Shows a live quote chip when the vault is unlocked and market data is enabled |
| `recurrence` | `{t:'recurrence', v:{rrule:string, dtstart:string, tz?:string, mode:'schedule'\|'completion'}\|null}` | — | Uses the `rrule` crate. In `completion` mode, the next date is computed from the completion date |
| `secret` | `{t:'secret', v:{masked:string}}` | — | The value is stored in the `secrets` table (`secret:<random16>`). Only a mask of the last 4 characters is returned. Revealing it requires re-auth (`row_secret_reveal`). Excluded from search, export, previews and AI |
| `computed` | `{t:'computed', v:{kind,value,display}}` | `owner: 'lifeapp:<instance>:<metric>'` | Read-only. Written by Rust life-app jobs |

RollupFn:
- Counting: `show_original`, `show_unique`, `count_all`, `count_values`, `count_unique`, `count_empty`, `count_not_empty`, `pct_empty`, `pct_not_empty`.
- Numeric: `sum`, `average`, `median`, `min`, `max`, `range`.
- Date: `earliest`, `latest`, `date_range`.
- Checkbox: `checked`, `unchecked`, `pct_checked`, `pct_unchecked`.

### 8.2 Type conversions

A conversion first creates a `pre_bulk` schema version, then converts every row in Rust inside one transaction. The dialog always warns "This may lose data".

| From | To |
|---|---|
| text | select (creates options from distinct values, max 200) |
| select | text |
| number | text |
| text | number (parsed; unparseable values become empty) |
| date | text |
| checkbox | text ("Yes"/"No") |
| multi_select | text (comma-joined) |
| number | money |
| money | number |

### 8.3 Views (v1)

| Layout | v1 behaviour |
|---|---|
| table | Row and column virtualisation (overscan 8 rows and 2 columns). Sticky header and title column. Column resize and reorder. Per-column wrap. Footer aggregates. Checkbox selection with bulk edit, delete and duplicate. Keyboard grid: arrows move, Enter edits, Esc exits, Tab moves right. The "New" row sits at the bottom. Hovering a row shows "Open", which opens a side peek. |
| board | Group by select, status or checkbox. Drag between columns sets the property and the sort key atomically. Manual order within a column. Hide or collapse groups. "No value" group. Per-group count. Card preview: none, cover, or files. Card size S/M/L. Layout animations are disabled above 300 visible cards. Each column loads 50 cards at a time with infinite scroll. |
| list | Title plus chosen properties, with grouping. |
| calendar | Month view. Pick the date property. Drag a card to reschedule. "+" on a day creates a row dated that day. Weekends toggle. Today button. "+N more" overflow. Multi-day bars span across weeks. When Google Calendar is connected, events can be shown as an overlay. |
| gallery | Card preview: cover, content (first 6 blocks rendered to a cached thumbnail) or files. Size S/M/L. Fit image. |
| chart | Types: vertical bar, horizontal bar, line, area, stacked area, donut, combo (bar + line), waterfall. X axis is a property with a date bucket (day, week, month, quarter, year). Y is count, or sum/avg/min/max/median of a property. Optional series property. Options: stacked, cumulative, data labels, smoothing (monotone), omit zeros. Aggregation runs in Rust (`db_chart_data`). |

Each view stores: name, layout, filter, sorts, groupBy, visibleProps (with order), propWidths, wrap, card settings, calendar settings, chart settings, footerAggs, and `openIn: 'side_peek'|'full_page'`.

The view tab strip supports rename, duplicate, delete and drag-to-reorder. Database search filters the current view by title and text properties.

The header shows "142 rows" and, when filtered, "142 rows · 37 shown".

### 8.4 Filters

- Structure: a tree of `and`/`or` groups, at most 3 levels deep.
- Operators by type:

  | Type | Operators |
  |---|---|
  | text, title, url, email, phone | `eq`, `neq`, `contains`, `not_contains`, `starts_with`, `ends_with`, `empty`, `not_empty` |
  | number, money, rating, progress | `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `empty`, `not_empty` |
  | select, status | `eq`, `neq`, `any_of`, `none_of`, `empty`, `not_empty`; status also has `group_eq` |
  | multi_select | `any_of`, `all_of`, `none_of`, `empty`, `not_empty` |
  | date, created, updated | `eq`, `before`, `after`, `on_or_before`, `on_or_after`, `between`, `within`, `empty`, `not_empty` |
  | checkbox | `checked`, `unchecked` |
  | relation | `contains`, `not_contains`, `empty`, `not_empty` |
  | files | `empty`, `not_empty` |
  | formula, rollup | the operators of their result type |

- `within` values:
  - `today`, `tomorrow`, `yesterday`
  - `this_week`, `past_week`, `next_week`
  - `this_month`, `past_month`, `next_month`
  - `this_quarter`, `this_year`, `past_year`, `next_year`
  - `{past_days: n}`, `{next_days: n}`
- Relative dates are evaluated at query time using the vault locale, timezone and week start. At local midnight, open views re-query.

### 8.5 Sorts, grouping, calculations

**Sorts**
- Multiple levels.
- Select and status sort by option order.
- Empty values sort last.
- Text uses locale-aware collation, case-insensitive and diacritic-insensitive. Natural numeric sort ("Item 2" before "Item 10") is on.
- With no sort active, rows use the manual `sort_key`.

**Grouping**
- Groupable types: select, status (by group or by option), multi_select (a row appears in each of its groups), checkbox, date (bucket: relative/day/week/month/year), relation, and text (exact value).
- Groups can be hidden, collapsed (persisted per view), or empty-hidden.
- Each group shows its count.
- The group header has a "New" button that pre-fills the group's value.

**Footer and group aggregates (AggFn)**
- All types: `count`, `count_values`, `count_unique`, `empty`, `not_empty`, `pct_empty`, `pct_not_empty`.
- Numbers and money: `sum`, `avg`, `median`, `min`, `max`, `range`.
- Dates: `earliest`, `latest`, `range`.
- Checkboxes: `checked`, `unchecked`, `pct_checked`.

Money sums are computed in Decimal. Aggregates respect the active filters.

### 8.6 Row pages and templates

**Opening a row**
- Opens in a side peek by default.
- The side peek is 50% of the window width (min 420, max 860).
- Its header (44px) has: expand to full page, ↑/↓ to the previous/next row, and close.

**Row page layout**
- A properties block sits at the top.
- "Hide empty properties" is a per-database setting.
- The row body is a document (`page_docs` with `owner_kind='row'`), created on first edit.

**Row templates**
- Each template defines `{id, name, icon, values, doc}`, and one template can be the default.
- "New ▾" lets you pick a template.
- Life apps define templates such as Expense, Bill, Tax document and Habit check-in.

**Template variables**
- `@today`, `@now`, `@today+Nd`, `@today+Nw`, `@today+Nm`
- `@name` (the profile name)
- `@seq` (the unique-id sequence)

They are resolved when a row is created from the template.

---

### 8.7 Keyboard shortcut map (final)

On Windows and Linux, ⌘ becomes Ctrl and ⌥ becomes Alt. Match keys by `KeyboardEvent.code` and show labels for the current layout. Avoid OS-reserved combinations (⌘H, ⌘M, ⌘Q, Super-based keys).

**App**

| Keys | Action |
|---|---|
| ⌘K | Command palette (in the editor with a text selection: link popover) |
| ⌘P | Quick find (palette, pages-only scope) |
| ⌘⇧P | Palette in commands mode |
| ⌘N | New page |
| ⌘[ / ⌘] | Back / forward |
| ⌘⇧U | Go to parent page |
| ⌘\ | Toggle sidebar |
| ⌘⇧L | **Lock now** |
| ⌘⇧H | **Hide numbers** |
| ⌘⇧O | Offline mode |
| ⌘⇧D | Toggle theme (light ↔ dark) |
| ⌘⌥D | Today's daily note |
| ⌘, | Settings |
| ⌘L | Copy link to current page |
| ⌘F / ⌘⌥F | Find / find & replace |
| ⌘/ (no block selected) or `?` (not in text) | Shortcut cheat sheet |
| ⌘+ / ⌘− / ⌘0 | Zoom |
| F6 / ⇧F6 | Cycle regions |

**Formatting**

| Keys | Action |
|---|---|
| ⌘B / ⌘I / ⌘U | Bold / italic / underline |
| ⌘⇧S | Strikethrough |
| ⌘E | Inline code |
| ⌘⇧E | Inline equation |
| ⌘K (with selection) | Link |
| ⌘⌥H | Apply last colour |
| ⌘⇧V | Paste plain text |

**Blocks**

| Keys | Action |
|---|---|
| Esc | Select current block |
| ⌘A | Select block text, then all blocks |
| ⇧↑ / ⇧↓ | Extend block selection |
| ⌘D | Duplicate |
| ⌘⇧↑ / ⌘⇧↓ | Move block |
| Tab / ⇧Tab | Indent / outdent |
| ⌘Enter | Toggle to-do or toggle; open link |
| ⌘⌥T | Expand or collapse all toggles |
| ⌘/ (block selected) | Block menu |
| ⌘⌥0–9 | Turn into |
| ⌘Z / ⌘⇧Z | Undo / redo |

**Database**

| Keys | Action |
|---|---|
| Arrows / Enter / Esc / Tab | Cell navigation |
| Space (row selected) | Open peek |
| ⌘Enter (title cell) | Open row |
| ⌘⇧⌫ | Delete selected rows |
| ⌥⇧N | New row |

**Sheets**

| Keys | Action |
|---|---|
| F2 | Edit cell |
| ⌘Enter | Fill selection |
| ⌘D / ⌘R | Fill down / fill right |

⌘⇧L locks everywhere, including in sheets, so Excel's ⌘⇧L filter shortcut is not available. Sheets use ⌘⇧F to toggle filters instead.
---

## 9. Security spec

All items in this section are **v1** unless they are marked P1 or P2.

### 9.1 Primitives and crates
| Purpose | Primitive | Crate |
|---|---|---|
| Record, keyslot and blob-key AEAD | XChaCha20-Poly1305 (256-bit key, 192-bit random nonce) | `chacha20poly1305` 0.10 (`XChaCha20Poly1305`, `stream`) |
| Password KDF | Argon2id v0x13 | `argon2` 0.5 |
| Subkeys | HKDF-SHA256 | `hkdf` 0.12, `sha2` |
| MACs | HMAC-SHA256 | `hmac` 0.12 |
| Constant-time compare | — | `subtle` |
| RNG | OS CSPRNG only | `getrandom` / `rand_core::OsRng` |
| Secret memory | — | `zeroize` (derive), `secrecy` 0.10 |
| Recovery key | BIP39 English, 24 words | `bip39` |
| Password strength | zxcvbn | `zxcvbn` (Rust) |
| Normalisation | NFKC | `unicode-normalization` |
| TLS | rustls (webpki roots + platform verifier) | `reqwest` with `rustls-tls`; `openssl` is banned via cargo-deny |

Rules for `emp-crypto`:
- Lints: `#![forbid(unsafe_code)]` and `#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::indexing_slicing)]`.
- Key types must not implement `Clone`, `Copy` or `Debug`. Their `Debug` output, if any, is `[REDACTED]`, and they implement `ZeroizeOnDrop`.
- Known-answer tests (KATs) live in `crates/emp-crypto/tests/vectors/`:
  - RFC 9106 Argon2id
  - draft-irtf-cfrg-xchacha
  - RFC 5869 HKDF
  - RFC 4231 HMAC
  - fixed EMP envelope, keyslot and blob vectors

### 9.2 Key hierarchy
```
password --NFKC, ≤1024 bytes--> Argon2id(m,t,p, salt[16], out 32) --> KEK_pw
recovery (24 words → 32 bytes entropy) --HKDF(ikm=RK, salt=vault_id, info="emp/v1/kek/recovery")--> KEK_rec
device key (32 random bytes in OS keychain, service "com.devartin.emp", account "device-key/<vault_id hex>") --> KEK_dev
DEK (32 random bytes, epoch 1) wrapped by KEK_pw and KEK_rec when encrypted; by KEK_dev when not encrypted
DEK --HKDF-SHA256(salt=vault_id)--> subkeys (§9.4)
```
- The DEK is never written to disk unwrapped and never crosses IPC.
- When no OS keychain is available, the device key is stored in `<data>/device.key` with mode 0600. Security Center then shows: "Your API keys are obfuscated, not protected. Turn on vault encryption to protect them."
- Quick unlock (device keyslot with biometrics) is P2.

### 9.3 Argon2id parameters
| Profile | m (KiB) | t | p | Notes |
|---|---|---|---|---|
| Floor | 65536 (64 MiB) | 3 | 4 | Calibration never goes below this |
| **Standard (default)** | **262144 (256 MiB)** | **3** | **4** | Target 0.5–1.5 s |
| High (opt-in "Paranoid") | 1048576 (1 GiB) | 4 | 4 | |

Calibration runs at vault creation and on every password change:
1. Run m = 256 MiB, t = 1, p = 4 on a dummy input and record the time as T1.
2. Set t = clamp(ceil(0.8 s / T1), 3, 10).
3. If T1 > 0.8 s or available RAM is under 4 GiB, step m down through 192, 128, then 64 MiB, raising t to keep the total time at or above 0.5 s.

Other parameters:
- Salt: 16 random bytes per keyslot. A new salt is generated on every password change.
- Output length: 32 bytes. No pepper.
- The KDF runs in `spawn_blocking`.

Bounds checked when reading parameters (the KDF does not run if any check fails):
- 65536 ≤ m ≤ 4194304
- 3 ≤ t ≤ 20
- 1 ≤ p ≤ 16
- salt length = 16

After a successful unlock, if the stored parameters are below the current Standard profile, show "Strengthen key derivation". This rewraps the DEK.

### 9.4 HKDF labels (info strings; salt = vault_id, output 32 bytes)
| Subkey | Info |
|---|---|
| `k_records` | `emp/v1/records` |
| `k_assets` | `emp/v1/assets` |
| `k_secrets` | `emp/v1/secrets` |
| `k_manifest` | `emp/v1/manifest` |
| `k_blob_id` | `emp/v1/blob-id` |
| `k_backup_mac` | `emp/v1/backup-mac` |
| `k_header_mac` | `emp/v1/header-mac` |
| `k_search` | `emp/v1/search` (P1 encrypted index snapshot) |
| `k_blind` | `emp/v1/blind-index` (keyed hashes of remote ids and cache keys) |

### 9.5 Record envelope (enc = 1)
```
envelope = header[4] || nonce[24] || ciphertext || tag[16]
header   = u8 version(0x01) || u8 flags(bit0 zstd, bit1 padded) || u16le key_epoch
aad      = "EMP-REC-v1" || vault_id[16] || u8 table_tag || lp(id) || lp(kind) || u64be(rev) || header[0..4] || lp(extra)
inner    = u8 inner_flags || u32be unpadded_len || body || zero padding (PADMÉ to total length)
```
- **Nonce:** 24 fresh random bytes on every encryption, including every re-save. Nonces are never derived from ids or counters.
- **Compression:** zstd level 3 when the body is over 1 KiB and the row is not in `secrets`.
- **Padding:** PADMÉ: `E = floor(log2 L)`, `S = floor(log2 E) + 1`, `lastBits = E − S`, round L up to a multiple of `2^lastBits`.
- **Decrypt order:** verify the tag, then validate the flags, then check `unpadded_len ≤ padded_len`. Every failure is a typed `CryptoError` and never a panic.

`table_tag` values:

| Table | Tag |
|---|---|
| workspaces | 1 |
| pages | 2 |
| page_docs | 3 |
| synced_blocks | 4 (P1) |
| comments | 5 (P1) |
| databases | 6 |
| db_properties | 7 |
| db_rows | 8 |
| db_views | 9 |
| workbooks | 10 |
| sheets | 11 |
| sheet_bands | 12 |
| assets | 13 |
| versions | 14 |
| settings | 15 |
| secrets | 16 |
| kv | 17 |
| sync_links | 18 |
| outbox | 19 |
| reminders | 20 |
| lifeapp_instances | 21 |
| security_log | 22 |
| watchlists | 23 |

`kind` is the table's `kind` column where one exists, otherwise the empty string. `extra` binds composite keys:

| Table | `extra` |
|---|---|
| sheet_bands | `lp(sheet_id) ‖ u32be(band)` |
| settings | `lp(scope) ‖ lp(key)` |
| kv | `lp(ns) ‖ lp(key)` |

For tables without a `rev` column, rev is 0.

When the vault is not encrypted (enc = 0), `payload` holds UTF-8 canonical JSON, with keys in serde struct order. The `secrets` table is always enc = 1.

### 9.6 Keyslots
```
aad         = "EMP-KEYSLOT-v1" || vault_id || u32be(slot_id) || u8(kind: 1 pw, 2 recovery, 3 device) || lp(kdf) || lp(kdf_params_cbor) || u32be(key_epoch)
wrapped_dek = XChaCha20Poly1305(KEK, nonce[24], DEK, aad)   // 48 bytes
```
- Each keyslot stores `kdf` (`argon2id-v13` or `hkdf-sha256`), `kdf_params` (canonical CBOR `{m,t,p}`), the salt and the nonce.
- A password is verified only by the AEAD tag. No verifier or hash is stored.
- Password change and recovery-key regeneration each write the new slot and delete the old one in a single `synchronous=FULL` transaction, followed by `PRAGMA wal_checkpoint(TRUNCATE)`.

### 9.7 Assets (blobs)
- **Per-blob key:** each blob gets a random 32-byte file key `FK`, stored as `wrapped_fk = XChaCha20Poly1305(k_assets, nonce, FK, aad="EMP-BLOBKEY-v1"‖vault_id‖blob_name‖u32be(epoch))`.
- **File format:** header `"EMPBLOB\x01" ‖ prefix[19] ‖ u64be(padded_total_len)`, followed by 64 KiB chunks.
  - Each chunk uses STREAM-BE32 (`aead::stream::EncryptorBE32`, so the nonce is prefix ‖ u32 counter ‖ last flag).
  - Each chunk's AAD is the file header.
  - The final chunk is padded with PADMÉ.
- **Name:** `blob_name = hex(HMAC-SHA256(k_blob_id, SHA-256(content))[..16])`, which is 32 hex characters. Files are stored at `assets/<first 2 hex>/<blob_name>`.
- **Plaintext mode:** when the vault is not encrypted, blobs are stored raw.
- **On import:**
  - EXIF GPS is stripped from images by default.
  - Type is sniffed from magic bytes.
  - Images are capped at 50 MiB and 16384×16384 pixels. Other files are capped at 2 GiB.
- **`emp-asset` protocol handler:**
  - Accepts only ids matching `^[0-9a-f]{32}$` that exist, and only while unlocked.
  - Supports `Range`, returning 206.
  - Allowed MIME types for inline display: `image/png|jpeg|gif|webp|avif`, `image/svg+xml`, and `video/mp4|webm` plus `audio/*` (both P1). Anything else is served as `application/octet-stream` with `Content-Disposition: attachment`.
  - SVG responses add `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`. The UI only ever renders SVG inside `<img>`.
  - Every response carries `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` and `Cross-Origin-Resource-Policy: same-origin`.

### 9.8 Integrity manifest (encrypted mode)
```
h(row)    = HMAC-SHA256(k_manifest, u8 table_tag || lp(id) || lp(extra) || u64be(rev) || SHA-256(payload))
mset_root = XOR of h(row) over every row of every enc=1 table (incremental: root ^= h(old) ^ h(new); delete: root ^= h(old))
state_mac = HMAC-SHA256(k_manifest, "EMP-STATE-v1" || vault_id || u64be(write_counter) || mset_root || SHA-256(canonical keyslots))
```
- **When it is updated:** inside the same SQLite transaction as every write, on the writer thread.
- **When it is checked:** fully recomputed at unlock, in parallel with the search-index build.
- **On mismatch:** show a sheet titled "Integrity warning: the vault was modified outside EMP or restored from an older copy". It offers four actions:
  - Compare with latest snapshot
  - Export report
  - Continue read-only
  - Accept and re-seal (requires re-auth)
- **Per-record failure:** if a single record fails its AEAD check, quarantine it as a "Damaged item" card offering restore-from-snapshot or delete. Never fall back to treating it as plaintext.
- **Header MAC:** `HMAC(k_header_mac, canonical vault_meta)` is checked after unlock.
- **Plaintext mode:** run `PRAGMA quick_check` only.

### 9.9 Lock and auto-lock
| Trigger | Default | Implementation |
|---|---|---|
| Idle | 15 min | Options: 1, 5, 15, 30, 60 min, 4 h, Never. "Never" requires re-auth and shows a warning badge. The UI sends `vault_activity_ping` at most once every 30 s while there is input. Rust tracks a monotonic `Instant` and a 10 s ticker locks when it expires. |
| System sleep | On | macOS `NSWorkspaceWillSleepNotification`. Windows `WM_POWERBROADCAST/PBT_APMSUSPEND`. Linux logind `PrepareForSleep(true)`, holding an inhibitor until keys are zeroized. |
| Screen lock / user switch | On | macOS `com.apple.screenIsLocked`. Windows `WTS_SESSION_LOCK` / `WTS_CONSOLE_DISCONNECT`. Linux logind `Lock` / `LockedHint` and `org.freedesktop.ScreenSaver.ActiveChanged`. |
| Window minimised or unfocused | Off | Options: 0, 1 or 5 min |
| Monotonic gap greater than the timeout | Always | |
| Manual | — | `⌘⇧L`, the palette, the top-bar lock icon, the tray (P1) |

Lock sequence, all in Rust:
1. Flush pending saves. The UI receives `vault:will-lock` and has 1.5 s to respond.
2. Swap `VaultState` to `Locked`. In-flight commands get 2 s to finish, then they are aborted.
3. Dropping the `Session` zeroizes the DEK, the subkeys and any cached access tokens. Caches, the search index, workbooks and the database cache are dropped. Integration jobs are cancelled. The clipboard is cleared if it still holds an EMP secret, compared by hash.
4. Delete `vaults/<id>/tmp/*`.
5. Emit `vault:locked {reason}`. The frontend resets its stores and calls `window.location.replace('/#/lock')`.
6. While locked, every data command returns `LOCKED`.

### 9.10 Brute-force resistance and password policy
- **Online backoff:**
  - Failures 1–4: no delay.
  - Failure 5: 1 s delay.
  - After that the delay doubles each time (2, 4, 8 s and so on), capped at 300 s.
  - The delay is enforced in Rust before the result is returned.
  - The failure count and `lockout_until` are persisted in `vault_meta`.
- **Erase after 10 failures:** P1, off by default, with strongly worded copy.
- **Password requirements:**
  - zxcvbn score ≥ 3
  - at least 10 characters
  - at most 1024 bytes after NFKC normalisation
  - any Unicode allowed
  - must not appear in an embedded top-100k common-password Bloom filter (`resources/common-passwords.bloom`, about 200 KB, FP rate 1e-6)
- **Passphrase generator:** 5 words from the EFF long list, with the separator picked at random from `- . _ / space`. That gives about 64.6 bits.
- **"How strong is my password?" table** (assumes 10^6 guesses per second, Standard profile):

  | Password | Time to exhaust |
  |---|---|
  | Leaked top 10M | ~10 s |
  | 8 lowercase letters | ~2–3 days |
  | 4 Diceware words | ~100 years |
  | 10 random ASCII characters | ~1.7 million years |
  | 6 Diceware words | billions of years |

  The table is labelled as an order-of-magnitude estimate.

- **Re-auth ("sudo mode"):** `vault_reauth` is valid for 5 minutes. It is required to:
  - view or regenerate the recovery key
  - change the password
  - disable encryption
  - export unencrypted data
  - set auto-lock to Never
  - reveal a `secret` property
  - connect an integration
  - accept and re-seal the integrity manifest
  - restore a backup over the current vault (not allowed in v1, since restore always goes to a new vault)

### 9.11 Memory and process hygiene
- **Key and secret types:**
  - Keys use `Zeroizing<[u8;32]>` newtypes, boxed once and never moved after that.
  - IPC passwords deserialise directly into `SecretString`.
  - KDF inputs and outputs are zeroized immediately after use.
  - Pages holding the DEK and subkeys are `mlock`ed or `VirtualLock`ed on a best-effort basis; failure is logged.
- **Process hardening by platform:**
  - **Linux:** `prctl(PR_SET_DUMPABLE, 0)` and `setrlimit(RLIMIT_CORE, 0)`.
  - **macOS:** hardened runtime without `get-task-allow`, `allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation` or `allow-dyld-environment-variables`.
  - **Windows:** `SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOGPFAULTERRORBOX)`.
- **Panics:** a custom hook logs only the location. A panic outside a `catch_unwind` boundary triggers a lock and shows the "Something went wrong — EMP locked to protect your data" screen.
- **Webview:**
  - Decrypted data is never written to localStorage, sessionStorage, IndexedDB or Cache Storage. This is enforced by an ESLint rule.
  - The one exception is `src/lib/bootPrefs.ts`, which stores only the `emp.boot` key (D-23).
  - The password input is cleared right after `invoke`.

### 9.12 Tauri configuration (security-relevant)
```jsonc
{
  "productName": "EMP", "identifier": "com.devartin.emp",
  "app": {
    "withGlobalTauri": false,
    "windows": [{ "label": "main", "title": "EMP", "width": 1280, "height": 820, "minWidth": 800, "minHeight": 560,
                  "visible": false, "devtools": false, "dragDropEnabled": true,
                  "titleBarStyle": "Overlay", "hiddenTitle": true, "trafficLightPosition": { "x": 16, "y": 18 } }],
    "security": {
      "pattern": { "use": "isolation", "options": { "dir": "../src-tauri/isolation" } },
      "freezePrototype": true,
      "assetProtocol": { "enable": false },
      "dangerousDisableAssetCspModification": ["style-src"],
      "csp": {
        "default-src": "'self'", "script-src": "'self'", "style-src": "'self' 'unsafe-inline'",
        "img-src": "'self' data: blob: emp-asset: http://emp-asset.localhost",
        "media-src": "'self' blob: emp-asset: http://emp-asset.localhost",
        "font-src": "'self'", "connect-src": "ipc: http://ipc.localhost", "worker-src": "'self' blob:",
        "frame-src": "'none'", "child-src": "'none'", "object-src": "'none'", "base-uri": "'none'",
        "form-action": "'none'", "frame-ancestors": "'none'", "manifest-src": "'none'"
      },
      "capabilities": ["main", "settings"]
    }
  },
  "plugins": { "updater": { "pubkey": "<minisign public key>", "endpoints": ["https://github.com/devartin/ultra-note/releases/latest/download/latest.json"] } },
  "bundle": { "targets": "all", "createUpdaterArtifacts": true }
}
```
- On Windows, `decorations: false` is applied at runtime. Linux keeps the system decorations.
- `devCsp` allows the Vite origin and `ws:` in debug builds only. CI asserts that the release config contains no `localhost:` dev origins.
- `index.html` contains one inline boot script. It is allowed by a sha256 hash that a build script adds to `script-src`.
- `unsafe-eval` and `wasm-unsafe-eval` are never allowed in the desktop build. The WASM mock exists only in browser builds, which use their own meta-tag CSP that adds `'wasm-unsafe-eval'`.

### 9.13 Capabilities and command allowlist
- **`build.rs`:** `tauri_build::try_build(Attributes::new().app_manifest(AppManifest::new().commands(&ALL_COMMANDS)))`. `ALL_COMMANDS` is the list in §11. Any command not on that list cannot be called from JS.
- **`capabilities/main.json`:**
  - Applies to windows `["main"]`.
  - Sets `local: true`.
  - Grants:
    - `core:event:allow-listen`, `core:event:allow-unlisten`
    - `core:window:allow-{minimize,toggle-maximize,close,start-dragging,set-title,is-maximized,show}`
    - `core:app:allow-version`
    - `allow-<command>` for every command in §11
    - `updater:allow-check`, `updater:allow-download-and-install`
    - `process:allow-restart`
- **Never granted:** `shell:*`, `fs:*`, `http:*`, `opener:*`, `dialog:*`, `clipboard-manager:allow-read-*`, `deep-link:*`, or any `remote.urls`. Dialogs, the opener and the clipboard are driven only from Rust.
- **`capabilities/settings.json`:** reserved for a future settings window. Empty in v1.
- **Isolation hook (`src-tauri/isolation/index.js`):**
  - Zero dependencies.
  - Allows only command names on a hard-coded list.
  - Rejects serialised payloads over 8 MiB.
  - Shape-checks `vault_*`, `secret_*`, `open_external`, `backup_restore` and `export_*`.
  - Allows only one `vault_unlock` in flight at a time.
  - Authoritative validation is always done again in Rust.
- **Navigation:**
  - `on_navigation` accepts only `tauri://localhost/*` and `http://tauri.localhost/*`. Anything else is denied, and http(s) URLs are routed to `open_external`.
  - New windows are denied. The frontend intercepts `target=_blank` and `window.open`.
  - All webview permission requests are denied: camera, microphone, geolocation, notifications and clipboard-read.

### 9.14 File access via grants
- `file_pick({purpose, filters, multiple, mode})` opens the native dialog from Rust and returns `FileGrant[] {grantId, displayName, size}`.
- **Grant properties:**
  - 128-bit random id
  - canonicalised path
  - purpose and mode
  - expires after 10 minutes
  - single use
- **Drag-and-drop:** Rust handles the window's drag-drop event and emits `file:dropped {grants}`.
- **Commands that take files** accept only `grantId`. They reject a mismatched purpose, an expired grant or a reused grant.
- **Save:** `file_save_grant({purpose, suggestedName, filters})` opens a save dialog from Rust and returns a write grant.

### 9.15 Content security
- **Schema boundary.** The TipTap schema is the security boundary. There is no generic HTML node, no script, no iframe, and no `on*` attribute.
- **Link `href`** allows only `https:`, `http:`, `mailto:` and internal `emp://page/<id>[#blockId]`. Any other scheme drops the mark but keeps the text. Clicks call `open_external`, except internal links, which navigate inside the app.
- **Image `src`** must be an asset id. A pasted data URI image (png, jpeg, gif or webp, ≤ 10 MiB) is converted to an asset. A remote URL becomes a "Remote image · Load" placeholder. Clicking Load fetches it through NetGuard with a 20 MiB cap and image types only, then stores it as an asset.
- **Paste HTML** goes through DOMPurify configured as:

  ```
  USE_PROFILES:{html:true}
  FORBID_TAGS:['style','iframe','object','embed','form','input','svg','math','template','base','link','meta']
  FORBID_ATTR:['style','srcset','formaction','xlink:href']
  ALLOWED_URI_REGEXP:/^(?:https?:|mailto:|emp:\/\/page\/)/i
  ```

  Schema parsing runs afterwards.
- **Imported HTML** (Notion, Markdown with raw HTML) is sanitised in Rust with `ammonia`, using the same allowlist.
- **Rendering libraries:**
  - KaTeX: `trust:false`.
  - Syntax highlighting: builds DOM nodes, never uses `innerHTML`.
  - Provider and Google text renders as text nodes only.
- **ESLint, enforced in CI:**
  - `react/no-danger` is an error. The only exception is `src/ui/SanitizedHtml.tsx`, which accepts a branded `SanitizedHtml` type.
  - `no-eval`, `no-implied-eval` and `no-new-func`.
  - `eslint-plugin-no-unsanitized`.
  - `no-restricted-globals` blocks localStorage, sessionStorage and indexedDB everywhere except `bootPrefs.ts`.
- **Templates and life apps** are declarative JSON only: no code and no remote fetches.
- **Imported `.emptemplate` files** (P1) are capped at 20 MiB and validated against the schema.

### 9.16 Import hardening (all importers)
- **Common wrapper:**
  - runs on a blocking thread inside `catch_unwind`
  - takes a `CancellationToken`
  - wall-time budget of 60 s (the user can extend it)
  - progress reported through job events
- **Zip input** is pre-scanned before anything else:
  - at most 10,000 entries
  - total uncompressed size ≤ 512 MiB (the Notion importer allows 4 GiB after confirmation)
  - compression ratio per entry ≤ 100:1
  - no encrypted entries
  - no `..`, absolute paths or symlink entries
  - entries are never extracted to disk
- **XLSX, XLS, ODS (calamine):**
  - Excel limits apply: 1,048,576 × 16,384.
  - Default cap of 5,000,000 cells. Above that, ask for confirmation.
  - Macros are dropped with a notice.
  - External references import as `#REF!`, with the original text kept.
  - DDE-style formulas import as text.
  - XML is parsed without DTD or entity resolution. Tests assert this.
- **CSV:**
  - Streaming parse.
  - Size cap of 1 GiB. Above 100 MiB, ask for confirmation.
  - Encoding: UTF-8, UTF-16 with a BOM, or Windows-1252 (detected with `chardetng` and `encoding_rs`).
  - Cells starting with `= + - @ \t \r` import as text unless the user ticks "Treat formulas as formulas".
- **OFX and QFX:**
  - Version 1.x uses a tolerant SGML tokenizer with no DTD.
  - Version 2.x uses `quick-xml` with entity resolution disabled.
  - Amounts are parsed as `Decimal` and bounded to |x| < 10^15.
- **ICS:** recurrence expansion is capped at 5,000 instances per event and a 10-year horizon.
- **Images:** checked against the limits in §9.7.
- **PDF:** never parsed in v1. Stored as an asset and opened externally after a confirmation. It is decrypted to `vaults/<id>/tmp/` with mode 0600, and that directory is wiped on lock, quit and start.
- **Fuzzing:** `cargo-fuzz` targets cover the envelope, keyslot, snapshot header, OFX, QIF, CSV sniff, zip pre-scan, path normaliser, formula lexer and parser, Markdown import and ICS. Each target runs for 60 s per PR and 30 min nightly.

### 9.17 Formula engine limits
- **Purity.** The engine is a pure function of its inputs. The only things injected are the clock and a market or FX snapshot. `STOCK` and `FX` read the local cache only. They return `#FETCH` while data is pending and enqueue a fetch outside the engine.
- **Rejected at parse time:** `WEBSERVICE`, `FILTERXML`, `RTD`, `CALL`, `REGISTER.ID`, `DDE`, `EXEC`, external workbook references, and macros.
- **Size limits:**

  | Limit | Value |
  |---|---|
  | Formula length | 8,192 characters |
  | Parser depth | 256 |
  | Call nesting | 64 |
  | Arguments | 255 |
  | Operations per recalc | 50,000,000 (cancellable; shows "Calculation paused — formula too expensive") |
  | Spill size | 1,000,000 cells |
  | Text result | 32,767 characters |
  | Iterative calc | off by default; when on, 100 iterations or a 0.001 delta |
  | LET and LAMBDA depth | 1,024 (LAMBDA is P1) |

- **Regex functions** use the `regex` crate with `size_limit(1 MiB)` and `dfa_size_limit(2 MiB)`.
- **XLSX export:**
  - Text is written with `write_string`.
  - Formulas are written only from parsed ASTs.
  - Sheet names are sanitised: none of `[]:*?/\`, at most 31 characters.
- **CSV export:** "Protect against formula injection" (on by default) prefixes `'` to any cell that starts with a dangerous character.

### 9.18 NetGuard (all egress)
- **Client setup.** A single `reqwest::Client` with:
  - rustls and the platform verifier
  - `https_only(true)`
  - connect timeout 10 s, total timeout 30 s
  - at most 3 redirects, all of which must stay inside the integration's host allowlist
  - user agent `EMP/<version>`, plus a contact email only for SEC EDGAR, and only if the user supplied one (P1)
- **Response limits.** Body caps by response type:

  | Response type | Cap |
  |---|---|
  | Default | 5 MiB |
  | Images | 20 MiB |
  | Google Drive export | 50 MiB |
  | Market history | 20 MiB |

  The content type must match what was expected. JSON is decoded into strict serde structs.
- **Host allowlists.** Every connector declares a static list:

  | Connector | Hosts |
  |---|---|
  | `google` | `oauth2.googleapis.com`, `www.googleapis.com`, `sheets.googleapis.com`, `docs.googleapis.com` (`accounts.google.com` is opened in the browser only) |
  | `frankfurter` | `api.frankfurter.app` |
  | `stooq` | `stooq.com` |
  | `coingecko` | `api.coingecko.com` |
  | `finnhub` | `finnhub.io` |
  | `tiingo` | `api.tiingo.com` |
  | `yahoo` (P1, off) | `query1.finance.yahoo.com`, `query2.finance.yahoo.com` |
  | `updater` | `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com` |
  | `remote-image` (user content) | any public host |

- **Private-address blocking.** For user-content fetches, these ranges are blocked: 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, 0/8, ::1, fc00::/7 and fe80::/10. DNS is resolved first and the connection goes only to the vetted IP.
- **Credentials.** A credential is bound to its provider's hosts and is never attached elsewhere, including after a redirect.
- **Rate limits and failure handling.**
  - Each provider has a `governor` rate limiter.
  - Retries use exponential backoff with jitter and honour `Retry-After`.
  - After 5 failures a circuit breaker opens for 5 minutes and shows an amber dot.
- **Offline mode.** `network_set_offline(true)` refuses every request, including the updater.
- **Network log.** An encrypted ring buffer in `kv` (`ns=net.log`) keeps the last 1,000 entries `{at, connector, method, host, pathTemplate, status, bytes}`. Query strings are never logged.
- **No telemetry.** EMP sends no telemetry, ever.

### 9.19 Google OAuth (installed app, RFC 8252 + RFC 7636)
1. **Client.** The user creates a "Desktop app" client and enters a client ID and client secret. These are stored encrypted as `secret:<random16>` with provider `google-client`.
2. **Connect.** Connecting requires re-auth. On connect:
   - `code_verifier` = base64url of 32 random bytes; `code_challenge` = base64url(SHA-256(verifier)), method S256.
   - `state` = base64url of 32 random bytes, kept in memory and single-use.
   - A listener binds `127.0.0.1:0`. The redirect URI is `http://127.0.0.1:<port>/oauth/callback`.
   - The system browser opens the authorization URL with `access_type=offline`, `include_granted_scopes=true`, and `prompt=consent` on first connect.
3. **Callback listener.**
   - Accepts only `GET /oauth/callback`.
   - The `Host` header must equal `127.0.0.1:<port>`.
   - `state` is compared in constant time.
   - It accepts one valid request, then shuts down. It times out after 5 minutes.
   - It responds with a self-contained page carrying `CSP: default-src 'none'` and the text "You can close this tab and return to EMP."
4. **Token exchange.** The exchange happens in Rust. The refresh token, scopes and an account label are stored as a secret. The access token lives only in memory.
5. **Expired grant.** On `invalid_grant`, set the account status to `reauth_required` and show a "Reconnect Google" toast. The setup wizard warns that Testing-mode tokens expire after 7 days and recommends publishing the app.
6. **Disconnect.** Call `POST https://oauth2.googleapis.com/revoke`, then delete the secret. Cached data is optionally deleted too.
7. **Scopes.** Scopes are requested incrementally:

   | Feature | Scope |
   |---|---|
   | Calendar read | `https://www.googleapis.com/auth/calendar.readonly` |
   | Docs import by URL | `https://www.googleapis.com/auth/documents.readonly` |
   | Sheets import by URL | `https://www.googleapis.com/auth/spreadsheets.readonly` |
   | Export of new files EMP creates | `https://www.googleapis.com/auth/drive.file` |
   | Account label | `openid email` |
   | Calendar write (P1) | `https://www.googleapis.com/auth/calendar.events` |

8. **Locked vault.** Integrations run only while the vault is unlocked.

### 9.20 Metadata visible on disk with encryption on (documented in-app)

**Visible:**
- That a vault exists, its `vault_id`, its creation day and its KDF params.
- Counts of workspaces, pages, rows and assets.
- The page tree shape (`parent_id`) and page `kind`.
- `created_at`, `updated_at` and `deleted_at` timestamps, and revisions.
- Padded payload sizes and asset sizes.
- Version reasons.
- Reminder fire times (only when "Allow reminders while locked" is on; P1).
- Provider names in `outbox` and `sync_links`.
- `security_log` event types.
- File modification times.

**Not visible:** titles, text, documents, property names and values, views, asset names, MIME types and contents, tickers, account names, amounts, remote ids, tokens, keys, and the search index.

Secret ids are random (`secret:<random16>`), with the provider name stored inside the payload.

Security Center recommends full-disk encryption (FileVault, BitLocker or LUKS) to cover the remaining metadata.

### 9.21 Backups

**`.empsnap` (automatic snapshots)**
- File layout: `magic "EMPSNAP\0" || u16be(1) || u32be(manifest_len) || manifest(CBOR) || sqlite_bytes || mac[32]`.
- The manifest is `{vault_id, created_at, app_version, schema_version, write_counter, mset_root, blobs:[(name, size, sha256_ct)]}`.
- `mac = HMAC(k_backup_mac, everything before it)`.
- `sqlite_bytes` comes from `VACUUM INTO` a temp file in the vault directory, with `secure_delete` on.
- Blobs are copied as their already-encrypted files into `<snap>.blobs/`.
- In a plaintext vault, snapshots require a backup password set in Security Center. The whole container is encrypted with a key derived from that password (Argon2id Standard profile, 16-byte salt) using XChaCha20-Poly1305 STREAM in 64 KiB chunks, and its header stores the KDF parameters. If no backup password is set, snapshots are skipped and Security Center warns: "Automatic backups are off: set a backup password".
- Schedule: on quit (at most once every 6 h) and daily.
- Retention: 7 daily, 4 weekly and 6 monthly.
- Location: `<data>/vaults/<id>/snapshots/` by default, or a user folder (iCloud Drive, Dropbox, NAS and so on).

**`.empbackup` (manual)**
- Same container as `.empsnap`, packed as a single file with blobs appended (`u64be` length-prefixed entries).
- Optionally protected with a separate backup password.

**Restore**
1. Verify the magic, version and sizes.
2. Open the SQLite part read-only with `DEFENSIVE`, `trusted_schema=OFF` and `integrity_check`.
3. Verify that `sqlite_master` contains exactly the expected objects: no triggers beyond §10's, no views, no extra tables.
4. Unlock with the snapshot's keyslots, using the password or recovery key that was current when the snapshot was taken.
5. Verify the MAC and the manifest.
6. Import into a **new** vault directory. Restore never overwrites in place.

**Export**
- Unencrypted exports require re-auth and the checkbox "I understand this file is readable by anyone who has it".
- `age` export is P1.

### 9.22 Approved user-facing copy
**Approved claims:**
- "Your workspace lives on your computer. EMP has no servers and no accounts, and we never receive your data."
- "Optional encryption at rest: everything you write is encrypted on your device with 256-bit XChaCha20-Poly1305, under a key protected by your password using Argon2id."
- "Your password never leaves this device, and we can't reset it. Your recovery key is the only other way in, so keep it safe."
- "API keys and account connections are always stored encrypted."
- "Nothing connects to the internet unless you turn on an integration. You can see every request EMP makes in Security Center."
- "Tamper-evident: EMP detects if encrypted items are modified outside the app."

**Banned words and phrases (CI greps `src/` and `docs/` for these):** "military-grade", "military grade" (except inside the FAQ answer below), "bank-level", "unhackable", "unbreakable", "NSA-proof", "quantum-proof", "zero-knowledge", "100% secure", "FIPS".

**FAQ: "Is EMP military-grade encryption?"**
> "Military grade" isn't a technical standard, so we don't use the term. EMP uses modern, widely reviewed cryptography (XChaCha20-Poly1305 with 256-bit keys and Argon2id password hashing) with conservative settings. It has not been certified by any government program. In practice, your security depends most on a strong password and keeping your computer free of malware. If someone can run software on your computer while EMP is unlocked, no app-level encryption can stop them.

### 9.23 Clipboard, privacy, logging
- **Clipboard:**
  - When EMP copies a secret, recovery words or a passphrase, it writes them from Rust with concealed hints: `org.nspasteboard.ConcealedType` on macOS; `ExcludeClipboardContentFromMonitorProcessing`, `CanIncludeInClipboardHistory=0` and `CanUploadToCloudClipboard=0` on Windows.
  - It clears the value after 30 s if the clipboard still holds it (compared by SHA-256), and also clears it on lock.
- **Blur when inactive:** applies a 12px blur over 160ms when the window loses focus. Default off, except on views tagged `sensitivity: high`.
- **Logging:**
  - `tracing` writes to `logs/emp.log`, rotated at 5 × 5 MiB, at level info in release builds.
  - The redaction layer drops any field whose name matches `*token*`, `*secret*`, `*password*` or `*key*`.
  - Never logged: record content, titles, queries, imported file names (a hash is logged instead), or URLs with query strings.
- **Copy diagnostics:** copies only versions, OS, flags and error codes.
- **Temp files:** never written to the OS temp directory. Only `vaults/<id>/tmp/` (mode 0600) is used.
- **Permissions:**
  - Directories are 0700 and files are 0600 on Unix. These are re-asserted at startup, with a warning if the vault directory is group- or world-readable.
  - Windows keeps the default `%APPDATA%` ACL.
---

## 10. SQLite schema

### 10.1 Files and pragmas
```
<app_data_dir>/                         # Tauri path().app_data_dir() for com.devartin.emp; mode 0700
  config.json                           # {lastVaultId, windowState} — non-sensitive only
  emp.lock                              # fd-lock: one process per data dir
  vaults/<vault_id_hex>/
    vault.db  vault.db-wal  vault.db-shm
    assets/<2 hex>/<blob_name>
    snapshots/*.empsnap  snapshots/*.empsnap.blobs/
    backups/pre-v{N}-{ts}.sqlite        # pre-migration copies (keep last 3)
    tmp/                                # decrypted temp files; wiped on lock/quit/start
  logs/emp.log*
  device.key                            # only if no OS keychain (0600)
```
v1 creates a single vault called "Personal". Multiple vaults are P1. The directory layout already supports them.

Every connection runs these pragmas:
```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;          -- FULL is set per-transaction for keyslot/vault_state/vault_meta writes
PRAGMA foreign_keys = ON;
PRAGMA secure_delete = ON;
PRAGMA temp_store = MEMORY;
PRAGMA trusted_schema = OFF;
PRAGMA cell_size_check = ON;
PRAGMA mmap_size = 268435456;
PRAGMA cache_size = -32768;
PRAGMA busy_timeout = 5000;
PRAGMA wal_autocheckpoint = 1000;
-- at creation only: PRAGMA auto_vacuum = INCREMENTAL; PRAGMA page_size = 4096;
```
Connection-level settings:
- `SQLITE_DBCONFIG_DEFENSIVE` is on.
- `load_extension` is never enabled.
- Limits: `SQLITE_LIMIT_LENGTH` 64 MiB, `SQLITE_LIMIT_SQL_LENGTH` 1 MiB, `SQLITE_LIMIT_ATTACHED` 1.
- Every statement goes through `prepare_cached`.

Threading:
- One writer thread owns the write connection. It receives `WriteOp` batches over a bounded channel with capacity 256.
- A pool of 4 reader connections serves reads.
- The idle GC job runs `PRAGMA incremental_vacuum(2000)`.

### 10.2 DDL (migration 0001)
All tables are `STRICT`. Ids are lowercase UUIDv7 `TEXT`, with two exceptions: `blob_name`, and `secret:` ids, which are random. Timestamps are unix milliseconds stored as `INTEGER`. `sort_key` is a base-62 fractional index generated by `generateKeyBetween`.

```sql
CREATE TABLE vault_meta (key TEXT PRIMARY KEY, value BLOB NOT NULL) STRICT;
-- keys: format_version(1), vault_id(16 bytes), encryption('on'|'off'), created_day('YYYY-MM-DD'),
--       failed_unlocks(int), lockout_until(ms), header_mac(32 bytes), app_min_version, pending_payload_migrations(json)

CREATE TABLE keyslots (
  slot_id     INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('password','recovery','device')),
  kdf         TEXT NOT NULL CHECK (kdf IN ('argon2id-v13','hkdf-sha256','none')),
  kdf_params  BLOB NOT NULL,
  salt        BLOB NOT NULL,
  nonce       BLOB NOT NULL CHECK (length(nonce) = 24),
  wrapped_dek BLOB NOT NULL CHECK (length(wrapped_dek) = 48),
  key_epoch   INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE vault_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  write_counter INTEGER NOT NULL,
  mset_root BLOB NOT NULL CHECK (length(mset_root) = 32),
  state_mac BLOB NOT NULL CHECK (length(state_mac) = 32)
) STRICT;

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY, sort_key TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL     -- WorkspacePayload
) STRICT;

CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('doc','database','sheet','app','dashboard')),
  sort_key TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted_at INTEGER, trash_root INTEGER NOT NULL DEFAULT 0,        -- 1 on the page the user deleted
  rev INTEGER NOT NULL DEFAULT 0,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL   -- PagePayload
) STRICT;
CREATE INDEX pages_tree  ON pages(workspace_id, parent_id, sort_key) WHERE deleted_at IS NULL;
CREATE INDEX pages_trash ON pages(workspace_id, deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE page_docs (
  owner_id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('page','row')),
  rev INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL   -- DocPayload {v, format:'tiptap-json@1', doc}
) STRICT;

CREATE TABLE databases (
  id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  schema_rev INTEGER NOT NULL DEFAULT 0, data_rev INTEGER NOT NULL DEFAULT 0, rev INTEGER NOT NULL DEFAULT 0,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL   -- DatabasePayload
) STRICT;

CREATE TABLE db_properties (
  id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  sort_key TEXT NOT NULL, deleted_at INTEGER, rev INTEGER NOT NULL DEFAULT 0,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL   -- PropertyPayload {v,name,type,config,role?,hidden}
) STRICT;
CREATE INDEX db_properties_db ON db_properties(database_id, sort_key);

CREATE TABLE db_rows (
  id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  sort_key TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
  rev INTEGER NOT NULL DEFAULT 0,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL   -- RowPayload {v, values:{propId:CellValue}, icon?, tags?:['sample']}
) STRICT;
CREATE INDEX db_rows_db ON db_rows(database_id, sort_key) WHERE deleted_at IS NULL;

CREATE TABLE db_views (
  id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  sort_key TEXT NOT NULL, deleted_at INTEGER, rev INTEGER NOT NULL DEFAULT 0,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL   -- ViewPayload
) STRICT;
CREATE INDEX db_views_db ON db_views(database_id, sort_key);

CREATE TABLE workbooks (
  id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  rev INTEGER NOT NULL,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL   -- {v, styles[], namedRanges, calc:{iterative,maxIter,maxChange,date1904}}
) STRICT;

CREATE TABLE sheets (
  id TEXT PRIMARY KEY,
  workbook_id TEXT NOT NULL REFERENCES workbooks(id) ON DELETE CASCADE,
  sort_key TEXT NOT NULL, rev INTEGER NOT NULL,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL   -- {v,name,color,hidden,frozen,colWidths,rowHeights,merges,condFormats,validations,charts,maxRow,maxCol}
) STRICT;

CREATE TABLE sheet_bands (
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  band INTEGER NOT NULL,                                             -- row >> 8 (256 rows)
  rev INTEGER NOT NULL,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL,  -- {v, cells:[[rowOff,col,input,cached,styleId],...]}
  PRIMARY KEY (sheet_id, band)
) STRICT;

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  blob_name TEXT NOT NULL,
  stored_size INTEGER NOT NULL,
  wrapped_fk BLOB,                                                   -- NULL when vault unencrypted
  key_epoch INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL   -- {v,name,mime,size,width?,height?,source,originUrl?}
) STRICT;
CREATE INDEX assets_blob ON assets(blob_name);

CREATE TABLE versions (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('page_doc','db_row','db_schema','sheet','workbook')),
  created_at INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('auto','manual','pre_restore','pre_import','pre_bulk','pre_migration','pre_lifeapp')),
  stored_size INTEGER NOT NULL,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL   -- {v,label?,snapshot} (zstd always)
) STRICT;
CREATE INDEX versions_target ON versions(target_id, created_at DESC);

CREATE TABLE settings (
  scope TEXT NOT NULL CHECK (scope IN ('device','vault')),
  key TEXT NOT NULL, updated_at INTEGER NOT NULL,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL,
  PRIMARY KEY (scope, key),
  CHECK (scope = 'vault' OR enc = 0)                                 -- device scope readable pre-unlock; never sensitive
) STRICT;

CREATE TABLE secrets (
  id TEXT PRIMARY KEY,                                               -- 'secret:<random16 hex>'
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0,
  enc INTEGER NOT NULL CHECK (enc = 1),
  payload BLOB NOT NULL                                              -- {v, provider, label, kind:'api_key'|'oauth'|'client'|'field', allowedHosts[], data, last4?}
) STRICT;

CREATE TABLE kv (
  ns TEXT NOT NULL, key TEXT NOT NULL,                               -- sensitive namespaces store hex(HMAC(k_blind, key))[..32]
  updated_at INTEGER NOT NULL, expires_at INTEGER,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL,
  PRIMARY KEY (ns, key)
) STRICT;
CREATE INDEX kv_expiry ON kv(expires_at) WHERE expires_at IS NOT NULL;
-- namespaces: ui.*, market.quote, market.bars, market.search, market.alerts, fx.rates, net.log, gcal.sync, search.recent, lifeapp.cache

CREATE TABLE watchlists (
  id TEXT PRIMARY KEY, sort_key TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL   -- {v,name,symbols:[{key,alertAbove?,alertBelow?,alertPct?}]}
) STRICT;

CREATE TABLE lifeapp_instances (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,                                              -- plaintext: 'money-hq' etc. (documented leakage: which apps are installed)
  installed_at INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL   -- {v, manifestVersion, answers, keyMap:{templateKey:recordId}, touched:{recordId:[field]}, muted:{ruleId:until}, detached:bool, rootPageId, checklist:{itemId:doneAt}}
) STRICT;

CREATE TABLE sync_links (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, local_id TEXT NOT NULL,
  remote_key TEXT NOT NULL, updated_at INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL,  -- {v, remoteId, etag, accountId, lastSyncedRev}
  UNIQUE (provider, remote_key)
) STRICT;
CREATE INDEX sync_links_local ON sync_links(local_id);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL,
  created_at INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, rev INTEGER NOT NULL DEFAULT 0,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL
) STRICT;
CREATE INDEX outbox_due ON outbox(next_attempt_at);

CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  fire_at INTEGER NOT NULL, fired_at INTEGER, rev INTEGER NOT NULL DEFAULT 0,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL   -- {v, targetKind, targetId, blockId?, text}
) STRICT;
CREATE INDEX reminders_due ON reminders(fire_at) WHERE fired_at IS NULL;

CREATE TABLE security_log (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('unlock_ok','unlock_fail','lock','pw_change','recovery_regen','recovery_unlock',
        'enc_on','enc_off','export_plain','backup_create','backup_restore','integrity_fail','reseal','secret_reveal','integration_connect'))
) STRICT;

CREATE TRIGGER rows_purge_docs  AFTER DELETE ON db_rows BEGIN DELETE FROM page_docs WHERE owner_id = OLD.id; DELETE FROM versions WHERE target_id = OLD.id; END;
CREATE TRIGGER pages_purge_docs AFTER DELETE ON pages   BEGIN DELETE FROM page_docs WHERE owner_id = OLD.id; DELETE FROM versions WHERE target_id = OLD.id; END;
PRAGMA user_version = 1;
```
P1 migration 0002 adds `synced_blocks`, `comments` and `key_epochs`, using the shapes in the architecture lens.

### 10.3 Payload shapes (Rust structs; every payload carries `"v": n`)
```ts
WorkspacePayload   { v:1; name:string; icon?:Icon; favorites:Id[]; recents:Id[]; defaults:{ font:'sans'|'serif'|'mono'; fullWidth:boolean; smallText:boolean } }
PagePayload        { v:1; title:string; icon?:Icon; cover?:Cover; flags:PageFlags; appInstanceId?:Id; templateKey?:string }
DatabasePayload    { v:1; description?:RichText; primaryPropId:Id; uidPrefix?:string; uidSeq:number; inline:boolean;
                     templates:RowTemplate[]; defaultTemplateId?:Id; hideEmptyProps:boolean; roles:Record<string,Id> /* semantic role → propId */ }
PropertyPayload    { v:1; name:string; type:PropType; config:PropConfig; role?:string; hidden:boolean; description?:string }
RowPayload         { v:1; values:Record<Id,CellValue>; icon?:Icon; tags?:('sample')[] }
ViewPayload        { v:1; name:string; icon?:string; layout:Layout; filter?:Filter; sorts:Sort[]; groupBy?:GroupBy; visibleProps:Id[];
                     propWidths:Record<Id,number>; wrap:Record<Id,boolean>; card?:CardSettings; calendar?:{dateProp:Id; showWeekends:boolean};
                     chart?:ChartSpec; footerAggs:Record<Id,AggFn>; collapsedGroups:string[]; openIn:'side_peek'|'full_page' }
```
**Upcasts.** Readers run an upcast chain `upcast_<table>(v, Value) -> Value`. Writers always write the latest version.

**Deferred payload migrations:**
- Changes that need decrypted data are recorded in `vault_meta.pending_payload_migrations`.
- After unlock they run in batches of 500 rows, idempotently and resumably.
- Until they finish, reads upcast lazily.

**Structural migrations:**
- Each migration is an ordered `Migration { version, kind: Sql | Rust(fn) }` that runs inside a transaction.
- A pre-migration backup is taken before the first migration runs.
- If `user_version` is higher than the app knows, opening fails with `SCHEMA_TOO_NEW`.
- Fixture DBs live at `crates/emp-store/tests/fixtures/v{n}-{plain|enc}.sqlite`. Every released schema version has one in both variants, and CI migrates each fixture forward.

**Encryption on/off for an existing vault:**
- Rows are re-encrypted in batches of 1,000 per transaction. The job is resumable because the `enc` value is stored per row.
- Assets are rewritten.
- The job then runs `wal_checkpoint(TRUNCATE)` and `VACUUM`.
- Existing snapshots are re-encrypted (the default) or deleted.
- The UI warns that OS backups may still hold old plaintext.
---

## 11. IPC contract

### 11.1 Conventions

**Calling convention**
- Every command takes exactly one argument named `req`.
- The Rust type is `#[derive(Deserialize, TS)] #[serde(rename_all="camelCase", deny_unknown_fields)]`.
- The JS call is `invoke('<snake_name>', { req })`.

**TypeScript surface**
- ts-rs writes the generated types to `src/backend/types.gen/`.
- CI runs `npm run gen:types && git diff --exit-code`.
- The facade in `src/backend/contract.ts` is `interface EmpBackend`, with namespaced methods such as `api.page.get(req)`.
- Two implementations exist: `TauriBackend` and `MockBackend`.

**Commands that need a vault or confirmation**
- Every data command first calls `state.session()?`, which returns `LOCKED` when the vault is locked, and then stamps activity.
- Commands marked **(reauth)** return `REAUTH_REQUIRED` if `vault_reauth` was not called in the last 5 minutes.

**Long-running jobs**
- Commands marked **(job)** return `JobRef` immediately and stream `JobEvent` over the `onEvent: Channel<JobEvent>` field in `req`.
- They are cancellable with `job_cancel`.

**Binary data and files**
- Binary data never travels as JSON.
- Uploads use raw-body invoke, with metadata in headers.
- Downloads and rendering go through `emp-asset://`.
- Files are referenced only by grants (§9.14).

**Validation**
- Strings are bounded: titles ≤ 1,024, queries ≤ 512, formulas ≤ 8,192, URLs ≤ 4,096.
- Pages are bounded: list pages ≤ 1,000, query windows ≤ 500.
- Floats must be finite. Money values are decimal strings with scale ≤ 8.
- Debounced callers pass `reqId`, and the client drops stale responses.

### 11.2 Shared types
```ts
type Id = string; type Ts = number; type Rev = number; type SortKey = string;
type ErrorCode = 'LOCKED'|'BAD_PASSWORD'|'RATE_LIMITED'|'REAUTH_REQUIRED'|'NOT_FOUND'|'CONFLICT'|'INVALID'|'CRYPTO'|'INTEGRITY'
  |'IO'|'NETWORK'|'OFFLINE'|'AUTH_REQUIRED'|'PROVIDER'|'QUOTA'|'CANCELLED'|'UNSUPPORTED'|'SCHEMA_TOO_NEW'|'TOO_LARGE'|'INTERNAL';
interface ApiError { code: ErrorCode; message: string; details?: { field?: string; retryAfterMs?: number; currentRev?: Rev; correlationId?: string } }
type JobEvent = { kind:'progress'; done:number; total:number; label?:string } | { kind:'done'; result:unknown } | { kind:'error'; error:ApiError };
interface JobRef { jobId: Id }
type Channel<T> = import('@tauri-apps/api/core').Channel<T>;

type BlockColor = 'gray'|'brown'|'orange'|'yellow'|'green'|'blue'|'purple'|'pink'|'red';
type Icon  = { t:'emoji'; v:string } | { t:'lucide'; v:string; color?:BlockColor|'accent' } | { t:'asset'; assetId:Id };
type Cover = { t:'gradient'; v:'aurora'|'dusk'|'mint'|'sand'|'slate'|'rose' } | { t:'asset'; assetId:Id; posY:number /*0..1*/ };
type PageKind = 'doc'|'database'|'sheet'|'app'|'dashboard';
interface PageFlags { fullWidth?:boolean; smallText?:boolean; font?:'sans'|'serif'|'mono'; locked?:boolean; template?:boolean; inline?:boolean }
interface PageMeta { id:Id; workspaceId:Id; parentId:Id|null; kind:PageKind; sortKey:SortKey; title:string; icon?:Icon; cover?:Cover;
  createdAt:Ts; updatedAt:Ts; deletedAt?:Ts; rev:Rev; flags:PageFlags; appInstanceId?:Id; hasChildren:boolean }
interface TipTapNode { type:string; attrs?:Record<string,unknown>; content?:TipTapNode[]; marks?:{type:string;attrs?:Record<string,unknown>}[]; text?:string }
interface TipTapDoc { type:'doc'; attrs:{ schemaVersion:number }; content:TipTapNode[] }
type RichText = { text:string; marks?:{ type:'bold'|'italic'|'underline'|'strike'|'code'|'link'|'mention'|'textColor'|'highlight'; attrs?:Record<string,unknown> }[] }[];
type Money = { amount:string; currency:string };
type DateValue = { start:string; end?:string; time:boolean; tz?:string };   // start/end: 'YYYY-MM-DD' if !time else RFC3339
interface Rect { r0:number; c0:number; r1:number; c1:number }               // inclusive, 0-based
interface FileGrant { grantId:Id; displayName:string; size:number }
type SymbolKey = string;                                                     // 'AAPL:XNAS', 'VOD:XLON', 'BTC:CRYPTO', 'EURUSD:FX'
interface Insight { id:string; appInstanceId:Id; ruleId:string; severity:'info'|'tip'|'warn'|'critical'; title:string; body:string;
  math?:{ label:string; value:string; source?:string }[]; actions:{ label:string; route:Route }[]; mutedUntil?:Ts }
type Route = { t:'page'; id:Id; blockId?:string } | { t:'row'; id:Id } | { t:'db'; id:Id; viewId?:Id } | { t:'sheet'; id:Id; sheetId?:Id }
  | { t:'app'; instanceId:Id; tab?:string } | { t:'home' } | { t:'today' } | { t:'markets'; symbol?:SymbolKey }
  | { t:'settings'; section:string } | { t:'trash' } | { t:'lifeapps'; appId?:string } | { t:'lock' } | { t:'onboarding' };
```

### 11.3 Commands

Every command below is exported in `ALL_COMMANDS` (§9.13). To add a command, update this section in the same PR.

#### App, windows, network
```ts
app_info({}) → { version:string; commit:string; platform:'macos'|'windows'|'linux'; arch:string; webview:string;
  features:('reduced-transparency'|'vibrancy'|'mica'|'keychain'|'biometrics'|'eyedropper')[] }
app_ready({ marks:Record<string,number> }) → void
app_reveal_data_dir({}) → void
app_quit({}) → void
app_check_update({}) → { available:boolean; version?:string; notes?:string }            // OFFLINE if updates disabled/offline
app_install_update({ onEvent }) (job) ⇒ void
open_external({ url:string }) → void                                                     // §9.13: https|http(warn)|mailto; emits open-external:confirm unless host remembered
open_external_confirm({ requestId:Id; allow:boolean; rememberHost:boolean }) → void
file_pick({ purpose:'import'|'attach'|'restore'|'image'; filters:{ name:string; extensions:string[] }[]; multiple:boolean }) → FileGrant[]
file_save_grant({ purpose:'export'|'backup'; suggestedName:string; filters:{ name:string; extensions:string[] }[] }) → FileGrant | null
network_activity({ limit:number }) → { at:Ts; connector:string; method:string; host:string; path:string; status:number; bytes:number }[]
network_set_offline({ offline:boolean }) → { offline:boolean }
```

#### Vault and security
```ts
interface VaultStatus { state:'uninitialized'|'locked'|'unlocked'; encrypted:boolean; vaultId?:string;
  kdf?:{ mKiB:number; t:number; p:number; estMs:number; belowStandard:boolean }; recoveryConfirmed:boolean;
  autoLock:AutoLock; failedAttempts:number; retryAfterMs:number; schemaVersion:number; pendingMigrations:number;
  keychainAvailable:boolean; integrity:'ok'|'warning'|'unchecked'; reauthValidUntil?:Ts }
interface AutoLock { idleMinutes:number|null; onSleep:boolean; onScreenLock:boolean; onBlurMinutes:number|null; maxSessionHours:number|null }
vault_status({}) → VaultStatus
vault_create({ password?:string; profile:'standard'|'high'; autoLock:AutoLock }) → { status:VaultStatus; recoveryWords?:string[] }   // password omitted = unencrypted
vault_unlock({ password:string }) → VaultStatus                       // BAD_PASSWORD | RATE_LIMITED{retryAfterMs}
vault_unlock_recovery({ words:string[]; newPassword:string }) → VaultStatus
vault_lock({ reason?:'manual' }) → void
vault_activity_ping({}) → void
vault_reauth({ password:string }) → { validUntil:Ts }
vault_set_auto_lock(AutoLock) → VaultStatus                          // (reauth) if idleMinutes===null
vault_benchmark_kdf({}) → { mKiB:number; t:number; p:number; ms:number }
vault_strengthen_kdf({ password:string }) → VaultStatus
vault_change_password({ oldPassword:string; newPassword:string }) → VaultStatus
vault_enable_encryption({ password:string; onEvent }) (job) ⇒ { recoveryWords:string[] }
vault_disable_encryption({ password:string; confirm:'DECRYPT'; onEvent }) (reauth)(job) ⇒ void
vault_recovery_view({}) (reauth) → { words:string[] }                  // only if not yet confirmed; afterwards UNSUPPORTED → regenerate
vault_recovery_regenerate({}) (reauth) → { words:string[] }
vault_recovery_confirm({ positions:number[]; words:string[] }) → { confirmed:boolean }
vault_integrity_check({ onEvent }) (job) ⇒ { ok:boolean; damaged:{ table:string; id:string }[]; msetMismatch:boolean }
vault_integrity_reseal({}) (reauth) → void
security_log({ limit:number }) → { at:Ts; event:string }[]
password_strength({ password:string }) → { score:0|1|2|3|4; crackTime:string; warning?:string; suggestions:string[]; common:boolean }
password_generate({}) → { passphrase:string; bits:number }
```

#### Secrets
```ts
interface SecretInfo { id:Id; provider:string; label:string; kind:'api_key'|'oauth'|'client'|'field'; last4?:string; createdAt:Ts; lastUsedAt?:Ts }
secret_list({}) → SecretInfo[]
secret_set({ id?:Id; provider:string; label:string; kind:'api_key'|'client'; value:string; showLast4:boolean }) → SecretInfo   // write-only
secret_delete({ id:Id }) → void
```

#### Settings and kv
```ts
interface DeviceSettings { theme:'system'|'light'|'dark'|'midnight'; accent:'iris'|'ocean'|'jade'|'amber'|'ruby'|'orchid'|'graphite';
  density:'comfortable'|'compact'; textSize:'s'|'m'|'l'; motion:'system'|'reduced'|'full'; effects:'auto'|'full'|'reduced';
  contrast:'system'|'more'; numberColors:'standard'|'cvd'|'eastasian'|'mono'; readableFont:boolean; letterSpacing:boolean;
  updates:'off'|'check'; language:string }
interface VaultSettings { profileName:string; baseCurrency:string; locale:string; timezone:string; weekStart:0|1|6;
  dateFormat:'full'|'mdy'|'dmy'|'ymd'; clock:12|24; spellcheck:boolean; typography:boolean; markdownShortcuts:boolean;
  stripImageLocation:boolean; remoteImages:'ask'|'allow'|'block'; trashRetentionDays:number; hideNumbersOnLaunch:boolean;
  blurWhenInactive:boolean; clipboardClearSeconds:number; celebrations:boolean; startPage:'home'|'last'|Id;
  snapshots:{ enabled:boolean; folderGrantLabel?:string; keepDaily:number; keepWeekly:number; keepMonthly:number };
  marketProviders:{ order:string[]; refreshSeconds:number }; offline:boolean }
settings_get({}) → { device:DeviceSettings; vault?:VaultSettings }
settings_set_device({ patch:Partial<DeviceSettings> }) → DeviceSettings
settings_set_vault({ patch:Partial<VaultSettings> }) → VaultSettings
kv_get({ ns:`ui.${string}`; key:string }) → unknown|null
kv_set({ ns:`ui.${string}`; key:string; value:unknown }) → void
kv_get_many({ ns:`ui.${string}`; keys:string[] }) → Record<string,unknown>
```

#### Backup, import, export
```ts
backup_create({ grantId:Id; password?:string; onEvent }) (job) ⇒ { bytes:number }
backup_restore({ grantId:Id; password?:string; recoveryWords?:string[]; onEvent }) (job) ⇒ { vaultId:string; pages:number }  // opens as new vault, app restarts into it
snapshot_list({}) → { id:string; at:Ts; bytes:number; schemaVersion:number; location:'local'|'folder' }[]
snapshot_now({ onEvent }) (job) ⇒ { id:string }
snapshot_set_folder({ grantId:Id|null }) → void
snapshot_verify({ id:string; onEvent }) (job) ⇒ { ok:boolean }
import_detect({ grantId:Id }) → { kind:'markdown'|'markdown_folder'|'notion_zip'|'csv'|'xlsx'|'ofx'|'qfx'|'qif'|'ics'|'empbackup'|'unknown'; details:Record<string,unknown> }
import_markdown({ grantId:Id; workspaceId:Id; parentId:Id|null; onEvent }) (job) ⇒ { pages:number; warnings:string[] }
import_notion({ grantId:Id; workspaceId:Id; parentId:Id|null; onEvent }) (job) ⇒ { pages:number; databases:number; rows:number; assets:number; unresolved:{ title:string; ref:string }[]; warnings:string[] }
import_ics({ grantId:Id; target:'calendar'|{ databaseId:Id }; onEvent }) (job) ⇒ { events:number }
import_undo({ importJobId:Id }) → { removed:number }
export_pages({ pageIds:Id[]; format:'markdown'|'json'|'pdf'; includeChildren:boolean; includeAssets:boolean; grantId:Id; onEvent }) (job) ⇒ { files:number }   // (reauth) when vault encrypted
export_everything({ grantId:Id; onEvent }) (reauth)(job) ⇒ { bytes:number }
```
PDF export is driven by the frontend, which prints the page to a hidden print window with `window.print()`. `export_pages` with `format:'pdf'` returns `UNSUPPORTED` in v1. Native print-to-PDF is P1.

#### Workspaces
```ts
interface Workspace { id:Id; name:string; icon?:Icon; favorites:Id[]; defaults:{ font:'sans'|'serif'|'mono'; fullWidth:boolean; smallText:boolean } }
workspace_list({}) → Workspace[]
workspace_create({ name:string; icon?:Icon }) → Workspace
workspace_update({ id:Id; patch:{ name?:string; icon?:Icon|null; favorites?:Id[]; defaults?:Workspace['defaults'] } }) → Workspace
workspace_open({ id:Id }) → { workspace:Workspace; pages:PageMeta[]; recents:Id[]; lastRoute?:Route; lifeapps:LifeAppInstance[] }
```

#### Pages and docs
```ts
page_get({ id:Id }) → { meta:PageMeta; doc:TipTapDoc|null; docRev:Rev; breadcrumbs:{ id:Id; title:string; icon?:Icon }[] }
page_get_meta({ ids:Id[] }) → PageMeta[]
page_create({ workspaceId:Id; parentId:Id|null; kind:'doc'|'dashboard'; title?:string; icon?:Icon; afterId?:Id; templatePageId?:Id; doc?:TipTapDoc }) → { meta:PageMeta; docRev:Rev }
page_update_meta({ id:Id; patch:{ title?:string; icon?:Icon|null; cover?:Cover|null; flags?:Partial<PageFlags> } }) → PageMeta
page_save_doc({ ownerId:Id; ownerKind:'page'|'row'; doc:TipTapDoc; baseRev:Rev }) → { rev:Rev }       // CONFLICT {currentRev}
page_move({ id:Id; parentId:Id|null; beforeId?:Id; afterId?:Id }) → PageMeta                          // cycle check
page_duplicate({ id:Id; deep:boolean; onEvent }) (job) ⇒ PageMeta
page_turn_into_page({ sourceId:Id; blockIds:string[]; title:string }) → { meta:PageMeta; newSourceRev:Rev }
page_delete({ ids:Id[] }) → void
page_restore({ ids:Id[] }) → PageMeta[]                                                               // restores to root if parent gone
page_purge({ ids:Id[] }) → void
trash_list({ workspaceId:Id; q?:string }) → PageMeta[]
trash_empty({ workspaceId:Id; onEvent }) (job) ⇒ { purged:number }
page_backlinks({ id:Id }) → { sourceId:Id; sourceTitle:string; sourceIcon?:Icon; blockId?:string; snippet:string }[]
page_outline({ id:Id }) → { blockId:string; level:1|2|3; text:string }[]
page_get_block({ pageId:Id; blockId:string }) → { node:TipTapNode }|null
template_list({ workspaceId:Id }) → { id:string; title:string; icon?:Icon; builtin:boolean; category:string; kind:PageKind }[]
template_apply({ templateId:string; workspaceId:Id; parentId:Id|null }) → PageMeta
page_set_template({ id:Id; template:boolean }) → PageMeta
daily_note_open({ date:string /*YYYY-MM-DD*/ }) → PageMeta                                            // creates from template if missing
```

#### Versions
```ts
interface VersionMeta { id:Id; createdAt:Ts; reason:string; label?:string; size:number }
version_list({ targetId:Id; targetKind:'page_doc'|'db_row'|'db_schema'|'sheet'|'workbook' }) → VersionMeta[]
version_get({ id:Id }) → { snapshot:unknown }
version_create({ targetId:Id; targetKind:'page_doc'|'workbook'; label:string }) → VersionMeta
version_restore({ id:Id }) → { rev:Rev }
version_delete({ id:Id }) → void
```

#### Databases
```ts
type PropType = 'title'|'text'|'number'|'money'|'select'|'multi_select'|'status'|'date'|'checkbox'|'url'|'email'|'phone'|'files'
  |'relation'|'rollup'|'formula'|'created_time'|'updated_time'|'unique_id'|'rating'|'progress'|'ticker'|'recurrence'|'secret'|'computed';
type CellValue = { t:'text'; v:RichText } | { t:'number'; v:number|null } | { t:'money'; v:string|null; cur:string }
  | { t:'select'|'status'; v:Id|null } | { t:'multi'; v:Id[] } | { t:'date'; v:DateValue|null } | { t:'check'; v:boolean }
  | { t:'url'|'email'|'phone'; v:string|null } | { t:'files'; v:{ assetId:Id; name:string }[] } | { t:'relation'; v:Id[] }
  | { t:'uid'; v:string } | { t:'rating'|'progress'; v:number|null } | { t:'ticker'; v:SymbolKey|null }
  | { t:'recurrence'; v:{ rrule:string; dtstart:string; tz?:string; mode:'schedule'|'completion' }|null }
  | { t:'secret'; v:{ masked:string }|null }
  | { t:'computed'; v:{ kind:'number'|'money'|'text'|'bool'|'date'|'list'|'error'; value:unknown; display:string } }
  | { t:'ts'; v:Ts };
interface Property { id:Id; name:string; type:PropType; config:Record<string,unknown>; role?:string; hidden:boolean; sortKey:SortKey; description?:string }
type Filter = { and:Filter[] } | { or:Filter[] } | { prop:Id|'$created'|'$updated'; op:FilterOp; value?:unknown };
type FilterOp = 'eq'|'neq'|'contains'|'not_contains'|'starts_with'|'ends_with'|'empty'|'not_empty'|'gt'|'gte'|'lt'|'lte'
  |'between'|'any_of'|'none_of'|'all_of'|'group_eq'|'before'|'after'|'on_or_before'|'on_or_after'|'within'|'checked'|'unchecked';
type Sort = { prop:Id|'$created'|'$updated'|'$manual'; dir:'asc'|'desc' };
type GroupBy = { prop:Id; dateBucket?:'relative'|'day'|'week'|'month'|'year'; byStatusGroup?:boolean; hideEmpty?:boolean; order?:string[] };
type Layout = 'table'|'board'|'list'|'gallery'|'calendar'|'chart';
type AggFn = 'count'|'count_values'|'count_unique'|'empty'|'not_empty'|'pct_empty'|'pct_not_empty'|'sum'|'avg'|'median'|'min'|'max'|'range'
  |'earliest'|'latest'|'checked'|'unchecked'|'pct_checked';
interface ChartSpec { type:'bar'|'hbar'|'line'|'area'|'stacked_area'|'donut'|'combo'|'waterfall'|'sankey'|'treemap'|'heatmap';
  x:{ prop:Id|'$created'; bucket?:'day'|'week'|'month'|'quarter'|'year' }; y:{ agg:AggFn; prop?:Id; as?:'bar'|'line' }[];
  series?:{ prop:Id }; stacked?:boolean; cumulative?:boolean; labels?:boolean; smooth?:boolean; omitZero?:boolean; colors?:'auto'|'gainloss' }
interface View { id:Id; name:string; icon?:string; layout:Layout; filter?:Filter; sorts:Sort[]; groupBy?:GroupBy; visibleProps:Id[];
  propWidths:Record<Id,number>; wrap:Record<Id,boolean>; card?:{ preview:'none'|'cover'|'content'|Id; size:'s'|'m'|'l'; fit:boolean };
  calendar?:{ dateProp:Id; showWeekends:boolean }; chart?:ChartSpec; footerAggs:Record<Id,AggFn>; collapsedGroups:string[];
  openIn:'side_peek'|'full_page'; sortKey:SortKey }
interface RowTemplate { id:Id; name:string; icon?:Icon; values:Record<Id,CellValue|string /* '@today' etc. */>; doc?:TipTapDoc }
interface DbSchema { database:{ id:Id; title:string; icon?:Icon; description?:RichText; primaryPropId:Id; schemaRev:Rev; dataRev:Rev;
  templates:RowTemplate[]; defaultTemplateId?:Id; hideEmptyProps:boolean; roles:Record<string,Id>; appInstanceId?:Id };
  properties:Property[]; views:View[] }
interface RowDTO { id:Id; rev:Rev; sortKey:SortKey; createdAt:Ts; updatedAt:Ts; values:Record<Id,CellValue>; hasBody:boolean; icon?:Icon; sample?:boolean }

db_create({ workspaceId:Id; parentId:Id|null; title:string; inline:boolean; properties?:{ name:string; type:PropType; config?:Record<string,unknown> }[]; afterId?:Id }) → { page:PageMeta; schema:DbSchema }
db_get_schema({ id:Id }) → DbSchema
db_update({ id:Id; patch:{ description?:RichText; templates?:RowTemplate[]; defaultTemplateId?:Id|null; hideEmptyProps?:boolean; inline?:boolean } }) → DbSchema
db_duplicate({ id:Id; withRows:boolean; onEvent }) (job) ⇒ { page:PageMeta }
db_property_create({ databaseId:Id; name:string; type:PropType; config?:Record<string,unknown>; afterId?:Id }) → Property    // relation dual created atomically
db_property_update({ id:Id; patch:{ name?:string; config?:Record<string,unknown>; hidden?:boolean; description?:string } }) → Property
db_property_convert({ id:Id; to:PropType; config?:Record<string,unknown>; onEvent }) (job) ⇒ Property
db_property_delete({ id:Id; alsoDual?:boolean }) → void                                    // soft (restorable from Trash)
db_property_reorder({ id:Id; beforeId?:Id; afterId?:Id }) → Property
db_select_option_upsert({ propertyId:Id; option:{ id?:Id; name:string; color:BlockColor; group?:'todo'|'in_progress'|'complete' } }) → Property
db_select_option_delete({ propertyId:Id; optionId:Id }) → Property
db_query({ databaseId:Id; viewId?:Id; override?:{ filter?:Filter; sorts?:Sort[]; groupBy?:GroupBy|null; search?:string };
  window:{ offset:number; limit:number }; group?:string; props?:Id[]; knownQueryRev?:string; reqId:number })
  → { reqId:number; notModified:true } | { reqId:number; queryRev:string; total:number; rows:RowDTO[];
      groups?:{ key:string; label:string; color?:BlockColor; count:number; aggs:Record<Id,string> }[]; aggs:Record<Id,string>; tookMs:number }
db_query_range({ databaseId:Id; viewId:Id; dateProp:Id; from:string; to:string }) → RowDTO[]
db_chart_data({ databaseId:Id; viewId?:Id; filter?:Filter; spec:ChartSpec; maxPoints?:number })
  → { x:(string|number)[]; series:{ key:string; label:string; color?:string; values:(number|null)[] }[]; currency?:string; links?:{ source:number; target:number; value:number }[] }
db_row_get({ id:Id }) → { row:RowDTO; doc:TipTapDoc|null; docRev:Rev; databaseId:Id; prevId?:Id; nextId?:Id }
db_row_create({ databaseId:Id; values?:Record<Id,CellValue>; afterId?:Id; viewId?:Id; templateId?:Id }) → RowDTO
db_rows_update({ updates:{ id:Id; values:Record<Id,CellValue|null>; baseRev?:Rev }[] }) → RowDTO[]          // ≤ 1,000 per call
db_rows_delete({ ids:Id[] }) → void
db_rows_restore({ ids:Id[] }) → RowDTO[]
db_rows_move({ ids:Id[]; beforeId?:Id; afterId?:Id; groupValue?:{ prop:Id; value:CellValue } }) → RowDTO[]
db_rows_duplicate({ ids:Id[] }) → RowDTO[]
db_view_create({ databaseId:Id; name:string; layout:Layout; fromViewId?:Id }) → View
db_view_update({ id:Id; patch:Partial<Omit<View,'id'|'sortKey'>> }) → View
db_view_delete({ id:Id }) → void
db_view_reorder({ id:Id; beforeId?:Id; afterId?:Id }) → View
db_relation_options({ propertyId:Id; search:string; limit:number }) → { id:Id; title:string; icon?:Icon }[]
db_formula_check({ databaseId:Id; expression:string }) → { ok:boolean; type?:string; error?:{ message:string; from:number; to:number }; preview:string[] }
db_import_csv({ grantId:Id; target:{ databaseId:Id; mapping:Record<string,Id|'new'|'skip'> } | { workspaceId:Id; parentId:Id|null; title:string }; onEvent }) (job) ⇒ { databaseId:Id; inserted:number }
db_import_preview({ grantId:Id }) → { columns:{ name:string; inferred:PropType; sample:string[] }[]; rows:number; delimiter:string; encoding:string; sheets?:string[] }
db_export({ databaseId:Id; viewId?:Id; format:'csv'|'xlsx'; grantId:Id; onEvent }) (job) ⇒ { rows:number }
row_secret_reveal({ rowId:Id; propertyId:Id }) (reauth) → { value:string }                    // only command that returns a secret; UI clears after 30 s
```

#### Sheets
```ts
interface SheetMeta { id:Id; name:string; color?:BlockColor; hidden:boolean; frozen:{ rows:number; cols:number }; maxRow:number; maxCol:number; sortKey:SortKey }
interface PackedCells { r:number[]; c:number[]; d:string[]; k:number[] /*0 empty,1 num,2 text,3 bool,4 err,5 pending*/; f:number[] /*1 formula, 2 spill child*/; s:number[] }
interface CellStyle { font?:{ b?:boolean; i?:boolean; u?:boolean; s?:boolean; color?:string; size?:number }; fill?:string;
  align?:{ h?:'left'|'center'|'right'; v?:'top'|'middle'|'bottom'; wrap?:boolean }; numFmt?:string; border?:Partial<Record<'t'|'r'|'b'|'l',{ style:'thin'|'medium'|'thick'|'dashed'; color:string }>>; role?:'input'|'output'|'check' }
type CondFormatRule = { id?:Id; rect:Rect; kind:'cell'|'formula'|'data_bar'|'color_scale'; op?:'gt'|'lt'|'between'|'eq'|'text_contains'; values?:string[]; formula?:string; styleId?:number; colors?:string[] };
sheet_workbook_create({ workspaceId:Id; parentId:Id|null; title:string; template?:string }) → { page:PageMeta; sheets:SheetMeta[] }
sheet_workbook_get({ id:Id }) → { sheets:SheetMeta[]; styles:Record<number,CellStyle>; namedRanges:{ name:string; ref:string }[]; calc:{ iterative:boolean; date1904:boolean } }
sheet_get_range({ sheetId:Id; rect:Rect }) → { rev:Rev; cells:PackedCells; rowHeights:[number,number][]; colWidths:[number,number][]; merges:Rect[]; cf:{ r:number; c:number; styleId:number; bar?:number }[] }
sheet_get_cell({ sheetId:Id; row:number; col:number }) → { input:string; display:string; kind:number; error?:string; styleId:number; precedents:string[]; spillOf?:string }
sheet_set_cells({ sheetId:Id; edits:{ row:number; col:number; input:string|null }[]; visible:Rect; undoGroup?:string })
  → { rev:Rev; changed:PackedCells; dirtyRects:{ sheetId:Id; rect:Rect }[]; recalcMs:number; errors?:{ row:number; col:number; message:string }[] }
sheet_set_style({ sheetId:Id; rects:Rect[]; patch:Partial<CellStyle> }) → { styles:Record<number,CellStyle>; changed:PackedCells }
sheet_clear({ sheetId:Id; rects:Rect[]; what:'all'|'contents'|'formats' }) → { changed:PackedCells; dirtyRects:{ sheetId:Id; rect:Rect }[] }
sheet_insert({ sheetId:Id; axis:'rows'|'cols'; at:number; count:number }) → { rev:Rev }
sheet_delete_span({ sheetId:Id; axis:'rows'|'cols'; at:number; count:number }) → { rev:Rev }
sheet_resize({ sheetId:Id; axis:'rows'|'cols'; indices:number[]; size:number|'auto' }) → void
sheet_merge({ sheetId:Id; rect:Rect; merge:boolean }) → void
sheet_freeze({ sheetId:Id; rows:number; cols:number }) → SheetMeta
sheet_copy({ sheetId:Id; rect:Rect }) → { tsv:string; html:string; clip:string }
sheet_paste({ sheetId:Id; at:{ row:number; col:number }; clip?:string; tsv?:string; html?:string; mode:'all'|'values'|'formats'|'formulas'; visible:Rect }) → { changed:PackedCells; dirtyRects:{ sheetId:Id; rect:Rect }[] }
sheet_fill({ sheetId:Id; source:Rect; target:Rect; mode:'series'|'copy' }) → { changed:PackedCells }
sheet_sort({ sheetId:Id; rect:Rect; keys:{ col:number; dir:'asc'|'desc' }[]; hasHeader:boolean }) → { changed:PackedCells }
sheet_find({ workbookId:Id; query:string; matchCase:boolean; wholeCell:boolean; inFormulas:boolean }) → { sheetId:Id; row:number; col:number }[]
sheet_replace({ workbookId:Id; query:string; replacement:string; matchCase:boolean; wholeCell:boolean }) → { count:number }
sheet_add({ workbookId:Id; name?:string; afterId?:Id }) → SheetMeta
sheet_update({ id:Id; patch:{ name?:string; color?:BlockColor|null; hidden?:boolean } }) → SheetMeta
sheet_remove({ id:Id }) → void
sheet_reorder({ id:Id; beforeId?:Id; afterId?:Id }) → SheetMeta
sheet_named_range_set({ workbookId:Id; name:string; ref:string|null }) → void
sheet_cond_format_set({ sheetId:Id; rules:CondFormatRule[] }) → void
sheet_chart_set({ sheetId:Id; chart:{ id?:Id; spec:ChartSpec & { range:string }; anchor:Rect } | { id:Id; delete:true } }) → void
sheet_undo({ workbookId:Id }) → { changedSheets:Id[] }
sheet_redo({ workbookId:Id }) → { changedSheets:Id[] }
sheet_eval({ workbookId?:Id; sheetId?:Id; formula:string }) → { display:string; value:unknown; error?:string }   // scalar mode without workbook
sheet_functions({}) → { name:string; category:string; signature:string; description:string; example:string; args:{ name:string; optional:boolean; repeat:boolean }[] }[]
sheet_lint({ workbookId:Id }) → { id:string; sheetId:Id; rect:Rect; rule:'hardcoded_constant'|'inconsistent_formula'|'ref_error'|'div0'|'circular'|'number_as_text'|'merged_in_data'|'unused_name'|'volatile_heavy'; message:string; fix?:string }[]
sheet_import_file({ grantId:Id; workspaceId:Id; parentId:Id|null; asDatabase:boolean; onEvent }) (job) ⇒ { page:PageMeta; warnings:string[] }
sheet_export({ workbookId:Id; format:'xlsx'|'csv'; sheetId?:Id; grantId:Id; onEvent }) (job) ⇒ { bytes:number }
sheet_to_database({ sheetId:Id; rect:Rect; hasHeader:boolean; workspaceId:Id; parentId:Id|null }) → { page:PageMeta }
```

#### Assets
```ts
interface AssetDTO { id:Id; name:string; mime:string; size:number; width?:number; height?:number; url:string }
asset_import_grants({ grantIds:Id[]; workspaceId:Id; onEvent }) (job) ⇒ AssetDTO[]
asset_import_bytes(<raw body>; headers:{ 'x-emp-workspace':Id; 'x-emp-name':string; 'x-emp-mime':string }) → AssetDTO
asset_get({ ids:Id[] }) → AssetDTO[]
asset_open_external({ id:Id }) → void          // decrypts to vault tmp, confirm sheet for executables, opener from Rust
asset_save_as({ id:Id; grantId:Id }) → void
asset_import_url({ workspaceId:Id; url:string }) → AssetDTO   // remote image "Load" (NetGuard; user-content policy)
```

#### Search
```ts
interface SearchHit { id:Id; kind:'page'|'row'|'database'|'sheet'|'block'|'asset'; title:string; icon?:Icon; path:string[];
  snippet?:{ text:string; ranges:[number,number][] }; blockId?:string; score:number; updatedAt:Ts }
search_query({ q:string; filters?:{ in?:Id; type?:SearchHit['kind'][]; db?:Id; edited?:{ from?:Ts; to?:Ts } }; limit:number; reqId:number })
  → { reqId:number; hits:SearchHit[]; indexReady:boolean; tookMs:number }      // also parses in:/type:/db:/edited: operators inside q
search_status({}) → { ready:boolean; docs:number; building:boolean; progress?:number }
search_reindex({ onEvent }) (job) ⇒ void
```

#### Life apps
```ts
interface LifeAppSummary { id:string; version:string; title:string; tagline:string; icon:string; color:string; category:string; estMinutes:number; installed:number; v1:boolean }
interface LifeAppInstance { id:Id; appId:string; version:string; rootPageId:Id; installedAt:Ts; upgradeAvailable:boolean; detached:boolean; checklist:{ id:string; label:string; done:boolean }[] }
interface GenerationPlan { items:{ key:string; kind:'page'|'database'|'view'|'dashboard'|'reminder'|'recurring'|'sheet'|'rule'|'goal'; title:string; parentKey?:string; optional:boolean; enabled:boolean; count?:number }[];
  counts:Record<string,number>; recommendations:{ stepId:string; value:unknown; why:string; source:string }[]; warnings:string[] }
interface PlanDiff { add:GenerationPlan['items']; update:{ key:string; fields:string[]; conflict:boolean }[]; keep:string[] }
lifeapp_list({}) → LifeAppSummary[]
lifeapp_manifest({ id:string }) → LifeAppManifest                       // §16.1
lifeapp_recommend({ appId:string; stepId:string; answers:Record<string,unknown> }) → { value:unknown; why:string; source:string }
lifeapp_preview({ appId:string; answers:Record<string,unknown>; mode:'quick'|'guided'; disabledKeys:string[] }) → GenerationPlan
lifeapp_install({ appId:string; answers:Record<string,unknown>; mode:'quick'|'guided'; disabledKeys:string[]; workspaceId:Id; sampleData:boolean; onEvent }) (job) ⇒ { instanceId:Id; rootPageId:Id; created:Id[] }
lifeapp_instances({ workspaceId:Id }) → LifeAppInstance[]
lifeapp_tuneup_preview({ instanceId:Id; answers:Record<string,unknown> }) → PlanDiff
lifeapp_tuneup_apply({ instanceId:Id; answers:Record<string,unknown>; acceptConflicts:string[]; onEvent }) (job) ⇒ { changed:Id[] }
lifeapp_detach({ instanceId:Id }) → void
lifeapp_uninstall({ instanceId:Id; keepContent:boolean }) → void
lifeapp_metrics({ instanceId:Id; names:string[] }) → Record<string,{ value:unknown; display:string; math:{ label:string; value:string; source?:string }[]; asOf:Ts }>
lifeapp_insights({ instanceId?:Id }) → Insight[]                        // all installed apps if omitted (Home)
lifeapp_insight_mute({ instanceId:Id; ruleId:string; until:Ts|null }) → void
lifeapp_sample_data({ instanceId:Id; on:boolean }) → { rows:number }
lifeapp_checklist_tick({ instanceId:Id; itemId:string }) → void         // also auto-ticked in Rust on matching events
```

#### Finance
```ts
finance_overview({ instanceId:Id; month:string }) → { netWorth:Money; netWorthDelta30d:Money; toBeAssigned?:Money; leftToSpend?:Money;
  savingsRate3m:number; efMonths:number; debtFreeDate?:string;
  budget:{ categoryId:Id; name:string; group:string; color:BlockColor; assigned:Money; activity:Money; available:Money; pace:number }[];
  upcoming:{ rowId:Id; name:string; due:string; amount:Money; autopay:boolean }[]; uncategorized:number; asOf:Ts }
finance_networth_series({ instanceId:Id; range:'6m'|'1y'|'3y'|'5y'|'all' }) → { t:string[]; assets:number[]; liabilities:number[]; net:number[]; currency:string }
finance_spending_breakdown({ instanceId:Id; from:string; to:string; by:'category'|'group'|'payee'|'account' }) → { key:string; label:string; color?:string; amount:string; pct:number; deltaPct?:number }[]
finance_cashflow_sankey({ instanceId:Id; month:string }) → { nodes:{ name:string; color?:string }[]; links:{ source:number; target:number; value:number }[] }
finance_budget_month({ instanceId:Id; month:string }) → { categories:{ categoryId:Id; assigned:string; activity:string; available:string; rollover:string }[]; toBeAssigned:string; currency:string }
finance_budget_assign({ instanceId:Id; month:string; categoryId:Id; amount:string }) → { available:string; toBeAssigned:string }
finance_import_start({ instanceId:Id; grantId:Id }) → { importId:Id; format:'csv'|'ofx'|'qfx'|'qif'; columns?:string[]; sample:string[][];
  mappingGuess:ImportMapping; profileMatch?:{ id:Id; name:string }; accountGuess?:Id; rowCount:number; encoding:string }
interface ImportMapping { date?:number; amount?:number; debit?:number; credit?:number; payee?:number; memo?:number; balance?:number; dateFormat?:string; invert:boolean; decimalComma:boolean }
finance_import_preview({ importId:Id; mapping:ImportMapping; accountId:Id }) → { rows:{ idx:number; date:string; payee:string; rawPayee:string; amount:string;
  categoryId?:Id; confidence:'rule'|'learned'|'none'; ruleId?:Id; duplicateOf?:Id; possibleDuplicate?:Id; transferPair?:Id }[]; newCount:number; duplicates:number; categorized:number }
finance_import_commit({ importId:Id; mapping:ImportMapping; accountId:Id; skip:number[]; overrides:Record<number,{ categoryId?:Id; payee?:string }>; saveProfileAs?:string; onEvent }) (job) ⇒ { inserted:number; skipped:number; transfersLinked:number }
finance_rules_list({ instanceId:Id }) → Rule[]
interface Rule { id:Id; name:string; priority:number; when:{ all:{ field:'payee'|'raw'|'memo'|'amount'|'abs_amount'|'account'|'day_of_month'; op:'contains'|'equals'|'starts_with'|'regex'|'lt'|'gt'|'between'|'in'; value:unknown }[] };
  then:{ categoryId?:Id; renamePayee?:string; tags?:string[]; markTransfer?:boolean; split?:{ categoryId:Id; pct?:number; amount?:string }[] }; continue:boolean; timesApplied:number }
finance_rule_upsert({ instanceId:Id; rule:Omit<Rule,'id'|'timesApplied'> & { id?:Id } }) → Rule
finance_rule_delete({ instanceId:Id; id:Id }) → void
finance_rules_apply({ instanceId:Id; scope:'uncategorized'|'all'; dryRun:boolean; onEvent }) (job) ⇒ { changed:number; sample:{ rowId:Id; from?:string; to:string }[] }
finance_recurring_detect({ instanceId:Id }) → { payee:string; cadence:'weekly'|'biweekly'|'monthly'|'quarterly'|'yearly'; amount:Money; nextDue:string; confidence:number; rowIds:Id[]; priceChange?:{ from:string; to:string } }[]
finance_recurring_accept({ instanceId:Id; items:{ payee:string; cadence:string; amount:Money; nextDue:string; kind:'bill'|'subscription'|'income' }[] }) → { created:Id[] }
finance_debt_plan({ debts:{ name:string; balance:string; aprPct:string; minPayment:string }[]; strategy:'avalanche'|'snowball'|'hybrid'|'custom'; extraMonthly:string; order?:string[]; startMonth:string })
  → { strategies:{ strategy:string; months:number; payoffDate:string; totalInterest:string; interestSavedVsMin:string }[];
      schedule:{ month:string; balances:Record<string,string>; payments:Record<string,string> }[] }      // schedule for requested strategy
finance_forecast({ instanceId:Id; horizonDays:number; band:boolean }) → { t:string[]; balance:number[]; p10?:number[]; p90?:number[]; threshold?:number; breaches:{ date:string; accountId:Id; amount:string; topOutflows:string[] }[] }
finance_amortization({ principal:string; annualRatePct:string; termMonths:number; extraMonthly?:string; startDate:string }) → { payment:string; totalInterest:string; payoffDate:string; rows:{ n:number; date:string; payment:string; principal:string; interest:string; balance:string }[] }
finance_goal_plan({ target:string; by:string; current:string; annualYieldPct:string }) → { monthlyRequired:string; onTrack:boolean }
```

#### Portfolio and tax
```ts
portfolio_rebuild({ instanceId:Id; onEvent }) (job) ⇒ { lots:number; realizedEvents:number }
portfolio_summary({ instanceId:Id }) → { totalValue:Money; dayChange:Money; dayChangePct:number; unrealized:Money; unrealizedPct:number;
  xirrYtd?:number; xirrAll?:number; divTtm:Money; divFwd12m:Money; maxDrift:number; feesPerYear:Money;
  holdings:{ symbol:SymbolKey; name:string; qty:string; price:number|null; value:Money; costBasis:Money; gain:Money; gainPct:number; weight:number; dayPct?:number; stale:boolean; assetClass:string }[];
  allocation:{ assetClass:string; current:number; target:number; drift:number; status:'ok'|'outside_band' }[]; asOf:Ts }
portfolio_performance({ instanceId:Id; range:'1m'|'3m'|'ytd'|'1y'|'5y'|'all'; benchmark?:SymbolKey }) → { t:number[]; value:number[]; contributions:number[]; twr:number[]; benchmark?:number[]; xirr?:number }
portfolio_rebalance_plan({ instanceId:Id; newCash:string; allowTaxableSells:boolean; minTrade:string; fractional:boolean })
  → { trades:{ accountId:Id; symbol:SymbolKey; side:'buy'|'sell'; qty:string; amount:string; estRealizedGain?:string }[]; after:{ assetClass:string; pct:number }[]; estRealizedGain:string }
portfolio_dividends({ instanceId:Id; year:number }) → { month:string; paid:string; projected:string }[]
portfolio_realized({ instanceId:Id; year:number }) → { lots:{ symbol:SymbolKey; acquired:string; sold:string; qty:string; proceeds:string; basis:string; gain:string; term:'short'|'long' }[]; totals:{ short:string; long:string } }
tax_packs({}) → { id:string; name:string; year:number; tier:'estimator'|'organizer'|'custom'; version:string; verifiedOn:string; stale:boolean }[]
tax_estimate(TaxInput) → TaxEstimate          // §15.6
tax_quarterly_plan({ packId:string; year:number; method:'safe_harbor'|'current_90'|'even_split'; estimate:TaxEstimate; priorYearTax?:string; priorYearAgi?:string; paid:{ date:string; amount:string }[] })
  → { due:{ period:string; date:string; suggested:string; paid:string; status:'upcoming'|'due_soon'|'paid'|'late' }[]; method:string; note:string }
```

#### Markets
```ts
interface Quote { symbol:SymbolKey; price:number; change:number; changePct:number; open?:number; high?:number; low?:number; prevClose?:number; volume?:number;
  currency:string; marketState:'pre'|'open'|'post'|'closed'; asOf:Ts; source:string; freshness:'live'|'delayed'|'eod'; delayedMin:number }
interface ProviderInfo { id:string; name:string; needsKey:boolean; configured:boolean; enabled:boolean; termsUrl:string; community:boolean;
  caps:('quote'|'daily'|'intraday'|'search'|'fx'|'crypto'|'dividends')[]; rateLimit:string; health:'ok'|'degraded'|'down'|'unknown' }
market_providers({}) → ProviderInfo[]
market_provider_configure({ id:string; enabled:boolean; apiKey?:string|null; priority?:number }) → ProviderInfo
market_provider_test({ id:string }) → { ok:boolean; latencyMs:number; error?:string }
market_search({ q:string; limit:number; reqId:number }) → { reqId:number; results:{ symbol:SymbolKey; name:string; exchange:string; type:'equity'|'etf'|'fund'|'crypto'|'fx'|'index'; currency:string }[] }
market_quotes({ symbols:SymbolKey[] }) → Quote[]                      // served from cache; fetch enqueued if stale
market_bars({ symbol:SymbolKey; interval:'1d'|'1wk'|'1mo'; from:string; to:string; adjusted:boolean }) → { t:number[]; o:number[]; h:number[]; l:number[]; c:number[]; v:number[]; currency:string; source:string; stale:boolean }
market_indicators({ symbol:SymbolKey; from:string; to:string; ind:{ kind:'sma'|'ema'|'bollinger'|'rsi'|'macd'; period:number }[] }) → Record<string,(number|null)[]>
market_subscribe({ symbols:SymbolKey[]; onQuote:Channel<Quote[]> }) → { subId:Id }
market_unsubscribe({ subId:Id }) → void
watchlist_list({}) → { id:Id; name:string; symbols:{ key:SymbolKey; alertAbove?:number; alertBelow?:number; alertPct?:number }[] }[]
watchlist_save({ id?:Id; name:string; symbols:{ key:SymbolKey; alertAbove?:number; alertBelow?:number; alertPct?:number }[] }) → { id:Id }
fx_rates({ base:string; symbols?:string[]; date?:string }) → { base:string; date:string; rates:Record<string,number>; source:string; stale:boolean }
```
v1 supports only daily, weekly and monthly bars. Intraday bars are P1, but `market_quotes` returns intraday price.

#### Google and calendars
```ts
interface GoogleAccount { id:Id; email:string; scopes:string[]; connectedAt:Ts; status:'ok'|'reauth_required' }
interface CalendarEvent { id:Id; source:'google'|'ics'|'db'; calendarId:string; title:string; start:string; end:string; allDay:boolean; tz?:string;
  location?:string; description?:string; color:string; recurring:boolean; link?:Route }
google_status({}) → { clientConfigured:boolean; accounts:GoogleAccount[] }
google_set_client({ clientId:string; clientSecret?:string }) (reauth) → void
google_connect({ feature:'calendar'|'docs_import'|'sheets_import'|'export'; accountId?:Id; onEvent }) (reauth)(job) ⇒ GoogleAccount
google_disconnect({ accountId:Id; revoke:boolean; deleteCache:boolean }) → void
gcal_calendars({ accountId:Id }) → { id:string; summary:string; color:string; primary:boolean; selected:boolean }[]
gcal_set_sync({ accountId:Id; calendarIds:string[]; intervalMin:5|15|30|60 }) → void
gcal_sync_now({ accountId?:Id; onEvent }) (job) ⇒ { added:number; updated:number; deleted:number }
calendar_events({ from:string; to:string; sources?:('google'|'ics'|'db')[] }) → CalendarEvent[]      // local cache; offline OK
gdocs_import({ accountId:Id; url:string; workspaceId:Id; parentId:Id|null; onEvent }) (job) ⇒ { page:PageMeta; warnings:string[] }
gdocs_export({ accountId:Id; pageId:Id; onEvent }) (job) ⇒ { fileId:string; webViewLink:string }
gsheets_import({ accountId:Id; url:string; workspaceId:Id; parentId:Id|null; asDatabase:boolean; onEvent }) (job) ⇒ { page:PageMeta; warnings:string[] }
gsheets_export({ accountId:Id; source:{ workbookId:Id } | { databaseId:Id; viewId?:Id }; onEvent }) (job) ⇒ { fileId:string; webViewLink:string }
ics_export({ source:{ databaseId:Id; dateProp:Id } | { pageIds:Id[] }; grantId:Id }) → { events:number }
```

#### Reminders and jobs
```ts
reminder_list({ from:Ts; to:Ts }) → { id:Id; fireAt:Ts; targetKind:'page'|'row'|'block'; targetId:Id; text:string; fired:boolean }[]
reminder_upsert({ id?:Id; fireAt:Ts; targetKind:'page'|'row'|'block'; targetId:Id; blockId?:string; text:string }) → { id:Id }
reminder_delete({ id:Id }) → void
reminder_snooze({ id:Id; minutes:5|15|60|1440 }) → void
job_list({}) → { jobId:Id; kind:string; done:number; total:number; startedAt:Ts; cancellable:boolean }[]
job_cancel({ jobId:Id }) → void
```

**Normative list.** The commands named above are the complete `ALL_COMMANDS` list. `build.rs` and the isolation hook read it from `src-tauri/src/commands/mod.rs::ALL_COMMANDS`. A unit test checks that this list, the capability file and `contract.ts` all match.

### 11.4 Events (Rust → webview)
| Event | Payload | Purpose |
|---|---|---|
| `vault:will-lock` | `{ reason }` | Flush saves (1.5 s) |
| `vault:locked` | `{ reason:'manual'\|'idle'\|'sleep'\|'screen'\|'blur'\|'session_max'\|'panic' }` | Reload to the lock route |
| `vault:status` | `VaultStatus` | After toggles and migrations |
| `vault:autolock-soon` | `{ secondsLeft:number }` | Drives the 60 s ring countdown |
| `tree:changed` | `{ workspaceId, upserted:PageMeta[], removed:Id[] }` | Updates the sidebar |
| `page:changed` | `{ id, metaRev?, docRev? }` | Keeps multiple views coherent |
| `db:changed` | `{ databaseId, dataRev, schemaRev, rowIds?:Id[] }` | Invalidates view windows |
| `sheet:changed` | `{ workbookId, sheetId, rects:Rect[] }` | External data arrived |
| `search:ready` | `{ docs:number }` | |
| `file:dropped` | `{ grants:FileGrant[]; x:number; y:number }` | Drag-and-drop |
| `open-external:confirm` | `{ requestId, url, host, punycode }` | The UI shows a confirmation sheet and replies with `open_external_confirm({requestId, allow, rememberHost})` (listed in ALL_COMMANDS) |
| `reminder:due` | `{ id, text }` | In-app toast (Rust also fires an OS notification) |
| `insight:new` | `Insight` | |
| `sync:status` | `{ provider, state:'idle'\|'syncing'\|'error', lastSync?:Ts, error?:string }` | |
| `net:activity` | `{ connector, host }` | Pulses the network indicator |
| `market:alert` | `{ symbol, kind:'above'\|'below'\|'pct', price }` | Watchlist alerts |
| `update:available` | `{ version }` | Only if updates are enabled |
| `integrity:warning` | `{ damaged:number; msetMismatch:boolean }` | |
| `clipboard:cleared` | `{}` | |
---

## 12. Frontend folder structure

```
src/
├─ main.tsx                       # read boot prefs → set data-* → mount → rAF → window.show(); perf marks
├─ app/
│  ├─ App.tsx                     # MotionConfig + LazyMotion, ErrorBoundary, Toaster, route outlet
│  ├─ boot.ts                     # vault_status → 'onboarding' | 'lock' | 'shell'; preload shell chunks during KDF
│  ├─ router.ts                   # ~80-line typed router on zustand; hash sync (always in browser mode)
│  ├─ shortcuts.ts                # keymap registry (§8.7), platform labels, code-based matching
│  └─ commands.ts                 # palette command registry (id, title, keywords, shortcut, run, when)
├─ backend/
│  ├─ contract.ts                 # interface EmpBackend (namespaced: api.vault.*, api.page.* …)
│  ├─ types.gen/                  # ts-rs output (committed)
│  ├─ tauri.ts                    # invoke wrappers, Channel helpers, ApiError normalisation
│  ├─ events.ts                   # typed listen/unlisten → store wiring
│  ├─ index.ts                    # '__TAURI_INTERNALS__' in window ? tauri : (import.meta.env.VITE_ALLOW_MOCK==='1' ? mock : reject)
│  └─ mock/                       # §13.6 (absent from desktop bundle)
├─ stores/  vault.ts workspace.ts tree.ts nav.ts ui.ts settings.ts toasts.ts jobs.ts market.ts search.ts undo.ts privacy.ts
├─ features/
│  ├─ vault/        LockScreen.tsx Onboarding/*.tsx RecoveryCeremony.tsx PasswordField.tsx
│  ├─ shell/        Shell.tsx Sidebar/*.tsx Topbar.tsx Breadcrumbs.tsx SidePeek.tsx RightPanel.tsx TrashPage.tsx WindowControls.tsx
│  ├─ home/         HomePage.tsx widgets/*.tsx
│  ├─ editor/       Editor.tsx useDocSave.ts schema.ts extensions/*.ts nodeviews/*.tsx menus/{Slash,Bubble,Block,Color,TurnInto}.tsx FindReplace.tsx
│  ├─ databases/    ViewController.ts DatabaseView.tsx views/{Table,Board,List,Gallery,Calendar,Chart}View.tsx properties/* filter/* sort/* group/* RowPage.tsx FormulaEditor.tsx
│  ├─ sheets/       GridCanvas.ts GridController.ts SheetPage.tsx CellEditor.tsx FormulaBar.tsx SheetTabs.tsx FunctionHelp.tsx
│  ├─ finance/      MoneyHQ/* ImportWizard/* Rules/* DebtPlanner.tsx Forecast.tsx
│  ├─ portfolio/    PortfolioDashboard.tsx HoldingPage.tsx RebalancePlanner.tsx IPS.tsx
│  ├─ markets/      CandleChart.tsx QuoteTile.tsx SymbolSearch.tsx Watchlist.tsx
│  ├─ taxes/        TaxHub.tsx Estimator.tsx QuarterlyPlan.tsx
│  ├─ lifeapps/     Gallery.tsx WizardSheet.tsx steps/{ChoiceCards,MultiChips,Money,Percent,Slider,Date,Recurrence,ListBuilder,FileImport,Connect,Jurisdiction,Review}.tsx PlanPreview.tsx Insights.tsx StartHere.tsx AppHeader.tsx
│  ├─ calendar/     CalendarPage.tsx
│  ├─ integrations/ GoogleSetupSheet.tsx ProvidersPanel.tsx NetworkLog.tsx
│  ├─ search/       CommandPalette.tsx
│  └─ settings/     SettingsPage.tsx sections/*.tsx SecurityCenter.tsx
├─ ui/              Button IconButton Input NumberField MoneyField SecretField Textarea Select Combobox Tag Checkbox Radio Switch Slider
│                   Segmented Tabs Menu ContextMenu Popover Tooltip Dialog AlertDialog Sheet Toast Kbd Badge Avatar Skeleton Spinner
│                   Progress Ring EmptyState ColorPicker EmojiPicker(lazy) DatePicker ChoiceCard Banner ScrollArea Resizable SanitizedHtml
│  └─ motion/       tokens.ts presets.ts RollingNumber.tsx Celebrate.tsx useReducedEffects.ts
├─ charts/          theme.ts ChartFrame.tsx Line.tsx Area.tsx Bar.tsx Donut.tsx Sankey.tsx Treemap.tsx Waterfall.tsx Heatmap.tsx Sparkline.tsx Fan.tsx Gauge.tsx Tooltip.tsx a11y.ts
├─ lib/             fractional-index.ts format.ts (Intl caches) money.ts (decimal.js-light; display only) dates.ts nlp.ts (chrono-node) dnd.ts lttb.ts raf.ts idle.ts perf.ts bootPrefs.ts platform.ts
├─ styles/          tokens.css theme.css editor.css grid.css print.css
└─ test/            setup.ts fixtures/ contract/
```

Code splitting is done per route and per feature with `lazy()`:
- **Initial chunk:** lock and onboarding.
- **Shell chunk:** shell and editor.
- **Lazy chunks, one each:** databases, sheets, finance, portfolio, markets, taxes, lifeapps, settings, charts, KaTeX, lowlight languages, emoji data.

Import style:
- Import lucide icons individually.
- Import Radix one package per primitive.

---

## 13. Frontend architecture

### 13.1 Stores (zustand v5)
- **One store per concern.** Read stores through selectors with `useShallow`. Do not build a mega-store.
- **`tree` store** keeps:
  - `byId: Map<Id,PageMeta>`
  - `children: Map<Id|null,Id[]>`
  - `expanded: Set<Id>`, persisted to `kv ui.tree.expanded`
  - a memoised flat list of visible rows, used by the virtualised sidebar
- **Server state.** It lives in the same stores. Update it from command results (optimistically where safe) and from events. **No TanStack Query.**
- **`nav` store** holds the current route and the back/forward stacks.
- **`privacy` store** holds the hide-numbers state, which it mirrors to `html[data-privacy]`.
- **Lock.** On `vault:locked`, call `window.location.replace('/#/lock')`. This discards the whole JS heap, so stores do not need to be cleaned up first.

### 13.2 Controllers outside React
- **Who uses them.** `ViewController` (databases) and `GridController` (sheets) are plain classes. Components read them through `useSyncExternalStore`.
- **`ViewController` windowing:**
  - Fetches windows of 200 rows, aligned to 100-row pages.
  - Prefetches ±1 page in the scroll direction.
  - Keeps an LRU of 2,000 rows.
  - Passes `knownQueryRev` with each request.
  - Edits are optimistic and reconcile with the response. On error, roll back and show a toast.
- **`GridController` tiles:**
  - Each tile is 256 rows × 32 columns.
  - Keeps an LRU of 64 tiles per sheet.
  - `dirtyRects` invalidate tiles.
  - Missing tiles render as skeleton gridlines.

### 13.3 Editor pool
- **Pool.** Keep 3 hidden TipTap instances for recently opened pages, so switching tabs or going back is instant.
- **Doc cache.** Rust keeps an LRU of 32 docs per session.

### 13.4 App command stack (undo outside the editor)
- **Commands.** `undo.ts` keeps a stack of `{label, do(), undo()}` per window. The cap is 100 commands.
- **Undoable actions:**
  - property edits (as inverse `db_rows_update` batches)
  - row create, delete and move
  - view changes
  - sidebar moves
  - page delete
  - life-app install (inverse: `lifeapp_uninstall {keepContent:false}`, offered for 10 minutes)
  - import (`import_undo`)
- **Routing ⌘Z.** It goes to whatever has focus: the editor first, then the sheet (`sheet_undo`), then the app stack.
- **Toasts.** Destructive actions show "… · Undo" for 6 s.

### 13.5 Charts
- **Wrapper.** Charts use Recharts through `charts/ChartFrame.tsx`. It provides:
  - theme tokens read from CSS variables, recomputed on theme change
  - tabular numbers
  - horizontal gridlines only, at `rgba(text,.06)`
  - 4–5 ticks chosen by nice-number rounding
  - tick labels at 11/14, tertiary
  - compact number formats: `$12.4k`, `$1.2M`, `−$340`, `4.2%`
  - at least 64 px between x-axis labels
  - padding: top 8, right 0, bottom 24, left 0
- **Y-axis side.** Put the y-axis on the right for price and net-worth time series, and on the left for category charts.
- **Lines:**
  - stroke 2 (1.5 when there are more than 2 series), with round caps and joins
  - curve: `monotoneX` for net worth and projections, `linear` for prices, `stepAfter` for balances
  - area: a gradient from series colour .22 to 0 (.30 in dark mode)
  - single-series value charts colour the line gain or loss by the sign of (last − first), and draw a dashed start reference line at `3 3`
  - projections use `dasharray 4 4`, with a p10–p90 band at .08
  - the last point is a 6 px dot; for live data it pulses with a halo growing from 6 to 14 over 1.6 s
- **Crosshair and tooltip:**
  - the crosshair is a dashed vertical line, `3 3`, in tertiary at .5
  - the active dot is 8 px with a 16 px halo at .20
  - the tooltip card has radius 10, elev-2, padding 10 12 and a minimum width of 160
- **Hero charts** use the header readout pattern. While scrubbing, the KPI above the chart shows the hovered value. On leave it reverts over 200 ms.
- **Entry animations.** They run once per mount, when at least 30 % of the chart is in view:

  | Chart | Entry | Timing |
  |---|---|---|
  | Line | `clip-path inset(0 100% 0 0)→0` | 700 ms `outExpo` |
  | Bars | `scaleY` 0→1 | 500 ms, 25 ms stagger, capped at 300 ms total |
  | Donut | sweep | 700 ms |
  | Candles | fade | 200 ms |

  Data updates morph over 400 ms. Above 500 points, updates swap instantly and Rust applies LTTB decimation to at most 2× the pixel width.
- **Bars:**
  - radius `[4,4,0,0]`, maximum width 28, category gap 30 %, bar gap 4
  - expenses use `--text-secondary` at .5
  - hovering a group dims the other groups to .35
- **Donut:**
  - inner radius 68 %, padding angle 1.5°, corner radius 4
  - the centre shows the total at 22/28 600
  - hovering a segment adds 4 px to its outer radius
- **Sankey:**
  - nodes 10 px wide, radius 3
  - links in the source colour at .28 (.5 on hover)
- **Heatmap:** 12 px cells with a 3 px gap and radius 3.
- **Candlesticks** use lightweight-charts v5:
  - transparent layout
  - `textColor` set to tertiary, font Inter 11
  - no vertical gridlines; horizontal gridlines in `--border-subtle`
  - `rightPriceScale.scaleMargins {top:.08,bottom:.24}`
  - `timeScale {rightOffset:6, barSpacing:8, minBarSpacing:2}`
  - Magnet crosshair, dashed
  - up/down colours = gain/loss, `borderVisible:false`
  - a volume histogram on `priceScaleId:'vol'` with margins `{top:.80,bottom:0}` at alpha .35
  - modes Line, Area and Candles
  - SMA 20/50/200 overlays, drawn at stroke 1.25 in categorical colours 2, 4 and 6
  - on theme change, call `applyOptions`; never recreate the chart
  - the TradingView attribution is shown as 11 px tertiary text in the footer
- **Chart states.** Every chart has:
  - a loading skeleton
  - an "insufficient data" state: a ghost dashed line and the copy "Add 2+ transactions to see your trend"
  - a cached/offline chip
  - an aria summary
  - "View as table"
  - keyboard scrubbing with arrows, Home and End

### 13.6 Browser mock backend
```
src/backend/mock/  index.ts options.ts wasm.ts db.ts events.ts market.ts google.ts control.ts commands/*.ts seed/{demo,empty,perf}.ts wasm/ (generated)
```
- **URL options:**
  - `?seed=demo|empty|perf`
  - `&latency=0|N`
  - `&locked=1`
  - `&encrypted=1` simulates 600 ms of KDF time; the password is `demo`
  - `&freeze=2026-11-26T10:00:00Z`
  - `&persist=1` uses IndexedDB, dev only
  - `&fail=<cmd>:<CODE>@<prob>`
- **Real Rust logic.** The mock calls the WASM build for query, filter, sort, formulas, number formats, doc indexing, search ranking, finance and life-app planning and metrics. TypeScript provides only storage maps, revs, events, latency and fault injection.
- **IPC fidelity.** Every request and response goes through `structuredClone`. Errors are `ApiError` objects with real codes.
- **Seeds:**
  - **demo:** Getting Started, all 6 life apps installed with sample data (6 months of transactions, 8 holdings), a workbook, and calendar events.
  - **perf:** a 10k-row database with 14 properties, 5,000 pages, a 2 MB document and a 200k-cell sheet.
- **Test controls.** `window.__EMP_MOCK__` exposes `{reset, lock, emit, setLatency, clock:{set,advance}, snapshot}`.
- **Market data.** Fictional tickers (EMPX, NOVA, ORBT, KITE, LUMA, VOLT, BRIX, ZENO) follow a seeded geometric Brownian motion (GBM), plus a fixed FX table.
- **Bundle checks.** The desktop build sets `VITE_ALLOW_MOCK=0`. CI fails if `dist/` contains the sentinel `__EMP_MOCK_BACKEND__`. Browser builds apply the same CSP through a meta tag, plus `'wasm-unsafe-eval'`.

---

## 14. Formula engine (emp-sheets)

### 14.1 Addressing and values
- **Grid limits.** 1,048,576 rows × 16,384 columns. A `CellKey` packs `(sheet u16, row u32, col u16)` into a `u64`.
- **References** support:
  - `A1`, `$A$1`, `A1:B9`, `A:A`, `1:1`
  - `Sheet2!A1`, `'My Sheet'!A1:B2`
  - named ranges
  - 3-D references (P1)
  - structured references (P1)
- **Values:** `Empty | Number(f64) | Text(Arc<str>) | Bool | Error(Null|Div0|Value|Ref|Name|Num|NA|Spill|Calc|Circ|Fetch) | Array(rows×cols)`. Evaluation additionally handles `Ref` and lazy `RangeView`.
- **Excel compatibility:**
  - Coercion follows Excel: `"1"+1=2`, `TRUE+1=2`.
  - Text comparison is case-insensitive. Mixed-type ordering is number < text < bool.
  - Wildcards `* ? ~` apply in `*IF(S)`, `MATCH` and `XLOOKUP` mode 2.
  - Dates use the 1900 system and preserve the leap-year bug. The 1904 system is available per workbook.
  - Display precision is 15 significant digits.
- **Pratt precedence**, lowest to highest:
  1. comparison
  2. `&`
  3. `+ -`
  4. `* /`
  5. `^`
  6. postfix `%`
  7. unary `±` (so `-2^2 = 4`)
  8. `:`, then space (intersection), then `,` union inside parentheses
- **Error reporting.** Errors carry byte spans.
- **Printer round-trip.** A property test asserts that `parse(print(ast)) == ast`.
- **Compiled form:**
  - an arena AST with relative R1C1 references, so filled-down formulas share one `Arc<CompiledFormula>`
  - flags for volatile, dynamic and external
  - a static dependency list

### 14.2 Storage, dependencies, recalculation
- **Storage.** Each sheet stores `cols: Vec<BTreeMap<u32,CellId>>` plus a cell slab.
- **Dependency index:**
  - single-cell precedents: `FxHashMap<CellKey, SmallVec<[CellId;4]>>`
  - range precedents: a bucketed index (64 columns × 1,024 rows per bucket) for ranges covering at most 64 buckets
  - whole column or row: `col_ranges` / `row_ranges`
  - larger ranges: a `big_ranges` list
  - external data: `FxHashMap<ExternalKey,Vec<CellId>>`
- **Recalculation steps:**
  1. Mark dirty cells by BFS, starting from the volatile set.
  2. Topologically sort the dirty set with an iterative DFS. Cycle members get `#CIRC!`, unless iterative calculation is on (100 iterations, change below 0.001).
  3. Evaluate in order with change-propagation cut-off: if a cell's precedents did not change, keep its old value.
  4. Return the changed cells inside `visible`, plus `dirtyRects`.
  5. Persist the cached values of touched bands in the same write batch.
- **On open.** Cached values persist, so opening a workbook evaluates only volatile cells and cells whose external data is stale.
- **Spill (v1):**
  - The anchor cell plus the spill range is registered as virtual precedents.
  - A blocked spill range gives `#SPILL!`.
  - Spill children are marked `f=2` in `PackedCells`.
- **Structural edits** (insert, delete, move, sort) rewrite references across every formula, named range, conditional format, merge and chart. References to deleted cells become `#REF!`. Undo keeps 200 groups per workbook.

### 14.3 Function list (v1, Excel dialect)

**Math**

`SUM SUMIF SUMIFS SUMPRODUCT SUMSQ PRODUCT QUOTIENT MOD ABS SIGN INT TRUNC ROUND ROUNDUP ROUNDDOWN MROUND CEILING CEILING.MATH FLOOR FLOOR.MATH EVEN ODD SQRT POWER EXP LN LOG LOG10 PI RAND RANDBETWEEN GCD LCM FACT COMBIN PERMUT SUBTOTAL AGGREGATE DEGREES RADIANS SIN COS TAN ASIN ACOS ATAN ATAN2`

**Statistical**

`AVERAGE AVERAGEA AVERAGEIF AVERAGEIFS COUNT COUNTA COUNTBLANK COUNTIF COUNTIFS MIN MAX MINA MAXA MINIFS MAXIFS MEDIAN MODE.SNGL STDEV.S STDEV.P STDEV VAR.S VAR.P LARGE SMALL RANK.EQ RANK.AVG PERCENTILE.INC PERCENTILE.EXC QUARTILE.INC PERCENTRANK.INC CORREL COVARIANCE.S SLOPE INTERCEPT RSQ FORECAST.LINEAR TREND GROWTH GEOMEAN NORM.DIST NORM.INV NORM.S.DIST`

**Logical**

`IF IFS IFERROR IFNA AND OR NOT XOR SWITCH TRUE FALSE LET`

**Lookup and reference**

`VLOOKUP HLOOKUP XLOOKUP LOOKUP INDEX MATCH XMATCH CHOOSE OFFSET INDIRECT ROW ROWS COLUMN COLUMNS ADDRESS TRANSPOSE HYPERLINK`

**Dynamic arrays (v1, D-14)**

`FILTER SORT SORTBY UNIQUE SEQUENCE RANDARRAY TAKE DROP CHOOSECOLS CHOOSEROWS VSTACK HSTACK TEXTSPLIT`

**Text**

`CONCAT CONCATENATE TEXTJOIN LEFT RIGHT MID LEN FIND SEARCH SUBSTITUTE REPLACE UPPER LOWER PROPER TRIM CLEAN TEXT VALUE NUMBERVALUE FIXED DOLLAR EXACT REPT CHAR CODE UNICHAR UNICODE T TEXTBEFORE TEXTAFTER`

**Date and time**

`TODAY NOW DATE TIME DATEVALUE TIMEVALUE YEAR MONTH DAY HOUR MINUTE SECOND WEEKDAY WEEKNUM ISOWEEKNUM EDATE EOMONTH DATEDIF DAYS DAYS360 NETWORKDAYS NETWORKDAYS.INTL WORKDAY WORKDAY.INTL YEARFRAC`

**Financial**

`PMT IPMT PPMT PV FV NPER RATE NPV XNPV IRR XIRR MIRR CUMIPMT CUMPRINC EFFECT NOMINAL SLN DB DDB SYD FVSCHEDULE PDURATION RRI`

**Information**

`ISBLANK ISNUMBER ISTEXT ISNONTEXT ISLOGICAL ISERROR ISERR ISNA ISREF ISEVEN ISODD ISFORMULA NA N TYPE ERROR.TYPE`

**EMP extensions**

- `STOCK(symbol,[field="price"|"change"|"changepct"|"open"|"high"|"low"|"prevclose"|"volume"|"name"|"currency"])`
- `FX(from,to,[date])`
- `CRYPTO(id,[field])`
- `STOCKHISTORY(symbol,start,[end],[interval],[field])` (P1)
- `DBLOOKUP(database,matchProp,matchValue,returnProp)` (P1)

All of these are non-blocking and read only from the cache. While a value is loading they return `#FETCH` and render as a shimmer.

**Behaviour shared by all functions**

- Functions the engine does not support import as `#NAME?`. The original text is kept and listed in the import warnings.
- `GOOGLEFINANCE(sym,"price")` maps to `STOCK`.
- Each function is described by `FnSpec {name, min_args, max_args, arg_kinds:[Value|Range|Lazy], volatility, returns_ref, impl, doc{signature, description, example}}`. The same registry backs `sheet_functions()`, autocomplete and the help panel.
- A test enforces at least 15 table cases per function in `tests/functions/*.toml`, including errors and type coercions.
- An Excel parity corpus of `.xlsx` files with cached values lives in `tests/excel/`. Results are compared with a relative tolerance of 1e-9; text must match exactly.

**v1.1 and later**

- v1.1: `LAMBDA MAP REDUCE SCAN BYROW BYCOL MAKEARRAY`, structured references, 3-D references, and pivot tables.

### 14.4 Number formats
`numfmt` parses Excel format codes:
- sections in the form `pos;neg;zero;text`
- digit and symbol tokens: `0 # ? . , %` and `E+`
- thousands scaling
- literal text
- `[Red]` and `[Color n]`
- conditions such as `[>=1000]`
- date and time tokens: `yyyy mm dd hh mm ss AM/PM [h]`
- fractions

Built-in format ids 0–49 map to their standard codes. Decimal and thousands separators follow the locale. All display strings are produced in Rust.

### 14.5 xlsx/csv IO
- **Import (calamine):**
  - values, formulas (`worksheet_formula`), merges, sheet visibility, and defined names
  - number formats, bold, fills, column widths and freeze panes, read from `xl/styles.xml` and the sheet XML with `quick-xml` (`io/xlsx_styles.rs`)
  - the 1904 date system, and the serial-60 bug
  - cached values are kept, and a background recalculation reports mismatches in debug builds
- **Export (rust_xlsxwriter):**
  - values and formulas with their cached results
  - styles and number formats
  - widths and heights, merges, freeze panes and defined names
  - autofilter, data-validation lists, and conditional formats (data bars and cell rules)
  - charts: line, bar, area, pie and scatter
- **CSV:** `csv` crate with delimiter sniffing (`, ; \t |` over the first 20 lines, choosing the most consistent column count) and encoding sniffing.

### 14.6 Database formula dialect (`Dialect::Row`)
**Syntax and storage**
- Property references: `prop("Name")`, plus a bare property-chip token.
- Literals: numbers, strings, booleans, and lists `[1,2]`.
- Operators: `+ - * / % ^ == != > < >= <= and or not && || !` and the ternary `?:`.
- Comments: `/* */`.
- Bindings: `let(x, v, expr)` and `lets(a,1,b,2,expr)`.
- Method sugar: `prop("Tags").length()`.
- Expressions are stored with property ids, written `prop("#<propId>")`, and re-printed with the current names for display.

**v1 functions**
- Logic: `if ifs empty and or not equal unequal`
- Text: `length contains lower upper format concat join replace replaceAll substring test split trim`
- Numbers: `min max sum mean median abs round ceil floor sqrt pow mod toNumber`
- Dates: `now today year month day week hour minute dateAdd dateSubtract dateBetween dateStart dateEnd formatDate parseDate timestamp fromTimestamp`
- Lists: `at first last slice sort reverse unique includes filter map find some every count flat`, with `current` and `index` inside list callbacks.
- Relations: `prop("Rel").map(current.prop("Amount")).sum()`
- Finance: `pmt fv pv npv irr fx("USD","EUR")`. `fx` uses the cached rate and sets a staleness flag.

**Typing and evaluation**
- Formulas are statically typed: `db_formula_check` returns the result type, or an error with its span.
- Division by zero returns empty, matching Notion.
- `now()` and `today()` re-evaluate on a 1-minute tick, but only in formulas that use them.
- Results are cached per `(propId,rowRev)` and invalidated through the dependency graph (property → formula → rollup → formula in other databases). A cycle gives "Circular reference".
- Regex uses the `regex` crate.

**Coming in P1:** `style unstyle link padStart padEnd repeat match dateRange`.

### 14.7 Metric dialect (`Dialect::Metric`, used by life-app metrics and advisor rules)
**Identifiers**
- `metrics.<name>`
- `answers.<id>`
- `today`
- `pack.<path>`

**Functions**
- Core: `if, and, or, not, min, max, abs, round, coalesce, days_between(a,b), months_between(a,b)`
- Formatters: `fmt_money(x)`, `fmt_pct(x)`, `fmt_months(x)`

**Output**
- An expression evaluates to a boolean or a value.
- Messages interpolate with `{{expr}}`.

**Safety:** the dialect has no IO and no access to rows except through metrics.
---

## 15. Finance engine (emp-finance)

`emp-finance` is pure. It has no IO and no store dependency. `emp-app` loads rows from emp-store by **semantic role**, converts them to emp-finance inputs, and writes results back.

### 15.0 Roles
A role maps a well-known concept to a property. Roles are stored in `DatabasePayload.roles` and in `PropertyPayload.role`.

| Role | Meaning |
|---|---|
| `txn.date` | Transaction date |
| `txn.amount` | Transaction amount |
| `txn.payee` | Payee |
| `txn.raw` | Raw description from the bank |
| `txn.memo` | Memo |
| `txn.account` | Account |
| `txn.category` | Category |
| `txn.cleared` | Cleared status |
| `txn.transfer` | Transfer link |
| `txn.import_id` | Import identifier, used for dedupe |
| `txn.split_parent` | Parent row of a split |
| `acct.type` | Account type |
| `acct.currency` | Account currency |
| `acct.opening` | Opening balance |
| `acct.apr` | APR |
| `acct.min_payment` | Minimum payment |
| `acct.limit` | Credit limit |
| `acct.on_budget` | Whether the account is on budget |
| `acct.low_threshold` | Low-balance threshold |
| `cat.group` | Category group |
| `cat.essential` | Essential flag |
| `cat.rollover` | Rollover flag |
| `cat.target_type` | Target type |
| `cat.target` | Target amount |
| `rec.amount` | Recurring amount |
| `rec.schedule` | Recurring schedule |
| `rec.kind` | Recurring kind |
| `rec.account` | Recurring account |
| `rec.category` | Recurring category |
| `rec.autopay` | Autopay flag |
| `rec.reminder_days` | Reminder lead time |
| `goal.target` | Goal target |
| `goal.date` | Goal date |
| `goal.saved` | Amount saved |
| `goal.kind` | Goal kind |
| `inv.date` | Investment transaction date |
| `inv.type` | Investment transaction type |
| `inv.security` | Security |
| `inv.qty` | Quantity |
| `inv.price` | Price |
| `inv.amount` | Amount |
| `inv.fees` | Fees |
| `inv.account` | Investment account |
| `sec.ticker` | Security ticker |
| `sec.class` | Asset class |
| `sec.expense_ratio` | Expense ratio |
| `alloc.class` | Allocation class |
| `alloc.target` | Allocation target |
| `alloc.band_abs` | Absolute band |
| `alloc.band_rel` | Relative band |

### 15.1 Money
- **Representation.** `Money { amount: Decimal, currency: Currency }`. Crypto values may use up to 8 decimal places.
- **Rounding.** Display uses half-even with an explicit label. Invoices (P1) use half-up. Tax rounding follows the pack (§15.6).
- **FX conversion.** `fx::convert(m, to, date, rates)` returns the converted amount together with `{rate, rateDate, source}`. Converted figures always keep the original amount alongside them.
- **Base currency.** Each vault has a base currency, set in `VaultSettings.baseCurrency`. Net worth and budgets are reported in it.

### 15.2 Import
- **Sniff.** Detect the format from magic bytes and the file extension:
  - OFX 1.x starts with the header `OFXHEADER:100`.
  - OFX 2.x starts with `<?xml` followed by `<?OFX`.
  - QIF starts with `!Type:`.
  - Anything else is treated as CSV.
- **CSV profiles.** Compute a header fingerprint as `sha256(lowercased, trimmed headers joined by \u001f)`. If a saved profile in `kv ns=fin.profiles` matches, apply it automatically.
- **Dates.** Try these formats in order: `YYYY-MM-DD`, `MM/DD/YYYY`, `DD/MM/YYYY`, `DD.MM.YYYY`, `D MMM YYYY`, `MM/DD'YY` (QIF), and Excel serial numbers.
  - Pick the format under which every row parses and the dates are monotonic, allowing 5% of rows out of order.
  - If two formats both fit (every day value ≤ 12), ask the user once.
- **Amounts.**
  - Handle thousands separators and decimal commas. `decimalComma` is detected when ≥ 80% of values match `\d+,\d{2}$`.
  - Treat `(45.00)`, a trailing minus, and `CR`/`DR` suffixes as signs.
  - Support split debit and credit columns.
  - `invert` flips signs for card exports.
- **Payee normalisation.** Apply these regexes in order, case-insensitive:
  1. `^(POS|DEBIT|PURCHASE|CHECKCARD|ACH|RECURRING|CARD PURCHASE)\s+`
  2. `^(SQ \*|TST\* |SP \*|PAYPAL \*|PP\*)`
  3. `[X*]{4,}\d{4}`
  4. `#\d{3,}`
  5. `\s+\d{2}/\d{2}(/\d{2,4})?`
  6. `\s+[A-Z][A-Z .'-]+\s+[A-Z]{2}$` (city and state)

  Then collapse whitespace and convert to title case. The payee alias table maps raw strings to a payee row.
- **Dedupe.**
  - *Exact match:* OFX and QFX match on `(account, FITID)`. CSV and QIF match on `sha256(account ‖ date ‖ amount_minor ‖ normalized_payee ‖ occurrence_index)`.
  - *Fuzzy match:* same amount, within ±3 days, and Jaro-Winkler(payee) ≥ 0.90. These go to a "possible duplicate" review lane and are never dropped automatically.
- **Transfers.** Link two transactions as a transfer when they meet all of these:
  - opposite amounts of equal magnitude
  - in two different accounts the user owns
  - within ±3 days
  - neither is already linked

  Transfers are excluded from income and spending.
- **Rules.**
  - Rules run in priority order, ascending, and the first match wins unless `continue` is set.
  - Regex rules use a `regex` size limit of 256 KiB.
  - When the user recategorises the same normalised payee to the same category twice, show the inline suggestion "Always categorise {payee} as {category}?".
  - If no rule matches, suggest the category the payee has used most often.

### 15.3 Budget
- **Methods.** `fifty_thirty_twenty`, `zero_based`, `pay_yourself_first`, `envelopes`, `track_only`.
- **Month boundaries.** A budget month runs from `monthStartDay` (1–28) to the day before the next one.
- **Core quantities.**
  - `activity(cat, month)` is the sum of the category's transactions in that month, excluding transfers.
  - `available = rollover_prev + assigned + activity`, where `rollover_prev` is the previous month's `available` if the category has rollover on (and is otherwise 0, with negative values carried as overspend).
  - `to_be_assigned = income_this_month + carry_tba_prev − Σ assigned`. This applies to zero-based and envelopes.
  - Under 50/30/20, the group targets are Needs 50%, Wants 30% and Savings & Debt 20% of net income.
- **Income buffer.** When the answer is income stability = irregular, "Budget last month's income" makes this month's income equal to the "Next month" holding category from last month.
- **Pace.** `day_of_period / days_in_period`. A category is "on track" when spent ÷ assigned ≤ pace + 0.1.

### 15.4 Recurring and subscriptions detection
- **Grouping.** Group transactions by normalised payee and sign.
  - A group needs ≥ 3 occurrences, or ≥ 2 if the cadence is yearly.
  - The median interval must fall within tolerance of one of these cadences:

    | Cadence | Interval (days) | Tolerance |
    |---|---|---|
    | weekly | 7 | ±1 |
    | biweekly | 14 | ±2 |
    | monthly | 30.44 | ±3 |
    | quarterly | 91.31 | ±7 |
    | yearly | 365.25 | ±10 |

  - The amount coefficient of variation must be < 0.10, or the group is flagged as `variable`.
- **Next date.** `next_due = last + cadence`, shifted to the next business day using the holiday pack.
- **Price change.** Flagged when the latest amount differs from the median of the previous 3 by more than 2% and $0.50.
- **Confidence.** `0.5·interval_fit + 0.3·amount_fit + 0.2·min(occurrences/6, 1)`. Items are shown only when confidence ≥ 0.6.

### 15.5 Debt, forecast, net worth, goals
- **Debt simulation** (`debt::simulate`):
  - Interest is monthly at `APR/12` on the balance, accrued before the payment.
  - The extra payment and any freed-up minimums go to the current target debt.
  - Strategy orderings:
    - avalanche: APR descending, ties broken by smaller balance first
    - snowball: balance ascending
    - hybrid: the two smallest balances first, then avalanche
    - custom: the user's order
  - The simulation stops at 600 months or when every balance is zero. A balance never goes below 0.
  - Output: a per-month schedule, payoff dates, total interest, and interest saved compared with paying minimums only.
- **Forecast** (`forecast::cashflow`):
  - Expand recurring items (`rrule`) over the horizon, which defaults to 90 days.
  - Discretionary daily spend is the median of daily non-recurring spend in variable categories over the trailing 90 days.
  - The optional p10/p90 band comes from 1,000 bootstrap resamples of daily spend (seeded with `vault_id ‖ month`).
  - Report a breach when the projected balance falls below the account's low-balance threshold, along with the top 3 outflows that cause it.
- **Net worth.**
  - A monthly snapshot (`networth::snapshot`) is created automatically on the first unlock of each month if one is missing.
  - `backfill_from_transactions` reconstructs past months from opening balances.
  - Assets are positive balances. Liabilities are debt account balances.
- **Metrics.**
  - `savings_rate = (income − spending) / income` over the trailing 3 months, excluding transfers and investment contributions, which count as saving.
  - `essential_monthly_spend` is the trailing-90-day median of the monthly sum over categories marked `essential`.
  - `ef_months = ef_balance / essential_monthly_spend`.
  - `utilization = card balance / limit`.
- **Goals** (`goals::monthly_needed`):
  - If the goal date is due or past, the amount needed is `target − saved`.
  - Otherwise it is `(target − saved) / months_left`.
  - With an expected yield `r`, use the annuity form `(target − saved·(1+r/12)^n) · (r/12) / ((1+r/12)^n − 1)`.

### 15.6 Tax engine
**Packs.** Packs live at `crates/emp-store/packs/tax/*.json` and use `deny_unknown_fields`.

```jsonc
{ "id":"us-federal-2026", "name":"US Federal", "country":"US", "year":2026, "tier":"estimator", "version":"1.0.0",
  "verifiedOn":"YYYY-MM-DD", "sources":[{ "label":"IRS Rev. Proc. (TY2026 inflation adjustments)", "url":"https://www.irs.gov/..." }],
  "filingStatuses":["single","mfj","mfs","hoh","qss"],
  "brackets": { "<status>": [{ "upTo": "<amount>|null", "rate": "<decimal>" }] },
  "standardDeduction": { "<status>": "<amount>" }, "additionalStdDeduction65OrBlind": { "<status>": "<amount>" },
  "preferentialRates": { "ltcgQualifiedDiv": [{ "upTo": { "<status>": "<amount>|null" }, "rate": "<decimal>" }] },
  "seTax": { "netEarningsFactor":"0.9235", "ssRate":"0.124", "medicareRate":"0.029", "ssWageBase":"<amount>", "deductibleShare":"0.5",
             "addlMedicare": { "rate":"0.009", "threshold": { "<status>":"<amount>" } } },
  "niit": { "rate":"0.038", "threshold": { "<status>":"<amount>" } },
  "credits": [{ "id":"child_tax_credit", "kind":"per_dependent", "amount":"<amount>", "phaseout": { "start": { "<status>":"<amount>" }, "per1000":"<amount>" } }],
  "estimated": { "periods":[{ "id":"Q1","due":"2026-04-15" },{ "id":"Q2","due":"2026-06-15" },{ "id":"Q3","due":"2026-09-15" },{ "id":"Q4","due":"2027-01-15" }],
                 "safeHarbor": { "priorYearPct":"1.00", "highIncomePct":"1.10", "highIncomeAgi": { "single":"150000","mfs":"75000","*":"150000" }, "currentYearPct":"0.90" } },
  "rounding": "whole_dollar_half_up", "retention": [{ "docType":"*", "years":3 }, { "docType":"property_basis", "rule":"until_sold_plus_3" }],
  "documents": [{ "when":"income:employment", "docs":["W-2"] }, { "when":"income:interest", "docs":["1099-INT"] }, { "when":"income:dividends", "docs":["1099-DIV"] },
                { "when":"income:brokerage", "docs":["1099-B","Consolidated 1099"] }, { "when":"income:self_employment", "docs":["1099-NEC","1099-K"] },
                { "when":"event:bought_home|deduction:mortgage", "docs":["1098"] }, { "when":"event:education", "docs":["1098-T"] },
                { "when":"income:retirement", "docs":["1099-R"] }, { "when":"income:social_security", "docs":["SSA-1099"] },
                { "when":"income:unemployment", "docs":["1099-G"] }, { "when":"income:k1", "docs":["Schedule K-1"] }, { "when":"hsa", "docs":["1099-SA","5498-SA"] },
                { "when":"marketplace_insurance", "docs":["1095-A"] }],
  "deadlines": [{ "name":"Federal return due", "date":"2027-04-15", "shiftWeekendHoliday":true }],
  "tests": [{ "input": { }, "expect": { "tax":"<amount>" }, "source":"<url>" }] }
```

**Pack values.** Every numeric value in `us-federal-2026.json` MUST be transcribed from official IRS publications for tax year 2026, with `verifiedOn` set. The numbers are deliberately not reproduced in this spec, so that nothing is copied from memory. CI runs the pack's `tests`, which take their worked examples from official sources. Deadline dates shift past weekends and federal holidays using `packs/holidays/us.json`.

**`generic.json`.** Has `tier:"custom"`. The user enters brackets, the standard deduction, the self-employment rate and deadlines in the estimator. These are stored in the instance answers, shown with "custom" badges, and run through the same math.

**`TaxInput`.**

```ts
{ packId:string; year:number; filingStatus:string; dependents:number; age65OrBlind?:number;
  incomes:{ kind:'wages'|'self_employment'|'interest'|'ordinary_dividends'|'qualified_dividends'|'stcg'|'ltcg'|'retirement'|'social_security'|'unemployment'|'rental'|'other'; amount:string; source?:string }[];
  adjustments:{ kind:'ira'|'hsa'|'student_loan_interest'|'se_health'|'other'; amount:string }[];
  deductions:'standard'|'auto'|{ itemized:{ kind:string; amount:string }[] };
  credits:{ id:string; amount?:string }[]; withheld:string; estimatedPaid:string; custom?:Record<string,unknown> }
```

**`TaxEstimate`.**

```ts
{ gross:string; agi:string; deduction:{ kind:'standard'|'itemized'; amount:string; standardWouldBe:string };
  taxable:string; ordinaryTax:string; preferentialTax:string; seTax:string; niit:string; credits:string; totalTax:string;
  brackets:{ rate:string; from:string; to:string|null; taxed:string }[]; effectiveRate:number; marginalRate:number;
  balance:string /* positive = estimated balance due, negative = estimated refund */; range?:{ low:string; high:string };
  lines:{ label:string; value:string; packRef?:string }[]; packVersion:string; verifiedOn:string; stale:boolean; disclaimer:string }
```

**Engine steps.**
1. Self-employment tax is `net_se × netEarningsFactor`. The Social Security part is capped at the wage base after wages, plus Medicare and additional Medicare. Half of it is deductible.
2. AGI is gross income minus adjustments minus the deductible half of SE tax.
3. The deduction is the larger of standard and itemized when `auto` is chosen.
4. Taxable income is `max(0, AGI − deduction)`.
5. Ordinary income runs through the brackets. Long-term capital gains and qualified dividends are stacked on top of ordinary income and taxed at the preferential rates.
6. Credits apply, subject to phase-outs.
7. Rounding follows the pack.

When inputs are incomplete (some questions answered "not sure"), `range` is computed from ±10% income sensitivity and the UI shows "≈".

**Quarterly payments.**
- *Safe harbor:* `max(0, priorYearPct × priorTax)`, or `highIncomePct` when prior AGI is above the threshold, minus expected withholding, divided by the remaining periods.
- *current_90:* `(0.90 × estimate.totalTax − withholding) / remaining`.
- *even_split:* `max(0, estimate.balance) / remaining`.

**Retention.** `keep_until(docType, filedDate)` is computed from the pack.

**Copy.** Results are never shown as "you owe". Show "Estimated balance due" and the persistent disclaimer: **"Estimates for planning only, based on {pack} v{version} verified {date}. Not tax advice. Verify with official sources or a qualified professional."** A pack is stale when its year differs from the selected year or `verifiedOn` is more than 13 months old.

### 15.7 Portfolio
- **Lots** (`lots::rebuild`).
  - v1 supports FIFO and average cost. Transaction types are buy, sell, dividend, reinvest, fee, split (ratio), transfer_in, transfer_out (basis kept), return_of_capital and interest.
  - Realised gains are classified as long-term when the holding period is more than 365 days (US pack). This comes from `packs/accounts/us.json`.
  - Invariant: Σ lot qty = position qty.
- **Performance.**
  - `xirr` uses Newton-Raphson from a guess of 0.1, at most 50 iterations, tolerance 1e-7, falling back to bisection on [−0.9999, 10].
  - `twr` chains daily returns from the price cache. When daily prices are missing it falls back to Modified Dietz per month.
- **Allocation.**
  - Classes come from `sec.class`.
  - Drift is current minus target, in percentage points.
  - A class is outside its band when `|drift| > band_abs` (default 5 pp) or `|drift| > band_rel × target` (default 25%).
- **Rebalance plan** (`rebalance::plan`). Steps, in order:
  1. Allocate new cash greedily to the most underweight classes, in proportion to their deficit.
  2. If still out of band, trade inside tax-advantaged accounts.
  3. Only if `allowTaxableSells`: sell taxable lots, losses first and then the highest basis.
  4. Respect `minTrade` and whole-share rounding unless `fractional` is set.

  EMP never places trades.
- **Dividends.** TTM, forward 12 months (the last regular dividend × its frequency), and a calendar.
- **Indicators.** SMA, EMA (α = 2/(n+1)), Bollinger (20, 2σ), RSI (14, Wilder) and MACD (12, 26, 9), computed in Rust over bars.
- **Risk** (P1). Volatility, max drawdown, Sharpe, beta.

### 15.8 Recurrence and natural-language dates (`emp-store::life`)
- **Recurrence.** `recurrence::next_after(rule, after, mode)` uses the `rrule` crate with `chrono-tz`. In `completion` mode it computes from the completion date. The `BYSETPOS=-1` business-day helper uses the holiday pack.
- **Natural-language dates.** The frontend parses with chrono-node for live chips. Rust `nlp_dates::parse` validates the result, which is authoritative. Supported forms:
  - "today", "tomorrow", "next fri", "in 3 weeks"
  - "Dec 3 3pm", "eom", "every weekday", "every 2 weeks", "for 45m"
  - tokens `#tag`, `!high|!med|!low`
- **Habits.**
  - `habits::streak(log, schedule, grace)` supports three grace modes:
    - `strict`
    - `never_miss_twice`: a single miss doesn't break the streak; two consecutive misses do.
    - `skip_days`: frozen days count as neutral.
  - `completion_rate(window)` is done ÷ expected, where expected is computed from the schedule: daily, `x_per_week`, weekdays or `every_n_days`.

---

## 16. Life apps (v1)

### 16.1 Framework
**Manifest.** `crates/emp-store/lifeapps/<id>.json` follows the Rust type `LifeAppManifest`, uses `deny_unknown_fields`, and is checked by a validation test.

```ts
interface LifeAppManifest {
  id:string; version:string /*semver*/; title:string; tagline:string; icon:string; color:string; category:'finance'|'investing'|'tax'|'sheets'|'planning'|'health';
  sensitivity:'normal'|'high'; estMinutes:number; disclaimer?:string;
  steps:Step[]; templates:Template[]; metrics:{ name:string; kind:'rust'|'expr'; fn?:string; expr?:string; deps:string[] /* templateKey.role */ }[];
  advisor:{ id:string; when:string /*Metric dialect*/; severity:'info'|'tip'|'warn'|'critical'; title:string; body:string; mathMetrics:string[]; actions:{ label:string; route:string }[] }[];
  checklist:{ id:string; label:string; autoTick?:{ event:string; where?:string } }[];
  migrations:{ to:string; ops:unknown[] }[]; sample:{ generator:string; seed:number };
}
interface Step { id:string; kind:'choice_cards'|'multi_chips'|'money'|'percent'|'number'|'slider'|'date'|'recurrence'|'list_builder'|'file_import'|'connect'|'jurisdiction'|'text'|'toggle'|'review';
  title:string; help?:string; why?:string; quick:boolean; skippable:boolean; when?:string; default?:unknown; recommend?:string /* rust fn id */;
  options?:{ value:string; label:string; description?:string; icon?:string }[]; itemSchema?:Record<string,string>; min?:number; max?:number; step?:number }
interface Template { key:string; kind:'page'|'database'|'view'|'dashboard'|'workbook'|'reminder'|'recurring'|'rule'|'row';
  parentKey?:string; optional:boolean; when?:string; spec:unknown /* typed per kind: PageSpec, DatabaseSpec{properties, roles, views, templates, seedRows}, DashboardSpec{tiles} … */ }
```

**Generation.**
- `lifeapp_preview` is pure and produces a `GenerationPlan`.
- `lifeapp_install` applies the plan in **one transaction**:
  - First it takes a `pre_lifeapp` version of any existing page it touches.
  - IDs are `UUIDv5(namespace = instance_id, name = templateKey [+ ":" + rowKey])`.
  - It creates one undo entry, labelled "Undo {App} setup".
- The instance record stores the answers, the `keyMap` and the `touched` fields.

**Updating an installed app.**
- **Tune-up:** re-run the wizard with the stored answers pre-filled. This produces a `PlanDiff`. Fields the user has touched are never overwritten silently; they show up as conflicts.
- **Upgrade:** migrations are additive only and are previewed before they run.
- **Detach** removes the link between the generated content and the app.
- **Uninstall** keeps the content by default.

**Metrics and the advisor.**
- Metrics are cached in memory after unlock. Recompute is debounced by 250 ms and triggered by `db:changed` on dependent databases.
- The advisor evaluates rules after each metric refresh.
- Insights are ranked: critical > warn > tip > info, then by recency.
- Muting is stored per instance.

**Sample data.**
- Seeded generators produce deterministic rows tagged `sample`.
- `lifeapp_sample_data(off)` deletes those rows.

**Checklist auto-tick.**
- Items tick themselves from Rust events, for example `finance.import_committed` and `budget.assigned`.

**Copy rules (all apps).**
- Use "common guideline", "consider" and "estimate".
- Finance and tax pages show a footer disclaimer.
- Never execute trades, filings or payments.

**Encryption prompt.** When `sensitivity:'high'` and the vault is unencrypted, the wizard shows the step "This data is sensitive — turn on encryption?", which leads to `vault_enable_encryption`.

**Quick mode** asks only the steps with `quick:true`. Every other step takes its `default` value or its recommendation.

### 16.2 Money HQ (`money-hq`, jade, `wallet`, sensitivity high)
**Questions.** Q marks a quick-mode question.

| # | id | kind | Q | Content / default |
|---|---|---|---|---|
| 1 | `currency` | choice_cards (searchable) | Q | Base currency (from the locale), number format, `monthStartDay` (default 1; "Align to payday?") |
| 2 | `household` | choice_cards | | Just me / With partner (joint, separate, or split %) / plus a dependents count. Adds a "Shared" group if relevant |
| 3 | `income` | list_builder | Q | `{name:text, amount:money, frequency:enum(weekly,biweekly,semimonthly,monthly,irregular), net:bool, nextPayDate:date}`. Default: one row "Salary", biweekly, net. Also `stability: stable\|variable\|irregular` |
| 4 | `method` | choice_cards | Q | 50/30/20, Zero-based, Pay-yourself-first, Envelopes, Track only. Chosen by `recommend_budget_method`: irregular income → zero-based with income buffer; any high-APR debt or tight cash → zero-based; stable income with savings rate ≥ 20% → pay-yourself-first; "simple" preference → 50/30/20 |
| 5 | `bills` | list_builder with chips | | Rent/Mortgage, Utilities, Phone, Internet, Insurance (health, auto, home, renters, life), Childcare, Transit, Loans, Subscriptions. Fields: `{name, amount, schedule:recurrence, autopay:bool, account}` |
| 6 | `accounts` | list_builder | Q | `{name, type:enum(checking,savings,credit_card,student_loan,auto_loan,mortgage,personal_loan,investment,cash,other_asset,other_liability), balance:money, apr?:percent, minPayment?:money, limit?:money, onBudget:bool}` |
| 7 | `debt` | choice_cards + slider | | Shown when a debt account exists. Strategy: avalanche (recommended) / snowball / hybrid / custom. Extra monthly slider from 0 to 2,000 in steps of 25. Shows a live `finance_debt_plan` table with debt-free date, total interest and months saved for each strategy |
| 8 | `emergency` | money + choice | | Current amount or linked savings account. Target months: 3 / 6 / 9–12, recommended by `recommend_ef_months` (dual stable income with no dependents → 3; single income or dependents → 6; irregular or self-employed → 9). Optional starter fund (default one month of essentials) |
| 9 | `goals` | list_builder with chips | | Car replacement, Holidays and gifts, Annual insurance, Vacation, Home repair, Medical deductible, Down payment. Fields: `{name, target, date, priority}`. Shows the monthly amount needed |
| 10 | `data` | file_import | Q | CSV / OFX / QFX / QIF (multiple files), Start blank, or Use sample data |
| 11 | `privacy` | toggle | | Turn on encryption (only if off), and "Hide amounts on launch" |
| 12 | `rituals` | recurrence | | Weekly check-in (default Sunday 10:00, 10 min), monthly review (first Saturday), bill reminders N days before (default 3), low-balance threshold per account |

**Generates.**
- **Pages**
  - **Money HQ** dashboard. KPI tiles:
    - Net worth (Δ vs last month)
    - Left to spend, or To be assigned (depends on method)
    - Savings rate (3 months)
    - Emergency fund months (gauge)
    - Debt-free date
    - Upcoming bills (7 days)

    Charts:
    - Sankey (income → groups → categories)
    - Budget vs actual (grouped bars by group)
    - Spending donut
    - Net worth stacked area plus net line
    - 90-day forecast with p10–p90 band and threshold line
    - Debt payoff stacked area
    - Goals rings
    - Insights feed

    Tabs: Overview · Transactions · Budget · Accounts · Goals · Bills · Reports.
  - "How your budget works": the chosen method explained with the user's own numbers.
  - "Financial order of operations" checklist, in seven steps:
    1. Budget plus starter emergency fund
    2. Employer match
    3. High-interest debt
    4. Full emergency fund
    5. Tax-advantaged saving
    6. Other goals
    7. Taxable investing
  - "Monthly review" and "Weekly check-in" recurring page templates.
- **Databases**
  - **Accounts**: Name, Type, Institution, Currency, Balance (computed), Cleared balance (computed), On budget, APR, Min payment, Credit limit, Utilization (formula), Last reconciled, Low-balance threshold, Closed, Last 4 (secret).
  - **Transactions**: Date, Payee (relation), Raw description, Memo, Amount (money, signed), Account (relation), Category (relation), Split parent (self-relation), Cleared (status: uncleared, cleared, reconciled), Transfer (self-relation), Import ID (hidden), Tags, Receipt (files), Source (select: manual, import, rule).
  - **Categories**: Name, Group (50/30/20 → Needs/Wants/Savings & Debt; other methods → default groups Bills, Everyday, Savings & Debt, Fun, Income), Essential, Rollover, Icon, Color, Target type, Target.
  - **Budgets** (Month × Category): Month, Category, Assigned, Activity (computed), Available (computed), Status (formula).
  - **Recurring**: Name, Amount, Schedule (recurrence), Next date (computed), Account, Category, Autopay, Reminder days, Kind, Variable.
  - **Goals**: Name, Kind (emergency, sinking, savings), Target, Target date, Saved, Monthly needed (formula, §15.5), Priority, Status, Progress.
  - **Net worth snapshots**: Month, Assets, Liabilities, Net worth, Source.
  - **Subscriptions**: Service, Amount, Cycle, Next charge, Annual cost (formula), Category, Status, Last price change, Value rating, Cancel URL.
  - **Rules** (backing store for `finance_rules_*`).
  - **Payees**: Name, Aliases, Default category, Icon.
- **Seeded categories.** The default taxonomy (BRAINSTORM §5.3) with `bucket`, Essential flags and Rollover set on sinking-fund categories.
- **Recurring and reminders.** Reminders for bills and rituals.
- **Advisor rules.**

  | Rule id | Condition | Severity |
  |---|---|---|
  | `cat-90pct` | category ≥ 90% spent with ≥ 10 days left | tip |
  | `cat-over` | category overspent | warn |
  | `forecast-breach` | forecast breach within 30 days | warn |
  | `ef-below-starter` | below starter fund | warn |
  | `ef-below-target` | below target | tip |
  | `sub-price-up` | subscription price up | info |
  | `sub-renewal-14d` | subscription renewal in 14 days | tip |
  | `uncategorized` | 10 or more uncategorised transactions | info |
  | `reconcile-30d` | not reconciled in 30 days | tip |
  | `util-30` | card utilization over 30% | tip |
  | `debt-vs-savings` | debt APR ≥ 10% while non-emergency savings grew 3 months in a row | info |
  | `savings-rate-down-3m` | savings rate down 3 months in a row | info |
  | `possible-dupes` | possible duplicates present | tip |

- **Checklist.**
  - Import transactions
  - Categorise last month
  - Set a budget
  - Set an emergency-fund goal
  - Review subscriptions
  - Do your first weekly check-in
- **Metrics.**
  - `net_worth`, `net_worth_delta_30d`
  - `to_be_assigned`, `left_to_spend`
  - `savings_rate_3m`, `essential_monthly_spend`, `ef_months`
  - `debt_free_date`
  - `upcoming_bills_7d`, `uncategorized_count`
  - `utilization_max`
  - `forecast_min_balance_30d`

### 16.3 Portfolio (`portfolio`, ocean, `candlestick-chart`, sensitivity high)
**Questions**

| # | id | kind | Q | Content |
|---|---|---|---|---|
| 1 | `experience` | choice_cards | Q | Beginner, Intermediate or Advanced. Controls indicator visibility and jargon tooltips. |
| 2 | `accounts` | list_builder | Q | `{name, broker, currency, type:enum from packs/accounts/<country>.json (US: 401k, 403b, ira, roth_ira, hsa, taxable, 529, crypto), taxTreatment:taxable\|deferred\|free}` |
| 3 | `depth` | choice_cards | Q | "Positions only" (ticker, qty, cost per position) or "Full history" (CSV import with generic mapping, or manual entry). |
| 4 | `basis` | choice_cards | | FIFO (default) or Average cost, per account. |
| 5 | `risk` | multi-question | | Horizon (<3, 3–10, >10 years), reaction to a 30% drop (sell, hold, buy), income stability, goal. Outputs a stock/bond *range*, labelled as education. |
| 6 | `targets` | choice_cards + editor | Q | "Three-fund style", "60/40", "Age-based (110−age stocks)", "All-equity" or "Custom". Each is labelled "example starting point, not a recommendation". Classes: US equity, Intl developed, Emerging, Bonds, Inflation-linked, REIT, Cash, Crypto, Other. Targets must sum to 100%, validated live. |
| 7 | `rebalance` | choice_cards | | Calendar (quarterly, semiannual or annual), Threshold (5 pp / 25% relative), or Hybrid (default). Cash-flow first: on. Avoid taxable sells: on. Minimum trade: 50. |
| 8 | `contrib` | money + recurrence | | Amount, frequency and accounts. |
| 9 | `market` | connect | Q | Keyless (default) or provider keys. States: "Only ticker symbols leave this device — never quantities, cost basis, account names or balances." |
| 10 | `watchlist` | list_builder | | `{ticker, alertAbove?, alertBelow?, alertPct?}` |
| 11 | `benchmark` | choice | | A symbol, or "blend of targets". |

**Generates**
- **Portfolio dashboard**
  - KPIs: Total value, Today Δ, Unrealised G/L, XIRR YTD and all-time, Dividends TTM and forward 12 months, Max drift, Fees per year.
  - Charts: allocation donut with a target ring, drift diverging bars, value vs contributions area, performance vs benchmark (TWR), holdings treemap (colour = day %), dividends by month.
- **Holding page template:** candlestick chart with SMA (indicators shown at Advanced), lots table, dividends, and a research note (thesis, what would change my mind, risks, review date).
- **Investment Policy Statement page:** pre-filled from the answers, with "rules I follow when markets fall" and a signature/date line.
- **Rebalance planner page.**
- **"Annual investing review"** recurring checklist.
- **Databases**
  - Investment accounts, which link to Money HQ Accounts when that app is installed.
  - Securities: Ticker (ticker), Name, Asset class, Region, Type, Currency, Expense ratio, Last price (computed), Price as-of.
  - Investment transactions.
  - Lots (computed, read-only).
  - Holdings (computed view).
  - Target allocation: Asset class, Target %, Band abs, Band rel, Current % (computed), Drift (computed), Status.
  - Watchlist (backed by `watchlists`).
  - Dividends.

**Advisor rules**

| Rule id | Condition | Severity |
|---|---|---|
| `drift-band` | Drift outside its band | warn |
| `concentration-10` | A position is more than 10% of the portfolio | tip |
| `cash-drag` | Cash above 5% for 60 days | info |
| `high-er` | Expense ratio above 0.5% | info |
| `stale-prices` | Prices older than 3 days | info |
| `ips-review` | IPS review is due (annual) | tip |
| `harvest-review` | It is December and there are unrealised taxable losses | info |

**Checklist:** Add accounts · Import or enter positions · Set target allocation · Write your IPS · Run your first rebalance check.

**Metrics:** `total_value`, `day_change`, `unrealized`, `xirr_ytd`, `xirr_all`, `div_ttm`, `div_fwd_12m`, `max_drift`, `fees_per_year`.

### 16.4 Tax Organizer (`tax-organizer`, amber, `receipt-text`, sensitivity high)
**Questions**

| # | id | kind | Q | Content |
|---|---|---|---|---|
| 1 | `jurisdiction` | jurisdiction | Q | Country (v1 estimator: US federal; any other country uses Generic/Custom), state/region (checklist only), tax year (current year, or the previous year if today is before April 16), residency. Shows the pack tier and its verified date. |
| 2 | `household` | choice_cards | Q | Filing status (from the pack), dependents, and age 65+/blind count. |
| 3 | `income` | multi_chips | Q | Employment, self-employment, interest, dividends, brokerage, crypto, rental, retirement, social security, unemployment, K-1, foreign, other. |
| 4 | `events` | multi_chips | | Married, divorced, baby/adoption, moved, bought home, sold home, started business, retired, education, inheritance, large medical, landlord, job loss, equity comp. |
| 5 | `deductions` | choice_cards | | Not sure (auto-compares), standard, itemized. |
| 6 | `payments` | money ×4 | | YTD withholding, expected remaining withholding, estimated payments made, prior-year total tax and AGI. "Expect to owe estimated tax?" is auto-yes if self-employment is selected. |
| 7 | `preparer` | choice_cards | | Self with software / professional (generates a preparer packet) / not sure. |
| 8 | `documents` | toggle | | Store originals encrypted (recommended) or track status only. |
| 9 | `reminders` | number | | Remind N days before deadlines (default 14 and 3). |

**Generates**
- **Tax Year {YYYY} hub:**
  - status ring (documents received / expected)
  - next-deadline countdown
  - "Estimated balance due / refund" card
  - quarterly timeline
  - deductions vs standard bar
  - insights
  - persistent disclaimer banner
- **Estimator page.** Pulls figures from Money HQ income categories and Portfolio realised gains/dividends when those apps are installed. Each pulled figure needs confirmation and carries a source chip.
  - "Show math" lists every line.
  - Scenario toggles: +$5k self-employment income, +$X retirement contribution, with deltas shown.
- **Quarterly payments page.**
- **Preparer packet page:** exports to PDF through the print path.
- **Year-end planning checklist.**
- **Record retention guide.**
- **Databases**
  - Document checklist (generated from `pack.documents` and the answers): Document, Issuer, For, Expected by (Jan 31 / Feb 15 / Mar 15 per doc type, from the pack), Status (Expected / Received / Reviewed / Sent to preparer / N/A), File (encrypted), Amount summary, Notes, Keep until (computed).
  - Deductions & credits: Date, Description, Category (pack list), Amount, Deductible %, Receipt, Payee, Tax year.
  - Estimated payments: Period, Due date, Suggested (computed), Paid amount, Paid date, Method, Confirmation # (secret), Status (formula).
  - Deadlines.
  - Mileage log: only if self-employment is selected.
- **Reminders** for deadlines and estimated payments. With Money HQ installed, these also appear as Recurring bills.

**Advisor rules**

| Rule id | Condition | Severity |
|---|---|---|
| `deadline-14` | Deadline in 14 days | tip |
| `deadline-3` | Deadline in 3 days | warn |
| `doc-late` | Expected document not received by expected date + 14 days | tip |
| `se-no-estimates` | Self-employment income YTD implies a quarterly payment over $1,000 and no payment is recorded (US pack threshold) | warn |
| `itemize-close` | Itemised total ≥ 90% of standard | info |
| `pack-stale` | Pack is stale | warn |
| `receipt-missing` | Deduction over $250 with no receipt | tip |
| `setaside-short` | Money HQ "Taxes" sinking fund is below the estimated balance due | info |

**Checklist:** Confirm filing status · Add expected documents · Log your first deduction · Review quarterly plan · Choose a preparer path.

**Metrics:** `docs_received_pct`, `next_deadline`, `est_balance`, `est_effective_rate`, `deductions_total`, `quarterly_next`.

### 16.5 Spreadsheet Studio (`spreadsheet-studio`, iris, `sheet`, sensitivity normal)
**Questions**

| # | id | kind | Q | Content |
|---|---|---|---|---|
| 1 | `intent` | choice_cards | Q | Loan/mortgage calculator, Budget sheet, Decision matrix, Project budget, Timesheet, Inventory, Split expenses, Savings/compound interest, Blank with best-practice structure, or Import a file (xlsx, xls, ods, csv, or Google Sheets URL if connected). |
| 2 | `excel_compat` | toggle | | "Will you share this with Excel users?" When on, restrict to round-trip functions and warn on EMP-only ones (`STOCK`, `FX`). |
| 3 | `structure` | multi_chips | | Inputs, Calculations, Output, Checks, Changelog. All on by default. |
| 4 | `chart` | choice | | None, Line, Bar, Area or Donut, with a live preview. |
| 5 | `import_opts` | — | | Only shown when importing: header-row detection, "Keep as spreadsheet / Convert to database / Both (linked)", and "Run checks now?". |

**Generates** a workbook. All templates share these conventions:
- Input cells use `role:'input'`, which renders as accent-soft fill with accent-text.
- Outputs are bold.
- A legend row sits at the top of each sheet.
- Constants live in named ranges on Inputs.
- Checks show green or red status in the sheet tab colour.
- Header rows are frozen.
- Dates are ISO.

Template formulas (exact):

- **Loan**
  - `Payment = PMT(Rate/PPY, Years*PPY, -Principal)`
  - The schedule uses `SEQUENCE(Years*PPY)`, with `IPMT` and `PPMT` per row.
  - `Balance = Principal + CUMPRINC(Rate/PPY, Years*PPY, Principal, 1, n, 0)`. CUMPRINC returns a negative number here.
  - Extra payment: a column that recomputes the payoff date via `MATCH(TRUE, Balance<=0, 0)`.
  - Chart: balance plus interest vs principal.
- **Decision matrix**
  - Weights must satisfy `SUM(Weights)=1` (a Check cell).
  - `Score = SUMPRODUCT(Weights, Scores)`
  - `Rank = RANK.EQ`
  - Sensitivity: each weight ±10%.
- **Timesheet**
  - `Hours = MOD(End-Start,1)*24 - Break/60`
  - Weekly totals with `SUMIFS`.
  - An overtime threshold input.
- **Inventory**
  - `Value = Qty*Cost`
  - `Reorder = FILTER(Items, Qty<=ReorderPoint)`
  - Conditional format red when `Qty<=ReorderPoint`.
- **Split expenses**
  - Balances per person.
  - "Who pays whom" is computed by Rust `settle::minimal_transfers` (greedy: largest debtor pays largest creditor) and written as values with a refresh button.
- **Compound interest**
  - `FV(Rate/12, Years*12, -Monthly, -Start)`
  - Inflation-adjusted column.
  - Line chart.

**Advisor (lint):** the `sheet_lint` results are surfaced as insights. Rules: hard-coded constants, inconsistent column formula, `#REF!`, `#DIV/0!`, circular reference, number stored as text, merged cells in data.

**Checklist:** Fill the inputs · Review the checks sheet · Export to Excel.

### 16.6 Life OS (`life-os`, blue, `kanban`, sensitivity normal)
**Questions**

| # | id | kind | Q | Content |
|---|---|---|---|---|
| 1 | `style` | choice_cards | Q | Simple (Today/Upcoming), GTD, Time-blocking, PARA, or Mix. |
| 2 | `areas` | multi_chips | Q | Work, Health, Money, Home, Relationships, Learning, Fun, Side project, Family, Community. Each choice becomes an Area. |
| 3 | `priority` | choice_cards | | P1–P4 (default), Eisenhower, or "Top 3 per day". |
| 4 | `hours` | time inputs | | Working days, hours, peak-focus window, max focus blocks. |
| 5 | `calendar` | connect | | Optionally connect Google Calendar (read) and pick which calendars to show. |
| 6 | `rituals` | recurrence | Q | Daily planning time (default 08:30), shutdown (17:30), weekly review (default Friday 16:00), monthly reset. |
| 7 | `capture` | toggle | | Natural-language dates (on). The global hotkey is P1 and is shown disabled with "Coming soon". |

**Generates**
- **Today page**, which is also the sidebar's Today item:
  - an agenda timeline (Google events plus scheduled task blocks)
  - Top 3
  - due and overdue tasks
  - a habit strip (if Habits is installed)
  - insights from all apps
  - a quick-add bar with NL parsing
- **Databases**
  - **Tasks:** Title, Status (Inbox, Next, Scheduled, Waiting, Someday, Done; using status groups), Priority (or Eisenhower quadrant), Due (date), Scheduled (date+time range), Estimate (number, minutes), Area (relation), Project (relation), Context (multi: @home, @computer, @errands, @calls), Energy (select), Recurrence, Waiting on (text), Source, Completed at (date).
  - **Projects:** Name, Area, Status, Outcome, Deadline, Progress (rollup `pct_checked` of Done), Next action (formula: first Next task title), Review date.
  - **Areas:** Name, Standard, Icon.
  - **Resources:** PARA only.
  - **Daily notes:** Date, Top 3, Log, Gratitude, Shutdown checklist. This database backs `daily_note_open`.
- **Views:** Inbox, Today, Upcoming (calendar), Board by status, Eisenhower (board grouped by a quadrant formula), Someday, Waiting, Completed.
- **Weekly review recurring page:**
  1. Get clear: inbox to zero.
  2. Get current: calendar for the past week and the next two weeks, projects without a next action, waiting list, insights.
  3. Get creative: someday list.
  4. Choose next week's top 3.
- **Recurrence behaviour:** completing a recurring task creates the next occurrence (§15.8) with a check-burst animation.

**Advisor rules**

| Rule id | Condition | Severity |
|---|---|---|
| `inbox-20` | Inbox > 20 | tip |
| `project-no-next` | Project with no Next task | tip |
| `overdue-5` | Overdue > 5 | warn |
| `overbooked` | Scheduled minutes > working minutes today | warn |
| `review-missed` | Weekly review missed | tip |

**Checklist:** Capture 5 tasks · Process your inbox · Create a project with a next action · Do your first weekly review.

**Metrics:** `inbox_count`, `overdue_count`, `today_scheduled_min`, `projects_without_next`, `last_review_date`.

### 16.7 Habits (`habits`, ruby, `heart-pulse`, sensitivity normal)
**Questions**

| # | id | kind | Q | Content |
|---|---|---|---|---|
| 1 | `pick` | list_builder with library chips | Q | Library chips: Sleep 7–9 h, Walk 8k steps, Strength train, Water, Read 20 min, Meditate, Journal, No phone first hour, Inbox zero, Language practice, Floss, Budget check-in, Stretch. Custom habits allowed. |
| 2 | `details` | per-habit sub-form | | Type (yes/no, count, duration, quantity+unit, avoid). Schedule (daily, X per week, weekdays, every N days). Target. Two-minute version. Cue ("After I ___, I will ___"). Time of day. Reminder. |
| 3 | `identity` | text | | "I'm becoming someone who…" (optional). |
| 4 | `grace` | choice_cards | Q | Strict, Never miss twice (recommended), or Skip days. |
| 5 | `review` | toggle | | Weekly reflection on or off. |

**Generates**
- **Habits database**
  - Name, Type, Schedule, Target, Unit, Two-minute version, Cue, Time of day, Area, Active
  - Computed: Current streak, Best streak, 30-day rate
- **Habit log database**
  - Date, Habit, Value, Status (done / partial / skipped / missed / frozen), Note, Mood (1–5, optional)
- **Dashboard**
  - Per-habit heatmap of 12×12 cells; the cell fills with a scale animation on check-in
  - Streak flame with a pop animation (`spring.bouncy`) when the streak increments
  - Weekly score ring
  - 4-week sparkline
  - Today checklist: tap to complete, long-press to enter a value
  - Identity card
- **Weekly habit review** template
- **Reminders** per habit

**Advisor rules**

| Rule id | Condition | Severity |
|---|---|---|
| `dont-miss-twice` | Missed yesterday | tip |
| `make-smaller` | Under 40% for 3 weeks | tip |
| `level-up` | ≥ 90% for 21 days | info |
| `too-many` | More than 6 active habits started within the last 14 days | tip |

**Checklist:** Check in today · Hit a 3-day streak · Do a weekly reflection.

**Metrics:** `active_count`, `today_done_pct`, `best_streak`, `rate_30d_avg`.

### 16.8 Cross-app links (v1)
| From | To | What flows |
|---|---|---|
| Portfolio | Money HQ | Investment account values become Net worth assets. |
| Portfolio | Tax | Realised ST/LT gains and dividends become estimator inputs, each confirmed by the user. |
| Money HQ | Tax | Income categories become wages and other income inputs, each confirmed by the user. |
| Tax | Money HQ | The suggested set-aside creates a "Taxes" sinking fund goal. Estimated payments become Recurring items. |
| All apps | Life OS Today and Home | Insights and due items. |
| Habits | Life OS | Habit strip on Today. |

How links work:
- Links are ordinary relations and metric bindings.
- Linked values carry a "from {App}" chip.
- No link sends anything off the device.
---

## 17. Integrations (v1)

### 17.1 Google
**Setup sheet (`GoogleSetupSheet.tsx`)** walks the user through six numbered steps. Each step has a deep link and copyable fields:

1. Create a Google Cloud project.
2. Enable these APIs: Calendar, Docs, Sheets and Drive.
3. Configure the OAuth consent screen with type "External".
4. Add yourself as a test user. Then choose **Publish app → In production**.
5. Create an OAuth client of type **Desktop app**.
6. Paste the Client ID and Client secret.

The sheet must also show these points:
- A callout: "In Testing mode Google expires access every 7 days. Publishing for personal use is fine: Google will show an 'unverified app' screen you can continue past."
- A "Test connection" button. It runs `google_connect({feature:'calendar'})` and confirms with a checkmark animation.
- A note that the redirect URI is chosen automatically. It is a random `http://127.0.0.1:<port>`, so the user does not configure it.

**Calendar (read)**
- **Calendar list.** `calendarList.list` returns the calendars. The user picks which ones to show. Each keeps its Google colour, mapped to the nearest block colour.
- **Event fetch.** The first sync calls `events.list` with `singleEvents=true` and a window of −90 to +365 days. Later syncs pass the stored `syncToken`.
- **Sync token reset.** On `410 Gone`, drop the token and resync silently.
- **When it syncs:**
  - every 5 minutes (the default) while unlocked
  - when the window regains focus
  - after waking from sleep
  - on manual refresh
- **Storage.** Events are stored as `kv ns=gcal.events`, encrypted, keyed by a blind index. `calendar_events` merges them with database date properties.
- **Dates.** All-day events are `date`, not `dateTime`. They are rendered without timezone shifts.

**Docs import**
- **ID extraction.** Get the document ID from the URL with `/document/d/([a-zA-Z0-9_-]+)`, then call `documents.get`.
- **Block mapping:**

  | Google Docs element | TipTap result |
  |---|---|
  | HEADING_1–3 | Headings |
  | TITLE | Page title |
  | Bullets | Bullet or numbered lists, by `glyphType` |
  | Tables | Table |
  | Inline images | Downloaded immediately (the URLs are short-lived) and stored as assets |
  | Bold, italic, underline, strike, links | Same marks |
  | Text colours | Nearest block colour |
  | Horizontal rule | Divider |
  | Footnotes | List at the end of the page |
  | Comments, suggestions, headers | Dropped, with a warning |

- **Fallback.** If mapping fails, call Drive `files.export` as `text/html` (10 MB cap) and run it through the HTML import path.

**Docs export**
- Convert the page to sanitised HTML.
- Upload it with a Drive multipart request: `mimeType: application/vnd.google-apps.document`, scope `drive.file`.
- Store the remote ID in `sync_links`. "Export again" calls `files.update` on that ID.

**Sheets import**
- **Metadata.** `spreadsheets.get` returns sheets, grid sizes, frozen rows, merges and number formats.
- **Values.** Call `values.batchGet` twice: once with `FORMULA` and once with `UNFORMATTED_VALUE`.
- **Unsupported functions.** Keep the cached value. Show an amber corner flag with the tooltip "Unsupported function – value frozen at import".
- **GOOGLEFINANCE.** Map `GOOGLEFINANCE` to `STOCK`.

**Sheets export**
- `spreadsheets.create`, then `values.batchUpdate` with `USER_ENTERED`, then a `batchUpdate` for formatting: bold header, frozen row, number formats, widths.
- Scope: `drive.file`.

**Quotas:** 300 read and 300 write requests per minute per project (verify). Batch requests wherever possible.

### 17.2 Market data
**Providers (v1)**

| id | Key? | Capabilities | Default | Notes |
|---|---|---|---|---|
| `frankfurter` | no | fx | **on** | ECB reference rates, daily. Cache per date. |
| `stooq` | no | daily (EOD) | **on** | CSV `https://stooq.com/q/d/l/?s=<sym>.<mkt>&i=d`; EOD only. Symbol suffixes: `.us`, `.uk`, `.de`, `.jp`. |
| `coingecko` | no (optional Demo key) | crypto quote, daily | **on** | Public API, about 5–15 requests/min. |
| `finnhub` | yes | quote, search, dividends | off until key | About 60 requests/min. Candles are paid, so they are not used. |
| `tiingo` | yes | daily (adjusted), dividends, search | off until key | About 1,000 requests/day. Preferred source for history. |
| `yahoo` | no | quote, daily | **off**, P1, labelled "Community source" | Unofficial, ToS grey area. Behind a cargo feature. |

**Fallback chains** (all user-reorderable):

| Data | Order |
|---|---|
| Quote | finnhub → coingecko (crypto) → stooq (last close, freshness `eod`) |
| Daily | tiingo → stooq → coingecko (crypto) |
| Search | finnhub → tiingo → built-in symbol list (`resources/symbols-top.json`, about 6,000 US/UK/EU tickers and ETFs plus the top 250 coins) |
| FX | frankfurter |

**Symbols**
- A symbol is `SymbolKey = TICKER:MIC`, where MIC is the market identifier code (e.g. `XNAS`, `XNYS`, `XLON`), or `CRYPTO`, or `FX`.
- Per-provider symbol mapping lives in the securities payload: `{providerSymbols:{stooq:"aapl.us", tiingo:"AAPL", finnhub:"AAPL", coingecko:"bitcoin"}}`.

**Caching**
- Closed daily bars are immutable and kept forever.
- Quotes have a 60 s TTL. They are refreshed only while the market is open and a subscriber exists. Subscriptions are reference-counted.
- Market hours and holidays come from `packs/holidays/exchanges.json`, covering NYSE/NASDAQ, LSE, XETRA, TSE and Euronext.
- When the market is closed, show "Closed · as of 4:00 PM ET" with a grey dot. When live, show a pulsing gain dot. The pulse becomes static in reduced motion.

**Data hygiene**
- Every number shows a freshness badge (Live / 15m delayed / EOD), and its tooltip names the source provider.
- Values must be finite. A move of more than 50% with no split flag is marked "unverified" and is not charted.
- Disclosure text, shown in onboarding and in Settings → Market data: "Providers see which symbols you look up and your IP address. EMP never sends quantities, cost basis, account names or balances."

**Watchlist alerts**
- The scheduler checks alerts on each quote refresh.
- When an alert triggers, it emits `market:alert` and an OS notification.
- Alerts are debounced so each one fires at most once per symbol per rule per day.

### 17.3 ICS
- **Import** uses the `ical` crate with `rrule` expansion (limits in §9.16). VEVENT becomes a calendar event or a database row. VTODO becomes a Life OS task.
- **Export** uses the `icalendar` crate. Rows with a date property become VEVENT entries.
- **Subscriptions** are P1.

### 17.4 Notion zip import (v1)
- Recursively unzip nested `Part-N.zip` archives in memory, applying the limits in §9.16.
- Strip the 32-hex id suffixes from filenames and keep them as a map from id to new id.
- **Prefer HTML when present.** Map elements as follows:

  | Notion HTML | EMP |
  |---|---|
  | `<details>` | toggle |
  | `<aside>` | callout with its emoji |
  | `.column-list` | columns |
  | `notion-*-background` / `-color` classes | block colours |
  | `<figure class="equation">` | math |

- Otherwise parse Markdown with comrak (GFM).
- **Databases.** Read from CSV, preferring `*_all.csv`. Row bodies come from the sibling folder.
- **Property type inference:**

  | Detected pattern | EMP property type |
  |---|---|
  | Notion date strings such as `November 26, 2026 3:00 PM` and `A → B` ranges | date |
  | Comma-separated values with ≤ 50 distinct | multi_select |
  | Yes/No | checkbox |
  | Link columns | relation, resolved in pass 2 by id and then by title |
  | People | text |
  | File paths | files |
  | Formula columns | text or number, with a warning |

- Every imported database gets a default Table view.
- Select options are assigned colours from the palette in order.
- **Report** (rendered with clickable items): pages, databases, attachments, unresolved links, and unsupported blocks. Synced blocks become copies; embeds become bookmark-style link paragraphs.
- The whole import is one `import_undo` unit.

### 17.5 Markdown import/export
- **Import:**
  - Single files or folders, where the folder hierarchy becomes the page tree.
  - YAML front matter becomes page properties when importing into a database. Otherwise it becomes a callout.
  - `[[Wikilinks]]` and `[[Page|alias]]` become mentions, resolved in pass 2.
  - `![[img]]` and relative images become assets.
  - `#tags` are collected into a "Tags" text line.
  - `- [ ]` becomes a to-do.
  - Fenced code keeps its language.
  - `> [!note]` becomes a callout.
  - `$$` becomes math.
- **Export:**
  - Each page becomes `<Title>.md` with front matter. Duplicate names get ` (2)`.
  - Assets go to `assets/`. Page mentions become relative links.
  - EMP-only blocks export as fenced code with an `emp-block` info string carrying JSON, which makes re-import lossless.
  - Databases export as CSV plus a folder of row `.md` files.
- **Export everything** writes a zip containing:
  - `pages/**`
  - `databases/*.csv` and `*.schema.json`
  - `sheets/*.xlsx`
  - `attachments/`
  - `calendar/*.ics`
  - `emp-full.json` (a lossless dump, excluding secrets)
  - `manifest.json` with SHA-256 sums

---

## 18. Performance budgets

**Reference machines:**
- Apple M1/M2 (macOS)
- i5-1235U with 16 GB RAM (Windows, WebView2)
- On Linux with WebKitGTK on the same Intel laptop, every budget is multiplied by 1.5.

CI measures each budget (§19). A run fails if a p95 value goes over its ceiling, or if anything regresses by more than 15% against `main`.

| # | Metric | p50 target | p95 ceiling |
|---|---|---|---|
| B1 | Launch → first painted frame (lock or shell, no white flash) | 350 ms | 700 ms |
| B2 | Launch → interactive last page (unencrypted) | 650 ms | 1.1 s |
| B3 | Argon2id Standard on reference | 0.5–1.0 s | 1.5 s |
| B4 | Unlock done → sidebar + last page painted | 200 ms | 350 ms |
| B5 | Page open warm | 40 ms | 80 ms |
| B6 | Page open cold (100 KB doc, encrypted) | 90 ms | 150 ms |
| B7 | Keystroke → paint on a 5,000-block doc | ≤ 8 ms | ≤ 16 ms (p99 ≤ 25 ms) |
| B8 | Slash menu / palette open | 30 ms | 60 ms |
| B9 | Save of a 200 KB doc in Rust (zstd + encrypt + WAL) | 3 ms | 8 ms |
| B10 | Sidebar with 5,000 pages render/expand | 20 ms | 40 ms |
| B11 | 10k-row DB, first window cold | 120 ms | 200 ms |
| B12 | 10k-row DB, first window warm | 25 ms | 50 ms |
| B13 | 10k-row DB, filter/sort change end-to-end | 45 ms | 80 ms |
| B14 | 10k-row DB scroll | 60 fps, no frame > 20 ms | window fetch ≤ 8 ms |
| B15 | 100k-row DB first window cold | 600 ms | 1.0 s |
| B16 | Board 10k cards / 8 groups | 120 ms | 200 ms |
| B17 | DB cell edit → repaint | 1 frame | 16 ms |
| B18 | Sheet tile fetch (256×32) | 4 ms | 10 ms |
| B19 | Sheet edit with ≤ 10k dependents → visible repaint | 20 ms | 40 ms |
| B20 | Full recalc of 100k formulas | 250 ms | 450 ms |
| B21 | xlsx import 10 MB (~1M cells) | 2 s | 4 s |
| B22 | Search keystroke → results (10k pages) | 10 ms | 25 ms |
| B23 | Full-text index build, 10k pages (background) | 1.2 s | 2.5 s |
| B24 | Candlesticks 5y daily (1,300 bars) | 15 ms | 30 ms |
| B25 | Finance dashboard (6 charts) mount | 120 ms | 200 ms |
| B26 | Animations | 60 fps (120 on ProMotion), ≤ 4 ms JS/frame | ≤ 2 dropped frames per transition |
| B27 | Idle memory, 1 page open (Rust + webview) | 150 MB | 220 MB |
| B28 | Lock/onboarding JS chunk | ≤ 90 KB gz | |
| B29 | Shell + editor JS | ≤ 250 KB gz | |
| B30 | Total JS / CSS | ≤ 1.3 MB gz / ≤ 40 KB gz | |
| B31 | Rust binary per arch (stripped) | ≤ 22 MB | |
| B32 | Installers | dmg universal ≤ 35 MB; msi/nsis ≤ 12 MB; deb/rpm ≤ 12 MB; AppImage ≤ 90 MB | |
| B33 | Unlock integrity verify (100k rows) | 60 ms | 150 ms |
| B34 | Money HQ: monthly rollup over 50k transactions | 30 ms | 60 ms |
| B35 | Debt sim 20 debts × 600 months | 2 ms | 5 ms |
| B36 | Portfolio lot rebuild, 10k transactions | 50 ms | 100 ms |
| B37 | Life-app install (Money HQ, guided, no import) | 400 ms | 800 ms |

How the budgets are met:
- **Startup**
  - Setup is minimal: paths, DB, pragmas and the vault header. Everything else starts lazily.
  - The KDF runs while shell chunks preload.
  - `workspace_open` returns the tree, recents and last route in one call.
- **Editor**
  - No IPC on keystrokes.
  - Plain-DOM node views.
  - `content-visibility` on blocks.
  - An editor pool.
- **Database**
  - Rows are decrypted once into typed columns.
  - Result caches are keyed by `(view, queryHash, dataRev)`.
  - Windows are projected to only the properties needed.
- **Sheets**
  - Canvas grid with tiles.
  - Display strings are formatted in Rust.
  - Shared formulas and cut-off propagation.
- **Bundle**
  - Lazy chunks.
  - `size-limit` checks in CI.
- **Rust build**
  - Fat LTO with `codegen-units=1`.
  - `default-features=false`.
  - rustls.
  - No `tokio/full`.

---

## 19. Testing, CI and release

### 19.1 Test matrix
| Layer | Tooling | Must cover |
|---|---|---|
| emp-crypto | cargo test, proptest, cargo-fuzz | KATs (§9.1). Bit-flip tamper tests on every field and every AAD component. Swap tests (id, table, vault). Wrong password returns `BAD_PASSWORD`, not `CRYPTO`. STREAM truncation and reorder. Param bounds rejected before the KDF runs. |
| emp-store | cargo test (tempdir), proptest-state-machine | CRUD in both modes. Model-based tree tests for acyclicity, sort order and rev monotonicity. Query engine checked against a naive reference. Doc indexer. Markdown round-trip. Migrations from every fixture. Encryption enable/disable interrupted at random batch points, then resumed. Manifest detects row deletion and rollback. **Plaintext leakage test:** canaries in every content field, then scan `vault.db`, `-wal`, `-shm`, assets and snapshots for UTF-8, UTF-16 and base64 hits. Zero hits allowed. Hostile snapshot restore is rejected. |
| emp-sheets | cargo test, proptest, fuzz, criterion | Function TOML tables (≥ 15 cases each). Excel parity corpus. Parser round-trip. Ref adjustment checked against a re-parse oracle. Spill. Cycles. numfmt corpus. |
| emp-finance | cargo test, proptest | PMT/IPMT/PPMT/XIRR/IRR against Excel values. Debt: balances ≥ 0, total paid ≥ principal, avalanche interest ≤ snowball interest. Lots: Σ qty invariants. Budget identities. OFX/QFX/QIF/CSV corpus, including malformed files. Recurring-detection precision ≥ 0.9 and recall ≥ 0.8 on synthetic ledgers. Tax pack `tests`. Bootstrap determinism by seed. |
| emp-integrations | wiremock, tokio test | PKCE S256. State mismatch. Loopback Host check and timeout. Refresh and revoke. `invalid_grant` → `reauth_required`. gcal `410` resync. Docs/Sheets converters on fixtures. Provider chains, rate limits and TTLs. Allowlist enforcement. Size caps. Offline mode. Private-IP block. |
| emp-app | tauri mock runtime | Locked gating on every data command. Reauth gating. Error mapping. `ALL_COMMANDS` ↔ capability ↔ `contract.ts` parity. Capability snapshot test. |
| Frontend unit | Vitest + Testing Library + happy-dom | ui primitives (roles, keyboard), stores, router, `ViewController`, `GridController`, `useDocSave`, formatting, LTTB, shortcut matching. |
| Contract | Vitest suite in `src/test/contract` | Runs against MockBackend on every PR and against TauriBackend nightly. |
| E2E (mock) | Playwright Chromium | Onboarding with encryption and recovery verify. Lock/unlock. Pages CRUD and DnD. Slash and turn-into. Database CRUD, filters, board drag. Sheet formulas and paste. Each of the 6 life apps installs and its dashboard renders. CSV import. Palette. Hide numbers. Settings. |
| Visual regression | Playwright `toHaveScreenshot` (Linux, frozen clock, reduced motion, seed `demo`) | ~60 screens × light/dark/midnight × iris/amber. Component gallery route `/#/__gallery` (mock only) covering every state. |
| Accessibility | @axe-core/playwright | Zero serious or critical violations. `scripts/contrast-check.ts` checks every text/surface pair in §3. |
| Performance | Playwright traces (seed `perf`), criterion, github-action-benchmark | B7, B8, B10–B14, B22 on PRs (mock). The full table runs nightly on real builds. |
| Real app | WebdriverIO + tauri-driver (Linux, Windows) | Launch, create encrypted vault, add page, restart, unlock, verify, export xlsx. macOS uses a manual checklist. |
| Security | cargo-deny, cargo-audit, `npm audit --omit=dev --audit-level=high`, gitleaks, CodeQL (JS/TS), XSS corpus test, CSP-violation listener, bundle grep (`eval(`, `new Function(`, mock sentinel), banned-claims grep | Run on every PR. |

### 19.2 CI (`.github/workflows/ci.yml`)
**Workflow-wide settings**
- `permissions: contents: read`.
- Every action is pinned by full SHA with a version comment.
- `actions/checkout` uses `persist-credentials: false`.

**Jobs**
1. **rust-lint** (ubuntu-22.04): `cargo fmt --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo deny check`, `cargo audit`.
2. **rust-test** (matrix: ubuntu-22.04, macos-latest, windows-latest): `cargo test --workspace --locked`.
3. **wasm** (ubuntu): builds the emp-store wasm feature and wasm-bindgen output, then uploads it as an artifact.
4. **frontend** (ubuntu):
   - `npm ci` (with `ignore-scripts`)
   - `npm run gen:types && git diff --exit-code`
   - `npm run typecheck`, `npm run lint`, `npm test`
   - `npm run build:desktop`, which also asserts that no mock chunk is present
   - `npx size-limit`
5. **e2e-mock** (ubuntu): `npm run build:web` (uses the wasm artifact), then Playwright E2E, visual, axe and the perf subset. Uploads reports.
6. **bundle-smoke** (ubuntu): `npm run tauri build -- --debug --bundles deb`.
7. **fuzz-smoke** (ubuntu, nightly toolchain): each fuzz target runs for 60 s.

**`nightly.yml`**: full fuzz (30 min per target), full performance suite on real builds, tauri-driver E2E, and benchmark trends.

### 19.3 Release (`.github/workflows/release.yml`, tag `v*.*.*`)
**Workflow-wide settings**
- Top-level `permissions: contents: read`.
- Release jobs add `contents: write`, `id-token: write` and `attestations: write`.
- Signing runs in the protected environment `release`.

**Jobs**
1. **create-release**: creates a draft GitHub Release named `EMP <version>`. It is marked prerelease if the tag contains `-`. Release notes come from `generate_release_notes` plus the "First launch" section below.
2. **build** (matrix):
   - `macos-latest` with `--target universal-apple-darwin` (Rust targets aarch64 and x86_64)
   - `windows-latest`
   - `ubuntu-22.04`
   - `ubuntu-22.04-arm`, only if available

   Each matrix entry:
   - Installs the Linux packages `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libxdo-dev`.
   - Runs `npm ci`.
   - Runs `tauri-apps/tauri-action` (pinned by SHA) with `releaseId` and `includeUpdaterJson: true`.
   - Gets these environment secrets: `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (always), plus `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` and the Windows signing secrets (each only when present).
   - Runs `actions/attest-build-provenance` on the bundles.
3. **verify**: runs `checksec` on the Linux binary, checks Windows PE flags (CFG, DYNAMICBASE, NXCOMPAT, HIGHENTROPYVA) and runs `codesign -dv` on macOS. A failure only warns while the build is unsigned.
4. **finalize**:
   - Downloads the assets and computes `SHA256SUMS.txt`.
   - Generates SBOMs with `cargo cyclonedx --format json` and `@cyclonedx/cyclonedx-npm`.
   - Uploads both.
   - Publishes the release by setting draft to false.

**Bundles**
- **macOS:** `.app` and `.dmg`.
- **Windows:** `.msi` and NSIS `.exe`.
- **Linux:** `.deb`, `.rpm` and `.AppImage`.
- **Updater:** `latest.json` plus `.sig` files.

**Signing**
- If the Apple or Windows certificates are missing, the build is still produced. macOS uses ad-hoc signing (`signingIdentity: "-"`).
- The release notes must then include a **"First launch"** section:
  - On macOS: right-click → Open, or `xattr -dr com.apple.quarantine /Applications/EMP.app`.
  - On Windows: SmartScreen → More info → Run anyway.
  - How to verify `SHA256SUMS.txt` and `gh attestation verify <file> --repo devartin/ultra-note`.

**Versioning**
- `package.json` is the single source of the version. `tauri.conf.json` reads it via `"version": "../package.json"`.
- `scripts/bump.ts` syncs `[workspace.package].version`, then commits and tags.

**Release profile**
- `opt-level=3`, `lto="fat"`, `codegen-units=1`, `strip="symbols"`, `panic="unwind"`, `overflow-checks=true`, `incremental=false`.
- `.cargo/config.toml` adds:
  - Windows: `-C control-flow-guard`, `+crt-static`
  - Linux: `-Wl,-z,relro,-z,now`, `-Wl,-z,noexecstack`
- Vite: `sourcemap:false` in release.

### 19.4 Repository hygiene
- `SECURITY.md` covers private vulnerability reporting, supported versions and response time.
- `CODEOWNERS` covers `crates/emp-crypto/**`, `crates/emp-store/**`, `src-tauri/capabilities/**`, `src-tauri/tauri.conf.json`, `src-tauri/isolation/**` and `.github/workflows/**`.
- Branch protection on `main` requires these checks: §19.2 jobs 1–6.
- Dependabot or Renovate opens grouped updates with a 7-day minimum release age.
- `.npmrc` sets `ignore-scripts=true`. Packages that need build scripts (for example `esbuild`) are allowlisted with `npm rebuild <pkg>` in CI.
- `deny.toml` (version 2):
  - Advisories: `yanked=deny`.
  - Licenses: allow MIT, Apache-2.0, Apache-2.0 WITH LLVM-exception, BSD-2/3-Clause, ISC, Zlib, Unicode-3.0, Unicode-DFS-2016, MPL-2.0, CC0-1.0, BSL-1.0.
  - Bans: `openssl` and `openssl-sys`, and wildcards.
  - Sources: crates.io only.

---

## 20. Acceptance criteria (v1.0 release gate)

Each item is verified by an automated test unless it is marked (manual). "Mock" means the browser mock E2E suite. "Real" means a Tauri build.

### 20.1 Shell, design, motion
1. On first launch no white flash appears. The window shows after the first frame on all 3 OSes (manual on macOS; tauri-driver on Linux and Windows).
2. All 3 themes and all 7 accents render the component gallery. The contrast script passes, and axe finds no serious or critical violations.
3. Under `prefers-reduced-motion`, no transform animations run. A test samples computed `transform` during transitions.
4. With `data-effects="reduced"` (Linux default), no `backdrop-filter` is present in the DOM.
5. Every interactive component in the gallery has hover, pressed, focus-visible and disabled screenshots.
6. All shortcuts in §8.7 work. On macOS, ⌘ labels are shown. On Windows and Linux, "Ctrl" is spelled out.
7. Budgets B1–B30 are met on reference hardware (nightly perf report). B7, B8, B13 and B22 are met in mock CI.

### 20.2 Security
8. Creating an encrypted vault and then scanning every file under the data dir for 20 canary strings finds zero hits in any encoding.
9. A wrong password returns `BAD_PASSWORD`. The 5th failure introduces a 1 s delay, and the delay doubles after each further failure. Restarting the app does not reset the counter.
10. The recovery flow works: create vault → write down words → "forget" password → unlock with words → forced new password → content intact.
11. Auto-lock fires after the configured idle time. A simulated sleep event also locks. After lock, `page_get` returns `LOCKED`. The webview reloads to `/#/lock`, and the heap snapshot contains no canary strings (debug build).
12. Flipping one byte in any `payload` makes that record "Damaged". Deleting a row raises the integrity warning on the next unlock.
13. Capability test: only `ALL_COMMANDS` are invocable. Calling a non-listed or plugin `fs:*` command from JS fails.
14. XSS corpus test: none of the 300+ payloads executes when pasted, imported (Markdown, Notion HTML) or rendered from provider text. There are no `on*` attributes and no `javascript:` URLs, and zero CSP violations are logged.
15. `open_external` rejects `file:`, `javascript:`, `data:`, `smb:`, `ms-*:` and custom schemes. Hosts that are IDN render as punycode in the confirmation.
16. In offline mode, zero sockets are opened (NetGuard counter). The network log records every request otherwise, and no request ever goes to a host outside its connector's allowlist (wiremock test).
17. A secret set via `secret_set` is never returned by any command except `row_secret_reveal` (reauth). The frontend bundle contains no code path that receives a token.
18. The release bundle contains no `localhost` CSP origins, no `eval`, no mock sentinel, and no banned claims (§9.22).

### 20.3 Editor and pages
19. Every v1 block type can be created via `/`, via the markdown shortcut where one exists, and via turn-into. Each survives save → reload → export Markdown → import Markdown with equal structure. EMP blocks survive via `emp-block` fences.
20. Tab and Shift+Tab nest and un-nest every container block type. Drag-to-nest at 24 px per level works. Block IDs stay unique after 10k random ops (property test).
21. Paste from Google Docs, Word and a web page (fixture HTML) produces headings, lists, links and tables. Paste of internal blocks regenerates IDs.
22. Autosave: edits are persisted within 2 s, and on window close. A conflicting save from a second editor instance produces the Keep mine / Take theirs sheet.
23. Find & replace "Replace all" is a single undo step.
24. Backlinks list every referencing page with snippets, and update within 1 s of a save.
25. Trash: deleting a page subtree and restoring it brings back the whole subtree. Purge removes rows, docs, versions and unreferenced assets.
26. Page history: a version is created after 10 min of edits and on close. Restoring creates a new version first.

### 20.4 Databases and sheets
27. All 25 property types can be created, edited, filtered (with every operator in §8.4), sorted and grouped (where groupable). Footer aggregations on money columns are exact. For example, summing 0.1 + 0.2 shows 0.30.
28. Two-way relations stay consistent under create, update and delete (property test). Rollups update when their target rows change.
29. A 100k-row database scrolls without "load more" (B15, B14).
30. Board drag between groups sets the property and the order atomically. Undo restores both.
31. CSV and XLSX import infer types correctly on the fixture corpus (≥ 95% of columns). CSV export with injection protection prefixes dangerous cells.
32. Formula properties: the 40 Notion-dialect fixture formulas evaluate to their expected outputs, type errors are reported with spans, and cycles report "Circular reference".
33. Sheets: every function in §14.3 passes its TOML cases. The Excel parity corpus matches within 1e-9. Spill and `#SPILL!` behave like Excel. An xlsx round-trip keeps formulas, number formats, merges, freeze panes and widths.
34. Opening a 1M-cell imported workbook performs no full recalculation (cached values) and renders the first viewport within 300 ms.

### 20.5 Finance and life apps
35. Each of the 6 v1 life apps installs from the wizard in both Quick and Guided modes. The preview counts equal what was actually created. "Undo setup" removes everything. Running a tune-up with unchanged answers produces an empty diff.
36. Quick-mode setup for Money HQ, measured from opening the wizard to the dashboard, takes ≤ 3 minutes in a scripted user test (manual, 3 testers) and ≤ 800 ms of backend time (B37).
37. Money HQ imports the bank fixture corpus (CSV ×10 banks, OFX 1.x and 2.x, QFX, QIF):
    - Dates and signs are correct.
    - Re-importing the same file adds 0 rows.
    - Transfers between two own accounts are linked and excluded from spending.
    - Rules apply.
    - The "Always categorise" suggestion appears after the second identical manual change.
38. Budget identities hold for random ledgers (property test). The 50/30/20 and zero-based dashboards show correct "Left to spend" and "To be assigned".
39. Debt planner results match hand-computed schedules for 3 fixtures. Avalanche interest ≤ snowball interest (property test).
40. Portfolio results:
    - FIFO lots, realised gains and XIRR match fixture values computed in Excel (tolerance 1e-6).
    - Drift and band status are correct.
    - The rebalance plan reaches its targets within the band when cash suffices.
    - Only symbols appear in outbound market requests (wiremock body/URL assertion).
41. Tax estimator: `us-federal-2026.json` pack tests pass. "Show math" lines sum to the total. The disclaimer and pack version are visible on every tax page. The words "you owe" never appear (grep).
42. Advisor: every rule listed in §16 has a fixture that triggers it and one that does not. Insights show "Show math".
43. Hide numbers masks every `[data-sensitive]` value, chart y-axis labels and KPI tiles. Screenshots in privacy mode contain no digits in masked regions (OCR-free check: DOM text audit).

### 20.6 Integrations, import/export, release
44. Google OAuth against a wiremock server:
    - PKCE completes.
    - A wrong `state` is rejected.
    - The listener closes after one request.
    - Calendar sync uses `syncToken` and recovers from `410`.
    - Docs and Sheets import fixtures map as specified.
    - Export creates a file with `drive.file` only.
    - Manual: a real Google account, end to end, once per release.
45. Market data: with only keyless providers, quotes (EOD) and FX load for the demo watchlist. With the network blocked, cached values show stale badges and nothing errors.
46. Notion export fixture (nested zips, databases, relations, callouts, toggles, columns) imports with 0 unresolved internal links. The report lists any unsupported blocks, and "Undo import" removes everything.
47. `.empsnap` snapshots are created on schedule with correct retention. Restoring one into a new vault reproduces identical page and row counts. A tampered snapshot (MAC failure, or an extra trigger in its SQLite) is rejected.
48. "Export everything" produces the zip layout in §17.5 with valid SHA-256 manifest entries. With encryption on, it requires re-auth and shows the unencrypted warning.
49. Pushing tag `v1.0.0` produces a published GitHub Release on `devartin/ultra-note` with:
    - macOS universal dmg
    - Windows msi and nsis
    - Linux deb, rpm and AppImage
    - `latest.json` with signatures
    - `SHA256SUMS.txt`
    - SBOMs
    - provenance attestations
    - "First launch" notes if unsigned
50. Each installer launches on a clean VM of its OS (manual: macOS 14, Windows 11, Ubuntu 24.04, Fedora 40) and completes onboarding with encryption.
