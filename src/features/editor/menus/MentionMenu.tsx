/**
 * `@` mentions and `[[` page links (§7.2): pages from search (recents first when empty), natural-language dates
 * ("today", "next fri", "Dec 3 3pm", "in 2 weeks"), and "Create page 'x'" for `[[`.
 */
import type { Editor } from '@tiptap/core';
import { PageGlyphWith } from '@/ui/icons/glyphCore';
import { GLYPHS } from '@/ui/icons/glyphs';
import { Calendar, CornerDownLeft, FileText, Plus } from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '@/backend';
import type { DateValue, Icon, SearchHit } from '@/backend/types';
import { cn } from '@/lib/cn';
import { formatDateValue, isoDay } from '@/lib/dates';
import { parseNatural } from '@/lib/nlp';
import { useTree } from '@/stores/tree';
import { useWorkspace } from '@/stores/workspace';
import { currentBlock, isEmptyParagraph } from '../lib/blocks';
import { editorContext } from '../lib/context';
import { createSubPage, insertAtom, insertDateMention, insertPageMention } from '../lib/editorCommands';
import { closeSuggest, consumeSuggest, registerSuggestKeys, type SuggestState } from '../extensions/suggest';
import { GlideHighlight } from '@/ui/GlideHighlight';
import { Floating } from './Floating';

interface Row {
  key: string;
  group: string;
  title: string;
  subtitle?: string;
  icon: ReactNode;
  run: () => void;
}

function glyph(icon: Icon | undefined): ReactNode {
  return <PageGlyphWith icon={icon} size={16} fallback="file" kindFallback={FileText} lookup={(n) => GLYPHS[n]} />;
}

function toDateValue(d: Date, time: boolean): DateValue {
  return time ? { start: d.toISOString(), time: true } : { start: isoDay(d), time: false };
}

