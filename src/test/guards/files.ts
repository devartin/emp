/// <reference types="node" />
/**
 * File discovery for the Phase 0 guards (docs/design/PROGRAMME-v3.md, K6). Paths are repo-relative with forward
 * slashes, sorted, so baselines are stable across machines.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const SKIP_DIRS = new Set(['node_modules', 'target', 'dist', 'dist-mock', '.git', 'gen']);

/** Every file under `dir` (repo-relative) whose name passes `keep`. */
export function walk(dir: string, keep: (rel: string) => boolean): string[] {
  const out: string[] = [];
  const visit = (abs: string) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(abs, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) visit(p);
      } else {
        const rel = relative(ROOT, p).split(sep).join('/');
        if (keep(rel)) out.push(rel);
      }
    }
  };
  visit(join(ROOT, dir));
  return out.sort();
}

export function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/** Test code and fixtures are exempt from every guard. */
export function isTestFile(rel: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(rel) || rel.startsWith('src/test/') || /(^|\/)(__tests__|fixtures?|__fixtures__)\//.test(rel);
}

export const cssFiles = () => walk('src', (r) => r.endsWith('.css') && !isTestFile(r));
export const tsFiles = () => walk('src', (r) => /\.tsx?$/.test(r) && !r.endsWith('.d.ts') && !isTestFile(r));
export const manifestFiles = () => walk('crates/emp-store/lifeapps', (r) => /^crates\/emp-store\/lifeapps\/[^/]+\.json$/.test(r));
export const rustFiles = () =>
  [...walk('crates', (r) => /\/src\/.*\.rs$/.test(r)), ...walk('src-tauri/src', (r) => r.endsWith('.rs'))].filter(
    (r) => !/(^|\/)tests?\//.test(r) && !/(_tests?|\/tests?)\.rs$/.test(r),
  );

/**
 * Rust modules whose string literals are shipped content (the desktop Getting Started tour, life-app sample data):
 * the copy lint scans them like the TS mock seed (banned phrases, "!", em dashes; no sentence-case heuristic).
 */
export const RUST_COPY_FILES = ['crates/emp-store/src/repo/tour.rs', 'crates/emp-store/src/lifeapps/sample.rs'];

/** The emoji→icon import mapping table(s) (K1 kit lane) are the only place emoji may live in source. */
export const isEmojiMapFile = (rel: string) => /(^|\/)emojiMap\.[^/]+$/.test(rel);
