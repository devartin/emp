/**
 * Grid keyboard map (§8.7 Sheets + Excel conventions), used while the grid has focus and no edit is in progress.
 */
import { isMac } from '@/lib/platform';
import { cellName, MAX_COLS, MAX_ROWS } from './engine/addr';
import type { GridController } from './GridController';

export interface GridKeyUi {
  openFind(replace?: boolean): void;
  openFormatMenu?(): void;
}

const mod = (e: KeyboardEvent | React.KeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey);

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Returns true when the key was handled (the caller prevents the default). */
export function handleGridKey(e: React.KeyboardEvent, ctrl: GridController, ui: GridKeyUi): boolean {
  const m = mod(e);
  const k = e.key;
  const shift = e.shiftKey;
  if (e.nativeEvent.isComposing) return false;
  switch (k) {
    case 'ArrowUp':
    case 'ArrowDown':
    case 'ArrowLeft':
    case 'ArrowRight': {
      const dr = k === 'ArrowUp' ? -1 : k === 'ArrowDown' ? 1 : 0;
      const dc = k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0;
      if (m) ctrl.jump(dr, dc, shift);
      else ctrl.move(dr, dc, shift);
      return true;
    }
    case 'Enter':
      if (m) {
        void ctrl.fillDown();
        return true;
      }
      ctrl.advance(shift ? 'up' : 'down');
      return true;
    case 'Tab':
      ctrl.advance(shift ? 'left' : 'right');
      return true;
    case 'Home':
      if (m) ctrl.select({ r: 0, c: 0 });
      else ctrl.select({ r: ctrl.active.r, c: ctrl.frozen.cols && ctrl.active.c >= ctrl.frozen.cols ? 0 : 0 });
      return true;
    case 'End':
      if (m) ctrl.select({ r: ctrl.sheet?.maxRow ?? 0, c: ctrl.sheet?.maxCol ?? 0 });
      else ctrl.jump(0, 1, shift);
      return true;
    case 'PageDown':
      ctrl.pageMove(1, shift);
      return true;
    case 'PageUp':
      ctrl.pageMove(-1, shift);
      return true;
    case 'F2':
      ctrl.beginEdit({ mode: 'edit' });
      return true;
    case 'Delete':
      void ctrl.clear('contents');
      return true;
    case 'Backspace':
      if (m) return false;
      void ctrl.clear('contents');
      return true;
    case 'Escape':
      if (ctrl.marquee) {
        ctrl.clearMarquee();
        return true;
      }
      if (ctrl.find.open) {
        ctrl.setFind({ open: false });
        return true;
      }
      return false;
    case ' ':
      if (shift && !m) {
        ctrl.selectRows(ctrl.active.r, ctrl.active.r);
        return true;
      }
      if (e.ctrlKey && !shift) {
        ctrl.selectCols(ctrl.active.c, ctrl.active.c);
        return true;
      }
      return false;
    default:
      break;
  }
  if (!m) return false;
  const key = k.length === 1 ? k.toLowerCase() : k;
  switch (key) {
    case 'a':
      ctrl.selectAll();
      return true;
    case 'b':
      void ctrl.toggleFont('b');
      return true;
    case 'i':
      void ctrl.toggleFont('i');
      return true;
    case 'u':
      void ctrl.toggleFont('u');
      return true;
    case 'z':
      if (shift) void ctrl.redo();
      else void ctrl.undo();
      return true;
    case 'y':
      void ctrl.redo();
      return true;
    case 'd':
      void ctrl.fillDown();
      return true;
    case 'r':
      void ctrl.fillRight();
      return true;
    case 'f':
      if (shift) return false;
      ui.openFind(false);
      return true;
    case 'h':
      if (isMac) return false;
      ui.openFind(true);
      return true;
    case ';':
      ctrl.beginEdit({ mode: 'enter', text: shift ? new Date().toTimeString().slice(0, 5) : today() });
      return true;
    case '1':
      if (!shift) return false;
      void ctrl.setNumFmt('#,##0.00');
      return true;
    case '4':
    case '$':
      if (!shift) return false;
      void ctrl.setNumFmt('$#,##0.00');
      return true;
    case '5':
    case '%':
      if (!shift) return false;
      void ctrl.setNumFmt('0%');
      return true;
    case '\\':
      return false;
    default:
      return false;
  }
}

/** F4 on a reference under the caret cycles A1 → $A$1 → A$1 → $A1. */
export function cycleAbsolute(text: string, caret: number): { text: string; caret: number } | null {
  const re = /(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const s = m.index;
    const e = s + m[0].length;
    if (caret < s || caret > e) continue;
    const colAbs = !!m[1];
    const rowAbs = !!m[3];
    const next = !colAbs && !rowAbs ? ['$', '$'] : colAbs && rowAbs ? ['', '$'] : !colAbs && rowAbs ? ['$', ''] : ['', ''];
    const rep = `${next[0]}${m[2]}${next[1]}${m[4]}`;
    return { text: text.slice(0, s) + rep + text.slice(e), caret: s + rep.length };
  }
  return null;
}

export const GRID_LIMITS = { rows: MAX_ROWS, cols: MAX_COLS, name: cellName };
