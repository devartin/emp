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
  Grid2x2,
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
import { useState, type ReactNode } from 'react';
import type { BorderStyle, CellStyle } from '@/backend/types';
import { cn } from '@/lib/cn';
import { Button } from '@/ui/Button';
import { IconButton } from '@/ui/IconButton';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/ui/Menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/Popover';
import { Tooltip } from '@/ui/Tooltip';
import { colName, MAX_COLS, MAX_ROWS } from './engine/addr';
import { formatValue } from './engine/numfmt';
import { useGridVersion, type GridController } from './GridController';
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
  condFormat: ReactNode;
}

export function Toolbar({ ctrl, condFormat }: ToolbarProps) {
  useGridVersion(ctrl);
  const st = ctrl.activeStyle;
  const h = st.align?.h;
  const p = ctrl.primary;
  const multi = p.r1 > p.r0 || p.c1 > p.c0;
  const merged = !!ctrl.mergeAt(ctrl.active.r, ctrl.active.c);
  const frozen = ctrl.frozen;
  const fmtLabel = labelForFormat(st.numFmt);
  const style = (patch: Partial<CellStyle>) => void ctrl.applyStyle(patch).then(() => ctrl.focusGrid?.());

  return (
    <div className="emp-sheet-toolbar" role="toolbar" aria-label="Formatting">
      <IconButton size="sm" icon={Undo2} label="Undo" shortcut="mod+z" onClick={() => void ctrl.undo()} />
      <IconButton size="sm" icon={Redo2} label="Redo" shortcut="mod+shift+z" onClick={() => void ctrl.redo()} />
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
      <Sep />
      <IconButton size="sm" icon={Bold} label="Bold" shortcut="mod+b" active={!!st.font?.b} onClick={() => void ctrl.toggleFont('b')} />
      <IconButton size="sm" icon={Italic} label="Italic" shortcut="mod+i" active={!!st.font?.i} onClick={() => void ctrl.toggleFont('i')} />
      <IconButton size="sm" icon={Underline} label="Underline" shortcut="mod+u" active={!!st.font?.u} onClick={() => void ctrl.toggleFont('u')} />
      <IconButton size="sm" icon={Strikethrough} label="Strikethrough" active={!!st.font?.s} onClick={() => void ctrl.toggleFont('s')} />
      <ColorButton label="Text colour" icon={Baseline} current={st.font?.color} swatches={[TEXT_SWATCHES]} onPick={(hex) => style({ font: { color: hex || (null as unknown as string) } })} />
      <ColorButton label="Fill colour" icon={PaintBucket} current={st.fill} swatches={[FILL_SWATCHES, STRONG_FILL_SWATCHES]} onPick={(hex) => style({ fill: hex })} />
      <Sep />
      <IconButton size="sm" icon={AlignLeft} label="Align left" active={h === 'left'} onClick={() => style({ align: { h: h === 'left' ? (null as unknown as 'left') : 'left' } })} />
      <IconButton size="sm" icon={AlignCenter} label="Align centre" active={h === 'center'} onClick={() => style({ align: { h: h === 'center' ? (null as unknown as 'center') : 'center' } })} />
      <IconButton size="sm" icon={AlignRight} label="Align right" active={h === 'right'} onClick={() => style({ align: { h: h === 'right' ? (null as unknown as 'right') : 'right' } })} />
      <IconButton size="sm" icon={WrapText} label="Wrap text" active={!!st.align?.wrap} onClick={() => style({ align: { wrap: !st.align?.wrap } })} />
      <BordersMenu ctrl={ctrl} />
      <IconButton
        size="sm"
        icon={Merge}
        label={merged ? 'Unmerge cells' : 'Merge cells'}
        active={merged}
        disabled={!merged && !multi}
        onClick={() => void ctrl.merge(!merged)}
      />
      <Sep />
      <Menu>
        <MenuTrigger asChild>
          <Button size="sm" variant="ghost" icon={Snowflake} iconRight={ChevronDown} active={!!(frozen.rows || frozen.cols)} className="emp-tb-menu">
            Freeze
          </Button>
        </MenuTrigger>
        <MenuContent width={240}>
          <MenuLabel>Freeze panes</MenuLabel>
          <MenuItem onSelect={() => void ctrl.freeze(1, frozen.cols)}>Top row</MenuItem>
          <MenuItem onSelect={() => void ctrl.freeze(frozen.rows, 1)}>First column</MenuItem>
          <MenuItem disabled={ctrl.active.r === 0 && ctrl.active.c === 0} onSelect={() => void ctrl.freeze(ctrl.active.r, ctrl.active.c)}>
            {`Up to ${ctrl.active.r ? `row ${ctrl.active.r}` : ''}${ctrl.active.r && ctrl.active.c ? ' and ' : ''}${ctrl.active.c ? `column ${colName(ctrl.active.c - 1)}` : ''}` || 'Up to the selection'}
          </MenuItem>
          <MenuSeparator />
          <MenuItem disabled={!frozen.rows && !frozen.cols} onSelect={() => void ctrl.freeze(0, 0)}>
            Unfreeze
          </MenuItem>
        </MenuContent>
      </Menu>
      <IconButton size="sm" icon={ArrowDownAZ} label="Sort A → Z" onClick={() => void ctrl.sort('asc')} />
      <IconButton size="sm" icon={ArrowUpAZ} label="Sort Z → A" onClick={() => void ctrl.sort('desc')} />
      {condFormat}
      <Sep />
      <Menu>
        <MenuTrigger asChild>
          <Button size="sm" variant="ghost" icon={Sigma} iconRight={ChevronDown} className="emp-tb-menu" aria-label="Functions">
            <span className="sr-only">Functions</span>
          </Button>
        </MenuTrigger>
        <MenuContent width={220}>
          <MenuLabel>Insert</MenuLabel>
          {['SUM', 'AVERAGE', 'COUNT', 'MAX', 'MIN'].map((fn) => (
            <MenuItem key={fn} onSelect={() => ctrl.beginEdit({ mode: 'enter', text: ctrl.autoSumFormula(fn) })}>
              {fn.charAt(0) + fn.slice(1).toLowerCase()}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onSelect={() => ctrl.beginEdit({ mode: 'enter', text: '=' })}>More functions…</MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
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
        <MenuLabel>Number</MenuLabel>
        {NUMBER_FORMATS.map((f) => (
          <MenuItem key={f.label} trailing={<span className="emp-fmt-sample">{formatValue(f.sample, f.code ?? undefined).text}</span>} onSelect={() => void ctrl.setNumFmt(f.code)} className={cn(f.code === (current ?? null) && 'is-current')}>
            {f.label}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuLabel>Date & time</MenuLabel>
        {DATE_FORMATS.map((f) => (
          <MenuItem key={f.label} trailing={<span className="emp-fmt-sample">{formatValue(f.sample, f.code).text}</span>} onSelect={() => void ctrl.setNumFmt(f.code)} className={cn(f.code === current && 'is-current')}>
            {f.label}
          </MenuItem>
        ))}
        <MenuItem trailing={<span className="emp-fmt-sample">abc</span>} onSelect={() => void ctrl.setNumFmt('@')}>
          Plain text
        </MenuItem>
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
    return formatValue(-1234.567, code).text;
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

function BordersMenu({ ctrl }: { ctrl: GridController }) {
  const color = '#71717A';
  const line = (style: BorderStyle['style'] = 'thin'): BorderStyle => ({ style, color });
  const apply = async (kind: 'all' | 'outer' | 'bottom' | 'top' | 'thick-bottom' | 'none') => {
    const p = ctrl.primary;
    const r1 = Math.min(p.r1, Math.max(p.r0, (ctrl.sheet?.maxRow ?? p.r0) + 1));
    const c1 = Math.min(p.c1, Math.max(p.c0, (ctrl.sheet?.maxCol ?? p.c0) + 1));
    const rect = { ...p, r1: p.r1 >= MAX_ROWS - 1 ? r1 : p.r1, c1: p.c1 >= MAX_COLS - 1 ? c1 : p.c1 };
    const run = async (rects: typeof rect[], border: CellStyle['border'] | null) => {
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
  };
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
        <MenuItem icon={Grid2x2} onSelect={() => void apply('all')}>
          All borders
        </MenuItem>
        <MenuItem icon={Square} onSelect={() => void apply('outer')}>
          Outside borders
        </MenuItem>
        <MenuItem icon={Paintbrush} onSelect={() => void apply('bottom')}>
          Bottom border
        </MenuItem>
        <MenuItem icon={Paintbrush} onSelect={() => void apply('thick-bottom')}>
          Thick bottom border
        </MenuItem>
        <MenuItem icon={Paintbrush} onSelect={() => void apply('top')}>
          Top border
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={SquareDashed} onSelect={() => void apply('none')}>
          No borders
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

export default Toolbar;
