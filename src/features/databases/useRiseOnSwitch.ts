/**
 * Database view switch (docs/DESIGN.md S21): after the view area changes, the rows / cards / events that render in
 * the next ~700ms rise in with a 16ms stagger (cap 12). Items stream in as the query resolves, so a short-lived
 * MutationObserver collects them in document order; each item animates once. Nothing runs on the first mount (the
 * page entrance covers that) or under reduced motion (fx.riseStagger crossfades instead).
 */
import { useEffect, useRef, type RefObject } from 'react';
import { riseStagger } from '@/features/editor/lib/fx';

const ITEMS = '.edb-tr:not(.is-loading), .edb-card, .edb-li, .edb-cal-week, .edb-chart-body, .edb-group-head';

export function useRiseOnSwitch(ref: RefObject<HTMLElement | null>, key: string): void {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const root = ref.current;
    if (!root) return;
    let done = 0;
    let raf = 0;
    const seen = new WeakSet<Element>();
    const run = () => {
      raf = 0;
      const fresh = Array.from(root.querySelectorAll(ITEMS)).filter((el) => !seen.has(el) && !el.closest('.edb-drag-ghost'));
      if (!fresh.length) return;
      fresh.forEach((el) => seen.add(el));
      // later batches continue the cascade instead of restarting it
      riseStagger(fresh, { step: 16, cap: 12, y: 8, delay: Math.min(done, 12) * 16 });
      done += fresh.length;
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(run);
    };
    schedule();
    const mo = new MutationObserver(schedule);
    mo.observe(root, { childList: true, subtree: true });
    const stop = window.setTimeout(() => mo.disconnect(), 700);
    return () => {
      mo.disconnect();
      window.clearTimeout(stop);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
}
