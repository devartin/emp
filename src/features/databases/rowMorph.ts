/**
 * Row open morph (docs/DESIGN.md S9, "row open as shared-element peek"). The side peek is a sliding sheet and the
 * full row page is a separate lazy route, so instead of a View Transition the row's title is FLIP-ed: the view that
 * opens a row records where its title was (`markRowOrigin`), and RowPage, once its title has rendered, plays that
 * title from the source rect/size into place on the `morph` spring (`playRowMorph`). If the sheet is still sliding,
 * the title's path blends into the sheet's motion. Transform only; skipped under reduced motion.
 */
import type { Id } from '@/backend/types';
import { isReducedMotion } from '@/ui/motion/useReducedEffects';
import { springEase } from '@/features/editor/lib/fx';

interface Origin {
  rowId: Id;
  rect: DOMRect;
  fontPx: number;
  at: number;
}

let pending: Origin | null = null;
let lastPointerTarget: Element | null = null;

/** Call from a pointerdown (capture) on the database root so `openRow` knows which row element was clicked. */
export function notePointer(target: EventTarget | null): void {
  lastPointerTarget = target instanceof Element ? target : null;
}

const TITLE_SEL = '.edb-title-text, .edb-card-title-text, .edb-li-title, .edb-ev-title, .edb-ev';
const ROW_SEL = '.edb-tr, .edb-card, .edb-li, .edb-ev';

/** Remember the title element of the row about to open (from the last pointer target, else the focused element). */
export function markRowOrigin(rowId: Id): void {
  pending = null;
  if (isReducedMotion()) return;
  const from = (lastPointerTarget?.isConnected ? lastPointerTarget : null) ?? document.activeElement;
  const rowEl = from?.closest(ROW_SEL);
  const title = rowEl?.querySelector<HTMLElement>(TITLE_SEL) ?? (rowEl instanceof HTMLElement && rowEl.matches('.edb-ev') ? rowEl : null);
  if (!title) return;
  const rect = title.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  pending = { rowId, rect, fontPx: parseFloat(getComputedStyle(title).fontSize) || 13, at: performance.now() };
}

export function hasRowOrigin(rowId: Id): boolean {
  return !!pending && pending.rowId === rowId && performance.now() - pending.at < 1600;
}

/** Plays the title morph into `title` (and lifts `rest` in after 80ms). Consumes the origin. */
export function playRowMorph(rowId: Id, title: HTMLElement | null, rest: HTMLElement[] = []): boolean {
  const o = pending;
  pending = null;
  if (!o || o.rowId !== rowId || !title || performance.now() - o.at > 1600 || isReducedMotion()) return false;
  const r = title.getBoundingClientRect();
  const fontPx = parseFloat(getComputedStyle(title).fontSize) || 30;
  const s = Math.max(0.2, Math.min(1.5, o.fontPx / fontPx));
  // align the text baselines: both boxes start at their first line's top-left
  const dx = o.rect.left - r.left;
  const dy = o.rect.top + o.rect.height / 2 - (r.top + (fontPx * 1.27 * s) / 2);
  const m = springEase('morph');
  title.animate(
    [
      { transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${s.toFixed(3)})`, transformOrigin: '0 0', opacity: 0.9 },
      { transform: 'none', transformOrigin: '0 0', opacity: 1 },
    ],
    { duration: m.duration + 60, easing: m.easing },
  );
  const settle = springEase('settle');
  rest.slice(0, 8).forEach((el, i) =>
    el.animate([{ opacity: 0, translate: '0 10px' }, { opacity: 1, translate: '0 0' }], { duration: settle.duration, easing: settle.easing, delay: 80 + i * 40, fill: 'backwards' }),
  );
  return true;
}
