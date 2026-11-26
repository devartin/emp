/// <reference types="node" />
/**
 * Ratchet bookkeeping shared by the style, copy and emoji guards.
 *
 *   baseline = { files: { "src/x.css": { metric: max } } }   (committed JSON, one file per guard)
 *
 * - A count above its baseline (or any count in a file/metric the baseline doesn't list) fails.
 * - Counts below the baseline pass; the test prints a hint to lock the gain in with `npm run guards:update`.
 * - `GUARDS_UPDATE=1` (npm run guards:update) rewrites the baseline to the current counts, but ONLY when nothing
 *   rose: it can only lower numbers. Raising a budget means editing the JSON by hand, visibly, in review.
 * - `GUARDS_INIT=1` (npm run guards:init) writes a baseline only when its file does not exist yet (first snapshot).
 * A renamed file shows up as a new file: move its entry in the JSON by hand in the same change.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './files';

export type FileCounts = Record<string, Record<string, number>>;

export interface Baseline {
  description: string;
  metrics: Record<string, string>;
  totals: Record<string, number>;
  files: FileCounts;
}

export interface RatchetResult {
  increases: string[];
  decreases: string[];
  wrote: boolean;
  totals: Record<string, number>;
}

export function clean(counts: Record<string, Partial<Record<string, number>>>): FileCounts {
  const out: FileCounts = {};
  for (const file of Object.keys(counts).sort()) {
    const m: Record<string, number> = {};
    for (const k of Object.keys(counts[file]).sort()) {
      const v = counts[file][k] ?? 0;
      if (v > 0) m[k] = v;
    }
    if (Object.keys(m).length) out[file] = m;
  }
  return out;
}

export function totalsOf(files: FileCounts, metrics: Record<string, string>): Record<string, number> {
  const t: Record<string, number> = {};
  for (const k of Object.keys(metrics)) t[k] = 0;
  for (const m of Object.values(files)) for (const [k, v] of Object.entries(m)) t[k] = (t[k] ?? 0) + v;
  return t;
}

export function loadBaseline(rel: string): Baseline | null {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as Baseline;
}

function write(rel: string, description: string, metrics: Record<string, string>, files: FileCounts) {
  const b: Baseline = { description, metrics, totals: totalsOf(files, metrics), files };
  writeFileSync(join(ROOT, rel), JSON.stringify(b, null, 2) + '\n');
}

/** Per-file, per-metric comparison: any rise (including a file the baseline doesn't list) is an increase. */
export function diff(base: FileCounts, current: FileCounts, metrics: Record<string, string>): { increases: string[]; decreases: string[] } {
  const increases: string[] = [];
  const decreases: string[] = [];
  const files = new Set([...Object.keys(base), ...Object.keys(current)]);
  for (const f of [...files].sort()) {
    const was = base[f] ?? {};
    const now = current[f] ?? {};
    for (const k of new Set([...Object.keys(was), ...Object.keys(now)])) {
      const a = was[k] ?? 0;
      const b = now[k] ?? 0;
      if (b > a) increases.push(`${f}: ${k} ${b} > baseline ${a}${!base[f] ? ' (new file)' : ''} (${metrics[k] ?? k})`);
      else if (b < a) decreases.push(`${f}: ${k} ${a} → ${b}`);
    }
  }
  return { increases, decreases };
}

/** Compare current counts with the committed baseline; update/init it when the env asks for that. */
export function ratchet(rel: string, description: string, metrics: Record<string, string>, current: FileCounts): RatchetResult {
  const env = typeof process !== 'undefined' ? process.env : {};
  const base = loadBaseline(rel);
  if (!base) {
    if (env.GUARDS_INIT === '1') {
      write(rel, description, metrics, current);
      return { increases: [], decreases: [], wrote: true, totals: totalsOf(current, metrics) };
    }
    return { increases: [`${rel} is missing: run \`npm run guards:init\` once to snapshot today's counts`], decreases: [], wrote: false, totals: totalsOf(current, metrics) };
  }
  const { increases, decreases } = diff(base.files, current, metrics);
  let wrote = false;
  if (env.GUARDS_UPDATE === '1' && !increases.length && decreases.length) {
    // Lower-only: every entry is min(baseline, current) — equal to current because nothing rose.
    write(rel, description, metrics, current);
    wrote = true;
  }
  return { increases, decreases, wrote, totals: totalsOf(current, metrics) };
}

export function topOffenders(files: FileCounts, metric: string | null, n = 10): [string, number][] {
  return Object.entries(files)
    .map(([f, m]): [string, number] => [f, metric ? (m[metric] ?? 0) : Object.values(m).reduce((s, v) => s + v, 0)])
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n);
}
