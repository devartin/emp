/**
 * Sheet toolbar: undo / redo, number formats, font styles, colours, alignment, wrap, borders, merge, freeze,
 * sort, conditional formatting and AutoSum. State reflects the active cell's style.
 */
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownAZ,
  ArrowUpAZ,
  Baseline,
  Bold,
  ChevronDown,
  DollarSign,
  Ellipsis,
  Grid2x2,
  Hash,
  Italic,
  Merge,
  PaintBucket,
  Paintbrush,
  Percent,
  Redo2,
  Sigma,
  Snowflake,
  Square,
  SquareDashed,
  Strikethrough,
  Underline,
  Undo2,
  WrapText,
} from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { BorderStyle, CellStyle } from '@/backend/types';
import { cn } from '@/lib/cn';
import { Button } from '@/ui/Button';
import { IconButton } from '@/ui/IconButton';
import { Menu, MenuCheckboxItem, MenuContent, MenuGroup, MenuItem, MenuLabel, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger } from '@/ui/Menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/Popover';
import { Tooltip } from '@/ui/Tooltip';
import { colName, MAX_COLS, MAX_ROWS } from './engine/addr';
import { formatValue } from './engine/numfmt';
import { CondFormatPopover } from './CondFormatPopover';
import { useGridSelector, type GridController } from './GridController';
import { FILL_SWATCHES, STRONG_FILL_SWATCHES, TEXT_SWATCHES, type Swatch } from './palette';

export const NUMBER_FORMATS: { label: string; code: string | null; sample: number }[] = [
  { label: 'Automatic', code: null, sample: 1234.5 },
  { label: 'Plain number', code: '0', sample: 1234.5 },
  { label: 'Number', code: '#,##0.00', sample: 1234.5 },
  { label: 'Currency', code: '$#,##0.00', sample: 1234.5 },
  { label: 'Currency (rounded)', code: '$#,##0', sample: 1234.5 },
  { label: 'Accounting', code: '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)', sample: -1234.5 },
  { label: 'Financial', code: '#,##0.00;(#,##0.00)', sample: -1234.5 },
  { label: 'Percent', code: '0.00%', sample: 0.1234 },
  { label: 'Scientific', code: '0.00E+00', sample: 1234.5 },
  { label: 'Thousands', code: '#,##0.0,"k"', sample: 1234500 },
  { label: 'Millions', code: '#,##0.0,,"M"', sample: 1234500 },
];
export const DATE_FORMATS: { label: string; code: string; sample: number }[] = [
  { label: 'Date', code: 'yyyy-mm-dd', sample: 46352.5 },
  { label: 'Long date', code: 'mmmm d, yyyy', sample: 46352.5 },
  { label: 'Short date', code: 'mmm d', sample: 46352.5 },
  { label: 'Month and year', code: 'mmm yyyy', sample: 46352.5 },
  { label: 'Time', code: 'h:mm AM/PM', sample: 46352.5625 },
  { label: 'Date and time', code: 'yyyy-mm-dd h:mm', sample: 46352.5625 },
  { label: 'Duration', code: '[h]:mm:ss', sample: 1.5625 },
];

function Sep() {
  return <span className="emp-tb-sep" aria-hidden />;
}

export interface ToolbarProps {
  ctrl: GridController;
  /** Conditional-formatting popover state (owned by the page so ⌘-shortcuts and the grid menu can open it). */
  cfOpen: boolean;
  onCfOpenChange: (open: boolean) => void;
}

/** Trailing groups collapse into the "More" menu in this order as the toolbar narrows (history never collapses). */
const GROUPS = ['num', 'font', 'align', 'data', 'fx'] as const;
type GroupId = (typeof GROUPS)[number];
const GROUP_LABEL: Record<GroupId, string> = { num: 'Number', font: 'Text', align: 'Layout', data: 'Data', fx: 'Functions' };
const FUNCTIONS = ['SUM', 'AVERAGE', 'COUNT', 'MAX', 'MIN'];
const MORE_W = 46; // separator + square key, used before the More key has been measured
const GAP = 2; // .emp-sheet-toolbar gap

