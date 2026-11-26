/** `:` + 2 characters → emoji autocomplete (§7.2). Emoji data is a lazy chunk shared with the picker. */
import type { Editor } from '@tiptap/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import { insertEmoji } from '../lib/editorCommands';
import { closeSuggest, consumeSuggest, registerSuggestKeys, type SuggestState } from '../extensions/suggest';
import { Floating } from './Floating';

type EmojiRow = readonly [string, string, number];
let data: ReadonlyArray<EmojiRow> | null = null;
let loading: Promise<void> | null = null;

function useEmojiData(): ReadonlyArray<EmojiRow> | null {
  const [d, setD] = useState(data);
  useEffect(() => {
    if (d) return;
    loading ??= import('@/ui/emoji-data').then((m) => {
      data = m.EMOJI;
    });
    void loading.then(() => setD(data));
  }, [d]);
  return d;
}

const shortcode = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export function EmojiMenu({ editor, state }: { editor: Editor; state: SuggestState }) {
  const view = editor.view;
  const all = useEmojiData();
  const [active, setActive] = useState(0);
  const q = state.query.toLowerCase();
  const results = useMemo(() => {
    if (!all) return [];
    const starts: EmojiRow[] = [];
    const contains: EmojiRow[] = [];
    for (const e of all) {
      const sc = shortcode(e[1]);
      if (sc.startsWith(q) || e[1].split(' ').some((w) => w.startsWith(q))) starts.push(e);
      else if (sc.includes(q)) contains.push(e);
      if (starts.length >= 24) break;
    }
    return [...starts, ...contains].slice(0, 24);
  }, [all, q]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    if (all && !results.length && q.length > 4) closeSuggest(view);
  }, [all, results.length, q, view]);

  const pick = useCallback(
    (e: EmojiRow) => {
      consumeSuggest(view);
      insertEmoji(editor, e[0], shortcode(e[1]));
    },
    [editor, view],
  );

  useEffect(() => {
    registerSuggestKeys(view, (e) => {
      const cols = 8;
      if (!results.length) return false;
      if (e.key === 'ArrowRight') return setActive((a) => Math.min(results.length - 1, a + 1)), true;
      if (e.key === 'ArrowLeft') return setActive((a) => Math.max(0, a - 1)), true;
      if (e.key === 'ArrowDown') return setActive((a) => Math.min(results.length - 1, a + cols)), true;
      if (e.key === 'ArrowUp') return setActive((a) => Math.max(0, a - cols)), true;
      if (e.key === 'Enter' || e.key === 'Tab') {
        const r = results[active];
        if (r) pick(r);
        return !!r;
      }
      return false;
    });
    return () => registerSuggestKeys(view, null);
  }, [view, results, active, pick]);

  const anchor = useCallback(() => {
    try {
      const c = view.coordsAtPos(state.from);
      return { x: c.left, y: c.top, width: 1, height: c.bottom - c.top };
    } catch {
      return null;
    }
  }, [view, state.from]);

  if (all && !results.length) return null;
  const cur = results[active];
  return (
    <Floating open anchor={anchor} context={view.dom} passive className="emp-emoji-menu" role="listbox" ariaLabel="Emoji">
      <div className="emp-emoji-grid">
        {results.map((e, i) => (
          <button
            key={e[0]}
            type="button"
            role="option"
            aria-selected={i === active}
            aria-label={e[1]}
            className={cn('emp-emoji-cell', i === active && 'is-active')}
            onMouseDown={(ev) => ev.preventDefault()}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(e)}
          >
            {e[0]}
          </button>
        ))}
      </div>
      <div className="emp-emoji-foot">{cur ? `:${shortcode(cur[1])}:` : 'Loading…'}</div>
    </Floating>
  );
}
