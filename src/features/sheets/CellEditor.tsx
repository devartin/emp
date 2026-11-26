/**
 * The in-cell editor overlay. One always-mounted textarea is the grid's keyboard target: while idle it sits
 * invisibly over the active cell (so typing, IME and clipboard events land in it); typing a character starts an
 * edit in place. While editing it grows with its content, colours references to match their grid highlights,
 * offers function autocomplete + signature help, supports point mode (arrow keys / clicks insert references) and
 * F4 to cycle `$` anchors.
 */
import { AnimatePresence, m } from 'motion/react';
import { AlertCircle } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { isMac } from '@/lib/platform';
import { transitions } from '@/ui/motion/presets';
import { formulaSpans } from './formula';
import { acceptCompletion, FormulaAssist, useAssist, type AssistItem, type AssistState } from './FormulaAssist';
import { useGridVersion, type GridController } from './GridController';
import { cycleAbsolute, handleGridKey, type GridKeyUi } from './keys';

const mod = (e: { metaKey: boolean; ctrlKey: boolean }) => (isMac ? e.metaKey : e.ctrlKey);

/**
 * Key handling shared by the cell editor and the formula bar while an edit is open. Returns true when handled.
 */
export function handleEditKey(
  e: ReactKeyboardEvent<HTMLTextAreaElement>,
  ctrl: GridController,
  assist: AssistState,
  setIndex: (i: number) => void,
  dismiss: (on: boolean) => void,
  source: 'cell' | 'bar',
): boolean {
  const edit = ctrl.edit;
  if (!edit) return false;
  const ta = e.currentTarget;
  const listOpen = assist.items.length > 0;
  if (listOpen) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const n = assist.items.length;
      setIndex((assist.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
      return true;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !mod(e) && !e.altKey)) {
      const item = assist.items[assist.index];
      if (item) {
        const next = acceptCompletion(edit.text, assist, item);
        ctrl.setEditText(next.text, next.caret);
        return true;
      }
    }
    if (e.key === 'Escape') {
      dismiss(true);
      return true;
    }
  }
  switch (e.key) {
    case 'Enter': {
      if (e.altKey || (e.ctrlKey && isMac && !e.metaKey)) {
        // Alt+Enter inserts a line break.
        const s = ta.selectionStart;
        const text = edit.text.slice(0, s) + '\n' + edit.text.slice(ta.selectionEnd);
        ctrl.setEditText(text, s + 1);
        return true;
      }
      void ctrl.commitEdit(mod(e) ? null : e.shiftKey ? 'up' : 'down', { fillSelection: mod(e) });
      return true;
    }
    case 'Tab':
      void ctrl.commitEdit(e.shiftKey ? 'left' : 'right');
      return true;
    case 'Escape':
      ctrl.cancelEdit();
      return true;
    case 'F2':
      ctrl.setEditMode(edit.mode === 'enter' ? 'edit' : 'enter');
      return true;
    case 'F4': {
      const next = cycleAbsolute(edit.text, ta.selectionStart);
      if (next) ctrl.setEditText(next.text, next.caret);
      return true;
    }
    case 'ArrowUp':
    case 'ArrowDown':
    case 'ArrowLeft':
    case 'ArrowRight': {
      if (source === 'bar' || edit.mode === 'edit') return false;
      const dr = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
      const dc = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
      if (ctrl.canPoint()) {
        ctrl.pointMove(dr, dc, e.shiftKey);
        return true;
      }
      void ctrl.commitEdit(dr > 0 ? 'down' : dr < 0 ? 'up' : dc > 0 ? 'right' : 'left');
      return true;
    }
    default:
      return false;
  }
}

export interface CellEditorProps {
  ctrl: GridController;
  ui: GridKeyUi;
  /** The grid root (for sizing limits). */
  gridRef: React.RefObject<HTMLDivElement | null>;
  barRef: React.RefObject<HTMLTextAreaElement | null>;
}

