/** Third-party software bundled with EMP (About → Open-source licences). Names and SPDX identifiers only. */
export interface Licence {
  name: string;
  licence: string;
  by: string;
  kind: "Interface" | "Data & charts" | "Fonts" | "Core (Rust)";
}

export const LICENCES: Licence[] = [
  { name: "React", licence: "MIT", by: "Meta Platforms, Inc.", kind: "Interface" },
  { name: "Tauri", licence: "MIT OR Apache-2.0", by: "The Tauri Programme", kind: "Interface" },
  { name: "TipTap & ProseMirror", licence: "MIT", by: "überdosis GbR, Marijn Haverbeke", kind: "Interface" },
  { name: "Radix UI", licence: "MIT", by: "WorkOS", kind: "Interface" },
  { name: "Motion", licence: "MIT", by: "Motion Division Ltd", kind: "Interface" },
  { name: "cmdk", licence: "MIT", by: "Paco Coursey", kind: "Interface" },
  { name: "zustand", licence: "MIT", by: "Poimandres", kind: "Interface" },
  { name: "dnd kit", licence: "MIT", by: "Claudéric Demers", kind: "Interface" },
  { name: "Floating UI", licence: "MIT", by: "Floating UI contributors", kind: "Interface" },
  { name: "TanStack Virtual", licence: "MIT", by: "Tanner Linsley", kind: "Interface" },
  { name: "Lucide", licence: "ISC", by: "Lucide contributors", kind: "Interface" },
  { name: "Tailwind CSS", licence: "MIT", by: "Tailwind Labs, Inc.", kind: "Interface" },
  { name: "DOMPurify", licence: "MPL-2.0 OR Apache-2.0", by: "Cure53", kind: "Interface" },
  { name: "KaTeX", licence: "MIT", by: "Khan Academy", kind: "Interface" },
  { name: "lowlight & highlight.js", licence: "MIT, BSD-3-Clause", by: "Titus Wormer, Ivan Sagalaev", kind: "Interface" },
  { name: "Recharts", licence: "MIT", by: "Recharts Group", kind: "Data & charts" },
  { name: "Lightweight Charts™", licence: "Apache-2.0", by: "TradingView, Inc.", kind: "Data & charts" },
  { name: "date-fns", licence: "MIT", by: "Sasha Koss and contributors", kind: "Data & charts" },
  { name: "Chrono", licence: "MIT", by: "Wanasit Tanakitrungruang", kind: "Data & charts" },
  { name: "decimal.js-light", licence: "MIT", by: "Michael Mclaughlin", kind: "Data & charts" },
  { name: "zxcvbn", licence: "MIT", by: "Dropbox, Inc.", kind: "Data & charts" },
  { name: "IBM Plex Sans", licence: "OFL-1.1", by: "IBM Corp.", kind: "Fonts" },
  { name: "Newsreader", licence: "OFL-1.1", by: "Production Type", kind: "Fonts" },
  { name: "JetBrains Mono", licence: "OFL-1.1", by: "JetBrains s.r.o.", kind: "Fonts" },
  { name: "Atkinson Hyperlegible", licence: "OFL-1.1", by: "Braille Institute of America", kind: "Fonts" },
  { name: "RustCrypto (argon2, chacha20poly1305, hkdf, hmac, sha2)", licence: "MIT OR Apache-2.0", by: "RustCrypto Developers", kind: "Core (Rust)" },
  { name: "rusqlite & SQLite", licence: "MIT, Public Domain", by: "rusqlite contributors, D. Richard Hipp", kind: "Core (Rust)" },
  { name: "tokio", licence: "MIT", by: "Tokio contributors", kind: "Core (Rust)" },
  { name: "reqwest & rustls", licence: "MIT OR Apache-2.0", by: "Sean McArthur, rustls contributors", kind: "Core (Rust)" },
  { name: "serde", licence: "MIT OR Apache-2.0", by: "Erick Tryzelaar, David Tolnay", kind: "Core (Rust)" },
  { name: "zeroize", licence: "MIT OR Apache-2.0", by: "RustCrypto Developers", kind: "Core (Rust)" },
  { name: "calamine", licence: "MIT", by: "Johann Tuffe", kind: "Core (Rust)" },
  { name: "rust_xlsxwriter", licence: "MIT OR Apache-2.0", by: "John McNamara", kind: "Core (Rust)" },
  { name: "quick-xml", licence: "MIT", by: "Johann Tuffe and contributors", kind: "Core (Rust)" },
  { name: "governor", licence: "MIT", by: "Andreas Fuchs", kind: "Core (Rust)" },
  { name: "chardetng & encoding_rs", licence: "MIT OR Apache-2.0", by: "Henri Sivonen", kind: "Core (Rust)" },
  { name: "ciborium", licence: "Apache-2.0", by: "Enarx project", kind: "Core (Rust)" },
  { name: "keyring", licence: "MIT OR Apache-2.0", by: "Walther Chen, Daniel Brotsky", kind: "Core (Rust)" },
  { name: "zxcvbn (Rust)", licence: "MIT", by: "Josh Holmer", kind: "Core (Rust)" },
];
