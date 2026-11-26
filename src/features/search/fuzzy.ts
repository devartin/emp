/**
 * Fuzzy matching for the command palette (§5.9): every query character must appear in order. Scoring favours
 * a whole-title prefix, word starts (including camelCase and after separators), consecutive runs and short
 * titles; matched ranges drive the weight-600 highlight. Returns `match` in roughly 0..1 so palette ranking can
 * apply `score = match × (1 + 0.3·recency + 0.2·frequency + 0.1·favorite)`.
 */

export interface FuzzyResult {
  /** 0 < match ≤ 1 */
  match: number;
  /** Matched character ranges [start, end) in the original text. */
  ranges: [number, number][];
}

export function fold(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const isWordStart = (text: string, i: number): boolean => {
  if (i === 0) return true;
  const prev = text[i - 1];
  const cur = text[i];
  if (/[\s\-_/.,:;()[\]→>·—–]/.test(prev)) return true;
  return prev === prev.toLowerCase() && cur !== cur.toLowerCase() && /[a-z]/i.test(cur);
};

function toRanges(idx: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const i of idx) {
    const last = out[out.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else out.push([i, i + 1]);
  }
  return out;
}

/** Greedy-with-lookahead subsequence match: prefers word-start positions for each query character. */
export function fuzzy(query: string, text: string): FuzzyResult | null {
  const q = fold(query.trim());
  if (!q) return { match: 1, ranges: [] };
  const t = fold(text);
  if (!t) return null;

  // Fast paths
  const direct = t.indexOf(q);
  if (direct === 0) return { match: 1 - Math.min(0.2, (t.length - q.length) / 200), ranges: [[0, q.length]] };
  if (direct > 0 && isWordStart(text, direct)) return { match: 0.9 - Math.min(0.2, direct / 120), ranges: [[direct, direct + q.length]] };

  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length > 1) {
    // Multi-word: every token must match somewhere (any order).
    let total = 0;
    const ranges: [number, number][] = [];
    for (const tok of tokens) {
      const r = fuzzy(tok, text);
      if (!r) return null;
      total += r.match;
      ranges.push(...r.ranges);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    return { match: (total / tokens.length) * 0.92, ranges: mergeRanges(ranges) };
  }

  if (direct > 0) return { match: 0.68 - Math.min(0.2, direct / 150), ranges: [[direct, direct + q.length]] };

  const idx: number[] = [];
  let ti = 0;
  let score = 0;
  let run = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    // Prefer the next word start that has this character; fall back to the next occurrence.
    for (let k = ti; k < t.length; k++) {
      if (t[k] === ch && isWordStart(text, k)) {
        found = k;
        break;
      }
    }
    const plain = t.indexOf(ch, ti);
    if (plain === -1) return null;
    if (found === -1 || (idx.length && plain === idx[idx.length - 1] + 1)) found = plain;
    const consecutive = idx.length > 0 && found === idx[idx.length - 1] + 1;
    run = consecutive ? run + 1 : 0;
    score += 1 + (isWordStart(text, found) ? 1.6 : 0) + run * 0.9 - Math.min(0.8, (found - ti) * 0.04);
    idx.push(found);
    ti = found + 1;
  }
  const best = q.length * (1 + 1.6 + 0.9 * (q.length - 1) / 2) || 1;
  const coverage = q.length / Math.max(q.length, t.length);
  const match = Math.max(0.05, Math.min(0.6, (score / best) * 0.55 + coverage * 0.15));
  return { match, ranges: toRanges(idx) };
}

function mergeRanges(ranges: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** Best match of the title, or of a keyword (keywords score lower and don't highlight). */
export function fuzzyAny(query: string, title: string, keywords: readonly string[] = []): FuzzyResult | null {
  const main = fuzzy(query, title);
  let best = main;
  for (const k of keywords) {
    const r = fuzzy(query, k);
    if (r && (!best || r.match * 0.82 > best.match)) best = { match: r.match * 0.82, ranges: main?.ranges ?? [] };
  }
  return best;
}