export function CellEditor({ ctrl, ui, gridRef, barRef }: CellEditorProps) {
  useGridVersion(ctrl);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const edit = ctrl.edit;
  const inCell = !!edit && edit.sheetId === ctrl.sheetId;
  const [assist, setIndex, dismiss] = useAssist(edit && edit.origin === 'cell' ? edit.text : null, edit?.caret ?? 0, ctrl.names);

  // Grid size, cached from a ResizeObserver so placing never reads layout (it runs on every overlay paint, i.e.
  // every frame of the selection glide).
  const gridSize = useRef<{ w: number; h: number } | null>(null);
  // Last written geometry: skip the style writes when nothing moved.
  const placed = useRef('');

  // Position over the active / edited cell; follows scrolling without React renders.
  const place = useCallback(() => {
    const wrap = wrapRef.current;
    const grid = gridRef.current;
    if (!wrap || !grid) return;
    const e = ctrl.edit;
    const pos = e && e.sheetId === ctrl.sheetId ? { r: e.r, c: e.c } : ctrl.active;
    const mg = ctrl.mergeAt(pos.r, pos.c);
    const rect = mg ?? { r0: pos.r, c0: pos.c, r1: pos.r, c1: pos.c };
    const l = ctrl.layout();
    const rp = ctrl.rectPx(rect, l);
    const size = gridSize.current ?? (gridSize.current = { w: grid.clientWidth, h: grid.clientHeight });
    const gw = size.w;
    const gh = size.h;
    // Hide while the cell is scrolled under the headers.
    const hidden = !!e && (rp.x + rp.w < l.headerW || rp.y + rp.h < l.headerH || rp.x > gw || rp.y > gh);
    const x = Math.round(rp.x);
    const y = Math.round(rp.y);
    const key = `${x},${y},${rp.w},${rp.h},${gw},${gh},${hidden ? 1 : 0}`;
    if (key === placed.current) return;
    placed.current = key;
    const st = wrap.style;
    st.transform = `translate(${x}px, ${y}px)`;
    st.minWidth = `${Math.max(24, rp.w + 1)}px`;
    st.minHeight = `${Math.max(16, rp.h + 1)}px`;
    st.maxWidth = `${Math.max(rp.w + 1, gw - rp.x - 8)}px`;
    st.maxHeight = `${Math.max(rp.h + 1, gh - rp.y - 8)}px`;
    st.visibility = hidden ? 'hidden' : '';
  }, [ctrl, gridRef]);

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const ro = new ResizeObserver(() => {
      gridSize.current = { w: grid.clientWidth, h: grid.clientHeight };
      place();
    });
    ro.observe(grid);
    return () => ro.disconnect();
  }, [gridRef, place]);

  useLayoutEffect(() => {
    place();
    return ctrl.onPaint((layer) => {
      if (layer === 'overlay') place();
    });
  }, [ctrl, place]);
  useLayoutEffect(place);

  // Register as the grid's keyboard target.
  useEffect(() => {
    ctrl.focusGrid = () => taRef.current?.focus({ preventScroll: true });
    return () => {
      ctrl.focusGrid = null;
    };
  }, [ctrl]);

  // Controller → textarea (point mode, autocomplete, programmatic edits).
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    if (!edit) {
      if (ta.value) ta.value = '';
      return;
    }
    if (ta.value !== edit.text) ta.value = edit.text;
    if (document.activeElement === ta && (ta.selectionStart !== edit.caret || ta.selectionEnd !== edit.caret) && edit.origin === 'cell') {
      ta.setSelectionRange(edit.caret, edit.caret);
    }
    if (edit.origin === 'cell' && document.activeElement !== ta) ta.focus({ preventScroll: true });
  }, [edit]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!ctrl.edit) {
      if (handleGridKey(e, ctrl, ui)) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (handleEditKey(e, ctrl, assist, setIndex, dismiss, 'cell')) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const syncCaret = () => {
    const ta = taRef.current;
    const e = ctrl.edit;
    if (!ta || !e || e.origin !== 'cell') return;
    if (ta.selectionStart !== e.caret) ctrl.setEditText(ta.value, ta.selectionStart, { keepPoint: ta.selectionStart === e.point?.end });
  };

  const onInput = () => {
    const ta = taRef.current;
    if (!ta) return;
    if (!ctrl.edit) {
      if (!ta.value) return;
      ctrl.beginEdit({ mode: 'enter', text: ta.value });
      return;
    }
    ctrl.setEditText(ta.value, ta.selectionStart);
  };

  const onBlur = () => {
    window.setTimeout(() => {
      const a = document.activeElement;
      if (!ctrl.edit || a === taRef.current || a === barRef.current) return;
      if (a && (a.closest('.emp-fa') || a.closest('.emp-sheet-namebox'))) return;
      if (a && a.closest('.emp-wb-footer') && ctrl.canPoint()) return;
      void ctrl.commitEdit(null);
    }, 0);
  };

  const pick = (item: AssistItem) => {
    if (!ctrl.edit) return;
    const next = acceptCompletion(ctrl.edit.text, assist, item);
    ctrl.setEditText(next.text, next.caret);
    taRef.current?.focus();
  };

  const spans = edit ? formulaSpans(edit.text) : [];
  return (
    <>
      <div ref={wrapRef} className="emp-cell-editor" data-editing={inCell ? '' : undefined} data-mode={edit?.mode}>
        {inCell ? (
          <div className="emp-cell-editor-mirror" aria-hidden>
            {spans.map((s, i) => (
              <span key={i} className={s.cls} data-ref={s.ref}>
                {s.text}
              </span>
            ))}
            {/* keeps a trailing newline measurable */}
            <span>{'​'}</span>
          </div>
        ) : null}
        <textarea
          ref={taRef}
          className="emp-cell-editor-input"
          aria-label={inCell ? `Editing ${ctrl.selectionLabel}` : `Cell ${ctrl.selectionLabel}`}
          aria-describedby={edit?.error ? 'emp-cell-editor-error' : undefined}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          wrap="soft"
          rows={1}
          onKeyDown={onKeyDown}
          onInput={onInput}
          onSelect={syncCaret}
          onKeyUp={syncCaret}
          onMouseUp={syncCaret}
          onBlur={onBlur}
          onCopy={(e) => {
            if (ctrl.edit) return;
            ctrl.onCopy(e.nativeEvent, false);
          }}
          onCut={(e) => {
            if (ctrl.edit) return;
            ctrl.onCopy(e.nativeEvent, true);
          }}
          onPaste={(e) => {
            if (ctrl.edit) return;
            e.preventDefault();
            const text = e.clipboardData.getData('text/plain');
            const html = e.clipboardData.getData('text/html');
            void ctrl.pasteText(text, html || undefined);
          }}
          onCompositionStart={() => {
            if (!ctrl.edit) ctrl.beginEdit({ mode: 'enter', text: '' });
          }}
        />
        <AnimatePresence>
          {inCell && edit?.error ? (
            <m.div
              id="emp-cell-editor-error"
              className="emp-cell-editor-error"
              role="alert"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0, transition: transitions.menuIn }}
              exit={{ opacity: 0, transition: transitions.menuOut }}
            >
              <AlertCircle size={14} aria-hidden />
              {edit.error}
            </m.div>
          ) : null}
        </AnimatePresence>
      </div>
      <FormulaAssist anchor={wrapRef} state={assist} open={inCell && edit?.origin === 'cell'} onPick={pick} onHover={setIndex} />
    </>
  );
}

export default CellEditor;
