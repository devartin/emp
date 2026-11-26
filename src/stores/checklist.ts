/**
 * Getting Started checklist (§6.2). Backend-visible actions (create a page, lock, templates) tick themselves in Rust /
 * the mock; UI-only actions report here: `markTried('try_slash' | 'open_palette' | 'hide_numbers')`.
 */
import { api } from '@/backend';
import { useVault } from './vault';

export type ChecklistItem =
  | 'create_page'
  | 'try_slash'
  | 'open_palette'
  | 'add_transaction'
  | 'hide_numbers'
  | 'lock'
  | 'templates';

const reported = new Set<ChecklistItem>();

export function markTried(item: ChecklistItem): void {
  if (reported.has(item)) return;
  if (useVault.getState().status?.state !== 'unlocked') return;
  reported.add(item);
  api.kv.set({ ns: 'ui.gettingStarted', key: item, value: Date.now() }).catch(() => reported.delete(item));
}
