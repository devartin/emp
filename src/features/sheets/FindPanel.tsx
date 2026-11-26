/**
 * Find & replace across the workbook (`sheet_find` / `sheet_replace`): a floating panel at the grid's top-right
 * with live results ("3 of 12"), ↵ / ⇧↵ to step, match case / whole cell / search formulas, and replace.
 */
import { AnimatePresence, m } from 'motion/react';
import { ArrowDown, ArrowUp, CaseSensitive, ChevronRight, Replace, Sigma, WholeWord, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/cn';
import { Button } from '@/ui/Button';
import { IconButton } from '@/ui/IconButton';
import { Tooltip } from '@/ui/Tooltip';
import { presets } from '@/ui/motion/presets';
import { useGridVersion, type GridController } from './GridController';

export function FindPanel({ ctrl }: { ctrl: GridController }) {
  useGridVersion(ctrl);
  const f = ctrl.find;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (f.open) requestAnimationFrame(() => inputRef.current?.select());
  }, [f.open]);

  const schedule = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void ctrl.runFind(), 140);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const toggle = (k: 'matchCase' | 'wholeCell' | 'inFormulas') => {
    ctrl.setFind({ [k]: !f[k] });
    schedule();
  };
  const n = f.results.length;
  const close = () => {
    ctrl.setFind({ open: false, results: [], index: -1 });
    ctrl.focusGrid?.();
  };
  const current = f.results[f.index];
  const elsewhere = current && current.sheetId !== ctrl.sheetId ? ctrl.sheets.find((s) => s.id === current.sheetId)?.name : null;

  return (
    <AnimatePresence>
      {f.open ? (
        <m.div className="emp-sheet-find" role="search" {...presets.menu} onKeyDown={(e) => e.key === 'Escape' && (e.preventDefault(), close())}>
          <div className="emp-find-row">
            <IconButton size="xs" icon={ChevronRight} label={f.replace ? 'Hide replace' : 'Show replace'} className={cn('emp-find-expand', f.replace && 'is-open')} onClick={() => ctrl.setFind({ replace: !f.replace })} />
            <div className="emp-find-field">
              <input
                ref={inputRef}
                className="emp-find-input"
                placeholder="Find in workbook"
                aria-label="Find"
                value={f.query}
                onChange={(e) => {
                  ctrl.setFind({ query: e.target.value });
                  schedule();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void ctrl.stepFind(e.shiftKey ? -1 : 1);
                  }
                }}
              />
              <span className="emp-find-count" aria-live="polite">
                {f.query ? (n ? `${f.index + 1} of ${n}` : f.busy ? '…' : 'No results') : ''}
              </span>
              <Tooltip content="Match case">
                <button type="button" className={cn('emp-find-opt', f.matchCase && 'is-on')} aria-pressed={f.matchCase} aria-label="Match case" onClick={() => toggle('matchCase')}>
                  <CaseSensitive size={15} aria-hidden />
                </button>
              </Tooltip>
              <Tooltip content="Whole cell">
                <button type="button" className={cn('emp-find-opt', f.wholeCell && 'is-on')} aria-pressed={f.wholeCell} aria-label="Match whole cell" onClick={() => toggle('wholeCell')}>
                  <WholeWord size={15} aria-hidden />
                </button>
              </Tooltip>
              <Tooltip content="Search formulas">
                <button type="button" className={cn('emp-find-opt', f.inFormulas && 'is-on')} aria-pressed={f.inFormulas} aria-label="Search formulas" onClick={() => toggle('inFormulas')}>
                  <Sigma size={15} aria-hidden />
                </button>
              </Tooltip>
            </div>
            <IconButton size="xs" icon={ArrowUp} label="Previous" shortcut="shift+enter" disabled={!n} onClick={() => void ctrl.stepFind(-1)} />
            <IconButton size="xs" icon={ArrowDown} label="Next" shortcut="enter" disabled={!n} onClick={() => void ctrl.stepFind(1)} />
            <IconButton size="xs" icon={X} label="Close" shortcut="esc" onClick={close} />
          </div>
          {f.replace ? (
            <div className="emp-find-row">
              <span className="emp-find-spacer" />
              <div className="emp-find-field">
                <input
                  className="emp-find-input"
                  placeholder="Replace with"
                  aria-label="Replace with"
                  value={f.replacement}
                  onChange={(e) => ctrl.setFind({ replacement: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void ctrl.replace(e.metaKey || e.ctrlKey);
                    }
                  }}
                />
              </div>
              <Button size="xs" variant="secondary" icon={Replace} disabled={!n} onClick={() => void ctrl.replace(false)}>
                Replace
              </Button>
              <Button size="xs" variant="ghost" disabled={!n} onClick={() => void ctrl.replace(true)}>
                All
              </Button>
            </div>
          ) : null}
          {elsewhere ? <div className="emp-find-note">On sheet “{elsewhere}”</div> : null}
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}

export default FindPanel;
