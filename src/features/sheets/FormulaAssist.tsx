/**
 * Formula assist popup shared by the cell editor and the formula bar: function / name autocomplete while typing an
 * identifier, otherwise signature help for the call around the caret. Rendered in a portal, anchored to the editor.
 */
import { AnimatePresence, m } from 'motion/react';
import { FunctionSquare, Tag } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { SheetFunctionInfo } from '@/backend/types';
import { cn } from '@/lib/cn';
import { GlideHighlight } from '@/ui/GlideHighlight';
import { Kbd } from '@/ui/Kbd';
import { transitions } from '@/ui/motion/presets';
import { callAt, cachedFunctions, completionAt, loadFunctions, rankFunctions } from './formula';
import { FunctionHelp } from './FunctionHelp';

export interface AssistItem {
  kind: 'fn' | 'name';
  name: string;
  info?: SheetFunctionInfo;
}

export interface AssistState {
  items: AssistItem[];
  index: number;
  ctx: { start: number; end: number; prefix: string } | null;
  call: { info: SheetFunctionInfo; argIndex: number } | null;
}

/** Computes completions / call help for text + caret. `dismissed` hides the list for one prefix (Esc). */
export function useAssist(text: string | null, caret: number, names: { name: string }[]): [AssistState, (i: number) => void, (dismiss: boolean) => void] {
  const [fns, setFns] = useState<SheetFunctionInfo[] | null>(() => cachedFunctions());
  const [index, setIndex] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  useEffect(() => {
    if (fns || text === null || !text.startsWith('=')) return;
    let live = true;
    void loadFunctions()
      .then((list) => live && setFns(list))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [fns, text]);
  const state = useMemo<AssistState>(() => {
    if (text === null || !text.startsWith('=') || !fns) return { items: [], index: 0, ctx: null, call: null };
    const ctx = completionAt(text, caret);
    const key = ctx ? `${ctx.start}:${ctx.prefix}` : null;
    const items = ctx && key !== dismissedAt ? rankFunctions(fns, ctx.prefix, names) : [];
    const call = callAt(text, caret);
    const info = call ? fns.find((f) => f.name === call.name) : undefined;
    return { items, index: Math.min(index, Math.max(0, items.length - 1)), ctx, call: info && call ? { info, argIndex: call.argIndex } : null };
  }, [text, caret, fns, names, index, dismissedAt]);
  useEffect(() => setIndex(0), [state.ctx?.prefix]);
  const dismiss = (on: boolean) => setDismissedAt(on && state.ctx ? `${state.ctx.start}:${state.ctx.prefix}` : null);
  return [state, setIndex, dismiss];
}

/** Applies a completion to the text. */
export function acceptCompletion(text: string, st: AssistState, item: AssistItem): { text: string; caret: number } {
  const ctx = st.ctx!;
  const insert = item.kind === 'fn' ? `${item.name}(` : item.name;
  const after = text.slice(ctx.end);
  const skipParen = item.kind === 'fn' && after.startsWith('(');
  const next = text.slice(0, ctx.start) + insert + (skipParen ? after.slice(1) : after);
  return { text: next, caret: ctx.start + insert.length };
}

export interface FormulaAssistProps {
  anchor: RefObject<HTMLElement | null>;
  state: AssistState;
  open: boolean;
  onPick: (item: AssistItem) => void;
  onHover: (i: number) => void;
}

export function FormulaAssist({ anchor, state, open, onPick, onHover }: FormulaAssistProps) {
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean; maxH: number } | null>(null);
  const showList = open && state.items.length > 0;
  const showHelp = open && !showList && !!state.call;
  useLayoutEffect(() => {
    if (!showList && !showHelp) return;
    const el = anchor.current;
    if (!el) return;
    const place = () => {
      const r = el.getBoundingClientRect();
      const below = window.innerHeight - r.bottom;
      const above = below < 240 && r.top > below;
      setPos({ left: Math.min(Math.max(8, r.left), window.innerWidth - 380), top: above ? r.top - 6 : r.bottom + 6, above, maxH: Math.max(160, (above ? r.top : below) - 24) });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener('resize', place);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [anchor, showList, showHelp, state.ctx?.start, state.call?.info.name]);
  if (typeof document === 'undefined') return null;
  const active = state.items[state.index];
  return createPortal(
    <AnimatePresence>
      {(showList || showHelp) && pos ? (
        <m.div
          key={showList ? 'list' : `help-${state.call?.info.name}`}
          className="emp-fa"
          style={pos.above ? { left: pos.left, bottom: window.innerHeight - pos.top, transformOrigin: 'bottom left' } : { left: pos.left, top: pos.top, transformOrigin: 'top left' }}
          initial={{ opacity: 0, scale: 0.97, y: pos.above ? 4 : -4 }}
          animate={{ opacity: 1, scale: 1, y: 0, transition: transitions.menuIn }}
          exit={{ opacity: 0, transition: transitions.menuOut }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {showList ? (
            <div className="emp-fa-list-wrap glass-1">
              <ul className="emp-fa-list" role="listbox" aria-label="Functions" style={{ maxHeight: Math.min(pos.maxH, 300) }}>
                <GlideHighlight selector='[aria-selected="true"]' tone="ghost" attributes={['aria-selected']} />
                {state.items.map((it, i) => (
                  <li
                    key={`${it.kind}:${it.name}`}
                    role="option"
                    aria-selected={i === state.index}
                    style={{ ['--i' as string]: Math.min(i, 12) }}
                    className={cn('emp-fa-item', i === state.index && 'is-active')}
                    onMouseEnter={() => onHover(i)}
                    onClick={() => onPick(it)}
                  >
                    {it.kind === 'fn' ? <FunctionSquare size={14} aria-hidden /> : <Tag size={14} aria-hidden />}
                    <span className="emp-fa-name">
                      <b>{it.name.slice(0, state.ctx?.prefix.length ?? 0)}</b>
                      {it.name.slice(state.ctx?.prefix.length ?? 0)}
                    </span>
                    <span className="emp-fa-meta">{it.kind === 'fn' ? it.info?.category : 'Named range'}</span>
                  </li>
                ))}
              </ul>
              {active?.info ? (
                <div className="emp-fa-detail">
                  <FunctionHelp info={active.info} argIndex={-1} />
                </div>
              ) : null}
              <div className="emp-fa-foot">
                <Kbd keys="arrowup" size="xs" />
                <Kbd keys="arrowdown" size="xs" />
                <span>to choose</span>
                <span className="emp-fa-dot" aria-hidden>·</span>
                <Kbd keys="tab" size="xs" />
                <span>to insert</span>
                <span className="emp-fa-dot" aria-hidden>·</span>
                <Kbd keys="esc" size="xs" />
                <span>to dismiss</span>
              </div>
            </div>
          ) : state.call ? (
            <div className="emp-fa-help glass-1">
              <FunctionHelp info={state.call.info} argIndex={state.call.argIndex} />
            </div>
          ) : null}
        </m.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
