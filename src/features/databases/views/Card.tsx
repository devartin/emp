/**
 * Row card shared by Board and Gallery (§5.10 board card: radius 10, padding 10, gap 6): optional preview
 * (cover image from a files property, the row's first image, or a snippet of its page content), icon + title and
 * the view's visible properties as compact chips. Sizes S/M/L.
 */
import { FileText } from 'lucide-react';
import { memo, useEffect, useState, type CSSProperties, type ReactNode, type Ref } from 'react';
import { api } from '@/backend';
import type { CardSettings, Id, Property, RowDTO, TipTapNode } from '@/backend/types';
import { cn } from '@/lib/cn';
import { cellFor } from '../engine/filter';
import { isEmptyCell, plainText } from '../engine/values';
import { AssetThumb, CellView, RowIcon } from '../properties/CellView';

const contentCache = new Map<Id, { rev: number; lines: { kind: string; text: string }[]; image?: Id }>();

function walkDoc(nodes: TipTapNode[] | undefined, out: { kind: string; text: string }[], img: { id?: Id }) {
  for (const n of nodes ?? []) {
    if (out.length >= 6 && img.id) return;
    if (n.type === 'image' && !img.id && typeof n.attrs?.assetId === 'string') img.id = n.attrs.assetId as Id;
    if (['paragraph', 'heading', 'bulletItem', 'numberedItem', 'todoItem', 'quote', 'callout'].includes(n.type)) {
      const text = (n.content ?? []).map((c) => c.text ?? '').join('');
      if (text && out.length < 6) out.push({ kind: n.type === 'heading' ? 'h' : n.type === 'todoItem' ? (n.attrs?.checked ? 'done' : 'todo') : n.type === 'bulletItem' ? 'li' : 'p', text });
    }
    walkDoc(n.content, out, img);
  }
}

function useContent(row: RowDTO, enabled: boolean) {
  const [v, setV] = useState(() => contentCache.get(row.id));
  useEffect(() => {
    if (!enabled || !row.hasBody) return;
    const hit = contentCache.get(row.id);
    if (hit && hit.rev === row.updatedAt) return setV(hit);
    let live = true;
    api.db
      .rowGet({ id: row.id })
      .then((r) => {
        const lines: { kind: string; text: string }[] = [];
        const img: { id?: Id } = {};
        walkDoc(r.doc?.content, lines, img);
        const entry = { rev: row.updatedAt, lines, image: img.id };
        contentCache.set(row.id, entry);
        if (live) setV(entry);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [row.id, row.updatedAt, row.hasBody, enabled]);
  return v;
}

function firstImage(row: RowDTO, props: Property[], onlyProp?: Id): Id | undefined {
  for (const p of props) {
    if (p.type !== 'files' || (onlyProp && p.id !== onlyProp)) continue;
    const c = row.values[p.id];
    if (c?.t === 'files') {
      const f = c.v.find((x) => /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(x.name)) ?? c.v[0];
      if (f) return f.assetId;
    }
  }
  return undefined;
}

export interface CardProps {
  row: RowDTO;
  titleProp: Property;
  props: Property[];
  allProps: Property[];
  card: CardSettings;
  variant: 'board' | 'gallery';
  onOpen?: () => void;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLDivElement>;
  children?: ReactNode;
  dragging?: boolean;
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  editTitle?: boolean;
  onTitle?: (t: string) => void;
}

function CardImpl({ row, titleProp, props, allProps, card, variant, onOpen, className, style, ref, dragging, onPointerDown, editTitle, onTitle }: CardProps) {
  const preview = card.preview;
  const fileProp = preview !== 'none' && preview !== 'cover' && preview !== 'content' ? preview : undefined;
  const wantContent = preview === 'content' || preview === 'cover';
  const content = useContent(row, wantContent);
  const image = fileProp ? firstImage(row, allProps, fileProp) : preview === 'cover' ? (firstImage(row, allProps) ?? content?.image) : preview === 'content' ? content?.image : undefined;
  const titleCell = row.values[titleProp.id];
  const title = titleCell?.t === 'text' ? plainText(titleCell.v) : '';
  // Inline chips (tags, status, ratings) flow together first; full-width lines (dates, text, numbers) follow.
  const INLINE = new Set(['select', 'status', 'multi_select', 'checkbox', 'rating', 'unique_id', 'ticker', 'files']);
  const chips = props
    .filter((p) => p.id !== titleProp.id)
    .map((p) => ({ p, c: cellFor(row, p.type === 'created_time' ? '$created' : p.type === 'updated_time' ? '$updated' : p.id) }))
    .filter(({ p, c }) => !isEmptyCell(c) || p.type === 'checkbox')
    .sort((a, b) => Number(!INLINE.has(a.p.type)) - Number(!INLINE.has(b.p.type)));
  const showPreview = preview !== 'none' && (image || (preview === 'content' && content?.lines.length) || variant === 'gallery');
  const [draft, setDraft] = useState(title);
  return (
    <div
      ref={ref}
      className={cn('edb-card', `is-${variant}`, `size-${card.size}`, dragging && 'is-placeholder', className)}
      style={style}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen?.();
        }
      }}
      onPointerDown={onPointerDown}
      aria-label={title || 'Untitled'}
    >
      {showPreview ? (
        <div className={cn('edb-card-preview', card.fit && 'is-fit', !image && 'is-text')}>
          {image ? (
            <AssetThumb id={image} fit={card.fit} className="edb-card-img" />
          ) : content?.lines.length ? (
            <div className="edb-card-doc">
              {content.lines.map((l, i) => (
                <div key={i} className={cn('edb-doc-line', `is-${l.kind}`)}>
                  {l.kind === 'todo' || l.kind === 'done' ? <span className="edb-doc-box" data-done={l.kind === 'done' ? '' : undefined} /> : l.kind === 'li' ? <span className="edb-doc-dot" /> : null}
                  {l.text}
                </div>
              ))}
            </div>
          ) : (
            <div className="edb-card-blank">
              <FileText size={20} aria-hidden />
            </div>
          )}
        </div>
      ) : null}
      <div className="edb-card-body">
        <div className="edb-card-title">
          <RowIcon icon={row.icon} size={15} />
          {editTitle ? (
            <input
              autoFocus
              className="edb-card-title-input"
              value={draft}
              placeholder="Untitled"
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter' || e.key === 'Escape') onTitle?.(draft);
              }}
              onBlur={() => onTitle?.(draft)}
              aria-label="Title"
            />
          ) : (
            <span className={cn('edb-card-title-text', !title && 'is-empty')}>{title || 'Untitled'}</span>
          )}
        </div>
        {chips.length ? (
          <div className="edb-card-props">
            {chips.map(({ p, c }) => (
              <div key={p.id} className="edb-card-prop" data-type={p.type} title={p.name}>
                <CellView prop={p} cell={c} variant="card" readOnly />
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export const Card = memo(CardImpl);
