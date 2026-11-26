/** Seeded randomness and id generation for the mock (deterministic per seed so demo URLs survive reloads). */

export interface Rng {
  /** [0, 1) */
  next(): number;
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Uniform float in [min, max). */
  float(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  /** Standard normal (Box–Muller). */
  normal(): number;
  chance(p: number): boolean;
  shuffle<T>(items: T[]): T[];
  /** Internal state, for persistence. */
  state(): number;
  setState(s: number): void;
}

export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 */
export function createRng(seed: number | string): Rng {
  let a = (typeof seed === 'string' ? hashString(seed) : seed) >>> 0;
  let spare: number | null = null;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    int: (min, max) => Math.floor(next() * (max - min + 1)) + min,
    float: (min, max) => next() * (max - min) + min,
    pick: (items) => items[Math.floor(next() * items.length)],
    normal: () => {
      if (spare !== null) {
        const s = spare;
        spare = null;
        return s;
      }
      let u = 0;
      let v = 0;
      while (u === 0) u = next();
      while (v === 0) v = next();
      const mag = Math.sqrt(-2 * Math.log(u));
      spare = mag * Math.sin(2 * Math.PI * v);
      return mag * Math.cos(2 * Math.PI * v);
    },
    chance: (p) => next() < p,
    shuffle: (items) => {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
      return items;
    },
    state: () => a,
    setState: (s) => {
      a = s >>> 0;
      spare = null;
    },
  };
  return rng;
}

const HEX = '0123456789abcdef';
const NANO = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-';

/** Lowercase UUIDv7 (§10.2) from a millisecond timestamp and the rng. */
export function uuidv7(ms: number, rng: Rng): string {
  let tsHex = Math.max(0, Math.floor(ms)).toString(16).padStart(12, '0').slice(-12);
  const rand = (n: number) => {
    let s = '';
    for (let i = 0; i < n; i++) s += HEX[Math.floor(rng.next() * 16)];
    return s;
  };
  const variant = HEX[8 + Math.floor(rng.next() * 4)];
  tsHex = tsHex.toLowerCase();
  return `${tsHex.slice(0, 8)}-${tsHex.slice(8, 12)}-7${rand(3)}-${variant}${rand(3)}-${rand(12)}`;
}

/** 12-character nanoid used for blockContainer ids (§7.1). */
export function nanoid12(rng: Rng): string {
  let s = '';
  for (let i = 0; i < 12; i++) s += NANO[Math.floor(rng.next() * 64)];
  return s;
}

export function randomHex(rng: Rng, bytes: number): string {
  let s = '';
  for (let i = 0; i < bytes * 2; i++) s += HEX[Math.floor(rng.next() * 16)];
  return s;
}
