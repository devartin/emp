#!/usr/bin/env node
/**
 * Bundle budget (PROGRAMME-v3 K6; chair: +5% per chunk, a new chunk > 50 KB fails, Home boot > +3% fails).
 *
 *   npx vite build && node scripts/bundle-budget.mjs          check dist/ against scripts/bundle-baseline.json
 *   npm run budget:update                                       re-snapshot the baseline from the current dist/
 *
 * Chunks are keyed by file name without the content hash (`HomePage-AbCd1234.js` → `HomePage.js`); chunks that share
 * a name are summed. Sizes are gzip level 9 of the built bytes. Checks:
 *   - a known chunk grows by more than 5% (and more than 512 B, so tiny chunks don't trip on noise)
 *   - a new chunk is larger than 50 KB gzipped
 *   - the Home boot set grows by more than 3%. Boot set = index.html's entry script, modulepreloads and stylesheets,
 *     plus the static-import closure of the Shell and HomePage chunks (what Home needs before first paint).
 * Exit code 1 on any failure.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const DIST = resolve(ROOT, opt('--dist', 'dist'));
const BASELINE = resolve(ROOT, opt('--baseline', 'scripts/bundle-baseline.json'));
const CHUNK_TOLERANCE = 0.05;
const CHUNK_SLACK_BYTES = 512;
const NEW_CHUNK_MAX = 50 * 1024;
const BOOT_TOLERANCE = 0.03;
const BOOT_ROUTE_CHUNKS = ['Shell.js', 'HomePage.js'];

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const pct = (a, b) => (b ? `${a >= b ? '+' : ''}${(((a - b) / b) * 100).toFixed(1)}%` : 'new');

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

if (!existsSync(join(DIST, 'index.html'))) fail(`No build at ${relative(ROOT, DIST)}/ — run \`npx vite build\` first.`);
const ASSETS = join(DIST, 'assets');
const files = readdirSync(ASSETS).filter((f) => /\.(js|css)$/.test(f));
const keyOf = (file) => file.replace(/-[A-Za-z0-9_-]{8}(?=\.(js|css)$)/, '');

const gz = new Map();
const bytes = new Map();
for (const f of files) {
  const buf = readFileSync(join(ASSETS, f));
  bytes.set(f, buf);
  gz.set(f, gzipSync(buf, { level: 9 }).length);
}

/** name → { gzip, raw, count } */
const chunks = {};
for (const f of files.sort()) {
  const k = keyOf(f);
  const c = (chunks[k] ??= { gzip: 0, raw: 0, count: 0 });
  c.gzip += gz.get(f);
  c.raw += bytes.get(f).length;
  c.count += 1;
}

// ── Home boot set
const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const fromHtml = [...html.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="\/?assets\/([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
const STATIC_IMPORT = /\bimport\s*(?:[\w$*{}\s,]*?\bfrom\s*)?["']\.\/([^"']+\.js)["']/g;
const boot = new Set();
const visit = (f) => {
  if (boot.has(f) || !bytes.has(f)) return;
  boot.add(f);
  if (!f.endsWith('.js')) return;
  for (const m of bytes.get(f).toString('utf8').matchAll(STATIC_IMPORT)) visit(m[1]);
};
for (const f of fromHtml) visit(f);
for (const name of BOOT_ROUTE_CHUNKS) for (const f of files) if (keyOf(f) === name) visit(f);
const missingBoot = BOOT_ROUTE_CHUNKS.filter((n) => !chunks[n]);
const bootGzip = [...boot].reduce((s, f) => s + gz.get(f), 0);
const totals = {
  js: Object.entries(chunks).filter(([k]) => k.endsWith('.js')).reduce((s, [, c]) => s + c.gzip, 0),
  css: Object.entries(chunks).filter(([k]) => k.endsWith('.css')).reduce((s, [, c]) => s + c.gzip, 0),
};

const current = {
  description: 'Bundle budget baseline (gzip -9 bytes). Regenerate with `npm run budget:update` after an intended change; reviewers see the diff.',
  homeBoot: { gzip: bootGzip, files: boot.size, entryChunks: BOOT_ROUTE_CHUNKS },
  totals,
  chunks: Object.fromEntries(Object.entries(chunks).sort(([a], [b]) => a.localeCompare(b)).map(([k, c]) => [k, c.gzip])),
};

if (flag('--update')) {
  writeFileSync(BASELINE, JSON.stringify(current, null, 2) + '\n');
  console.log(`Wrote ${relative(ROOT, BASELINE)}: ${Object.keys(chunks).length} chunks, Home boot ${kb(bootGzip)} (${boot.size} files), JS ${kb(totals.js)}, CSS ${kb(totals.css)}.`);
  process.exit(0);
}

if (!existsSync(BASELINE)) fail(`No baseline at ${relative(ROOT, BASELINE)} — run \`npm run budget:update\` once.`);
const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
const failures = [];
const notes = [];
for (const [k, c] of Object.entries(chunks)) {
  const was = base.chunks[k];
  if (was === undefined) {
    if (c.gzip > NEW_CHUNK_MAX) failures.push(`new chunk ${k} is ${kb(c.gzip)} gzipped (> ${kb(NEW_CHUNK_MAX)})`);
    else notes.push(`new chunk ${k} ${kb(c.gzip)}`);
  } else if (c.gzip > was * (1 + CHUNK_TOLERANCE) && c.gzip - was > CHUNK_SLACK_BYTES) {
    failures.push(`${k} grew ${pct(c.gzip, was)}: ${kb(was)} → ${kb(c.gzip)} (budget +${CHUNK_TOLERANCE * 100}%)`);
  }
}
for (const k of Object.keys(base.chunks)) if (!chunks[k]) notes.push(`chunk ${k} is gone (${kb(base.chunks[k])})`);
if (missingBoot.length) notes.push(`boot route chunk(s) not found: ${missingBoot.join(', ')} — the Home boot set may be incomplete`);
if (bootGzip > base.homeBoot.gzip * (1 + BOOT_TOLERANCE)) failures.push(`Home boot set grew ${pct(bootGzip, base.homeBoot.gzip)}: ${kb(base.homeBoot.gzip)} → ${kb(bootGzip)} (budget +${BOOT_TOLERANCE * 100}%)`);

const top = Object.entries(chunks)
  .sort((a, b) => b[1].gzip - a[1].gzip)
  .slice(0, 8)
  .map(([k, c]) => `${k} ${kb(c.gzip)}${base.chunks[k] !== undefined ? ` (${pct(c.gzip, base.chunks[k])})` : ' (new)'}`);
console.log(`Bundle budget: ${Object.keys(chunks).length} chunks · JS ${kb(totals.js)} (${pct(totals.js, base.totals.js)}) · CSS ${kb(totals.css)} (${pct(totals.css, base.totals.css)}) · Home boot ${kb(bootGzip)} (${pct(bootGzip, base.homeBoot.gzip)}, ${boot.size} files)`);
console.log(`Largest: ${top.join(', ')}`);
for (const n of notes) console.log(`  note: ${n}`);
if (failures.length) {
  console.error(`\nBundle budget FAILED:\n  ${failures.join('\n  ')}\nIf the growth is intended, run \`npm run budget:update\` and commit the baseline with a reason.`);
  process.exit(1);
}
console.log('Bundle budget OK.');
