# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's
[private vulnerability reporting](https://github.com/devartin/emp/security/advisories/new) instead.
We aim to acknowledge reports within 72 hours.

## What Ultra Note protects

With vault encryption on, everything you write — page content, titles, database values, spreadsheet cells,
transactions, attachments — is encrypted at rest with XChaCha20-Poly1305 under a random 256-bit data key. That key is
wrapped by a key derived from your password with Argon2id, and separately by a 24-word recovery key. Keys live only in
memory while the vault is unlocked and are zeroised when it locks (manually, on idle, on sleep or screen lock).

API keys and OAuth tokens are always encrypted, even when vault encryption is off (using a device key held in the OS
keychain).

## What Ultra Note does not protect

- **Structural metadata stays visible on disk:** record ids, the page tree shape, record kinds, sort order, timestamps,
  revision numbers, approximate sizes, and which life apps are installed. The full list is in
  [SPEC §9.20](docs/SPEC.md).
- **A compromised computer.** Malware running as your user while the vault is unlocked can read what you can read.
- **A forgotten password *and* lost recovery key.** There is no backdoor; the data cannot be recovered.
- **Connected services.** Data you send to Google or a market-data provider is subject to their policies. Every request
  is listed in the in-app network log, and offline mode blocks them all.

## Hardening summary

Strict Content-Security-Policy, minimal Tauri capabilities with a command allowlist, no shell or filesystem access from
the web layer, all network egress through a single host-allowlisted client, hardened importers with size and depth
limits, and supply-chain checks (cargo-deny) in CI. See [SPEC §9](docs/SPEC.md) for the complete specification.
