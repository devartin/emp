//! Runs the isolation hook (`isolation/index.js`, SPEC §9.13) under Node and checks what it rejects.
//!
//! Skipped when `node` is not installed. The hook is defence in depth: Rust validates every request again.

use std::process::Command;

const REJECTED: &str = "__emp_isolation_rejected__";

/// Loads the hook with a fake `window`, feeds it `cases` (a JS array of `[cmd, payload]` expressions) and returns
/// the command name each message left the hook with.
fn run_hook(cases: &str) -> Option<Vec<String>> {
    let hook = concat!(env!("CARGO_MANIFEST_DIR"), "/isolation/index.js");
    let script = format!(
        r"
globalThis.window = {{}};
require({hook:?});
const hook = window.__TAURI_ISOLATION_HOOK__;
const cases = {cases};
const out = cases.map(([cmd, payload]) => hook({{ cmd, callback: 1, error: 2, payload }}).cmd);
process.stdout.write(JSON.stringify(out));
"
    );
    let output = Command::new("node").arg("-e").arg(script).output().ok()?;
    assert!(
        output.status.success(),
        "node failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Some(serde_json::from_slice(&output.stdout).expect("hook output is JSON"))
}

#[test]
fn hook_rejects_oversized_and_malformed_messages() {
    let cases = r"[
        ['app_info', { req: {} }],
        ['plugin:event|listen', { event: 'vault:locked', handler: 1 }],
        ['plugin:event|listen', { event: 'x'.repeat(8 * 1024 * 1024 + 16) }],
        ['page_get', { req: { id: '€'.repeat(3 * 1024 * 1024) } }],
        ['page_get', { req: { id: 'a'.repeat(1024) } }],
        ['open_external', { req: { url: 'javascript:alert(1)' } }],
        ['open_external', { req: { url: 'https://example.com/' } }],
        ['not_a_command', { req: {} }],
        ['vault_unlock', { req: { password: 'correct horse battery staple' } }],
        ['vault_unlock', { req: { password: 'correct horse battery staple' } }],
    ]";
    let Some(out) = run_hook(cases) else {
        eprintln!("node is not installed; skipping the isolation hook test");
        return;
    };
    assert_eq!(
        out,
        [
            "app_info",
            "plugin:event|listen",
            // Plugin calls are size-capped too (their payload could be replayed under another command name).
            REJECTED,
            // 3 Mi code units of `€` are 9 MiB of UTF-8: over the cap even though `.length` is not.
            REJECTED,
            "page_get",
            REJECTED,
            "open_external",
            REJECTED,
            "vault_unlock",
            // A second unlock within the double-submit window.
            REJECTED,
        ]
    );
}
