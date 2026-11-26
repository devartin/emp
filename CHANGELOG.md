# Changelog

All notable changes to Ultra Note are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

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
