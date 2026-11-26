/// <reference types="node" />
/**
 * Phase 0 "Fence" ratchets (docs/design/PROGRAMME-v3.md, K6): style, copy and emoji counts per file may only fall.
 *
 *   npx vitest run src/test/guards          check (CI runs this inside `npx vitest run`)
 *   npm run guards:update                   lock in lower counts (refuses if any count rose)
 *   GUARDS_REPORT=1 npx vitest run src/test/guards   print totals and the top offenders
 *
 * Baselines: style-baseline.json, copy-baseline.json, emoji-baseline.json (this folder).
 */
import { describe, expect, test } from 'vitest';
import { scanCss } from './css';
import { cssFiles, isEmojiMapFile, manifestFiles, read, rustFiles, tsFiles } from './files';
import { collectTs, type TsFacts } from './tsx';
import { cssStyleCounts, STYLE_METRICS, tsStyleCounts } from './style-rules';
import { COPY_METRICS, copyCountsForStrings, isTitleCase, manifestStrings, parseProperNouns, tsCopyCounts } from './copy-rules';
import { emojiIn, rustStrings } from './emoji-rules';
import { clean, diff, ratchet, topOffenders, type FileCounts, type RatchetResult } from './ratchet';

const EMOJI_METRICS = { emoji: 'emoji cluster (\\p{Extended_Pictographic}, flags, keycaps; ©®™ allowed)' } as const;
const REPORT = process.env.GUARDS_REPORT === '1';

// ───────────────────────────────────────────────────────────────── one scan, shared by the three ratchets

interface Scan {
  style: FileCounts;
  copy: FileCounts;
  emoji: FileCounts;
  emojiChars: Map<string, number>;
}

let cached: Scan | null = null;
function scan(): Scan {
  if (cached) return cached;
  const nouns = parseProperNouns(read('src/test/guards/proper-nouns.txt'));
  const style: Record<string, Partial<Record<string, number>>> = {};
  const copy: Record<string, Partial<Record<string, number>>> = {};
  const emoji: Record<string, Partial<Record<string, number>>> = {};
  const emojiChars = new Map<string, number>();
  const addEmoji = (file: string, texts: Iterable<string>) => {
    if (isEmojiMapFile(file)) return;
    let n = 0;
    for (const t of texts)
      for (const e of emojiIn(t)) {
        n++;
        emojiChars.set(e, (emojiChars.get(e) ?? 0) + 1);
      }
    if (n) emoji[file] = { emoji: n };
  };

  for (const f of cssFiles()) {
    const raw = read(f);
    style[f] = cssStyleCounts(f, raw);
    addEmoji(f, scanCss(raw).decls.map((d) => d.value));
  }
  for (const f of tsFiles()) {
    const facts: TsFacts = collectTs(f, read(f));
    style[f] = tsStyleCounts(f, facts);
    copy[f] = tsCopyCounts(f, facts, nouns);
    addEmoji(
      f,
      facts.strings.map((s) => s.text),
    );
  }
  for (const f of manifestFiles()) {
    const raw = read(f);
    let json: unknown = null;
    try {
      json = JSON.parse(raw);
    } catch {
      json = null;
    }
    copy[f] = copyCountsForStrings(manifestStrings(json), nouns, true);
    addEmoji(f, [raw]);
  }
  for (const f of rustFiles()) addEmoji(f, rustStrings(read(f)));
  cached = { style: clean(style), copy: clean(copy), emoji: clean(emoji), emojiChars };
  return cached;
}

function report(name: string, r: RatchetResult, files: FileCounts, metrics: Record<string, string>) {
  if (r.decreases.length && !r.wrote) {
    console.info(`[guards] ${name}: ${r.decreases.length} count(s) dropped below the baseline. Lock them in: npm run guards:update`);
  }
  if (r.wrote) console.info(`[guards] ${name}: baseline written (${Object.keys(files).length} files).`);
  if (REPORT) {
    const lines = [`[guards] ${name} totals: ${JSON.stringify(r.totals)}`];
    for (const k of Object.keys(metrics)) {
      const top = topOffenders(files, k, 5);
      if (top.length) lines.push(`  ${k}: ${top.map(([f, v]) => `${f} ${v}`).join(', ')}`);
    }
    lines.push(`  all metrics: ${topOffenders(files, null, 10).map(([f, v]) => `${f} ${v}`).join(', ')}`);
    console.info(lines.join('\n'));
  }
}

