/**
 * Formula bar (§5.11: 32px, mono 13): the name box (jump to a cell / range / name, or name the selection), an fx
 * button that starts a formula with the function list open, and the input mirrored with the in-cell editor.
 */
import { ChevronDown, FunctionSquare, X, Check } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { api } from '@/backend';
import { notify } from '@/stores/toasts';
import { IconButton } from '@/ui/IconButton';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from '@/ui/Menu';
import { parseRect, splitSheetRef } from './engine/addr';
import { handleEditKey } from './CellEditor';
import { formulaSpans } from './formula';
import { acceptCompletion, FormulaAssist, useAssist, type AssistItem } from './FormulaAssist';
import { useGridVersion, type GridController } from './GridController';

export interface FormulaBarProps {
  ctrl: GridController;
  barRef: React.RefObject<HTMLTextAreaElement | null>;
}

export function FormulaBar({ ctrl, barRef }: FormulaBarProps) {
  useGridVersion(ctrl);
  const edit = ctrl.edit;
  const editingHere = !!edit && edit.origin === 'bar';
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [assist, setIndex, dismiss] = useAssist(editingHere ? edit!.text : null, edit?.caret ?? 0, ctrl.names);
  const value = edit ? edit.text : ctrl.activeInput;

  useLayoutEffect(() => {
    const ta = barRef.current;
    if (!ta) return;
    if (ta.value !== value) ta.value = value;
    if (editingHere && document.activeElement === ta && ta.selectionStart !== edit!.caret) ta.setSelectionRange(edit!.caret, edit!.caret);
  }, [value, editingHere, edit, barRef]);

  const onFocus = () => {
    if (!ctrl.edit) ctrl.beginEdit({ mode: 'edit', origin: 'bar' });
    else ctrl.setEditOrigin('bar');
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!ctrl.edit) return;
    if (handleEditKey(e, ctrl, assist, setIndex, dismiss, 'bar')) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const onInput = () => {
    const ta = barRef.current;
    if (!ta) return;
    if (!ctrl.edit) ctrl.beginEdit({ mode: 'edit', origin: 'bar', text: ta.value });
    else ctrl.setEditText(ta.value, ta.selectionStart);
  };

  const syncCaret = () => {
    const ta = barRef.current;
    const e = ctrl.edit;
    if (!ta || !e || e.origin !== 'bar') return;
    if (ta.selectionStart !== e.caret) ctrl.setEditText(ta.value, ta.selectionStart, { keepPoint: ta.selectionStart === e.point?.end });
  };

  const pick = (item: AssistItem) => {
    if (!ctrl.edit) return;
    const next = acceptCompletion(ctrl.edit.text, assist, item);
    ctrl.setEditText(next.text, next.caret);
    barRef.current?.focus();
  };

  const startFormula = () => {
    if (!ctrl.edit) ctrl.beginEdit({ mode: 'enter', text: '=' });
    else if (!ctrl.edit.text.startsWith('=')) ctrl.setEditText(`=${ctrl.edit.text}`, ctrl.edit.text.length + 1);
    ctrl.focusGrid?.();
  };

  return (
    <div className="emp-formula-bar" data-editing={edit ? '' : undefined}>
      <NameBox ctrl={ctrl} />
      <div className="emp-fbar-actions">
        {edit ? (
          <>
            <IconButton size="xs" icon={X} label="Cancel" shortcut="esc" onMouseDown={(e) => e.preventDefault()} onClick={() => ctrl.cancelEdit()} />
            <IconButton size="xs" icon={Check} label="Enter" shortcut="enter" onMouseDown={(e) => e.preventDefault()} onClick={() => void ctrl.commitEdit(null)} />
          </>
        ) : null}
        <IconButton size="xs" icon={FunctionSquare} label="Insert function" onMouseDown={(e) => e.preventDefault()} onClick={startFormula} />
      </div>
      <div ref={wrapRef} className="emp-fbar-input-wrap">
        <div className="emp-fbar-mirror" aria-hidden data-ghost={!edit && !value && ctrl.activeGhost ? '' : undefined}>
          {formulaSpans(!edit && !value && ctrl.activeGhost ? ctrl.activeGhost : value).map((s, i) => (
            <span key={i} className={s.cls} data-ref={s.ref}>
              {s.text}
            </span>
          ))}
        </div>
        <textarea
          ref={barRef}
          className="emp-fbar-input"
          aria-label="Formula bar"
          rows={1}
          spellCheck={false}
          autoComplete="off"
          onFocus={onFocus}
          onKeyDown={onKeyDown}
          onInput={onInput}
          onSelect={syncCaret}
          onKeyUp={syncCaret}
          onMouseUp={syncCaret}
          onBlur={() => {
            window.setTimeout(() => {
              const a = document.activeElement;
              if (!ctrl.edit || ctrl.edit.origin !== 'bar') return;
              if (a === barRef.current || (a && a.classList.contains('emp-cell-editor-input'))) return;
              void ctrl.commitEdit(null);
            }, 0);
          }}
        />
      </div>
      <FormulaAssist anchor={wrapRef} state={assist} open={editingHere} onPick={pick} onHover={setIndex} />
    </div>
  );
}

