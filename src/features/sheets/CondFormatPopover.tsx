/**
 * Conditional formatting (§11.3 `sheet_cond_format_set`): colour scales, data bars and highlight rules for the
 * selection, plus the list of rules on the sheet. Highlight rules carry their look inline as `colors: [fill, text]`.
 */
import { AnimatePresence, m } from 'motion/react';
import { Paintbrush, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { CondFormatRule, Rect } from '@/backend/types';
import { cn } from '@/lib/cn';
import { Button } from '@/ui/Button';
import { IconButton } from '@/ui/IconButton';
import { Input } from '@/ui/Input';
import { Popover, PopoverAnchor, PopoverContent } from '@/ui/Popover';
import { Segmented } from '@/ui/Segmented';
import { Select } from '@/ui/Select';
import { Tooltip } from '@/ui/Tooltip';
import { spring } from '@/ui/motion/tokens';
import { MAX_COLS, MAX_ROWS, rectName, rectsIntersect } from './engine/addr';
import { useGridSelector, type GridController } from './GridController';
import { BAR_PRESETS, gradientCss, HIGHLIGHT_PRESETS, SCALE_PRESETS } from './palette';

type Kind = 'scale' | 'bars' | 'highlight';
type Op = NonNullable<CondFormatRule['op']>;

const OPS: { value: Op; label: string }[] = [
  { value: 'gt', label: 'Greater than' },
  { value: 'lt', label: 'Less than' },
  { value: 'between', label: 'Between' },
  { value: 'eq', label: 'Equal to' },
  { value: 'text_contains', label: 'Text contains' },
];

export interface CondFormatPopoverProps {
  ctrl: GridController;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where to point the popover when its toolbar key is collapsed into the toolbar's "More" menu. */
  fallbackAnchor?: RefObject<HTMLElement | null>;
}

function describe(rule: CondFormatRule): string {
  const where = rectName(rule.rect);
  switch (rule.kind) {
    case 'color_scale':
      return `Colour scale · ${where}`;
    case 'data_bar':
      return `Data bars · ${where}`;
    case 'formula':
      return `Formula ${rule.formula ?? ''} · ${where}`;
    default: {
      const op = OPS.find((o) => o.value === rule.op)?.label ?? 'Rule';
      const v = rule.op === 'between' ? `${rule.values?.[0] ?? ''} and ${rule.values?.[1] ?? ''}` : rule.values?.[0] ?? '';
      return `${op} ${v} · ${where}`;
    }
  }
}

export function CondFormatPopover({ ctrl, open, onOpenChange, fallbackAnchor }: CondFormatPopoverProps) {
  // Closed it is just a toolbar key: don't follow every selection move.
  useGridSelector(ctrl, (c) => (open ? c.version : -1));
  const [kind, setKind] = useState<Kind>('scale');
  const [op, setOp] = useState<Op>('gt');
  const [v1, setV1] = useState('');
  const [v2, setV2] = useState('');
  const [look, setLook] = useState(0);
  const keyRef = useRef<HTMLButtonElement | null>(null);
  // Anchor on the toolbar key, or on "More" while the key is collapsed (an inert, invisible group).
  const anchor = useRef({
    getBoundingClientRect: (): DOMRect => {
      const key = keyRef.current;
      const el = key && !key.closest('[data-collapsed]') ? key : (fallbackAnchor?.current ?? key);
      return el ? el.getBoundingClientRect() : new DOMRect();
    },
  });
  useEffect(() => {
    if (!open) return;
    setV1('');
    setV2('');
  }, [open]);

  const target = (): Rect => {
    const p = ctrl.primary;
    const maxR = ctrl.sheet?.maxRow ?? p.r0;
    const maxC = ctrl.sheet?.maxCol ?? p.c0;
    return { r0: p.r0, c0: p.c0, r1: p.r1 >= MAX_ROWS - 1 ? Math.max(p.r0, maxR) : p.r1, c1: p.c1 >= MAX_COLS - 1 ? Math.max(p.c0, maxC) : p.c1 };
  };
  const rules = ctrl.cf;
  const here = rules.filter((r) => rectsIntersect(r.rect, target()));
  const others = rules.filter((r) => !here.includes(r));
  const add = (rule: Omit<CondFormatRule, 'rect'>) => void ctrl.setCondFormats([...rules, { ...rule, rect: target() }]);
  const remove = (rule: CondFormatRule) => void ctrl.setCondFormats(rules.filter((r) => r !== rule));

  const addHighlight = () => {
    const preset = HIGHLIGHT_PRESETS[look];
    if (!v1 && op !== 'text_contains') return;
    add({ kind: 'cell', op, values: op === 'between' ? [v1, v2] : [v1], colors: [preset.fill, preset.text] });
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={anchor} />
      <Tooltip content="Conditional formatting">
        <button ref={keyRef} type="button" className="emp-tb-icon-menu" aria-label="Conditional formatting" data-active={open ? '' : undefined} onClick={() => onOpenChange(!open)}>
          <Paintbrush size={16} aria-hidden />
        </button>
      </Tooltip>
      <PopoverContent form className="emp-cf-pop" align="start" onOpenAutoFocus={(e) => e.preventDefault()}>
        <div className="emp-cf-head">
          <span className="emp-cf-title">Conditional formatting</span>
          <span className="emp-cf-range">{rectName(target())}</span>
        </div>
        <Segmented<Kind>
          block
          size="sm"
          value={kind}
          onValueChange={setKind}
          aria-label="Rule type"
          options={[
            { value: 'scale', label: 'Colour scale' },
            { value: 'bars', label: 'Data bars' },
            { value: 'highlight', label: 'Highlight' },
          ]}
        />
        <div className="emp-cf-body">
          {kind === 'scale' ? (
            <div className="emp-cf-grid">
              {SCALE_PRESETS.map((p) => (
                <button key={p.name} type="button" className="emp-cf-scale" onClick={() => add({ kind: 'color_scale', colors: p.colors })} aria-label={p.name} title={p.name}>
                  <span className="emp-cf-scale-swatch" style={{ background: gradientCss(p.colors) }} />
                  <span className="emp-cf-scale-label">{p.name}</span>
                </button>
              ))}
            </div>
          ) : kind === 'bars' ? (
            <div className="emp-cf-grid">
              {BAR_PRESETS.map((p) => (
                <button key={p.name} type="button" className="emp-cf-scale" onClick={() => add({ kind: 'data_bar', colors: [p.color] })} aria-label={`${p.name} data bars`}>
                  <span className="emp-cf-bars" aria-hidden>
                    {[0.85, 0.45, 0.65, 0.25].map((w, i) => (
                      <span key={i} style={{ width: `${w * 100}%`, background: p.color }} />
                    ))}
                  </span>
                  <span className="emp-cf-scale-label">{p.name}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="emp-cf-form">
              <Select<Op> size="sm" value={op} onValueChange={setOp} options={OPS} />
              <div className="emp-cf-values">
                <Input size="sm" placeholder={op === 'text_contains' ? 'Text' : 'Value'} value={v1} onChange={(e) => setV1(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addHighlight()} />
                {op === 'between' ? <Input size="sm" placeholder="and" value={v2} onChange={(e) => setV2(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addHighlight()} /> : null}
              </div>
              <div className="emp-cf-looks" role="radiogroup" aria-label="Style">
                {HIGHLIGHT_PRESETS.map((p, i) => (
                  <button
                    key={p.name}
                    type="button"
                    role="radio"
                    aria-checked={look === i}
                    className={cn('emp-cf-look', look === i && 'is-active')}
                    style={{ background: p.fill || undefined, color: p.text || undefined }}
                    onClick={() => setLook(i)}
                  >
                    Aa
                  </button>
                ))}
              </div>
              <Button size="sm" variant="primary" onClick={addHighlight} disabled={!v1}>
                Add rule
              </Button>
            </div>
          )}
        </div>
        {rules.length ? (
          <div className="emp-cf-rules relative">
            <div className="emp-cf-rules-title">Rules on this sheet</div>
            {/* DESIGN §1.6: rows rise in at full size; removals pop out of flow and the rest glide (layout="position"). */}
            <AnimatePresence initial={false} mode="popLayout">
              {[...here, ...others].map((r) => (
                <m.div
                  key={r.id ?? describe(r)}
                  className={cn('emp-cf-rule', !here.includes(r) && 'is-other')}
                  layout="position"
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: here.includes(r) ? 1 : 0.6, y: 0, transition: { opacity: { duration: 0.16 }, y: spring.settle } }}
                  exit={{ opacity: 0, transition: { duration: 0.12 } }}
                  transition={spring.layout}
                >
                  <span
                    className="emp-cf-rule-chip"
                    style={
                      r.kind === 'color_scale'
                        ? { background: gradientCss(r.colors?.length ? r.colors : ['#F8696B', '#FFEB84', '#63BE7B']) }
                        : r.kind === 'data_bar'
                          ? { background: `linear-gradient(90deg, ${r.colors?.[0] ?? '#7D7BF5'} 60%, transparent 60%)` }
                          : { background: ctrl.style(r.styleId).fill ?? 'var(--bg-surface-3)' }
                    }
                  />
                  <span className="emp-cf-rule-text">{describe(r)}</span>
                  <IconButton size="xs" icon={Trash2} label="Remove rule" onClick={() => remove(r)} />
                </m.div>
              ))}
            </AnimatePresence>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

export default CondFormatPopover;