/**
 * Re-renders only when what it shows changes (the active cell's style, multi-selection, merge, freeze) — not on
 * every selection move. Groups that don't fit are kept in the DOM (measurable, inert, invisible) and offered from a
 * "More" menu instead, so nothing is clipped at narrow widths.
 */
export const Toolbar = memo(function Toolbar({ ctrl, cfOpen, onCfOpenChange }: ToolbarProps) {
  useGridSelector(ctrl, (c) => {
    const p = c.primary;
    const f = c.frozen;
    const s = c.activeStyle;
    const fo = s.font;
    // Only what the keys show: moving between cells that look the same doesn't re-render the toolbar.
    return [s.numFmt ?? '', fo?.b ? 1 : 0, fo?.i ? 1 : 0, fo?.u ? 1 : 0, fo?.s ? 1 : 0, fo?.color ?? '', s.fill ?? '', s.align?.h ?? '', s.align?.wrap ? 1 : 0, p.r1 > p.r0 || p.c1 > p.c0 ? 1 : 0, c.mergeAt(c.active.r, c.active.c) ? 1 : 0, f.rows, f.cols].join('|');
  });
  const st = ctrl.activeStyle;
  const h = st.align?.h;
  const p = ctrl.primary;
  const multi = p.r1 > p.r0 || p.c1 > p.c0;
  const merged = !!ctrl.mergeAt(ctrl.active.r, ctrl.active.c);
  const frozen = ctrl.frozen;
  const fmtLabel = labelForFormat(st.numFmt);
  const style = (patch: Partial<CellStyle>) => void ctrl.applyStyle(patch).then(() => ctrl.focusGrid?.());
  const setAlign = (to: 'left' | 'center' | 'right') => style({ align: { h: h === to ? (null as unknown as 'left') : to } });

  // ── overflow: how many trailing groups are collapsed into "More"
  const barRef = useRef<HTMLDivElement | null>(null);
  const headRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const groupRefs = useRef<Partial<Record<GroupId, HTMLDivElement | null>>>({});
  const [collapsed, setCollapsed] = useState(0);
  const measure = useCallback(() => {
    const bar = barRef.current;
    const head = headRef.current;
    if (!bar || !head) return;
    const cs = getComputedStyle(bar);
    const avail = bar.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 1;
    const widths = GROUPS.map((g) => (groupRefs.current[g]?.offsetWidth ?? 0) + GAP);
    const moreW = (moreRef.current?.parentElement?.offsetWidth ?? MORE_W) + GAP;
    let used = head.offsetWidth + widths.reduce((a, b) => a + b, 0);
    let k = 0;
    if (used > avail) {
      used += moreW;
      while (k < GROUPS.length && used > avail) {
        used -= widths[GROUPS.length - 1 - k];
        k++;
      }
    }
    setCollapsed(k);
  }, []);
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [measure]);
  // The format label changes the number group's width.
  useLayoutEffect(measure, [measure, fmtLabel]);
  const hidden = (g: GroupId) => GROUPS.indexOf(g) >= GROUPS.length - collapsed;
  const groupProps = (g: GroupId) => ({
    ref: (el: HTMLDivElement | null) => {
      groupRefs.current[g] = el;
    },
    className: 'emp-tb-group',
    'data-group': g,
    'data-collapsed': hidden(g) ? '' : undefined,
    inert: hidden(g),
    'aria-hidden': hidden(g) || undefined,
  });
  const moreGroups = GROUPS.filter(hidden);
  // Opening a popover from a menu item must wait until the menu (and its focus scope) has fully unmounted, or the
  // menu's teardown dismisses the popover straight away.
  const afterClose = useRef<(() => void) | null>(null);

  return (
    <div ref={barRef} className="emp-sheet-toolbar" role="toolbar" aria-label="Formatting">
      <div ref={headRef} className="emp-tb-group" data-group="history">
        <IconButton size="sm" icon={Undo2} label="Undo" shortcut="mod+z" onClick={() => void ctrl.undo()} />
        <IconButton size="sm" icon={Redo2} label="Redo" shortcut="mod+shift+z" onClick={() => void ctrl.redo()} />
      </div>
      <div {...groupProps('num')}>
        <Sep />
        <IconButton size="sm" icon={DollarSign} label="Currency" shortcut="mod+shift+4" active={!!st.numFmt?.includes('$')} onClick={() => void ctrl.setNumFmt('$#,##0.00')} />
        <IconButton size="sm" icon={Percent} label="Percent" shortcut="mod+shift+5" active={!!st.numFmt?.includes('%')} onClick={() => void ctrl.setNumFmt('0.0%')} />
        <Tooltip content="Fewer decimals">
          <button type="button" className="emp-tb-text" aria-label="Fewer decimals" onClick={() => void ctrl.adjustDecimals(-1)}>
            .0<span className="emp-tb-arrow">←</span>
          </button>
        </Tooltip>
        <Tooltip content="More decimals">
          <button type="button" className="emp-tb-text" aria-label="More decimals" onClick={() => void ctrl.adjustDecimals(1)}>
            .00<span className="emp-tb-arrow">→</span>
          </button>
        </Tooltip>
        <NumberFormatMenu ctrl={ctrl} label={fmtLabel} current={st.numFmt} />
      </div>
      <div {...groupProps('font')}>
        <Sep />
        <IconButton size="sm" icon={Bold} label="Bold" shortcut="mod+b" active={!!st.font?.b} onClick={() => void ctrl.toggleFont('b')} />
        <IconButton size="sm" icon={Italic} label="Italic" shortcut="mod+i" active={!!st.font?.i} onClick={() => void ctrl.toggleFont('i')} />
        <IconButton size="sm" icon={Underline} label="Underline" shortcut="mod+u" active={!!st.font?.u} onClick={() => void ctrl.toggleFont('u')} />
        <IconButton size="sm" icon={Strikethrough} label="Strikethrough" active={!!st.font?.s} onClick={() => void ctrl.toggleFont('s')} />
        <ColorButton label="Text colour" icon={Baseline} current={st.font?.color} swatches={[TEXT_SWATCHES]} onPick={(hex) => style({ font: { color: hex || (null as unknown as string) } })} />
        <ColorButton label="Fill colour" icon={PaintBucket} current={st.fill} swatches={[FILL_SWATCHES, STRONG_FILL_SWATCHES]} onPick={(hex) => style({ fill: hex })} />
      </div>
      <div {...groupProps('align')}>
        <Sep />
        <IconButton size="sm" icon={AlignLeft} label="Align left" active={h === 'left'} onClick={() => setAlign('left')} />
        <IconButton size="sm" icon={AlignCenter} label="Align centre" active={h === 'center'} onClick={() => setAlign('center')} />
        <IconButton size="sm" icon={AlignRight} label="Align right" active={h === 'right'} onClick={() => setAlign('right')} />
        <IconButton size="sm" icon={WrapText} label="Wrap text" active={!!st.align?.wrap} onClick={() => style({ align: { wrap: !st.align?.wrap } })} />
        <BordersMenu ctrl={ctrl} />
        <IconButton size="sm" icon={Merge} label={merged ? 'Unmerge cells' : 'Merge cells'} active={merged} disabled={!merged && !multi} onClick={() => void ctrl.merge(!merged)} />
      </div>
      <div {...groupProps('data')}>
        <Sep />
        <Menu>
          <MenuTrigger asChild>
            <Button size="sm" variant="ghost" icon={Snowflake} iconRight={ChevronDown} active={!!(frozen.rows || frozen.cols)} className="emp-tb-menu">
              Freeze
            </Button>
          </MenuTrigger>
          <MenuContent width={240}>
            <MenuLabel>Freeze panes</MenuLabel>
            <FreezeItems ctrl={ctrl} />
          </MenuContent>
        </Menu>
        <IconButton size="sm" icon={ArrowDownAZ} label="Sort A → Z" onClick={() => void ctrl.sort('asc')} />
        <IconButton size="sm" icon={ArrowUpAZ} label="Sort Z → A" onClick={() => void ctrl.sort('desc')} />
        <CondFormatPopover ctrl={ctrl} open={cfOpen} onOpenChange={onCfOpenChange} fallbackAnchor={moreRef} />
      </div>
      <div {...groupProps('fx')}>
        <Sep />
        <Menu>
          <MenuTrigger asChild>
            <Button size="sm" variant="ghost" icon={Sigma} iconRight={ChevronDown} className="emp-tb-menu" aria-label="Functions">
              <span className="sr-only">Functions</span>
            </Button>
          </MenuTrigger>
          <MenuContent width={220}>
            <MenuLabel>Insert</MenuLabel>
            <FunctionItems ctrl={ctrl} />
          </MenuContent>
        </Menu>
      </div>
      {moreGroups.length ? (
        <div className="emp-tb-group" data-group="more">
          <Sep />
          <Menu>
            <MenuTrigger asChild>
              <IconButton ref={moreRef} size="sm" icon={Ellipsis} label="More tools" />
            </MenuTrigger>
            <MenuContent align="end" width={232} noReturnFocus>
              <OnUnmount run={afterClose} />
              {moreGroups.map((g, i) => (
                <MenuGroup key={g}>
                  {i ? <MenuSeparator /> : null}
                  <MenuLabel>{GROUP_LABEL[g]}</MenuLabel>
                  {g === 'num' ? (
                    <>
                      <MenuCheckboxItem icon={DollarSign} shortcut="mod+shift+4" checked={!!st.numFmt?.includes('$')} keepOpen={false} onCheckedChange={() => void ctrl.setNumFmt('$#,##0.00')}>
                        Currency
                      </MenuCheckboxItem>
                      <MenuCheckboxItem icon={Percent} shortcut="mod+shift+5" checked={!!st.numFmt?.includes('%')} keepOpen={false} onCheckedChange={() => void ctrl.setNumFmt('0.0%')}>
                        Percent
                      </MenuCheckboxItem>
                      <MenuItem icon={<span className="emp-tb-glyph">.0</span>} keepOpen onSelect={() => void ctrl.adjustDecimals(-1)}>
                        Fewer decimals
                      </MenuItem>
                      <MenuItem icon={<span className="emp-tb-glyph">.00</span>} keepOpen onSelect={() => void ctrl.adjustDecimals(1)}>
                        More decimals
                      </MenuItem>
                      <MenuSub>
                        <MenuSubTrigger icon={Hash}>Format · {fmtLabel}</MenuSubTrigger>
                        <MenuSubContent className="emp-tb-sub">
                          <FormatItems ctrl={ctrl} current={st.numFmt} />
                        </MenuSubContent>
                      </MenuSub>
                    </>
                  ) : g === 'font' ? (
                    <>
                      <MenuCheckboxItem icon={Bold} shortcut="mod+b" checked={!!st.font?.b} onCheckedChange={() => void ctrl.toggleFont('b')}>
                        Bold
                      </MenuCheckboxItem>
                      <MenuCheckboxItem icon={Italic} shortcut="mod+i" checked={!!st.font?.i} onCheckedChange={() => void ctrl.toggleFont('i')}>
                        Italic
                      </MenuCheckboxItem>
                      <MenuCheckboxItem icon={Underline} shortcut="mod+u" checked={!!st.font?.u} onCheckedChange={() => void ctrl.toggleFont('u')}>
                        Underline
                      </MenuCheckboxItem>
                      <MenuCheckboxItem icon={Strikethrough} checked={!!st.font?.s} onCheckedChange={() => void ctrl.toggleFont('s')}>
                        Strikethrough
                      </MenuCheckboxItem>
                      <MenuSub>
                        <MenuSubTrigger icon={Baseline}>Text colour</MenuSubTrigger>
                        <MenuSubContent className="emp-tb-sub">
                          <SwatchItems swatches={TEXT_SWATCHES} current={st.font?.color} onPick={(hex) => style({ font: { color: hex || (null as unknown as string) } })} />
                        </MenuSubContent>
                      </MenuSub>
                      <MenuSub>
                        <MenuSubTrigger icon={PaintBucket}>Fill colour</MenuSubTrigger>
                        <MenuSubContent className="emp-tb-sub">
                          <SwatchItems swatches={[...FILL_SWATCHES, ...STRONG_FILL_SWATCHES]} current={st.fill} onPick={(hex) => style({ fill: hex })} />
                        </MenuSubContent>
                      </MenuSub>
                    </>
                  ) : g === 'align' ? (
                    <>
                      <MenuCheckboxItem icon={AlignLeft} checked={h === 'left'} onCheckedChange={() => setAlign('left')}>
                        Align left
                      </MenuCheckboxItem>
                      <MenuCheckboxItem icon={AlignCenter} checked={h === 'center'} onCheckedChange={() => setAlign('center')}>
                        Align centre
                      </MenuCheckboxItem>
                      <MenuCheckboxItem icon={AlignRight} checked={h === 'right'} onCheckedChange={() => setAlign('right')}>
                        Align right
                      </MenuCheckboxItem>
                      <MenuCheckboxItem icon={WrapText} checked={!!st.align?.wrap} onCheckedChange={() => style({ align: { wrap: !st.align?.wrap } })}>
                        Wrap text
                      </MenuCheckboxItem>
                      <MenuSub>
                        <MenuSubTrigger icon={Grid2x2}>Borders</MenuSubTrigger>
                        <MenuSubContent>
                          <BorderItems ctrl={ctrl} />
                        </MenuSubContent>
                      </MenuSub>
                      <MenuItem icon={Merge} disabled={!merged && !multi} onSelect={() => void ctrl.merge(!merged)}>
                        {merged ? 'Unmerge cells' : 'Merge cells'}
                      </MenuItem>
                    </>
                  ) : g === 'data' ? (
                    <>
                      <MenuSub>
                        <MenuSubTrigger icon={Snowflake}>Freeze panes</MenuSubTrigger>
                        <MenuSubContent>
                          <FreezeItems ctrl={ctrl} />
                        </MenuSubContent>
                      </MenuSub>
                      <MenuItem icon={ArrowDownAZ} onSelect={() => void ctrl.sort('asc')}>
                        Sort A → Z
                      </MenuItem>
                      <MenuItem icon={ArrowUpAZ} onSelect={() => void ctrl.sort('desc')}>
                        Sort Z → A
                      </MenuItem>
                      <MenuItem icon={Paintbrush} onSelect={() => (afterClose.current = () => onCfOpenChange(true))}>
                        Conditional formatting…
                      </MenuItem>
                    </>
                  ) : (
                    <MenuSub>
                      <MenuSubTrigger icon={Sigma}>Insert function</MenuSubTrigger>
                      <MenuSubContent>
                        <FunctionItems ctrl={ctrl} />
                      </MenuSubContent>
                    </MenuSub>
                  )}
                </MenuGroup>
              ))}
            </MenuContent>
          </Menu>
        </div>
      ) : null}
    </div>
  );
});

