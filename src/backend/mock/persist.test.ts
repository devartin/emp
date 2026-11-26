/**
 * The mock twin of the store's schema-v2 icon migration (`crates/emp-store/src/icons.rs` `migrate_doc_icons`,
 * `db/payload_migrate.rs`): the same inputs give the same icons as the Rust tests.
 */
import { describe, expect, it } from 'vitest';
import { migrateIcons } from './persist';

const e = (cp: number) => String.fromCodePoint(cp);

describe('migrateIcons', () => {
  it('rewrites page, row and document icons; callouts fall back to lightbulb; text is untouched', () => {
    const state = {
      pages: [{ id: 'p', icon: { t: 'emoji', v: e(0x1f680) } }, { id: 'q', icon: { t: 'emoji', v: 'qq' } }],
      db_rows: [{ id: 'r', icon: { t: 'emoji', v: e(0x1f680) } }],
      docs: [
        {
          type: 'doc',
          content: [
            { type: 'callout', attrs: { icon: e(0x1f4cb), color: 'blue' }, content: [{ type: 'text', text: `Typed ${e(0x1f600)} stays` }] },
            { type: 'callout', attrs: { icon: { t: 'emoji', v: e(0x1f680) } } },
            { type: 'callout', attrs: { icon: { t: 'emoji', v: 'qq' } } },
            { type: 'callout', attrs: { icon: 'lucide:info' } },
            { type: 'callout', attrs: { icon: `${e(0x1fae0)}${e(0x1fae0)}` } },
            { type: 'callout', attrs: { icon: { t: 'lucide', v: 'star' } } },
            { type: 'callout', attrs: { icon: null } },
            { type: 'pageLink', attrs: { icon: { t: 'emoji', v: 'qq' } } },
          ],
        },
      ],
    };
    migrateIcons(state);
    expect(state.pages[0].icon).toEqual({ t: 'lucide', v: 'rocket' });
    expect('icon' in state.pages[1]).toBe(false);
    expect(state.db_rows[0].icon).toEqual({ t: 'lucide', v: 'rocket' });
    const c = state.docs[0].content as { attrs: Record<string, unknown>; content?: { text: string }[] }[];
    expect(c[0].attrs.icon).toEqual({ t: 'lucide', v: 'clipboard-list' });
    expect(c[0].attrs.color).toBe('blue');
    expect(c[0].content?.[0].text).toBe(`Typed ${e(0x1f600)} stays`);
    expect(c[1].attrs.icon).toEqual({ t: 'lucide', v: 'rocket' });
    expect(c[2].attrs.icon).toEqual({ t: 'lucide', v: 'lightbulb' });
    expect(c[3].attrs.icon).toEqual({ t: 'lucide', v: 'info' });
    expect(c[4].attrs.icon).toEqual({ t: 'lucide', v: 'lightbulb' });
    expect(c[5].attrs.icon).toEqual({ t: 'lucide', v: 'star' });
    expect(c[6].attrs.icon).toBeNull();
    expect('icon' in c[7].attrs).toBe(false);
    const again = JSON.stringify(state);
    migrateIcons(state);
    expect(JSON.stringify(state)).toBe(again);
  });
});
