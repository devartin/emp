/**
 * Read-only spreadsheet range embedded in a document (`sheetEmbed` block, §7.1). Renders the range as a real table
 * (selectable, accessible) with the workbook's formats, fills, conditional formats and data bars, and stays live
 * through `sheet:changed`. "Open" jumps to the sheet.
 */
import { ArrowUpRight, Sheet as SheetIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { navigate } from '@/app/router';
import { api, errorMessage, listen } from '@/backend';
import type { CellStyle, Id, Rect, SheetMeta } from '@/backend/types';
import { useTree } from '@/stores/tree';
import { Button } from '@/ui/Button';
import { Skeleton } from '@/ui/Skeleton';
import { useRootAttr } from '@/ui/motion/useReducedEffects';
import { cellKey, colName, parseRect, rectName, splitSheetRef } from './engine/addr';
import { adaptFill, adaptText } from './GridCanvas';

export interface SheetEmbedProps {
  pageId: Id;
  sheetId?: Id;
  range?: string;
}

interface Loaded {
  sheet: SheetMeta;
  rect: Rect;
  styles: Record<number, CellStyle>;
  cells: Map<number, { d: string; k: number; s: number; cf?: number; bar?: number; barStyle?: number }>;
  merges: Rect[];
  widths: Map<number, number>;
}

const MAX_ROWS_EMBED = 200;
const MAX_COLS_EMBED = 26;

export default function SheetEmbed({ pageId, sheetId, range }: SheetEmbedProps) {
  const title = useTree((s) => s.byId.get(pageId)?.title);
  const theme = useRootAttr('data-theme');
  const dark = theme === 'dark' || theme === 'midnight';
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let timer: number | undefined;
    const off = listen('sheet:changed', (e) => {
      if (e.workbookId !== pageId) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setTick((n) => n + 1), 250);
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, [pageId]);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const wb = await api.sheet.workbookGet({ id: pageId });
        const parsed = range ? splitSheetRef(range) : null;
        const byName = parsed?.sheet ? wb.sheets.find((s) => s.name.toLowerCase() === parsed.sheet!.toLowerCase()) : undefined;
        const sheet = byName ?? wb.sheets.find((s) => s.id === sheetId) ?? wb.sheets.find((s) => !s.hidden) ?? wb.sheets[0];
        if (!sheet) throw new Error('This workbook has no sheets');
        let rect = parsed ? parseRect(parsed.ref.replace(/\$/g, '')) : null;
        if (!rect) rect = { r0: 0, c0: 0, r1: Math.max(0, sheet.maxRow), c1: Math.max(0, sheet.maxCol) };
        rect = { ...rect, r1: Math.min(rect.r1, rect.r0 + MAX_ROWS_EMBED - 1, Math.max(rect.r0, sheet.maxRow)), c1: Math.min(rect.c1, rect.c0 + MAX_COLS_EMBED - 1, Math.max(rect.c0, sheet.maxCol)) };
        const res = await api.sheet.getRange({ sheetId: sheet.id, rect });
        const cells: Loaded['cells'] = new Map();
        res.cells.r.forEach((r, i) => cells.set(cellKey(r, res.cells.c[i]), { d: res.cells.d[i], k: res.cells.k[i], s: res.cells.s[i] }));
        for (const e of res.cf) {
          const cd = cells.get(cellKey(e.r, e.c));
          if (!cd) continue;
          if (e.bar !== undefined) {
            cd.bar = e.bar;
            cd.barStyle = e.styleId;
          } else cd.cf = e.styleId;
        }
        // Styles may have been interned by conditional formats; refetch once if needed.
        let styles = wb.styles;
        if ([...cells.values()].some((c) => (c.cf && !styles[c.cf]) || (c.barStyle && !styles[c.barStyle]))) styles = (await api.sheet.workbookGet({ id: pageId })).styles;
        if (!live) return;
        setData({ sheet, rect, styles, cells, merges: res.merges, widths: new Map(res.colWidths) });
        setError(null);
      } catch (e) {
        if (live) setError(errorMessage(e) || 'This range couldn’t be loaded');
      }
    })();
    return () => {
      live = false;
    };
  }, [pageId, sheetId, range, tick]);

  const covered = useMemo(() => {
    const set = new Set<number>();
    const anchors = new Map<number, Rect>();
    for (const m of data?.merges ?? []) {
      anchors.set(cellKey(m.r0, m.c0), m);
      for (let r = m.r0; r <= m.r1; r++) for (let c = m.c0; c <= m.c1; c++) if (r !== m.r0 || c !== m.c0) set.add(cellKey(r, c));
    }
    return { set, anchors };
  }, [data]);

  if (error) {
    return (
      <div className="emp-sheet-embed" role="status">
        <div className="emp-sheet-embed-head">
          <SheetIcon size={14} aria-hidden />
          <span>{error}</span>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="emp-sheet-embed" role="status" aria-label="Loading spreadsheet">
        <div className="emp-sheet-embed-head">
          <Skeleton width={180} height={10} />
        </div>
        <div className="p-3">
          <Skeleton width="100%" height={140} radius={6} />
        </div>
      </div>
    );
  }
  const { rect, styles, cells, sheet, widths } = data;
  const style = (id?: number): CellStyle => (id && styles[id]) || {};
  const rows: number[] = [];
  for (let r = rect.r0; r <= rect.r1; r++) rows.push(r);
  const cols: number[] = [];
  for (let c = rect.c0; c <= rect.c1; c++) cols.push(c);
  const empty = cells.size === 0;
  return (
    <div className="emp-sheet-embed" data-embed="sheet">
      <div className="emp-sheet-embed-head">
        <SheetIcon size={14} aria-hidden />
        <b>{title || 'Untitled spreadsheet'}</b>
        <span>· {sheet.name}</span>
        <span className="emp-sheet-embed-range">{rectName(rect)}</span>
        <span className="flex-1" />
        <Button size="xs" variant="ghost" iconRight={ArrowUpRight} onClick={() => navigate({ t: 'sheet', id: pageId, sheetId: sheet.id })}>
          Open
        </Button>
      </div>
      {empty ? (
        <div className="px-3 py-6 text-center text-[13px] text-tertiary">This range is empty. Open the workbook to add data.</div>
      ) : (
        <div className="emp-sheet-embed-scroll">
          <table aria-label={`${sheet.name} ${rectName(rect)}`}>
            <colgroup>
              {cols.map((c) => (
                <col key={c} style={{ width: widths.get(c) ?? 100 }} />
              ))}
            </colgroup>
            <tbody>
              {rows.map((r) => (
                <tr key={r}>
                  {cols.map((c) => {
                    const k = cellKey(r, c);
                    if (covered.set.has(k)) return null;
                    const m = covered.anchors.get(k);
                    const cd = cells.get(k);
                    const base = style(cd?.s);
                    const over = style(cd?.cf);
                    const st: CellStyle = { ...base, ...over, font: { ...base.font, ...over.font }, align: { ...base.align, ...over.align } };
                    const css: React.CSSProperties = {};
                    if (st.fill) css.background = adaptFill(st.fill, dark);
                    if (st.font?.color) css.color = adaptText(st.font.color, dark);
                    if (st.font?.b || st.role === 'output') css.fontWeight = 600;
                    if (st.font?.i) css.fontStyle = 'italic';
                    if (st.font?.u || st.font?.s) css.textDecoration = `${st.font.u ? 'underline' : ''} ${st.font.s ? 'line-through' : ''}`.trim();
                    if (st.font?.size && st.font.size !== 13) css.fontSize = `${st.font.size / 14}rem`;
                    if (st.align?.h) css.textAlign = st.align.h;
                    if (st.align?.wrap) css.whiteSpace = 'normal';
                    if (st.border?.b) css.borderBottom = `${st.border.b.style === 'medium' ? 2 : 1}px solid ${adaptText(st.border.b.color, dark)}`;
                    if (st.border?.t) css.borderTop = `${st.border.t.style === 'medium' ? 2 : 1}px solid ${adaptText(st.border.t.color, dark)}`;
                    const bar = cd?.bar !== undefined && cd.bar > 0 ? { width: `calc(${cd.bar * 100}% - 6px)`, background: style(cd.barStyle).fill ?? 'var(--accent-solid)' } : null;
                    return (
                      <td
                        key={c}
                        data-k={cd?.k ?? 0}
                        data-input={st.role === 'input' && !st.fill ? '' : undefined}
                        style={css}
                        rowSpan={m ? m.r1 - m.r0 + 1 : undefined}
                        colSpan={m ? m.c1 - m.c0 + 1 : undefined}
                        title={cd?.d && cd.d.length > 40 ? cd.d : undefined}
                      >
                        {bar ? <span className="emp-embed-bar" style={bar} aria-hidden /> : null}
                        <span className="emp-embed-text">{cd?.d ?? ''}</span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="emp-sheet-embed-foot">
        <span>
          {colName(rect.c0)}–{colName(rect.c1)} · {rect.r1 - rect.r0 + 1} rows
        </span>
        <span>Live from the workbook</span>
      </div>
    </div>
  );
}
