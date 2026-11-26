/** password_strength (zxcvbn) and password_generate (5 EFF words, random separator, §9.10). */
import type { PasswordStrength } from '../../types';
import type { MockHandlers } from '../ctx';
import { EFF_SUBSET } from '../lib/words';

type Zxcvbn = typeof import('zxcvbn');
let zx: Promise<Zxcvbn> | null = null;
const loadZxcvbn = () => (zx ??= import('zxcvbn').then((m) => ((m as unknown as { default?: Zxcvbn }).default ?? m) as Zxcvbn));

const SEPARATORS = ['-', '.', '_', '/', ' '];
/** 5 × log2(7776) for the full EFF long list the desktop app uses. */
const PASSPHRASE_BITS = 64.6;
const MAX_BYTES = 1024;

export const handlers: MockHandlers = {
  password_strength: async (req) => {
    const pw = (req.password ?? '').normalize('NFKC');
    if (new TextEncoder().encode(pw).length > MAX_BYTES) {
      return { score: 0, crackTime: 'n/a', warning: 'Passwords are limited to 1,024 bytes', suggestions: [], common: false };
    }
    if (!pw) return { score: 0, crackTime: 'instantly', suggestions: ['Use a few words that only you would put together.'], common: false };
    const zxcvbn = await loadZxcvbn();
    const r = zxcvbn(pw.slice(0, 256));
    const common = r.sequence.some(
      (m) => m.pattern === 'dictionary' && (m as { dictionary_name?: string }).dictionary_name === 'passwords' && (m.rank ?? Infinity) < 100_000 && m.token.length >= pw.length - 2,
    );
    const suggestions = [...r.feedback.suggestions];
    if (pw.length < 10) suggestions.unshift('Use at least 10 characters.');
    const out: PasswordStrength = {
      score: r.score as PasswordStrength['score'],
      crackTime: String(r.crack_times_display.offline_slow_hashing_1e4_per_second),
      suggestions,
      common,
    };
    if (r.feedback.warning) out.warning = r.feedback.warning;
    else if (common) out.warning = 'This is a commonly used password.';
    return out;
  },
  password_generate: (_req, ctx) => {
    const sep = ctx.rng.pick(SEPARATORS);
    const words = Array.from({ length: 5 }, () => ctx.rng.pick(EFF_SUBSET));
    return { passphrase: words.join(sep), bits: PASSPHRASE_BITS };
  },
};
