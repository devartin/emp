/**
 * Copy lint (PROGRAMME-v3 K6 "Copy lint"; banned list from the v3 AI-tells research, Builder §2c and Skeptic's
 * additions). Each rule counts offending UI strings per file; the baseline may only fall, and every area reaches 0
 * when its sweep closes. It cannot judge tone: the chair's contact-sheet review covers that.
 */
import type { TsFacts, TsString } from './tsx';

export const COPY_METRICS = {
  greeting: '"Good morning/afternoon/evening" greeting',
  coach_voice: 'coach voice ("Small wins add up", "level up", "Don\'t miss twice", "make it yours", …)',
  hedge: '"Consider…", "Common guideline", "not advice" boilerplate',
  show_math: '"Show math" control',
  needs_attention: '"Needs attention"',
  dollar_job: '"Give every dollar a job"',
  we_voice: 'the app as "we" ("we spotted…", "we\'ll", "let\'s"); security truths ("we can\'t…") excepted',
  device_verb: 'touch verbs on a desktop app ("tap", "long-press", "swipe")',
  exclamation: 'UI string ending in "!"',
  em_dash: 'em dash in a UI string',
  coming_soon: '"Coming soon"',
  title_case: 'Title Case button / label (sentence case is the rule)',
} as const;
export type CopyMetric = keyof typeof COPY_METRICS;

/** Attribute / property names whose string values are shown to people. */
const COPY_KEYS = new Set([
  'title',
  'subtitle',
  'description',
  'label',
  'placeholder',
  'hint',
  'aria-label',
  'ariaLabel',
  'body',
  'message',
  'heading',
  'caption',
  'tooltip',
  'helper',
  'help',
  'helpText',
  'emptyText',
  'emptyTitle',
  'emptyBody',
  'confirmLabel',
  'cancelLabel',
  'actionLabel',
  'cta',
  'lede',
  'tagline',
  'summary',
  'why',
  'detail',
  'subtext',
  'sublabel',
  'badge',
  'prompt',
  'question',
  'explain',
  'note',
]);
/** Keys that hold short labels (buttons, menu items, tabs): the sentence-case check applies to these. */
const LABEL_KEYS = new Set(['label', 'confirmLabel', 'cancelLabel', 'actionLabel', 'cta']);
const BUTTONISH_TAG = /(^|\.)(Button|IconButton|button|MenuItem|Item|Tab|TabsTrigger|Trigger)$/;

const RULES: [Exclude<CopyMetric, 'exclamation' | 'em_dash' | 'title_case'>, RegExp][] = [
  ['greeting', /\bgood (morning|afternoon|evening)\b/i],
  ['coach_voice', /\bsmall wins\b|\blevel up\b|\bdon['’]?t miss twice\b|\bmake (it|\w+) yours\b|\bkeeps? the streak alive\b|\bmake today a win\b|\byou['’]ve got this\b/i],
  ['hedge', /\bconsider\b|\bcommon guidelines?\b|\bnot (financial |tax )?advice\b/i],
  ['show_math', /\bshow (the )?math\b/i],
  ['needs_attention', /\bneeds attention\b/i],
  ['dollar_job', /\bgive every dollar a job\b/i],
  // Case-sensitive on purpose: "WE" is a weekday code in RRULEs.
  ['we_voice', /\b[Ww]e(?:['’](?:ll|re|ve|d))?\b|\b[Ll]et['’]s\b/],
  ['device_verb', /\b(tap|taps|tapping|long-press|long press|swipe)\b/i],
  ['coming_soon', /\bcoming soon\b/i],
];
/** Security truths about the developer are a legitimate "we" (research note 41). */
const WE_ALLOW = /\bwe (can['’]t|cannot|never|don['’]t)\b/i;

/** Proper nouns and product names that keep their capitals inside sentence-case labels (src/test/guards/proper-nouns.txt). */
export function parseProperNouns(text: string): { words: Set<string>; phrases: string[] } {
  const words = new Set<string>();
  const phrases: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (line.includes(' ')) phrases.push(line);
    else words.add(line);
  }
  phrases.sort((a, b) => b.length - a.length);
  return { words, phrases };
}

