/**
 * Browser-mock URL options (§13.6):
 *   ?seed=demo|empty|perf   &latency=0|N   &locked=1   &encrypted=1 (password "demo", 600 ms KDF)
 *   &freeze=2026-11-26T10:00:00Z   &persist=1 (IndexedDB, dev only)   &fail=<cmd>:<CODE>@<prob>[,<cmd>:<CODE>@<prob>…]
 */
import type { ErrorCode } from '../types';
import { isErrorCode } from '../errors';

export type SeedKind = 'demo' | 'empty' | 'perf';

export interface FailRule {
  /** Command name, or '*' for every command. */
  command: string;
  code: ErrorCode;
  /** 0..1 */
  prob: number;
}

export interface MockOptions {
  seed: SeedKind;
  /** Mean simulated IPC latency in ms (each call jitters ±35 %). */
  latency: number;
  /** Start locked (implies encrypted). */
  locked: boolean;
  /** Vault is encrypted with password `demo`; unlock simulates 600 ms of Argon2id. */
  encrypted: boolean;
  /** Frozen clock start (ms). */
  freeze: number | null;
  persist: boolean;
  fail: FailRule[];
}

export const DEMO_PASSWORD = 'demo';

export const DEFAULT_OPTIONS: MockOptions = {
  seed: 'demo',
  latency: 0,
  locked: false,
  encrypted: false,
  freeze: null,
  persist: false,
  fail: [],
};

function parseFail(raw: string | null): FailRule[] {
  if (!raw) return [];
  const out: FailRule[] = [];
  for (const part of raw.split(',')) {
    const m = /^([a-z_*]+):([A-Z_]+)(?:@([0-9.]+))?$/.exec(part.trim());
    if (!m || !isErrorCode(m[2])) continue;
    const prob = m[3] === undefined ? 1 : Math.min(1, Math.max(0, Number(m[3])));
    out.push({ command: m[1], code: m[2], prob: Number.isFinite(prob) ? prob : 1 });
  }
  return out;
}

export function parseMockOptions(search: string | URLSearchParams): MockOptions {
  const p = typeof search === 'string' ? new URLSearchParams(search) : search;
  const seedRaw = p.get('seed');
  const seed: SeedKind = seedRaw === 'empty' || seedRaw === 'perf' ? seedRaw : 'demo';
  const latency = Math.max(0, Number(p.get('latency') ?? 0) || 0);
  const locked = p.get('locked') === '1';
  const encrypted = p.get('encrypted') === '1' || locked;
  const freezeRaw = p.get('freeze');
  const freezeTs = freezeRaw ? Date.parse(freezeRaw) : NaN;
  return {
    seed,
    latency,
    locked,
    encrypted,
    freeze: Number.isFinite(freezeTs) ? freezeTs : null,
    persist: p.get('persist') === '1',
    fail: parseFail(p.get('fail')),
  };
}

export function optionsFromLocation(): MockOptions {
  if (typeof window === 'undefined' || !window.location) return { ...DEFAULT_OPTIONS };
  // Options may sit in the query string or (for hash-routed links) after the hash's own '?'.
  const params = new URLSearchParams(window.location.search);
  const hash = window.location.hash;
  const q = hash.indexOf('?');
  if (q >= 0) new URLSearchParams(hash.slice(q + 1)).forEach((v, k) => params.has(k) || params.set(k, v));
  return parseMockOptions(params);
}
