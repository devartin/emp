/**
 * Slash menu (§5.6, §7.5): 320 wide, 44px items with a 32px icon tile, title + description, groups in order, fuzzy
 * matching with matched characters at weight 600, recently used first, animated highlight, keyboard navigation
 * (↑/↓, Enter, Tab cycles groups, Esc leaves the text), closes after 3 keystrokes with no match or a space after them.
 * Second-level lists: Turn into…, Color…, Linked view (database picker), Move to… (page picker).
 */
import type { Editor } from '@tiptap/core';
import { m } from 'motion/react';
import { ArrowLeft, CornerDownLeft, Database, FileText, Search } from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '@/backend';
import type { Icon as PageIconT, SearchHit } from '@/backend/types';
import { cn } from '@/lib/cn';
import { Kbd } from '@/ui/Kbd';
import { spring } from '@/ui/motion/tokens';
import { TURN_INTO, currentTarget } from '../lib/blockTypes';
import { currentBlock, turnInto } from '../lib/blocks';
import { insertLinkedDatabase, moveBlocksToPage } from '../lib/editorCommands';
import { fuzzyItem } from '../lib/fuzzy';
import { closeSuggest, consumeSuggest, registerSuggestKeys, type SuggestState } from '../extensions/suggest';
import { Floating } from './Floating';
import { pushSlashRecent, SLASH_GROUPS, SLASH_ITEMS, slashRecent, type SlashItem } from './slashItems';

interface Row {
  key: string;
  title: string;
  description?: string;
  icon: ReactNode;
  group: string;
  indices: number[];
  shortcut?: string;
  active?: boolean;
  run: () => void;
}

function Highlighted({ text, indices }: { text: string; indices: number[] }) {
  if (!indices.length) return <>{text}</>;
  const set = new Set(indices);
  const parts: ReactNode[] = [];
  let buf = '';
  let on = false;
  const flush = (i: number) => {
    if (!buf) return;
    parts.push(on ? <b key={i}>{buf}</b> : <Fragment key={i}>{buf}</Fragment>);
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    if (hit !== on) {
      flush(i);
      on = hit;
    }
    buf += text[i];
  }
  flush(text.length);
  return <>{parts}</>;
}

function Tile({ children, swatch }: { children?: ReactNode; swatch?: SlashItem['swatch'] }) {
  if (swatch) {
    const c = swatch.color;
    return (
      <span
        className="emp-slash-tile"
        data-swatch={swatch.kind}
        style={
          swatch.kind === 'text'
            ? { color: c ? `var(--block-${c}-text)` : 'var(--text-primary)' }
            : { background: c ? `var(--block-${c}-bg)` : 'var(--bg-surface-2)', color: c ? `var(--block-${c}-text)` : 'var(--text-secondary)' }
        }
      >
        A
      </span>
    );
  }
  return <span className="emp-slash-tile">{children}</span>;
}

function pageGlyph(icon: PageIconT | undefined, kind: 'page' | 'database' = 'page') {
  if (icon?.t === 'emoji') return <span className="emp-slash-emoji">{icon.v}</span>;
  return kind === 'database' ? <Database size={18} strokeWidth={1.75} /> : <FileText size={18} strokeWidth={1.75} />;
}

type Sub = null | 'turnInto' | 'color' | 'linkedDb' | 'moveTo';

