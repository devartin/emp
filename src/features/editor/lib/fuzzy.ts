/** Small fuzzy matcher for menus: subsequence match with bonuses for word starts and runs; returns matched indices. */
export interface FuzzyResult {
  score: number;
  indices: number[];
}

export function fuzzy(query: string, target: string): FuzzyResult | null {
  const q = query.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!q) return { score: 1, indices: [] };
  const t = target.toLowerCase();
  // Prefer contiguous substring matches.
  const at = t.indexOf(q);
  if (at >= 0) {
    const wordStart = at === 0 || /[\s\-_/(]/.test(t[at - 1]);
    return { score: 100 + (wordStart ? 40 : 0) - at - (t.length - q.length) * 0.2, indices: Array.from({ length: q.length }, (_, i) => at + i) };
  }
  const indices: number[] = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === ' ') continue;
    let found = -1;
    for (let i = ti; i < t.length; i++) {
      if (t[i] === ch) {
        found = i;
        break;
      }
    }
    if (found < 0) return null;
    const wordStart = found === 0 || /[\s\-_/(]/.test(t[found - 1]);
    score += 10 + (found === prev + 1 ? 8 : 0) + (wordStart ? 6 : 0) - Math.min(5, found - ti);
    indices.push(found);
    prev = found;
    ti = found + 1;
  }
  return { score, indices };
}

/** Best match over a title plus extra searchable words (aliases/keywords give no highlight indices). */
export function fuzzyItem(query: string, title: string, extra: readonly string[] = []): FuzzyResult | null {
  const main = fuzzy(query, title);
  let best = main;
  for (const e of extra) {
    const r = fuzzy(query, e);
    if (r && (!best || r.score * 0.9 > best.score)) best = { score: r.score * 0.9, indices: main?.indices ?? [] };
  }
  return best;
}