/** Runs (and clears) `run.current` when the surrounding menu content unmounts, i.e. after its exit animation. */
function OnUnmount({ run }: { run: RefObject<(() => void) | null> }) {
  useEffect(
    () => () => {
      const fn = run.current;
      run.current = null;
      if (fn) window.setTimeout(fn, 0);
    },
    [run],
  );
  return null;
}

/** Freeze-pane choices; reads the active cell when the menu opens (the toolbar doesn't follow selection moves). */
function FreezeItems({ ctrl }: { ctrl: GridController }) {
  const frozen = ctrl.frozen;
  const { r, c } = ctrl.active;
  return (
    <>
      <MenuItem onSelect={() => void ctrl.freeze(1, frozen.cols)}>Top row</MenuItem>
      <MenuItem onSelect={() => void ctrl.freeze(frozen.rows, 1)}>First column</MenuItem>
      <MenuItem disabled={r === 0 && c === 0} onSelect={() => void ctrl.freeze(r, c)}>
        {`Up to ${r ? `row ${r}` : ''}${r && c ? ' and ' : ''}${c ? `column ${colName(c - 1)}` : ''}` || 'Up to the selection'}
      </MenuItem>
      <MenuSeparator />
      <MenuItem disabled={!frozen.rows && !frozen.cols} onSelect={() => void ctrl.freeze(0, 0)}>
        Unfreeze
      </MenuItem>
    </>
  );
}

