/**
 * Emoji lint (owner ruling: no emoji anywhere in the app; PROGRAMME-v3 K6 "Emoji lint"). Counts emoji clusters:
 * \p{Extended_Pictographic} sequences (with VS16 / skin-tone modifiers / ZWJ joins), regional-indicator flags and
 * keycap sequences. ©, ® and ™ are allowed. The emoji→icon import mapping table (`**​/emojiMap.*`) is exempt.
 */

const CLUSTER = /\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?)*/gu;
const FLAG = /\p{Regional_Indicator}{2}/gu;
const KEYCAP = /[0-9#*]️?⃣/gu;
const ALLOWED = new Set(['©', '®', '™']);

/** The emoji clusters in `s` (allowlisted symbols excluded). */
export function emojiIn(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(CLUSTER)) {
    const base = m[0].replace(/️/g, '');
    if (!ALLOWED.has(base)) out.push(m[0]);
  }
  for (const m of s.matchAll(FLAG)) out.push(m[0]);
  for (const m of s.matchAll(KEYCAP)) out.push(m[0]);
  return out;
}

/**
 * String literals of a Rust source file, with comments skipped and everything from the first `#[cfg(test)]` on
 * dropped (test modules are fixtures). Handles "…" with escapes, r#"…"#, b"…" and char literals.
 */
export function rustStrings(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (src[i] === '/' && src[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (src[i] === '*' && src[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
      continue;
    }
    if (ch === '#' && src.startsWith('#[cfg(test)]', i)) break;
    const raw = /^b?r(#*)"/.exec(src.slice(i, i + 40));
    if (raw && !/[\w]/.test(src[i - 1] ?? '')) {
      const hashes = raw[1];
      const start = i + raw[0].length;
      const end = src.indexOf('"' + hashes, start);
      const stop = end < 0 ? n : end;
      out.push(src.slice(start, stop));
      i = stop + 1 + hashes.length;
      continue;
    }
    if (ch === '"' || (ch === 'b' && next === '"' && !/[\w]/.test(src[i - 1] ?? ''))) {
      let k = ch === 'b' ? i + 2 : i + 1;
      let s = '';
      while (k < n && src[k] !== '"') {
        if (src[k] === '\\') {
          s += src.slice(k, k + 2);
          k += 2;
        } else s += src[k++];
      }
      out.push(s);
      i = k + 1;
      continue;
    }
    if (ch === "'") {
      // char literal ('x', '\n', '\u{1F600}', '🔥') vs lifetime ('a)
      const m = /^'(?:\\u\{[0-9a-fA-F]+\}|\\.|[^\\'\n]{1,2})'/u.exec(src.slice(i, i + 16));
      if (m) {
        out.push(m[0].slice(1, -1));
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  // Resolve \u{…} escapes so escaped emoji count too.
  return out.map((s) => s.replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16))));
}