const failMessage = (name: string, r: RatchetResult) =>
  `${name} ratchet: ${r.increases.length} count(s) rose above the committed baseline.\n  ${r.increases.join('\n  ')}\n` +
  'Fix the new occurrences (see docs/design/KIT.md and the v3 copy rules). If a file was renamed, move its baseline entry by hand.';

// ───────────────────────────────────────────────────────────────── ratchets

describe('Phase 0 ratchets', () => {
  test('style ratchet: per-file counts never rise (colours, shadows, gradients, blur, keyframes, scales, inline styles, USD, Sparkles)', () => {
    const s = scan();
    const r = ratchet('src/test/guards/style-baseline.json', 'Style ratchet (PROGRAMME-v3 K6). Per-file maxima; may only fall.', STYLE_METRICS, s.style);
    report('style', r, s.style, STYLE_METRICS);
    expect(r.increases, failMessage('Style', r)).toEqual([]);
  });

  test('copy lint: banned phrases and Title Case labels never rise', () => {
    const s = scan();
    const r = ratchet('src/test/guards/copy-baseline.json', 'Copy lint (PROGRAMME-v3 K6). Per-file offending UI strings; each area reaches 0 when its sweep closes.', COPY_METRICS, s.copy);
    report('copy', r, s.copy, COPY_METRICS);
    expect(r.increases, failMessage('Copy', r)).toEqual([]);
  });

  test('emoji lint: emoji clusters in src, manifests and Rust strings never rise (target 0)', () => {
    const s = scan();
    const r = ratchet('src/test/guards/emoji-baseline.json', 'Emoji lint (owner ruling: no emoji in the app). Per-file emoji clusters; target 0.', EMOJI_METRICS, s.emoji);
    report('emoji', r, s.emoji, EMOJI_METRICS);
    if (REPORT) console.info(`[guards] emoji codepoints: ${[...s.emojiChars.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([e, n]) => `${e} ${n}`).join('  ')}`);
    expect(r.increases, failMessage('Emoji', r)).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────── the matchers catch what they claim to

describe('guard matchers', () => {
  test('ratchet: rises and new files fail, drops pass', () => {
    const base = { 'a.css': { gradient: 2, shadow_literal: 1 } };
    expect(diff(base, { 'a.css': { gradient: 1, shadow_literal: 1 } }, STYLE_METRICS)).toEqual({ increases: [], decreases: ['a.css: gradient 2 → 1'] });
    expect(diff(base, { 'a.css': { gradient: 3, shadow_literal: 1 } }, STYLE_METRICS).increases).toHaveLength(1);
    expect(diff(base, { 'a.css': { gradient: 2, shadow_literal: 1, uppercase: 1 } }, STYLE_METRICS).increases).toHaveLength(1);
    expect(diff(base, { ...base, 'b.css': { gradient: 1 } }, STYLE_METRICS).increases[0]).toContain('(new file)');
  });

  test('CSS: counts literals, ignores token definitions, comments and var()-only values', () => {
    const css = `
      /* #ffffff and box-shadow: 0 0 1px red in a comment */
      .a { color: #fff; background: linear-gradient(#000, rgba(0, 0, 0, .5)); box-shadow: 0 1px 2px rgba(0,0,0,.2); }
      .b { box-shadow: var(--elev-1), var(--ring-halo); color: rgba(var(--text-rgb), 0.5); border-radius: 8px; }
      .c { border-radius: 6px 50%; font-weight: 650; text-transform: uppercase; transition: all 120ms; }
      .d:hover { animation: spin 1s linear infinite; backdrop-filter: blur(8px); background: url("data:image/svg+xml;utf8,<svg fill='%23fff'/>"); }
      @keyframes spin { to { transform: rotate(1turn); } }
      :root { --x: #123456; }`;
    expect(cssStyleCounts('src/features/x/x.css', css)).toEqual({
      color_literal: 5,
      gradient: 1,
      shadow_literal: 1,
      radius_off_scale: 1,
      font_weight_off_scale: 1,
      uppercase: 1,
      transition_all: 1,
      infinite_animation: 1,
      backdrop_filter: 1,
      keyframes: 1,
    });
    // In a token file, custom-property definitions are the tokens themselves.
    expect(cssStyleCounts('src/styles/tokens.css', ':root { --x: #123456; --shadow: 0 1px 2px rgba(0,0,0,.1); }')).toEqual({});
    // …but an off-scale weight token is still off-scale.
    expect(cssStyleCounts('src/styles/theme.css', ':root { --weight-h1: 650; }')).toEqual({ font_weight_off_scale: 1 });
  });

  test('TSX: inline styles, class strings, USD, Sparkles, repeat: Infinity, toFixed in finance', () => {
    const src = `
      import { Sparkles, Plus } from "lucide-react";
      import { DeltaPill } from "@/ui/DeltaPill";
      export function X({ v }: { v: number }) {
        return (
          <div className={cn("uppercase transition-all", v && "font-[650] rounded-[7px]")} style={{ fontWeight: 650, color: "#5e5ce6" }}>
            <m.div animate={{ opacity: 1 }} transition={{ repeat: Infinity }} />
            {format(v, "USD")} {v.toFixed(2)}
          </div>
        );
      }`;
    const c = tsStyleCounts('src/features/finance/X.tsx', collectTs('X.tsx', src));
    expect(c).toEqual({
      uppercase: 1,
      transition_all: 1,
      font_weight_off_scale: 2,
      radius_off_scale: 1,
      inline_style: 1,
      color_literal: 1,
      infinite_animation: 1,
      usd_literal: 1,
      sparkles_import: 1,
      deltapill_import: 1,
      tofixed_finance: 1,
    });
  });

  test('copy: banned phrases, exclamation, em dash and Title Case on buttons / labels', () => {
    const nouns = parseProperNouns(read('src/test/guards/proper-nouns.txt'));
    const src = `
      export const items = [{ label: "Add Transaction" }, { label: "Open in Google Sheets" }, { label: "Export CSV" }];
      export function X() {
        return (
          <section title="Small wins add up!">
            <p>Good morning, Alex — tap to check in.</p>
            <Button>Show math</Button>
            <Button>{busy ? "Saving…" : "Save Changes"}</Button>
            <EmptyState body="Coming soon" />
            <p>{"We spotted 3 recurring payments"}</p>
          </section>
        );
      }`;
    expect(tsCopyCounts('src/features/x/X.tsx', collectTs('X.tsx', src), nouns)).toEqual({
      title_case: 2,
      coach_voice: 1,
      exclamation: 1,
      greeting: 1,
      em_dash: 1,
      device_verb: 1,
      show_math: 1,
      coming_soon: 1,
      we_voice: 1,
    });
    expect(isTitleCase('Open in Google Sheets', nouns)).toBe(false);
    expect(isTitleCase('Import from Ultra Note', nouns)).toBe(false);
    expect(isTitleCase('New page', nouns)).toBe(false);
    expect(isTitleCase('Create New Page', nouns)).toBe(true);
  });

  test('emoji: clusters, flags and keycaps count once; ©®™ and arrows like → do not', () => {
    expect(emojiIn('Run 🏃‍♀️ 🔥🔥 ✅ 🇺🇸 1️⃣ © ® ™ → ←')).toEqual(['🏃‍♀️', '🔥', '🔥', '✅', '🇺🇸', '1️⃣']);
    expect(rustStrings('// "🔥" comment\nlet a = "💰 cash"; let r = r#"🎯 raw"#; let c = \'✨\'; fn f<\'a>() {}\n#[cfg(test)] mod t { const X: &str = "🧪"; }')).toEqual([
      '💰 cash',
      '🎯 raw',
      '✨',
    ]);
  });
});
