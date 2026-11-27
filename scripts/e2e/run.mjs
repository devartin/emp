#!/usr/bin/env node
// Run desktop E2E specs against a built binary.
//   ULTRANOTE_BIN=target/debug/emp-app DISPLAY=:99 node scripts/e2e/run.mjs [spec-name ...]
// See scripts/e2e/README.md for the Xvfb / tauri-driver setup.
import { readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const shots = resolve(process.env.E2E_SHOTS || join(here, '..', '..', 'test-results', 'e2e'));
const wanted = process.argv.slice(2);
const files = readdirSync(join(here, 'specs')).filter((f) => f.endsWith('.mjs')).sort();
let failed = 0;
for (const f of files) {
  const mod = await import(join(here, 'specs', f));
  if (wanted.length && !wanted.includes(mod.name)) continue;
  const t0 = Date.now();
  let problems;
  try {
    problems = await mod.default({ shots });
  } catch (e) {
    problems = [`threw: ${e.stack || e.message}`];
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (problems.length) {
    failed++;
    console.log(`FAIL ${mod.name} (${secs}s)`);
    for (const p of problems) console.log(`  - ${p}`);
  } else console.log(`ok   ${mod.name} (${secs}s)`);
}
console.log(failed ? `\n${failed} spec(s) failed` : '\nall specs passed');
process.exit(failed ? 1 : 0);