export function SlashMenu({ editor, state }: { editor: Editor; state: SuggestState }) {
  const view = editor.view;
  const query = state.query;
  const [sub, setSub] = useState<Sub>(null);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const lastInput = useRef<'key' | 'mouse'>('key');
  const listRef = useRef<HTMLDivElement>(null);
  const lastMatchLen = useRef(0);
  const reqId = useRef(0);

  // Remote lists (linked database / move to).
  useEffect(() => {
    if (sub !== 'linkedDb' && sub !== 'moveTo') return;
    const id = ++reqId.current;
    const t = setTimeout(() => {
      void api.search
        .query({ q: query, filters: { type: sub === 'linkedDb' ? ['database'] : ['page'] }, limit: 12, reqId: id })
        .then((res) => {
          if (res.reqId === reqId.current) setHits(res.hits);
        })
        .catch(() => setHits([]));
    }, 60);
    return () => clearTimeout(t);
  }, [sub, query]);

  const run = useCallback(
    (fn: () => void | Promise<void>, recentId?: string) => {
      consumeSuggest(view);
      if (recentId) pushSlashRecent(recentId);
      void Promise.resolve(fn());
    },
    [view],
  );

  const rows: Row[] = useMemo(() => {
    const q = query.trim();
    const block = currentBlock(editor.state);
    if (sub === 'turnInto') {
      const cur = block ? currentTarget(block.content) : undefined;
      return TURN_INTO.filter((t) => t.type !== '$page')
        .map((t) => ({ t, r: fuzzyItem(q, t.label) }))
        .filter((x) => x.r)
        .map(({ t, r }) => ({
          key: t.key,
          title: t.label,
          icon: <t.icon size={18} strokeWidth={1.75} />,
          group: 'Turn into',
          indices: r!.indices,
          shortcut: t.shortcut,
          active: cur?.key === t.key,
          run: () =>
            run(() => {
              const b = currentBlock(editor.state);
              if (b) turnInto(editor.state, (tr) => editor.view.dispatch(tr), [b], t);
            }),
        }));
    }
    if (sub === 'color') {
      return SLASH_ITEMS.filter((i) => i.swatch)
        .map((i) => ({ i, r: fuzzyItem(q, i.title, i.keywords) }))
        .filter((x) => x.r)
        .map(({ i, r }) => ({
          key: i.id,
          title: i.title,
          icon: <Tile swatch={i.swatch} />,
          group: i.swatch?.kind === 'text' ? 'Text colour' : 'Background',
          indices: r!.indices,
          run: () => run(() => i.run?.(editor)),
        }));
    }
    if (sub === 'linkedDb' || sub === 'moveTo') {
      return hits.map((h) => ({
        key: h.id,
        title: h.title || 'Untitled',
        description: h.path.length ? h.path.join(' / ') : undefined,
        icon: pageGlyph(h.icon, sub === 'linkedDb' ? 'database' : 'page'),
        group: sub === 'linkedDb' ? 'Databases' : 'Move to page',
        indices: [],
        run: () =>
          run(() => {
            if (sub === 'linkedDb') insertLinkedDatabase(editor, h.id);
            else {
              const b = currentBlock(editor.state);
              if (b) void moveBlocksToPage(editor, [b], h.id);
            }
          }),
      }));
    }
    const recent = slashRecent();
    const scored = SLASH_ITEMS.map((item) => {
      if (!q && item.searchOnly) return null;
      const r = fuzzyItem(q, item.title, [...(item.aliases ?? []), ...(item.keywords ?? [])]);
      return r ? { item, r } : null;
    }).filter((x): x is { item: SlashItem; r: NonNullable<ReturnType<typeof fuzzyItem>> } => !!x);
    const toRow = (item: SlashItem, indices: number[], group: string): Row => ({
      key: `${group}:${item.id}`,
      title: item.title,
      description: item.description,
      icon: item.swatch ? <Tile swatch={item.swatch} /> : <item.icon size={18} strokeWidth={1.75} />,
      group,
      indices,
      shortcut: item.shortcut,
      run: () => {
        if (item.submenu) {
          // Keep "/" and clear the query so the next keystrokes filter the second-level list.
          const s = state;
          if (s.to > s.from + 1) view.dispatch(view.state.tr.delete(s.from + 1, s.to));
          setSub(item.submenu);
          setActive(0);
          return;
        }
        run(() => item.run?.(editor), item.id);
      },
    });
    if (!q) {
      const rec = recent.map((id) => SLASH_ITEMS.find((i) => i.id === id)).filter((i): i is SlashItem => !!i);
      const out: Row[] = rec.map((i) => toRow(i, [], 'Recent'));
      for (const g of SLASH_GROUPS) for (const { item } of scored.filter((s) => s.item.group === g)) out.push(toRow(item, [], g));
      return out;
    }
    const recentBoost = (id: string) => (recent.includes(id) ? 12 - recent.indexOf(id) * 2 : 0);
    return scored
      .sort((a, b) => b.r.score + recentBoost(b.item.id) - (a.r.score + recentBoost(a.item.id)))
      .slice(0, 24)
      .map(({ item, r }) => toRow(item, r.indices, 'Best matches'));
  }, [query, sub, hits, editor, run, state, view]);

  // Close after 3 keystrokes with no match, or a space after them.
  useEffect(() => {
    if (rows.length) {
      lastMatchLen.current = query.length;
      return;
    }
    if (sub === 'linkedDb' || sub === 'moveTo') return;
    if (query.length - lastMatchLen.current >= 3 || (query.endsWith(' ') && query.length > lastMatchLen.current)) closeSuggest(view);
  }, [rows.length, query, view, sub]);

  useEffect(() => setActive(0), [query, sub]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (el && lastInput.current === 'key') el.scrollIntoView({ block: 'nearest' });
  }, [active]);

  useEffect(() => {
    registerSuggestKeys(view, (e) => {
      if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
        lastInput.current = 'key';
        setActive((a) => (rows.length ? (a + 1) % rows.length : 0));
        return true;
      }
      if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
        lastInput.current = 'key';
        setActive((a) => (rows.length ? (a - 1 + rows.length) % rows.length : 0));
        return true;
      }
      if (e.key === 'Enter') {
        const r = rows[active];
        if (!r) {
          closeSuggest(view);
          return false;
        }
        r.run();
        return true;
      }
      if (e.key === 'Tab') {
        const groups = Array.from(new Set(rows.map((r) => r.group)));
        if (groups.length < 2) return true;
        const cur = rows[active]?.group;
        const gi = (groups.indexOf(cur ?? groups[0]) + (e.shiftKey ? -1 : 1) + groups.length) % groups.length;
        setActive(rows.findIndex((r) => r.group === groups[gi]));
        lastInput.current = 'key';
        return true;
      }
      if (e.key === 'Backspace' && sub && !query) {
        setSub(null);
        return true;
      }
      if (e.key === 'ArrowLeft' && sub && !query) {
        setSub(null);
        return true;
      }
      return false;
    });
    return () => registerSuggestKeys(view, null);
  }, [view, rows, active, sub, query]);

  const anchor = useCallback(() => {
    try {
      const c = view.coordsAtPos(state.from);
      return { x: c.left, y: c.top, width: 1, height: c.bottom - c.top };
    } catch {
      return null;
    }
  }, [view, state.from]);

  let lastGroup = '';
  const title = sub === 'turnInto' ? 'Turn into' : sub === 'color' ? 'Color' : sub === 'linkedDb' ? 'Link a database' : sub === 'moveTo' ? 'Move to' : null;
  return (
    <Floating open anchor={anchor} context={view.dom} passive className="emp-slash" role="listbox" ariaLabel="Insert block" maxHeight={420}>
      {title ? (
        <div className="emp-slash-sub">
          <button type="button" className="emp-slash-back" onMouseDown={(e) => e.preventDefault()} onClick={() => setSub(null)} aria-label="Back">
            <ArrowLeft size={14} />
          </button>
          <span>{title}</span>
          {sub === 'linkedDb' || sub === 'moveTo' ? (
            <span className="emp-slash-sub-hint">
              <Search size={12} /> {query ? `“${query}”` : 'Type to search'}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="emp-slash-list" ref={listRef} onMouseMove={() => (lastInput.current = 'mouse')}>
        {rows.length === 0 ? (
          <div className="emp-slash-empty">{sub === 'linkedDb' ? 'No databases found' : sub === 'moveTo' ? 'No pages found' : 'No results'}</div>
        ) : (
          rows.map((r, i) => {
            const header = r.group !== lastGroup ? r.group : null;
            lastGroup = r.group;
            return (
              <Fragment key={r.key}>
                {header ? <div className="emp-menu-header emp-slash-header">{header}</div> : null}
                <div
                  role="option"
                  aria-selected={i === active}
                  data-index={i}
                  className={cn('emp-slash-item', i === active && 'is-active')}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => lastInput.current === 'mouse' && setActive(i)}
                  onClick={() => r.run()}
                >
                  {i === active ? <m.span layoutId={`slash-hl-${editor.instanceId}`} className="emp-slash-hl" transition={spring.snappy} /> : null}
                  {r.icon && (r.icon as { type?: unknown }).type === Tile ? r.icon : <Tile>{r.icon}</Tile>}
                  <span className="emp-slash-text">
                    <span className="emp-slash-title">
                      <Highlighted text={r.title} indices={r.indices} />
                    </span>
                    {r.description ? <span className="emp-slash-desc">{r.description}</span> : null}
                  </span>
                  {r.active ? <span className="emp-slash-check">Current</span> : null}
                  {i === active ? (
                    <CornerDownLeft className="emp-slash-enter" size={13} />
                  ) : r.shortcut ? (
                    <Kbd keys={r.shortcut} size="xs" className="emp-slash-kbd" />
                  ) : null}
                </div>
              </Fragment>
            );
          })
        )}
      </div>
      <div className="emp-slash-foot">
        <span>
          <Kbd keys="arrowup" size="xs" />
          <Kbd keys="arrowdown" size="xs" /> navigate
        </span>
        <span>
          <Kbd keys="enter" size="xs" /> insert
        </span>
        <span>
          <Kbd keys="esc" size="xs" /> close
        </span>
      </div>
    </Floating>
  );
}