/** Heuristic: 2–7 plain words where a word after the first starts with a capital and is not a proper noun/acronym. */
export function isTitleCase(s: string, nouns: { words: Set<string>; phrases: string[] }): boolean {
  let t = s.replace(/[…→←↗.:!?]+\s*$/u, '').trim();
  if (!t || /[{}<>=/\\_@#$%0-9]/.test(t)) return false;
  for (const p of nouns.phrases) t = t.split(p).join('Pn');
  const sentences = t.split(/[.:?!]\s+|\s[-–—]\s|\s·\s|[()"“”]/);
  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.length > 7) continue;
    if (!words.every((w) => /^[\p{L}'’&+-]+$/u.test(w))) continue;
    const offending = words.slice(1).filter((w) => {
      const bare = w.replace(/['’]s$/, '');
      if (!/^\p{Lu}/u.test(bare)) return false;
      if (bare === 'Pn' || bare.length === 1) return false; // phrase placeholder, "I", "N"
      if (bare.length > 1 && bare === bare.toUpperCase()) return false; // acronym
      if (/\p{Lu}/u.test(bare.slice(1))) return false; // camel brand (iCloud, YouTube, QuickBooks)
      return !nouns.words.has(bare);
    });
    if (offending.length) return true;
  }
  return false;
}

/** Is this collected string UI copy? */
export function isCopy(s: TsString): boolean {
  if (s.inClass) return false;
  if (s.kind === 'jsxText' || s.kind === 'jsxChild' || s.kind === 'toast') return true;
  if ((s.kind === 'attr' || s.kind === 'prop') && s.key) return COPY_KEYS.has(s.key);
  return false;
}

/** Is this a short action label (button child, menu item, label prop)? */
export function isLabel(s: TsString): boolean {
  if (s.kind === 'jsxText' || s.kind === 'jsxChild') return !!s.tag && BUTTONISH_TAG.test(s.tag);
  if ((s.kind === 'attr' || s.kind === 'prop') && s.key) return LABEL_KEYS.has(s.key);
  return false;
}

type Counts = Partial<Record<string, number>>;

/**
 * `copy` marks strings known to be shown (JSX text, copy props): the exclamation and sentence-case checks only run on
 * those. Banned phrases and em dashes are checked in every string literal (a phrase like "Good morning" returned from
 * a helper is still copy).
 */
export function copyCountsForStrings(
  strings: { text: string; label: boolean; copy?: boolean }[],
  nouns: ReturnType<typeof parseProperNouns>,
  checkTitleCase: boolean,
): Counts {
  const c: Counts = {};
  const add = (k: CopyMetric) => {
    c[k] = (c[k] ?? 0) + 1;
  };
  for (const { text, label, copy = true } of strings) {
    const t = text.trim();
    if (!t || !/\p{L}/u.test(t)) continue;
    for (const [k, re] of RULES) {
      if (!re.test(t)) continue;
      if (k === 'we_voice' && WE_ALLOW.test(t) && !/\blet['’]s\b/i.test(t)) continue;
      add(k);
    }
    if (copy && /!\s*$/.test(t) && !/^!+$/.test(t)) add('exclamation');
    if (t.includes('—')) add('em_dash');
    if (copy && checkTitleCase && label && isTitleCase(t, nouns)) add('title_case');
  }
  return c;
}

export function tsCopyCounts(file: string, f: TsFacts, nouns: ReturnType<typeof parseProperNouns>): Counts {
  const strings = f.strings.filter((s) => !s.inClass).map((s) => ({ text: s.text, label: isLabel(s), copy: isCopy(s) }));
  // Seed data (src/backend/mock) is demo content: banned phrases count, but its labels are user data (account and
  // category names), so the sentence-case heuristic only runs on UI code.
  return copyCountsForStrings(strings, nouns, !file.startsWith('src/backend/'));
}

const MANIFEST_COPY_KEYS = new Set([...COPY_KEYS, 'text', 'disclaimer', 'md', 'items', 'tabs']);

/** String values of user-facing keys in a life-app manifest (crates/emp-store/lifeapps/*.json). */
export function manifestStrings(json: unknown): { text: string; label: boolean }[] {
  const out: { text: string; label: boolean }[] = [];
  const visit = (v: unknown, key: string | null) => {
    if (typeof v === 'string') {
      if (key && MANIFEST_COPY_KEYS.has(key)) out.push({ text: v, label: LABEL_KEYS.has(key) });
    } else if (Array.isArray(v)) {
      for (const x of v) visit(x, key);
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) visit(x, k);
    }
  };
  visit(json, null);
  return out;
}