export function MentionMenu({ editor, state }: { editor: Editor; state: SuggestState }) {
  const view = editor.view;
  const pagelink = state.kind === 'pagelink';
  const query = state.query;
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [active, setActive] = useState(0);
  const req = useRef(0);
  const misses = useRef(0);
  const lastInput = useRef<'key' | 'mouse'>('key');

  useEffect(() => {
    const id = ++req.current;
    const t = setTimeout(
      () => {
        if (!query.trim()) {
          const recents = useWorkspace.getState().recents.slice(0, 6);
          const byId = useTree.getState().byId;
          setHits(
            recents
              .map((rid) => byId.get(rid))
              .filter((p): p is NonNullable<typeof p> => !!p && p.id !== useWorkspace.getState().workspace?.id)
              .map((p) => ({ id: p.id, kind: 'page', title: p.title, icon: p.icon, path: [], score: 1, updatedAt: p.updatedAt })),
          );
          return;
        }
        void api.search
          .query({ q: query, filters: { type: ['page', 'database', 'sheet'] }, limit: 8, reqId: id })
          .then((res) => {
            if (res.reqId === req.current) setHits(res.hits);
          })
          .catch(() => setHits([]));
      },
      query ? 70 : 0,
    );
    return () => clearTimeout(t);
  }, [query]);

  const finish = useCallback(
    (fn: () => void) => {
      consumeSuggest(view);
      fn();
    },
    [view],
  );

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    const q = query.trim();
    const insertPage = (id: string) => {
      const b = currentBlock(editor.state);
      if (pagelink && b && isEmptyParagraph(b)) insertAtom(editor, 'pageLink', { pageId: id }, 'after');
      else insertPageMention(editor, id);
    };
    const self = editorContext(editor).ownerId;
    for (const h of (hits ?? []).filter((x) => x.id !== self)) {
      out.push({
        key: `p:${h.id}`,
        group: q ? 'Pages' : 'Recent pages',
        title: h.title || 'Untitled',
        subtitle: h.path.length ? h.path.join(' / ') : undefined,
        icon: glyph(h.icon),
        run: () => finish(() => insertPage(h.id)),
      });
    }
    if (!pagelink) {
      const dates: { label: string; value: DateValue }[] = [];
      if (q) {
        const parsed = parseNatural(q);
        if (parsed.start) dates.push({ label: q, value: toDateValue(parsed.start, parsed.hasTime) });
      } else {
        const now = new Date();
        const tomorrow = new Date(now.getTime() + 86_400_000);
        dates.push({ label: 'Today', value: toDateValue(now, false) }, { label: 'Tomorrow', value: toDateValue(tomorrow, false) });
        const nextMon = new Date(now);
        nextMon.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
        dates.push({ label: 'Next Monday', value: toDateValue(nextMon, false) });
      }
      for (const d of dates) {
        out.push({
          key: `d:${d.value.start}`,
          group: 'Dates',
          title: formatDateValue(d.value),
          subtitle: d.label.toLowerCase() === formatDateValue(d.value).toLowerCase() ? undefined : d.label,
          icon: <Calendar size={16} strokeWidth={1.75} />,
          run: () => finish(() => insertDateMention(editor, d.value)),
        });
      }
    }
    if (pagelink && q) {
      out.push({
        key: 'create',
        group: 'New',
        title: `Create page “${q}”`,
        subtitle: 'As a sub-page of this page',
        icon: <Plus size={16} strokeWidth={2} />,
        run: () =>
          finish(() => {
            const b = currentBlock(editor.state);
            void createSubPage(editor, { title: q, open: false, link: b && isEmptyParagraph(b) ? 'pageLink' : 'mention' });
          }),
      });
    }
    return out;
  }, [hits, query, pagelink, editor, finish]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    if (hits === null) return;
    if (rows.length) misses.current = 0;
    else if (++misses.current >= 3 || query.length > 48) closeSuggest(view);
  }, [rows.length, hits, query, view]);

  useEffect(() => {
    registerSuggestKeys(view, (e) => {
      if (e.key === 'ArrowDown') {
        lastInput.current = 'key';
        setActive((a) => (rows.length ? (a + 1) % rows.length : 0));
        return true;
      }
      if (e.key === 'ArrowUp') {
        lastInput.current = 'key';
        setActive((a) => (rows.length ? (a - 1 + rows.length) % rows.length : 0));
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const r = rows[active];
        if (!r) return false;
        r.run();
        return true;
      }
      return false;
    });
    return () => registerSuggestKeys(view, null);
  }, [view, rows, active]);

  const anchor = useCallback(() => {
    try {
      const c = view.coordsAtPos(state.from);
      return { x: c.left, y: c.top, width: 1, height: c.bottom - c.top };
    } catch {
      return null;
    }
  }, [view, state.from]);

  let last = '';
  return (
    <Floating open anchor={anchor} context={view.dom} passive className="emp-slash emp-mention-menu" role="listbox" ariaLabel={pagelink ? 'Link to page' : 'Mention'} maxHeight={360}>
      <div className="emp-slash-list" onMouseMove={() => (lastInput.current = 'mouse')}>
        <GlideHighlight selector='[aria-selected="true"]' tone="slab" attributes={['aria-selected']} />
        {hits === null ? <div className="emp-slash-empty">Searching…</div> : null}
        {hits !== null && !rows.length ? <div className="emp-slash-empty">No matches</div> : null}
        {rows.map((r, i) => {
          const header = r.group !== last ? r.group : null;
          last = r.group;
          return (
            <Fragment key={r.key}>
              {header ? <div className="emp-menu-header emp-slash-header">{header}</div> : null}
              <div
                role="option"
                aria-selected={i === active}
                className={cn('emp-mention-item', i === active && 'is-active')}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => lastInput.current === 'mouse' && setActive(i)}
                onClick={() => r.run()}
              >
                <span className="emp-mention-item-icon">{r.icon}</span>
                <span className="emp-mention-item-text">
                  <span className="emp-mention-item-title">{r.title}</span>
                  {r.subtitle ? <span className="emp-mention-item-sub">{r.subtitle}</span> : null}
                </span>
                {i === active ? <CornerDownLeft className="emp-slash-enter" size={13} /> : null}
              </div>
            </Fragment>
          );
        })}
      </div>
    </Floating>
  );
}
