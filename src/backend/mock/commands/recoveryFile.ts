/**
 * vault_recovery_save_file (1.0 brief §2.5): Rust shows the native save dialog and writes the key as a text file.
 * The browser preview has no native dialog, so the mock downloads the same text file instead. Like Rust
 * (`check_recovery_words`), it only writes something shaped like a real recovery key: 24 words from the word list
 * (Rust also checks the checksum, which the mock's words don't carry). Neither compares the words with this
 * workspace's key: that copy is gone once the key is confirmed, and saving another copy afterwards must still work.
 */
import { BackendError } from '../../errors';
import type { MockHandlers } from '../ctx';
import { BIP39_SUBSET } from '../lib/words';

const FILE_NAME = 'Ultranote Recovery Key.txt';
const KNOWN = new Set(BIP39_SUBSET.map((w) => w.toLowerCase()));

/** The same layout Rust writes (`recovery_file_text` in src-tauri/src/commands/vault.rs). */
export function recoveryFileText(words: string[], created: string): string {
  const rows: string[] = [];
  for (let r = 0; r < Math.ceil(words.length / 4); r++) {
    rows.push(
      words
        .slice(r * 4, r * 4 + 4)
        .map((w, c) => `${String(r * 4 + c + 1).padStart(2, ' ')}. ${w}`.padEnd(18, ' '))
        .join('')
        .trimEnd(),
    );
  }
  return (
    `Ultranote recovery key\n\n${rows.join('\n')}\n\nCreated ${created}.\n\n` +
    `If you forget your password, choose "Use recovery key" on the lock screen and enter these 24 words.\n` +
    `Store this somewhere safe. If you lose both your password and this key, your data cannot be recovered.\n`
  );
}

export const handlers: MockHandlers = {
  vault_recovery_save_file: (req, ctx) => {
    const words = Array.isArray(req.words) ? req.words.map((w) => String(w).trim().toLowerCase()) : [];
    if (words.length !== 24) throw new BackendError('INVALID', 'the recovery key has 24 words', { field: 'words' });
    if (words.some((w) => !KNOWN.has(w))) throw new BackendError('INVALID', "this isn't a recovery key", { field: 'words' });
    if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return { saved: false };
    const created = new Date(ctx.clock.now()).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const url = URL.createObjectURL(new Blob([recoveryFileText(words, created)], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = FILE_NAME;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { saved: true, fileName: FILE_NAME };
  },
};
