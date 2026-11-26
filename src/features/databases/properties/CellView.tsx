/**
 * Read-only rendering of a cell for every property type (table cells, cards, list rows, the row page).
 * Interactive shortcuts that don't need an editor (checkbox toggle, rating click) are handled here via `onChange`.
 */
import { AlertCircle, ArrowUpRight, Check, FileText, Lock, Paperclip, Repeat, Star, Heart, Image as ImageIcon } from 'lucide-react';
import { memo, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { api } from '@/backend';
import type { AssetDTO, CellValue, Icon, Property, RichText } from '@/backend/types';
import { cn } from '@/lib/cn';
import { formatNumber, MINUS } from '@/lib/format';
import { useQuote } from '@/stores/market';
import { Checkbox } from '@/ui/Checkbox';
import { Ring } from '@/ui/Ring';
import { Sensitive } from '@/ui/Sensitive';
import { Tag } from '@/ui/Tag';
import { loadAsset, cachedAsset } from '@/features/editor/lib/assets';
import { describeRRule, formatCell, numberConfig, tickerLabel } from '../engine/format';
import { familyOf } from '../engine/schema';
import { isEmptyCell, optionById, optionsOf, plainText, type SelectOption } from '../engine/values';
import { relationCache } from '../store';

export type CellVariant = 'table' | 'card' | 'page' | 'list';

export interface CellViewProps {
  prop: Property;
  cell: CellValue | undefined;
  variant?: CellVariant;
  wrap?: boolean;
  onChange?: (v: CellValue | null) => void;
  readOnly?: boolean;
}

export function RowIcon({ icon, size = 16 }: { icon?: Icon; size?: number }) {
  if (!icon) return null;
  if (icon.t === 'emoji') return <span className="edb-row-emoji" style={{ fontSize: size * 0.95, lineHeight: 1 }} aria-hidden>{icon.v}</span>;
  return <FileText size={size} className="text-tertiary" aria-hidden />;
}

function RichSpan({ v }: { v: RichText }) {
  if (!v.length) return null;
  return (
    <>
      {v.map((s, i) => {
        const types = new Set((s.marks ?? []).map((m) => m.type));
        let el: ReactNode = s.text;
        if (types.has('code')) el = <code className="edb-code">{el}</code>;
        if (types.has('bold')) el = <strong>{el}</strong>;
        if (types.has('italic')) el = <em>{el}</em>;
        if (types.has('strike')) el = <s>{el}</s>;
        return <span key={i}>{el}</span>;
      })}
    </>
  );
}

const STATUS_GLYPH: Record<string, ReactNode> = {
  todo: <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden><circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.2 1.6" /></svg>,
  in_progress: <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden><circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M6 1.5a4.5 4.5 0 0 1 0 9z" fill="currentColor" /></svg>,
  complete: <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden><circle cx="6" cy="6" r="5.25" fill="currentColor" /><path d="M3.7 6.1 5.2 7.6 8.3 4.4" fill="none" stroke="var(--bg-canvas)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>,
};

export function OptionTag({ opt, status, onRemove }: { opt: SelectOption; status?: boolean; onRemove?: () => void }) {
  return (
    <Tag color={opt.color} onRemove={onRemove} removeOnHover className={cn(status && 'edb-status-tag')}>
      {status ? <span className="edb-status-glyph">{STATUS_GLYPH[opt.group ?? 'todo']}</span> : null}
      {opt.name}
    </Tag>
  );
}

function urlLabel(u: string): string {
  try {
    const x = new URL(u);
    if (x.protocol === 'mailto:') return x.pathname;
    return (x.host.replace(/^www\./, '') + (x.pathname === '/' ? '' : x.pathname)).replace(/\/$/, '');
  } catch {
    return u;
  }
}

export function openUrl(url: string) {
  void api.open.external({ url }).catch(() => undefined);
}

function useAsset(id: string): AssetDTO | undefined {
  const [a, setA] = useState(() => cachedAsset(id));
  useEffect(() => {
    if (a?.id === id) return;
    let live = true;
    void loadAsset(id).then((x) => live && x && setA(x));
    return () => {
      live = false;
    };
  }, [id, a?.id]);
  return a;
}

export function AssetThumb({ id, className, fit }: { id: string; className?: string; fit?: boolean }) {
  const a = useAsset(id);
  if (!a) return <span className={cn('edb-thumb-skeleton', className)} />;
  if (!a.mime.startsWith('image/')) return <span className={cn('edb-file-glyph', className)}><Paperclip size={14} aria-hidden /></span>;
  return <img src={a.url} alt="" draggable={false} className={cn(className)} style={{ objectFit: fit ? 'contain' : 'cover' }} loading="lazy" />;
}

function FileChip({ f }: { f: { assetId: string; name: string } }) {
  const a = useAsset(f.assetId);
  const isImg = a?.mime.startsWith('image/') ?? /\.(png|jpe?g|gif|webp|svg)$/i.test(f.name);
  return (
    <span className="edb-chip edb-file-chip" title={f.name}>
      {isImg && a ? <img src={a.url} alt="" className="edb-file-img" /> : isImg ? <ImageIcon size={12} aria-hidden /> : <Paperclip size={12} aria-hidden />}
      <span className="truncate">{f.name}</span>
    </span>
  );
}

function RelationChips({ prop, ids, variant }: { prop: Property; ids: string[]; variant: CellVariant }) {
  useSyncExternalStore(relationCache.subscribe, relationCache.getVersion, relationCache.getVersion);
  useEffect(() => relationCache.ensure(prop), [prop]);
  if (!ids.length) return null;
  const shown = variant === 'card' ? ids.slice(0, 3) : ids;
  return (
    <>
      {shown.map((id) => {
        const t = relationCache.title(prop.id, id);
        return (
          <span key={id} className="edb-chip edb-rel-chip">
            {t?.icon?.t === 'emoji' ? <span aria-hidden>{t.icon.v}</span> : <ArrowUpRight size={12} aria-hidden className="text-tertiary" />}
            <span className="truncate">{t?.title ?? '…'}</span>
          </span>
        );
      })}
      {shown.length < ids.length ? <span className="edb-more">+{ids.length - shown.length}</span> : null}
    </>
  );
}

function TickerChip({ sym }: { sym: string }) {
  const q = useQuote(sym);
  const up = (q?.change ?? 0) >= 0;
  return (
    <span className="edb-ticker">
      <span className="edb-ticker-sym">{tickerLabel(sym)}</span>
      {q ? (
        <Sensitive className={cn('edb-ticker-q', up ? 'text-gain-text' : 'text-loss-text')}>
          {formatNumber(q.price, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          <span className="edb-ticker-pct">{(up ? '+' : MINUS) + Math.abs(q.changePct * 100).toFixed(2)}%</span>
        </Sensitive>
      ) : null}
    </span>
  );
}

export function RatingStars({ value, max, icon, onChange, size = 14 }: { value: number | null; max: number; icon?: string; onChange?: (n: number | null) => void; size?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const I = icon === 'heart' ? Heart : Star;
  const shown = hover ?? value ?? 0;
  return (
    <span className="edb-rating" data-icon={icon === 'heart' ? 'heart' : 'star'} onMouseLeave={() => setHover(null)} role={onChange ? 'radiogroup' : undefined} aria-label={`${value ?? 0} of ${max}`}>
      {Array.from({ length: max }, (_, i) => (
        <span
          key={i}
          role={onChange ? 'radio' : undefined}
          aria-checked={onChange ? (value ?? 0) === i + 1 : undefined}
          className="edb-rating-star"
          data-on={i < shown ? '' : undefined}
          onMouseEnter={onChange ? () => setHover(i + 1) : undefined}
          onClick={
            onChange
              ? (e) => {
                  e.stopPropagation();
                  onChange(value === i + 1 ? null : i + 1);
                }
              : undefined
          }
        >
          <I size={size} aria-hidden />
        </span>
      ))}
    </span>
  );
}

export function ProgressView({ value, display, label = true }: { value: number; display: 'bar' | 'ring'; label?: boolean }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const done = pct >= 100;
  if (display === 'ring')
    return (
      <span className="edb-progress-ring">
        <Ring value={value} size={16} color={done ? 'var(--gain)' : undefined} />
        {label ? <span className="tabular-nums">{pct}%</span> : null}
      </span>
    );
  return (
    <span className="edb-progress">
      <span className="edb-progress-track">
        <span className="edb-progress-fill" data-done={done ? '' : undefined} style={{ transform: `scaleX(${pct / 100})` }} />
      </span>
      {label ? <span className="edb-progress-label tabular-nums">{pct}%</span> : null}
    </span>
  );
}

function NumberView({ prop, n, text }: { prop: Property; n: number; text: string }) {
  const cfg = numberConfig(prop);
  if (cfg.display === 'bar' || cfg.display === 'ring') {
    const max = cfg.divideBy ?? (cfg.format === 'percent' ? 1 : 100);
    const frac = Math.max(0, Math.min(1, n / max));
    if (cfg.display === 'ring')
      return (
        <span className="edb-progress-ring">
          <Ring value={frac} size={16} color={frac >= 1 ? 'var(--gain)' : undefined} />
          <Sensitive className="tabular-nums">{text}</Sensitive>
        </span>
      );
    return (
      <span className="edb-progress">
        <span className="edb-progress-track">
          <span className="edb-progress-fill" style={{ transform: `scaleX(${frac})` }} />
        </span>
        <Sensitive className="edb-progress-label tabular-nums">{text}</Sensitive>
      </span>
    );
  }
  return <Sensitive align="end" className="tabular-nums">{text}</Sensitive>;
}

function ComputedView({ prop, cell, variant }: { prop: Property; cell: Extract<CellValue, { t: 'computed' }>; variant: CellVariant }) {
  const v = cell.v;
  if (!v) return null;
  if (v.kind === 'error')
    return (
      <span className="edb-error" title={String(v.value ?? v.display)}>
        <AlertCircle size={12} aria-hidden /> {variant === 'table' ? 'Error' : String(v.value ?? 'Error')}
      </span>
    );
  if (v.kind === 'bool') return <span className="edb-bool" data-on={v.value ? '' : undefined}>{v.value ? <Check size={12} strokeWidth={3} aria-hidden /> : null}</span>;
  if (v.kind === 'number' || v.kind === 'money') {
    if (prop.type === 'rollup' && /pct_/.test(String(prop.config.fn ?? '')) && typeof v.value === 'number') return <ProgressView value={v.value} display="bar" />;
    return <Sensitive align="end" className="tabular-nums">{v.display}</Sensitive>;
  }
  if (v.kind === 'list' && Array.isArray(v.value)) {
    return (
      <>
        {(v.value as unknown[]).slice(0, variant === 'card' ? 4 : 50).map((x, i) => (
          <span key={i} className="edb-chip">
            {String(x)}
          </span>
        ))}
      </>
    );
  }
  return <span className="edb-text">{v.display}</span>;
}

/**
 * Lightweight checkbox for dense grids: the same `.emp-check` skin as the UI kit without Radix Presence (which reads
 * computed styles per instance — too slow for thousands of virtualised cells). The check draws in over 180ms.
 */
export function MiniCheck({ checked, indeterminate, onChange, disabled, label }: { checked: boolean; indeterminate?: boolean; onChange?: (v: boolean) => void; disabled?: boolean; label: string }) {
  const state = indeterminate ? 'indeterminate' : checked ? 'checked' : 'unchecked';
  return (
    <span className="emp-check-hit">
      <button
        type="button"
        role="checkbox"
        aria-checked={indeterminate ? 'mixed' : checked}
        aria-label={label}
        className="emp-check edb-minicheck"
        data-state={state}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          onChange?.(!checked);
        }}
      >
        {indeterminate ? <span className="emp-check-bar" /> : checked ? (
          <svg viewBox="0 0 12 12" fill="none" aria-hidden>
            <path d="M2.5 6.4 4.9 8.7 9.6 3.6" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" className="edb-check-path" />
          </svg>
        ) : null}
      </button>
    </span>
  );
}

function CellViewImpl({ prop, cell, variant = 'table', wrap, onChange, readOnly }: CellViewProps) {
  const c = cell;
  if (prop.type === 'checkbox') {
    const on = c?.t === 'check' ? c.v : false;
    if (variant === 'table' || variant === 'card' || variant === 'list')
      return (
        <span className="edb-checkbox" onClick={(e) => e.stopPropagation()}>
          <MiniCheck checked={on} disabled={readOnly || !onChange} onChange={(v) => onChange?.({ t: 'check', v })} label={prop.name} />
        </span>
      );
    return (
      <span className="edb-checkbox" onClick={(e) => e.stopPropagation()}>
        <Checkbox checked={on} disabled={readOnly || !onChange} onCheckedChange={(v) => onChange?.({ t: 'check', v })} aria-label={prop.name} />
      </span>
    );
  }
  if (prop.type === 'rating') {
    const n = c?.t === 'rating' ? c.v : null;
    if (!n && !onChange) return null;
    return <RatingStars value={n} max={Number(prop.config.max ?? 5)} icon={String(prop.config.icon ?? 'star')} onChange={readOnly ? undefined : onChange ? (x) => onChange({ t: 'rating', v: x }) : undefined} />;
  }
  if (!c || isEmptyCell(c)) return null;
  switch (c.t) {
    case 'text':
      return (
        <span className={cn('edb-text', wrap && 'edb-wrap')}>
          <RichSpan v={c.v} />
        </span>
      );
    case 'number':
      return <NumberView prop={prop} n={c.v ?? 0} text={formatCell(c, prop)} />;
    case 'money':
      return <Sensitive align="end" className={cn('tabular-nums', Number(c.v) < 0 && 'text-loss-text')}>{formatCell(c, prop)}</Sensitive>;
    case 'select':
    case 'status': {
      const o = optionById(prop, c.v);
      return o ? <OptionTag opt={o} status={c.t === 'status'} /> : null;
    }
    case 'multi': {
      const opts = optionsOf(prop);
      return (
        <span className={cn('edb-tags', wrap && 'edb-wrap')}>
          {c.v.map((id) => {
            const o = opts.find((x) => x.id === id);
            return o ? <OptionTag key={id} opt={o} /> : null;
          })}
        </span>
      );
    }
    case 'date':
    case 'ts':
      return <span className="edb-date">{formatCell(c, prop)}</span>;
    case 'url':
      return (
        <a
          className="edb-link"
          href={c.v ?? '#'}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (c.v) openUrl(c.v);
          }}
          title={c.v ?? ''}
        >
          {urlLabel(c.v ?? '')}
        </a>
      );
    case 'email':
      return (
        <a
          className="edb-link"
          href={`mailto:${c.v}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openUrl(`mailto:${c.v}`);
          }}
        >
          {c.v}
        </a>
      );
    case 'phone':
      return <span className="edb-text tabular-nums">{c.v}</span>;
    case 'files':
      return (
        <span className="edb-tags">
          {c.v.slice(0, variant === 'card' ? 2 : 20).map((f) => (
            <FileChip key={f.assetId} f={f} />
          ))}
        </span>
      );
    case 'relation':
      return (
        <span className={cn('edb-tags', wrap && 'edb-wrap')}>
          <RelationChips prop={prop} ids={c.v} variant={variant} />
        </span>
      );
    case 'uid':
      return <span className="edb-uid">{c.v}</span>;
    case 'progress':
      return <ProgressView value={c.v ?? 0} display={prop.config.display === 'ring' ? 'ring' : 'bar'} />;
    case 'ticker':
      return c.v ? <TickerChip sym={c.v} /> : null;
    case 'recurrence':
      return (
        <span className="edb-recur">
          <Repeat size={12} aria-hidden />
          <span className="truncate">{describeRRule(c.v)}</span>
        </span>
      );
    case 'secret':
      return (
        <span className="edb-secret">
          <Lock size={12} aria-hidden />
          {c.v?.masked}
        </span>
      );
    case 'computed':
      return <ComputedView prop={prop} cell={c} variant={variant} />;
    default:
      return <span className="edb-text">{plainText([])}</span>;
  }
}

export const CellView = memo(CellViewImpl);

/** Right-align numeric columns in tables. */
export function isRightAligned(p: Property): boolean {
  const f = familyOf(p);
  if (p.type === 'rating' || p.type === 'progress') return false;
  if (p.type === 'number' && (p.config.display === 'bar' || p.config.display === 'ring')) return false;
  if ((p.type === 'rollup' || p.type === 'formula') && f === 'number') return true;
  return p.type === 'number' || p.type === 'money';
}
