/**
 * Daily-note parity with the desktop store (`crates/emp-store/src/repo/pages.rs::daily_note_open`, held by
 * `crates/emp-store/tests/pages_docs.rs`): "Thursday, Nov 26, 2026" titles under "Journal", newest first, a sun glyph
 * for today and a calendar glyph otherwise (never an emoji). Home's today's-note lookup matches this title.
 */
import { describe, expect, it } from 'vitest';
import { mockApi } from '@/test/helpers';
import { dailyTitle } from './lib/templates';

describe('daily notes (parity with Rust)', () => {
  it('titles, folder, icons and order match the desktop store', async () => {
    const { api } = await mockApi({ freeze: Date.parse('2026-11-26T15:30:00Z') });
    expect(dailyTitle('2026-11-26')).toBe('Thursday, Nov 26, 2026');
    const today = await api.daily.noteOpen({ date: '2026-11-26' });
    const older = await api.daily.noteOpen({ date: '2026-11-25' });
    const newer = await api.daily.noteOpen({ date: '2026-11-27' });
    expect(today.title).toBe('Thursday, Nov 26, 2026');
    expect(newer.title).toBe('Friday, Nov 27, 2026');
    expect(today.icon).toEqual({ t: 'lucide', v: 'sun' });
    expect(older.icon).toEqual({ t: 'lucide', v: 'calendar' });
    const [ws] = await api.workspace.list();
    const open = await api.workspace.open({ id: ws.id });
    const folder = open.pages.find((p) => p.id === today.parentId);
    expect(folder?.title).toBe('Journal');
    expect(folder?.icon?.t).toBe('lucide');
    const order = open.pages
      .filter((p) => p.parentId === folder?.id && [today.id, older.id, newer.id].includes(p.id))
      .sort((x, y) => (x.sortKey < y.sortKey ? -1 : 1))
      .map((p) => p.id);
    expect(order).toEqual([newer.id, today.id, older.id]);
  });
});
