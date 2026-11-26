/**
 * Selection summary (Numbers / Excel status bar): Sum, Average and Count of the selected cells, computed by the
 * engine (`sheet_eval`) so number formats and text are handled exactly like formulas would.
 */
import { AnimatePresence, m } from 'motion/react';
import { useEffect, useState } from 'react';
import { api } from '@/backend';
import { Tooltip } from '@/ui/Tooltip';
import { rectName } from './engine/addr';
import { formatValue } from './engine/numfmt';
import { useGridVersion, type GridController } from './GridController';

interface Summary {
  sum: number | null;
  avg: number | null;
  count: number;
  countA: number;
}

export function StatusBar({ ctrl }: { ctrl: GridController }) {
  useGridVersion(ctrl);
  const [sum, setSum] = useState<Summary | null>(null);
  const ranges = ctrl.sel.ranges;
  const key = `${ctrl.sheetId}|${ranges.map(rectName).join(',')}|${ctrl.dataVersion}`;
  const single = ranges.length === 1 && ranges[0].r0 === ranges[0].r1 && ranges[0].c0 === ranges[0].c1;
  const refs = ranges.map(rectName).join(', ');
  const fmt = ctrl.activeStyle.numFmt;

  useEffect(() => {
    if (single || !ctrl.sheetId) {
      setSum(null);
      return;
    }
    let live = true;
    const t = window.setTimeout(async () => {
      try {
        const [s, c, a] = await Promise.all([
          api.sheet.eval({ sheetId: ctrl.sheetId, formula: `=SUM(${refs})` }),
          api.sheet.eval({ sheetId: ctrl.sheetId, formula: `=COUNT(${refs})` }),
          api.sheet.eval({ sheetId: ctrl.sheetId, formula: `=COUNTA(${refs})` }),
        ]);
        if (!live) return;
        const count = typeof c.value === 'number' ? c.value : 0;
        const total = typeof s.value === 'number' ? s.value : null;
        setSum({ sum: count ? total : null, avg: count && total !== null ? total / count : null, count, countA: typeof a.value === 'number' ? a.value : 0 });
      } catch {
        if (live) setSum(null);
      }
    }, 140);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, single]);

  const show = (n: number) => formatValue(n, fmt && !/[ymdhs]/i.test(fmt) ? fmt : Math.abs(n) >= 1000 ? '#,##0.00' : 'General').text;
  return (
    <div className="emp-sheet-status" aria-live="polite">
      <AnimatePresence initial={false} mode="popLayout">
        {sum && sum.countA > 0 ? (
          <m.div key="sum" className="emp-status-items" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={{ duration: 0.16 }}>
            {sum.sum !== null ? (
              <Tooltip content="Sum of the numbers in the selection">
                <span className="emp-status-item">
                  <span>Sum</span>
                  <b>{show(sum.sum)}</b>
                </span>
              </Tooltip>
            ) : null}
            {sum.avg !== null ? (
              <span className="emp-status-item">
                <span>Average</span>
                <b>{show(sum.avg)}</b>
              </span>
            ) : null}
            <span className="emp-status-item">
              <span>Count</span>
              <b>{sum.countA.toLocaleString()}</b>
            </span>
          </m.div>
        ) : (
          <m.span key="hint" className="emp-status-hint" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
            {ctrl.sheet ? `${ctrl.sheets.length} ${ctrl.sheets.length === 1 ? 'sheet' : 'sheets'}` : ''}
          </m.span>
        )}
      </AnimatePresence>
    </div>
  );
}

export default StatusBar;