function NameBox({ ctrl }: { ctrl: GridController }) {
  const label = ctrl.selectionLabel;
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => setDraft(null), [label]);

  const go = async () => {
    const raw = (draft ?? '').trim();
    setDraft(null);
    if (!raw) return;
    const { sheet, ref } = splitSheetRef(raw);
    const target = sheet ? ctrl.sheets.find((s) => s.name.toLowerCase() === sheet.toLowerCase()) : ctrl.sheet;
    const rect = parseRect(ref.replace(/\$/g, ''));
    if (target && rect) {
      if (target.id !== ctrl.sheetId) await ctrl.setSheet(target.id);
      ctrl.selectRect(rect);
      ctrl.focusGrid?.();
      return;
    }
    const named = ctrl.names.find((n) => n.name.toLowerCase() === raw.toLowerCase());
    if (named) {
      const nr = splitSheetRef(named.ref);
      const sh = nr.sheet ? ctrl.sheets.find((s) => s.name.toLowerCase() === nr.sheet!.toLowerCase()) : ctrl.sheet;
      const r = parseRect(nr.ref.replace(/\$/g, ''));
      if (sh && r) {
        if (sh.id !== ctrl.sheetId) await ctrl.setSheet(sh.id);
        ctrl.selectRect(r);
        ctrl.focusGrid?.();
      }
      return;
    }
    // A new name labels the selection (Excel's name box behaviour).
    if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(raw)) {
      const sheetName = ctrl.sheet?.name ?? 'Sheet1';
      const quoted = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(sheetName) ? sheetName : `'${sheetName.replace(/'/g, "''")}'`;
      const p = ctrl.primary;
      const abs = (r: number, c: number) => `$${ctrl.colLabel(c)}$${r + 1}`;
      const refText = p.r0 === p.r1 && p.c0 === p.c1 ? abs(p.r0, p.c0) : `${abs(p.r0, p.c0)}:${abs(p.r1, p.c1)}`;
      try {
        await api.sheet.namedRangeSet({ workbookId: ctrl.workbookId, name: raw, ref: `${quoted}!${refText}` });
        await ctrl.refreshMeta();
        notify.success(`Named ${refText.replace(/\$/g, '')} “${raw}”`, { description: 'Use the name in formulas instead of the reference.' });
      } catch (e) {
        notify.fromError(e, 'Couldn’t name the range');
      }
      ctrl.focusGrid?.();
      return;
    }
    notify.warning('That isn’t a cell, range or name', { description: 'Try B12, A1:C9, Sheet2!A1 or a named range.' });
  };

  return (
    <div className="emp-sheet-namebox">
      <input
        ref={inputRef}
        className="emp-namebox-input"
        aria-label="Name box"
        value={draft ?? label}
        onFocus={(e) => {
          setDraft(label);
          requestAnimationFrame(() => e.target.select());
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void go();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setDraft(null);
            ctrl.focusGrid?.();
          }
        }}
      />
      {ctrl.names.length ? (
        <Menu>
          <MenuTrigger asChild>
            <button type="button" className="emp-namebox-menu" aria-label="Named ranges">
              <ChevronDown size={12} aria-hidden />
            </button>
          </MenuTrigger>
          <MenuContent width={260}>
            <MenuLabel>Named ranges</MenuLabel>
            {ctrl.names.map((n) => (
              <MenuItem
                key={n.name}
                trailing={<span className="emp-namebox-ref">{n.ref}</span>}
                onSelect={() => {
                  setDraft(n.name);
                  queueMicrotask(() => {
                    const nr = splitSheetRef(n.ref);
                    const sh = nr.sheet ? ctrl.sheets.find((s) => s.name.toLowerCase() === nr.sheet!.toLowerCase()) : ctrl.sheet;
                    const r = parseRect(nr.ref.replace(/\$/g, ''));
                    if (!sh || !r) return;
                    void (async () => {
                      if (sh.id !== ctrl.sheetId) await ctrl.setSheet(sh.id);
                      ctrl.selectRect(r);
                      ctrl.focusGrid?.();
                    })();
                  });
                }}
              >
                {n.name}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      ) : null}
    </div>
  );
}

export default FormulaBar;
