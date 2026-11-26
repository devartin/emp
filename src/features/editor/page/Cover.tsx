/**
 * Page cover (§6.1): 280px tall (≤ 30vh). Gradients (aurora, dusk, mint, sand, slate, rose) or an uploaded image with
 * drag-to-reposition (posY 0..1). Hover shows Change / Reposition.
 */
import { m } from 'motion/react';
import { ImagePlus, Move, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Cover as CoverT, CoverGradient, Id } from '@/backend/types';
import { cn } from '@/lib/cn';
import { notify } from '@/stores/toasts';
import { Button } from '@/ui/Button';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/Popover';
import { cachedAsset, loadAsset, pickFiles, uploadBlob } from '../lib/assets';

export const GRADIENTS: { id: CoverGradient; label: string }[] = [
  { id: 'aurora', label: 'Aurora' },
  { id: 'dusk', label: 'Dusk' },
  { id: 'mint', label: 'Mint' },
  { id: 'sand', label: 'Sand' },
  { id: 'slate', label: 'Slate' },
  { id: 'rose', label: 'Rose' },
];

export function randomGradient(): CoverGradient {
  return GRADIENTS[Math.floor(Math.random() * GRADIENTS.length)].id;
}

export function CoverPicker({ workspaceId, onPick, onRemove, children }: { workspaceId: Id; onPick: (c: CoverT) => void; onRemove?: () => void; children: React.ReactElement }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="end" side="bottom" className="emp-cover-pop">
        <div className="emp-menu-header">Gradients</div>
        <div className="emp-cover-grid">
          {GRADIENTS.map((g) => (
            <button
              key={g.id}
              type="button"
              className="emp-cover-swatch"
              data-gradient={g.id}
              aria-label={g.label}
              title={g.label}
              onClick={() => {
                onPick({ t: 'gradient', v: g.id });
                setOpen(false);
              }}
            />
          ))}
        </div>
        <div className="emp-cover-pop-foot">
          <Button
            size="sm"
            variant="secondary"
            icon={Upload}
            loading={busy}
            onClick={async () => {
              const [f] = await pickFiles('image/png,image/jpeg,image/webp,image/gif,image/avif');
              if (!f) return;
              setBusy(true);
              try {
                const a = await uploadBlob(workspaceId, f, f.name);
                onPick({ t: 'asset', assetId: a.id, posY: 0.5 });
                setOpen(false);
              } catch (e) {
                notify.fromError(e, "Couldn't upload that image");
              } finally {
                setBusy(false);
              }
            }}
          >
            Upload image
          </Button>
          {onRemove ? (
            <Button
              size="sm"
              variant="ghost"
              icon={Trash2}
              onClick={() => {
                onRemove();
                setOpen(false);
              }}
            >
              Remove
            </Button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function Cover({ cover, workspaceId, readOnly, onChange }: { cover: CoverT; workspaceId: Id; readOnly: boolean; onChange: (c: CoverT | null) => void }) {
  const [url, setUrl] = useState<string | null>(() => (cover.t === 'asset' ? cachedAsset(cover.assetId)?.url ?? null : null));
  const [repositioning, setRepositioning] = useState(false);
  const [posY, setPosY] = useState(cover.t === 'asset' ? cover.posY : 0.5);
  const ref = useRef<HTMLDivElement>(null);
  const assetId = cover.t === 'asset' ? cover.assetId : null;

  useEffect(() => {
    if (!assetId) return;
    let live = true;
    void loadAsset(assetId).then((a) => live && setUrl(a?.url ?? null));
    return () => {
      live = false;
    };
  }, [assetId]);
  useEffect(() => {
    if (cover.t === 'asset') setPosY(cover.posY);
  }, [cover]);

  const startDrag = (e: React.PointerEvent) => {
    if (!repositioning) return;
    e.preventDefault();
    const el = ref.current;
    const img = el?.querySelector('img');
    if (!el || !img) return;
    const startY = e.clientY;
    const start = posY;
    const overflow = Math.max(1, img.getBoundingClientRect().height - el.getBoundingClientRect().height);
    const move = (ev: PointerEvent) => setPosY(Math.max(0, Math.min(1, start - (ev.clientY - startY) / overflow)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <m.div
      ref={ref}
      className={cn('emp-cover', repositioning && 'is-repositioning')}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: { duration: 0.16 } }}
      onPointerDown={startDrag}
    >
      {/* the art lives on its own layer so it can settle in from 1.02 (S22) without the cover box overflowing */}
      {cover.t === 'gradient' ? <div key={cover.v} className="emp-cover-art" data-gradient={cover.v} aria-hidden /> : null}
      {cover.t === 'asset' ? (
        url ? (
          <img key={url} src={url} alt="" draggable={false} style={{ objectPosition: `50% ${Math.round(posY * 100)}%` }} />
        ) : (
          <div className="emp-cover-loading" />
        )
      ) : null}
      {cover.t === 'gradient' ? <div className="emp-cover-grain" aria-hidden /> : null}
      {!readOnly ? (
        <div className="emp-cover-actions" data-visible={repositioning ? '' : undefined}>
          {repositioning ? (
            <>
              <span className="emp-cover-hint">Drag image to reposition</span>
              <button
                type="button"
                className="emp-cover-btn"
                onClick={() => {
                  setRepositioning(false);
                  if (cover.t === 'asset') onChange({ ...cover, posY: Math.round(posY * 1000) / 1000 });
                }}
              >
                Save position
              </button>
              <button
                type="button"
                className="emp-cover-btn"
                onClick={() => {
                  setRepositioning(false);
                  if (cover.t === 'asset') setPosY(cover.posY);
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <CoverPicker workspaceId={workspaceId} onPick={onChange} onRemove={() => onChange(null)}>
                <button type="button" className="emp-cover-btn">
                  <ImagePlus size={13} /> Change cover
                </button>
              </CoverPicker>
              {cover.t === 'asset' ? (
                <button type="button" className="emp-cover-btn" onClick={() => setRepositioning(true)}>
                  <Move size={13} /> Reposition
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </m.div>
  );
}