function FunctionItems({ ctrl }: { ctrl: GridController }) {
  return (
    <>
      {FUNCTIONS.map((fn) => (
        <MenuItem key={fn} onSelect={() => ctrl.beginEdit({ mode: 'enter', text: ctrl.autoSumFormula(fn) })}>
          {fn.charAt(0) + fn.slice(1).toLowerCase()}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem onSelect={() => ctrl.beginEdit({ mode: 'enter', text: '=' })}>More functions…</MenuItem>
    </>
  );
}

function FormatItems({ ctrl, current }: { ctrl: GridController; current?: string }) {
  return (
    <>
      <MenuLabel>Number</MenuLabel>
      {NUMBER_FORMATS.map((f) => (
        <MenuItem key={f.label} trailing={<span className="emp-fmt-sample">{sample(f.sample, f.code ?? undefined)}</span>} onSelect={() => void ctrl.setNumFmt(f.code)} className={cn(f.code === (current ?? null) && 'is-current')}>
          {f.label}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuLabel>Date & time</MenuLabel>
      {DATE_FORMATS.map((f) => (
        <MenuItem key={f.label} trailing={<span className="emp-fmt-sample">{sample(f.sample, f.code)}</span>} onSelect={() => void ctrl.setNumFmt(f.code)} className={cn(f.code === current && 'is-current')}>
          {f.label}
        </MenuItem>
      ))}
      <MenuItem trailing={<span className="emp-fmt-sample">abc</span>} onSelect={() => void ctrl.setNumFmt('@')}>
        Plain text
      </MenuItem>
    </>
  );
}

function SwatchItems({ swatches, current, onPick }: { swatches: Swatch[]; current?: string; onPick: (hex: string) => void }) {
  return (
    <>
      {swatches.map((s) => (
        <MenuItem
          key={s.name + s.hex}
          icon={<span className={cn('emp-tb-dot', !s.hex && 'is-none')} style={s.hex ? { background: s.hex } : undefined} />}
          className={cn((current ?? '') === s.hex && 'is-current')}
          onSelect={() => onPick(s.hex)}
        >
          {s.name}
        </MenuItem>
      ))}
    </>
  );
}

/** Format samples in menus are display text: a true minus (U+2212), like the grid paints. */
function sample(n: number, code: string | undefined): string {
  return formatValue(n, code).text.replace(/^-/, '−');
}

function labelForFormat(code: string | undefined): string {
  if (!code) return '123';
  const hit = [...NUMBER_FORMATS, ...DATE_FORMATS].find((f) => f.code === code);
  if (hit) return hit.label;
  if (code.includes('%')) return 'Percent';
  if (code.includes('$')) return 'Currency';
  if (/[ymd]/i.test(code) && !/[0#]/.test(code)) return 'Date';
  return 'Custom';
}

function NumberFormatMenu({ ctrl, label, current }: { ctrl: GridController; label: string; current?: string }) {
  const [custom, setCustom] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <Menu
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setCustom(null);
      }}
    >
      <MenuTrigger asChild>
        <Button size="sm" variant="ghost" iconRight={ChevronDown} className="emp-tb-menu emp-tb-fmt" aria-label={`Number format: ${label}`}>
          <span className="emp-tb-fmt-label">{label}</span>
        </Button>
      </MenuTrigger>
      <MenuContent width={300}>
        <FormatItems ctrl={ctrl} current={current} />
        <MenuSeparator />
        <div className="emp-fmt-custom" onKeyDown={(e) => e.stopPropagation()}>
          <input
            className="emp-fmt-custom-input"
            placeholder="Custom format, e.g. #,##0.0 “kg”"
            aria-label="Custom number format"
            value={custom ?? current ?? ''}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && custom) {
                e.preventDefault();
                void ctrl.setNumFmt(custom);
                setCustom(null);
                setOpen(false);
              }
            }}
          />
          {custom ? <span className="emp-fmt-sample">{safeSample(custom)}</span> : null}
        </div>
      </MenuContent>
    </Menu>
  );
}

function safeSample(code: string): string {
  try {
    return sample(-1234.567, code);
  } catch {
    return '—';
  }
}

function ColorButton({ label, icon: Icon, current, swatches, onPick }: { label: string; icon: typeof Baseline; current?: string; swatches: Swatch[][]; onPick: (hex: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip content={label}>
        <PopoverTrigger asChild>
          <button type="button" className="emp-tb-color" aria-label={label} data-active={open ? '' : undefined}>
            <Icon size={16} aria-hidden />
            <span className="emp-tb-color-bar" style={{ background: current || 'var(--text-disabled)' }} />
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent className="emp-swatch-pop">
        {swatches.map((row, i) => (
          <div key={i} className="emp-swatch-row">
            {row.map((s) => (
              <button
                key={s.name}
                type="button"
                className={cn('emp-swatch', !s.hex && 'is-none', (current ?? '') === s.hex && 'is-current')}
                style={s.hex ? { background: s.hex } : undefined}
                aria-label={s.name}
                title={s.name}
                onClick={() => {
                  onPick(s.hex);
                  setOpen(false);
                }}
              />
            ))}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

type BorderKind = 'all' | 'outer' | 'bottom' | 'top' | 'thick-bottom' | 'none';

async function applyBorders(ctrl: GridController, kind: BorderKind): Promise<void> {
  const color = '#71717A';
  const line = (style: BorderStyle['style'] = 'thin'): BorderStyle => ({ style, color });
  const p = ctrl.primary;
  const r1 = Math.min(p.r1, Math.max(p.r0, (ctrl.sheet?.maxRow ?? p.r0) + 1));
  const c1 = Math.min(p.c1, Math.max(p.c0, (ctrl.sheet?.maxCol ?? p.c0) + 1));
  const rect = { ...p, r1: p.r1 >= MAX_ROWS - 1 ? r1 : p.r1, c1: p.c1 >= MAX_COLS - 1 ? c1 : p.c1 };
  const run = async (rects: (typeof rect)[], border: CellStyle['border'] | null) => {
    const saved = ctrl.sel;
    ctrl.sel = { ...saved, ranges: rects };
    await ctrl.applyStyle({ border: border as CellStyle['border'] });
    ctrl.sel = saved;
  };
  if (kind === 'none') await run([rect], null);
  else if (kind === 'all') await run([rect], { t: line(), r: line(), b: line(), l: line() });
  else if (kind === 'bottom') await run([{ ...rect, r0: rect.r1 }], { b: line() });
  else if (kind === 'thick-bottom') await run([{ ...rect, r0: rect.r1 }], { b: line('medium') });
  else if (kind === 'top') await run([{ ...rect, r1: rect.r0 }], { t: line() });
  else {
    await run([{ ...rect, r1: rect.r0 }], { t: line() });
    await run([{ ...rect, r0: rect.r1 }], { b: line() });
    await run([{ ...rect, c1: rect.c0 }], { l: line() });
    await run([{ ...rect, c0: rect.c1 }], { r: line() });
  }
  ctrl.paint();
  ctrl.emit();
}

function BorderItems({ ctrl }: { ctrl: GridController }) {
  const apply = (kind: BorderKind) => void applyBorders(ctrl, kind);
  return (
    <>
      <MenuItem icon={Grid2x2} onSelect={() => apply('all')}>
        All borders
      </MenuItem>
      <MenuItem icon={Square} onSelect={() => apply('outer')}>
        Outside borders
      </MenuItem>
      <MenuItem icon={Paintbrush} onSelect={() => apply('bottom')}>
        Bottom border
      </MenuItem>
      <MenuItem icon={Paintbrush} onSelect={() => apply('thick-bottom')}>
        Thick bottom border
      </MenuItem>
      <MenuItem icon={Paintbrush} onSelect={() => apply('top')}>
        Top border
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={SquareDashed} onSelect={() => apply('none')}>
        No borders
      </MenuItem>
    </>
  );
}

function BordersMenu({ ctrl }: { ctrl: GridController }) {
  return (
    <Menu>
      <Tooltip content="Borders">
        <MenuTrigger asChild>
          <button type="button" className="emp-tb-icon-menu" aria-label="Borders">
            <Grid2x2 size={16} aria-hidden />
            <ChevronDown size={12} aria-hidden />
          </button>
        </MenuTrigger>
      </Tooltip>
      <MenuContent width={200}>
        <BorderItems ctrl={ctrl} />
      </MenuContent>
    </Menu>
  );
}

export default Toolbar;
