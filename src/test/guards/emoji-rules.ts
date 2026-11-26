/**
 * Emoji lint (owner ruling: no emoji anywhere in the app; PROGRAMME-v3 K6 "Emoji lint"). Counts emoji clusters:
 * \p{Extended_Pictographic} sequences (with VS16 / skin-tone modifiers / ZWJ joins), regional-indicator flags and
 * keycap sequences. ©, ® and ™ are allowed, and so are typographic arrows / triangles / check marks written without
 * VS16 (TEXT_SYMBOL). The emoji→icon import mapping table (`**​/emojiMap.*`) is exempt.
 */

const CLUSTER = /\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?)*/gu;
const FLAG = /\p{Regional_Indicator}{2}/gu;
const KEYCAP = /[0-9#*]️?⃣/gu;
const ALLOWED = new Set(['©', '®', '™']);
/**
 * Typographic symbols that are Extended_Pictographic but render as text glyphs unless followed by VS16 (U+FE0F):
 * the arrows (↔ ↗ ↘ ⤴ ➡ ⬅ …), media triangles (▶ ◀), small squares and the check / cross dingbats (✔ ✖ ☑). With
 * VS16 they are emoji and count.
 */
const TEXT_SYMBOL = /^[\u2194-\u21ff\u2934\u2935\u27a1\u2b05-\u2b07\u25aa\u25ab\u25b6\u25c0\u25fb-\u25fe\u2611\u2714\u2716]$/u;

/** The emoji clusters in `s` (allowlisted symbols excluded). */
export function emojiIn(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(CLUSTER)) {
    const base = m[0].replace(/️/g, '');
    if (ALLOWED.has(base)) continue;
    if (TEXT_SYMBOL.test(m[0])) continue; // no VS16: a text glyph
    out.push(m[0]);
  }
  for (const m of s.matchAll(FLAG)) out.push(m[0]);
  for (const m of s.matchAll(KEYCAP)) out.push(m[0]);
  return out;
}

interface Lexed {
  end: number;
  /** The literal's contents, for string and char literals. */
  text?: string;
}

/** A comment, string, raw string, byte string or char literal starting at `i` (null for anything else). */
function lexAt(src: string, i: number): Lexed | null {
  const n = src.length;
  const ch = src[i];
  const next = src[i + 1];
  if (ch === '/' && next === '/') {
    const nl = src.indexOf('\n', i);
    return { end: nl < 0 ? n : nl + 1 };
  }
  if (ch === '/' && next === '*') {
    let depth = 1;
    let k = i + 2;
    while (k < n && depth > 0) {
      if (src[k] === '/' && src[k + 1] === '*') {
        depth++;
        k += 2;
      } else if (src[k] === '*' && src[k + 1] === '/') {
        depth--;
        k += 2;
      } else k++;
    }
    return { end: k };
  }
  const prevIsWord = /[\w]/.test(src[i - 1] ?? '');
  const raw = /^b?r(#*)"/.exec(src.slice(i, i + 40));
  if (raw && !prevIsWord) {
    const hashes = raw[1];
    const start = i + raw[0].length;
    const close = src.indexOf('"' + hashes, start);
    const stop = close < 0 ? n : close;
    return { end: stop + 1 + hashes.length, text: src.slice(start, stop) };
  }
  if (ch === '"' || (ch === 'b' && next === '"' && !prevIsWord)) {
    let k = ch === 'b' ? i + 2 : i + 1;
    let s = '';
    while (k < n && src[k] !== '"') {
      if (src[k] === '\\') {
        s += src.slice(k, k + 2);
        k += 2;
      } else s += src[k++];
    }
    return { end: k + 1, text: s };
  }
  if (ch === "'") {
    // char literal ('x', '\n', '\u{1F600}', '🔥') vs lifetime ('a)
    const m = /^'(?:\\u\{[0-9a-fA-F]+\}|\\.|[^\\'\n]{1,2})'/u.exec(src.slice(i, i + 16));
    if (m) return { end: i + m[0].length, text: m[0].slice(1, -1) };
  }
  return null;
}

/**
 * End of the item that starts at `i` (after a `#[cfg(test)]`): further attributes, then up to a `;` or `,` at depth 0
 * (a `use`, a field, an enum variant) or the `}` that closes its first top-level `{ … }` block (a fn, mod, impl,
 * struct). An unmatched closer (the attribute sat on the last field of a struct) ends the item too.
 */
function skipItem(src: string, i: number): number {
  const n = src.length;
  let depth = 0;
  let k = i;
  while (k < n) {
    const lx = lexAt(src, k);
    if (lx) {
      k = lx.end;
      continue;
    }
    const c = src[k];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return k;
      depth--;
      if (depth === 0 && c === '}') return k + 1;
    } else if (depth === 0 && (c === ';' || c === ',')) return k + 1;
    k++;
  }
  return n;
}

/**
 * String literals of a Rust source file, with comments skipped. Items gated by `#[cfg(test)]` (a test module, a
 * test-only helper fn or field) are skipped item by item; `#![cfg(test)]` drops the whole file. Handles "…" with
 * escapes, r#"…"#, b"…" and char literals.
 */
export function rustStrings(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    if (src[i] === '#') {
      if (src.startsWith('#![cfg(test)]', i)) break;
      if (src.startsWith('#[cfg(test)]', i)) {
        i = skipItem(src, i + '#[cfg(test)]'.length);
        continue;
      }
    }
    const lx = lexAt(src, i);
    if (lx) {
      if (lx.text !== undefined) out.push(lx.text);
      i = lx.end;
      continue;
    }
    i++;
  }
  // Resolve \u{…} escapes so escaped emoji count too.
  return out.map((s) => s.replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16))));
}
