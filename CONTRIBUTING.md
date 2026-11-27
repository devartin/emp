# Contributing to Ultra Note

Thanks for helping. Bug reports, fixes and focused improvements are all welcome.

## Before you start

- **Security problems:** please don't open a public issue. Follow [SECURITY.md](SECURITY.md).
- **Bigger changes** (new features, data-format or IPC changes, design changes): open an issue first so we can agree
  on the approach. [docs/SPEC.md](docs/SPEC.md) is the build spec and [docs/DESIGN.md](docs/DESIGN.md) is the visual
  language; changes should fit both.

## Setup

Requirements: [rustup](https://rustup.rs) (it installs the pinned toolchain from `rust-toolchain.toml`
automatically), Node.js 22+, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
npm ci
npm run tauri dev       # desktop app with hot reload
npm run dev:mock        # browser demo at http://localhost:1420/?seed=demo (no Rust needed)
```

## Checks

CI runs these on every pull request. Run them locally first:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm run typecheck
npm test                # unit tests plus the style, copy, emoji and contrast guards
npx vite build && npm run budget
```

## Code guidelines

- No `unwrap()` on fallible IO or parsing outside tests, no panics on user input, and `#![forbid(unsafe_code)]` in
  every crate (the only exception is `src-tauri/src/platform`).
- Rust DTOs and `src/backend/types.ts` must keep the same shapes (SPEC §11).
- Build UI from the `src/ui` kit and its motion tokens, respect reduced motion, and use tabular figures for money.
- Never use `dangerouslySetInnerHTML` outside `ui/SanitizedHtml`, and never log secrets.

## Pull requests

- Keep each pull request to one change, and explain what it does and why.
- Add an entry under **Unreleased** in [CHANGELOG.md](CHANGELOG.md) for anything a user would notice.
- Include a screenshot or short clip for visible UI changes.

By contributing you agree that your work is released under the [MIT License](LICENSE).
