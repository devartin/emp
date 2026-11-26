/** Find & replace bar (§7.9): ⌘F find, ⌘⌥F replace; ↵ / ⇧↵ next / previous; Aa and whole-word toggles. */
import type { Editor } from '@tiptap/core';
import { m } from 'motion/react';
import { ChevronDown, ChevronUp, Replace, X } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { cn } from '@/lib/cn';
import { Tooltip } from '@/ui/Tooltip';
import { spring } from '@/ui/motion/tokens';
import { findStep, getFind, replaceAll, replaceCurrent, revealCurrent, setFind } from '../extensions/findReplace';

export function FindBar({ editor, replace: replaceInit, onClose, focusToken }: { editor: Editor; replace: boolean; onClose: () => void; focusToken: number }) {
  const view = editor.view;
  const st = useSyncExternalStore(
    (fn) => {
      editor.on('transaction', fn);
      return () => editor.off('transaction', fn);
    },
    () => getFind(view.state),
  );
  const [showReplace, setShowReplace] = useState(replaceInit);
  const [replacement, setReplacement] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const sel = view.state.selection;
    const initial = !sel.empty && sel.$from.parent === sel.$to.parent ? view.state.doc.textBetween(sel.from, sel.to) : st.query;
    setFind(view, { open: true, query: initial.slice(0, 200) });
    return () => setFind(view, { open: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);
  useEffect(() => {
    setShowReplace((r) => r || replaceInit);
    input.current?.focus();
    input.current?.select();
  }, [focusToken, replaceInit]);

  const count = st.matches.length;
  const label = st.query ? (count ? `${st.index + 1} of ${count}` : 'No results') : '';
  const close = () => {
    onClose();
    editor.commands.focus();
  };
  return (
    <m.div
      className="emp-find"
      role="search"
      initial={{ opacity: 0, y: -6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1, transition: spring.ui }}
      exit={{ opacity: 0, y: -4, transition: { duration: 0.1 } }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          close();
        }
      }}
    >
      <div className="emp-find-row">
        <div className="emp-find-field">
          <input
            ref={input}
            className="emp-find-input"
            placeholder="Find in page"
            value={st.query}
            spellCheck={false}
            onChange={(e) => setFind(view, { query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (!count) return;
                if (st.matches.length && view.state.selection.from !== st.matches[st.index]?.from) revealCurrent(view);
                else findStep(view, e.shiftKey ? -1 : 1);
              }
            }}
            aria-label="Find"
          />
          <span className={cn('emp-find-count', st.query && !count && 'is-none')} aria-live="polite">
            {label}
          </span>
          <Tooltip content="Match case">
            <button type="button" className="emp-find-toggle" data-active={st.caseSensitive ? '' : undefined} aria-pressed={st.caseSensitive} onClick={() => setFind(view, { caseSensitive: !st.caseSensitive })}>
              Aa
            </button>
          </Tooltip>
          <Tooltip content="Whole word">
            <button type="button" className="emp-find-toggle emp-find-ww" data-active={st.wholeWord ? '' : undefined} aria-pressed={st.wholeWord} onClick={() => setFind(view, { wholeWord: !st.wholeWord })}>
              ab
            </button>
          </Tooltip>
        </div>
        <Tooltip content="Previous" shortcut="shift+enter">
          <button type="button" className="emp-find-btn" disabled={!count} onClick={() => findStep(view, -1)} aria-label="Previous match">
            <ChevronUp size={15} />
          </button>
        </Tooltip>
        <Tooltip content="Next" shortcut="enter">
          <button type="button" className="emp-find-btn" disabled={!count} onClick={() => findStep(view, 1)} aria-label="Next match">
            <ChevronDown size={15} />
          </button>
        </Tooltip>
        {editor.isEditable ? (
          <Tooltip content="Replace" shortcut="mod+alt+f">
            <button type="button" className="emp-find-btn" data-active={showReplace ? '' : undefined} onClick={() => setShowReplace((s) => !s)} aria-label="Toggle replace">
              <Replace size={15} />
            </button>
          </Tooltip>
        ) : null}
        <button type="button" className="emp-find-btn" onClick={close} aria-label="Close find">
          <X size={15} />
        </button>
      </div>
      {showReplace && editor.isEditable ? (
        <div className="emp-find-row">
          <div className="emp-find-field">
            <input
              className="emp-find-input"
              placeholder="Replace with"
              value={replacement}
              spellCheck={false}
              onChange={(e) => setReplacement(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (e.metaKey || e.ctrlKey) replaceAll(view, replacement);
                  else replaceCurrent(view, replacement);
                }
              }}
              aria-label="Replace with"
            />
          </div>
          <button type="button" className="emp-find-action" disabled={!count} onClick={() => replaceCurrent(view, replacement)}>
            Replace
          </button>
          <button type="button" className="emp-find-action" disabled={!count} onClick={() => replaceAll(view, replacement)}>
            Replace all
          </button>
        </div>
      ) : null}
    </m.div>
  );
}
