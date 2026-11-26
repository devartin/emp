/**
 * Floating panel anchored to a virtual rect (caret, selection, node view control). floating-ui flip/shift, fixed
 * strategy, glass-1, origin-aware motion (§5.4.1: scale .96 → 1 and 4px toward the anchor on the glide spring; exit
 * 100ms ease-in). The slash menu's anchor is the caret, so it grows from the caret (S22).
 * Closes on outside pointer down and Esc when `onClose` is given.
 */
import { autoUpdate, flip, offset, shift, size, useFloating, type Placement } from '@floating-ui/react';
import { AnimatePresence, m } from 'motion/react';
import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { ease, spring } from '@/ui/motion/tokens';

export type RectLike = { x: number; y: number; width: number; height: number };

export interface FloatingProps {
  open: boolean;
  /** Static rect or a function re-evaluated on scroll/resize. */
  anchor: RectLike | (() => RectLike | null) | null;
  /** Element whose scroll containers should update the position. */
  context?: Element | null;
  placement?: Placement;
  offsetPx?: number;
  onClose?: () => void;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
  /** Don't steal focus / close on outside clicks (suggestion menus driven by the editor). */
  passive?: boolean;
  maxHeight?: number;
  role?: string;
  ariaLabel?: string;
  zIndex?: number;
  /** Keep the panel at least this wide. */
  minWidth?: number;
}

function toDomRect(r: RectLike): DOMRect {
  return new DOMRect(r.x, r.y, r.width, r.height);
}

export function Floating({ open, anchor, context, placement = 'bottom-start', offsetPx = 6, onClose, className, style, children, passive, maxHeight = 480, role, ariaLabel, zIndex = 40, minWidth }: FloatingProps) {
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const { refs, floatingStyles, placement: final, isPositioned } = useFloating({
    open,
    placement,
    strategy: 'fixed',
    middleware: [
      offset(offsetPx),
      flip({ padding: 8, fallbackAxisSideDirection: 'end' }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableHeight, elements }) {
          elements.floating.style.maxHeight = `${Math.max(120, Math.min(maxHeight, availableHeight))}px`;
        },
      }),
    ],
    whileElementsMounted: (ref, floating, update) => autoUpdate(ref, floating, update, { animationFrame: false }),
  });

  useLayoutEffect(() => {
    if (!open) return;
    refs.setPositionReference({
      getBoundingClientRect: () => {
        const a = anchorRef.current;
        const r = typeof a === 'function' ? a() : a;
        return toDomRect(r ?? { x: 0, y: 0, width: 0, height: 0 });
      },
      contextElement: context ?? undefined,
    });
  }, [open, refs, context]);

  useEffect(() => {
    if (!open || passive || !onClose) return;
    const down = (e: PointerEvent) => {
      const f = refs.floating.current;
      if (f && e.target instanceof Node && f.contains(e.target)) return;
      if ((e.target as HTMLElement | null)?.closest?.('[data-floating-keep]')) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [open, passive, onClose, refs]);

  const side = final.split('-')[0];
  const origin = `${side === 'top' ? 'bottom' : side === 'bottom' ? 'top' : 'center'} ${final.endsWith('end') ? 'right' : 'left'}`;

  return createPortal(
    <AnimatePresence>
      {open ? (
        <div ref={refs.setFloating} style={{ ...floatingStyles, zIndex, minWidth, opacity: isPositioned ? undefined : 0 }} role={role} aria-label={ariaLabel} data-floating-keep="">
          <m.div
            className={cn('emp-floating', className)}
            style={{ transformOrigin: origin, ...style }}
            initial={{ opacity: 0, scale: 0.96, y: side === 'top' ? 4 : side === 'bottom' ? -4 : 0, x: side === 'left' ? 4 : side === 'right' ? -4 : 0 }}
            animate={{ opacity: 1, scale: 1, y: 0, x: 0, transition: { ...spring.glide, opacity: { duration: 0.12, ease: [...ease.out] as [number, number, number, number] } } }}
            exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.1, ease: [...ease.in] as [number, number, number, number] } }}
          >
            {children}
          </m.div>
        </div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
