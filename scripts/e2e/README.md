# Desktop end-to-end tests

These specs drive the **real Ultranote binary** (Rust backend, WebKitGTK webview) over WebDriver, the same way a
person uses it. The browser demo (`npm run dev:mock`) runs a TypeScript mock in Chromium and cannot catch problems
that only exist in the desktop build — 0.3.0 shipped with Home and five of six apps crashing on desktop for exactly
that reason.

## One-time setup (Linux)

```sh
sudo apt-get install -y libwebkit2gtk-4.1-dev webkit2gtk-driver xvfb openbox dbus-x11
cargo install tauri-driver --locked
```

## Build and run

```sh
npx tauri build --debug --no-bundle          # production frontend + custom protocol, debug Rust (fast to build)
Xvfb :99 -screen 0 1440x900x24 & DISPLAY=:99 openbox &
export DISPLAY=:99 ULTRANOTE_BIN=$PWD/target/debug/emp-app
node scripts/e2e/run.mjs                      # every spec
node scripts/e2e/run.mjs smoke-apps           # one spec by its exported name
```

Screenshots go to `test-results/e2e/` (override with `E2E_SHOTS`). Each spec launches the app with a fresh data
directory (`XDG_DATA_HOME`), so specs are independent.

## Writing a spec

A spec is a module in `specs/` that exports `name` and a default async function returning a list of problems (empty
means pass). Use `desktopSession()` from `lib/wd.mjs`, `ui()` from `lib/ui.mjs` for text-based clicking, waiting and
error capture, and the flows in `lib/flows.mjs` for first run.

`webkitSession()` opens the browser build in WebKitGTK's MiniBrowser instead, for checks against the mock backend in
the desktop engine.
