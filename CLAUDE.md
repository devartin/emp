# EMP — build conventions (read before changing anything)

EMP is a local-first, optionally-encrypted productivity super app (Notion-class editor + databases, Excel-grade sheets,
personal finance, portfolio/markets, taxes, guided "life apps", Google integrations). Tauri 2 + Rust workspace +
React 19/TypeScript frontend.

**Source of truth:** `docs/SPEC.md` (v1 build spec). `docs/BRAINSTORM.md` is background. Follow SPEC exactly
(names, numbers, tokens, IPC shapes) except for the overrides below.

## Overrides to SPEC (decided by the orchestrator — these win)
1. **No WASM mock.** The browser mock backend (`src/backend/mock/`) is pure TypeScript. It implements enough real
   logic (filter/sort, simple formulas, finance maths) in TS to make the demo seed behave realistically.
2. **No ts-rs.** Frontend IPC types are hand-written in `src/backend/types.ts`, transcribed from SPEC §11.2/§11.3.
   Rust DTOs use `#[serde(rename_all = "camelCase")]` and must match those shapes. SPEC §11 is the contract both
   sides implement; if you must deviate, keep both sides consistent and say so in your final report.
3. SBOM/provenance attestation, Linux arm64 and the updater are optional (P1) — never block on them.
4. The app crate is `src-tauri` (package `emp-app`, lib `emp_lib`).

## Ownership
Every task names the files/directories it owns. Only edit what you own. If you need a change in a file you don't
own, work around it and list the request in your final report. Never delete or rewrite other agents' work.
- Frontend mock command handlers live in `src/backend/mock/commands/<namespace>.ts` and are auto-registered
  (glob import) — add a file, don't edit a central list.
- Frontend routes resolve through `src/app/routes.tsx`, which lazy-imports feature entry components at fixed paths;
  feature owners replace their placeholder entry file in place.

## Checks you must run before finishing
- Rust: `cargo fmt -p <crate>`, `cargo clippy -p <crate> --all-targets -- -D warnings`, `cargo test -p <crate>`.
  The target dir is shared; cargo serialises builds — be patient, don't delete `target/`.
- Frontend: `npx tsc --noEmit` — fix every error in files you own (errors in others' files are not yours).
  Occasionally `npx vite build` to catch bundling problems.
- Browser preview: `npm run dev:mock` serves http://localhost:1420/?seed=demo (mock backend). Use the preinstalled
  global Playwright (`require('playwright')`, run node from outside the repo or with NODE_PATH) for screenshots.
  Never run `playwright install`.

## Quality bar
- No `todo!()`, `unimplemented!()`, panics on user input, `unwrap()` on fallible IO/parse in non-test code.
- `#![forbid(unsafe_code)]` in every crate (except `src-tauri/src/platform`).
- No "Coming soon" placeholders for v1 features. P1 features may be absent, not faked.
- UI: use the `src/ui` kit and motion tokens (SPEC §3–§5). Respect reduced motion. Tabular numbers for money.
- Security: never `dangerouslySetInnerHTML` outside `ui/SanitizedHtml` (DOMPurify). Never log secrets.
- Don't `git commit`/`push` — the orchestrator does that. Don't run `npm audit fix` or upgrade unrelated packages.
- End with a concise report: what you built, what you deferred, test results, and cross-team requests.
