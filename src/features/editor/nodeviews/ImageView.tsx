/**
 * Image block (§7.1, §9.15): `src` is always an asset. Pasted data URIs and dropped files upload on mount; remote URLs
 * become a "Remote image · Load" placeholder that fetches through NetGuard on request. Resize handles (width), align,
 * caption, replace, open.
 */
import type { NodeViewProps } from '@tiptap/react';
import { NodeSelection } from '@tiptap/pm/state';
import { AlignCenter, AlignLeft, AlignRight, ArrowUpRight, Globe, ImagePlus, Link2, Loader2, RefreshCw, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/backend';
import type { AssetDTO } from '@/backend/types';
import { cn } from '@/lib/cn';
import { notify } from '@/stores/toasts';
import { useSettings } from '@/stores/settings';
import { Button } from '@/ui/Button';
import { cachedAsset, dataUriToBlob, loadAsset, pickFiles, uploadBlob } from '../lib/assets';
import { editorContext } from '../lib/context';

type Align = 'left' | 'center' | 'right';

export default function ImageView({ node, updateAttributes, editor, getPos, selected }: NodeViewProps) {
  const { assetId, width, align, caption, pendingUrl } = node.attrs as { assetId: string | null; width: number | null; align: Align; caption: string; pendingUrl: string | null };
  const [asset, setAsset] = useState<AssetDTO | null>(() => cachedAsset(assetId) ?? null);
  const [busy, setBusy] = useState(false);
  const [linkMode, setLinkMode] = useState(false);
  const [link, setLink] = useState('');
  const [dragW, setDragW] = useState<number | null>(null);
  const [captionDraft, setCaptionDraft] = useState(caption);
  const frame = useRef<HTMLDivElement>(null);
  const readOnly = !editor.isEditable;
  const ctx = editorContext(editor);
  const remotePolicy = useSettings((s) => s.vault?.remoteImages ?? 'ask');

  useEffect(() => setCaptionDraft(caption), [caption]);

  useEffect(() => {
    let live = true;
    if (assetId) void loadAsset(assetId).then((a) => live && setAsset(a));
    else setAsset(null);
    return () => {
      live = false;
    };
  }, [assetId]);

  // data: and blob: sources upload immediately (images are never inlined).
  useEffect(() => {
    if (!pendingUrl || assetId || readOnly) return;
    const local = pendingUrl.startsWith('data:') || pendingUrl.startsWith('blob:');
    if (!local) {
      if (remotePolicy === 'allow') void loadRemote();
      return;
    }
    let live = true;
    setBusy(true);
    void (async () => {
      try {
        const blob = pendingUrl.startsWith('data:') ? dataUriToBlob(pendingUrl) : await fetch(pendingUrl).then((r) => r.blob());
        if (!blob) throw new Error('Unsupported image');
        const a = await uploadBlob(ctx.workspaceId, blob, `image.${(blob.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg')}`);
        if (pendingUrl.startsWith('blob:')) URL.revokeObjectURL(pendingUrl);
        if (live) updateAttributes({ assetId: a.id, pendingUrl: null });
      } catch (e) {
        notify.fromError(e, "Couldn't add that image");
      } finally {
        if (live) setBusy(false);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingUrl, assetId, readOnly]);

  const select = () => {
    const pos = getPos();
    if (typeof pos === 'number') editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
  };

  async function upload(files?: File[]) {
    const list = files ?? (await pickFiles('image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml'));
    const f = list[0];
    if (!f) return;
    setBusy(true);
    try {
      const a = await uploadBlob(ctx.workspaceId, f, f.name);
      updateAttributes({ assetId: a.id, pendingUrl: null });
    } catch (e) {
      notify.fromError(e, "Couldn't upload that image");
    } finally {
      setBusy(false);
    }
  }

  async function loadRemote(url = pendingUrl ?? link) {
    if (!url) return;
    setBusy(true);
    try {
      const a = await api.asset.importUrl({ workspaceId: ctx.workspaceId, url });
      updateAttributes({ assetId: a.id, pendingUrl: null });
      setLinkMode(false);
    } catch (e) {
      notify.fromError(e, "Couldn't load that image");
    } finally {
      setBusy(false);
    }
  }

  // ── empty / pending states
  if (!assetId) {
    if (pendingUrl && !pendingUrl.startsWith('data:') && !pendingUrl.startsWith('blob:')) {
      let host = '';
      try {
        host = new URL(pendingUrl).hostname;
      } catch {
        host = 'the web';
      }
      return (
        <div className="emp-img-placeholder is-remote" onClick={select}>
          <Globe size={18} className="text-tertiary" />
          <div className="emp-img-ph-text">
            <span className="emp-img-ph-title">Remote image</span>
            <span className="emp-img-ph-sub">From {host}. Loading it contacts that site.</span>
          </div>
          {!readOnly ? (
            <Button size="sm" variant="secondary" loading={busy} disabled={remotePolicy === 'block'} disabledReason={remotePolicy === 'block' ? 'Remote images are blocked in Settings' : undefined} onClick={() => void loadRemote()}>
              Load
            </Button>
          ) : null}
        </div>
      );
    }
    if (busy || pendingUrl) {
      return (
        <div className="emp-img-placeholder">
          <Loader2 size={16} className="emp-spin text-tertiary" />
          <span className="emp-img-ph-sub">Adding image…</span>
          {pendingUrl?.startsWith('blob:') ? <img className="emp-img-pending" src={pendingUrl} alt="" /> : null}
        </div>
      );
    }
    if (readOnly) return <div className="emp-img-placeholder"><ImagePlus size={18} className="text-tertiary" /><span className="emp-img-ph-sub">Empty image</span></div>;
    return (
      <div
        className={cn('emp-img-placeholder is-empty', selected && 'is-selected')}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            e.currentTarget.setAttribute('data-over', '');
          }
        }}
        onDragLeave={(e) => e.currentTarget.removeAttribute('data-over')}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          e.currentTarget.removeAttribute('data-over');
          void upload(Array.from(e.dataTransfer.files));
        }}
      >
        <ImagePlus size={18} className="text-tertiary" />
        {linkMode ? (
          <form
            className="emp-img-link"
            onSubmit={(e) => {
              e.preventDefault();
              void loadRemote(link);
            }}
          >
            <input autoFocus className="emp-img-link-input" placeholder="https://…/photo.jpg" value={link} onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setLinkMode(false)} />
            <Button size="sm" variant="primary" type="submit" loading={busy} disabled={!link}>
              Embed
            </Button>
          </form>
        ) : (
          <>
            <span className="emp-img-ph-title">Add an image</span>
            <span className="emp-img-ph-sub">Drop a file, paste, or</span>
            <span className="flex-1" />
            <Button size="sm" variant="secondary" icon={Upload} onClick={() => void upload()}>
              Upload
            </Button>
            <Button size="sm" variant="ghost" icon={Link2} onClick={() => setLinkMode(true)}>
              Embed link
            </Button>
          </>
        )}
      </div>
    );
  }

  // ── image
  const natural = asset?.width ?? null;
  const w = dragW ?? width ?? null;
  const startResize = (side: 'left' | 'right') => (e: React.PointerEvent) => {
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    const el = frame.current;
    if (!el) return;
    const startX = e.clientX;
    const startW = el.getBoundingClientRect().width;
    const max = el.parentElement?.getBoundingClientRect().width ?? startW;
    const factor = align === 'center' ? 2 : 1;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) * (side === 'right' ? 1 : -1) * factor;
      setDragW(Math.round(Math.max(96, Math.min(max, startW + dx))));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const dx = (ev.clientX - startX) * (side === 'right' ? 1 : -1) * factor;
      const final = Math.round(Math.max(96, Math.min(max, startW + dx)));
      setDragW(null);
      updateAttributes({ width: final >= max - 2 ? null : final });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <figure className="emp-img" data-align={align}>
      <div ref={frame} className={cn('emp-img-frame', selected && 'is-selected', dragW != null && 'is-resizing')} style={{ width: w ? `${w}px` : natural ? `min(100%, ${natural}px)` : '100%' }} onClick={select}>
        {asset ? <img src={asset.url} alt={caption || asset.name} draggable={false} width={asset.width} height={asset.height} /> : <div className="emp-img-loading" style={{ aspectRatio: '16 / 9' }} />}
        {!readOnly ? (
          <>
            <span className="emp-img-handle" data-side="left" onPointerDown={startResize('left')} />
            <span className="emp-img-handle" data-side="right" onPointerDown={startResize('right')} />
            <div className="emp-img-toolbar" onMouseDown={(e) => e.preventDefault()}>
              {(['left', 'center', 'right'] as Align[]).map((a) => {
                const I = a === 'left' ? AlignLeft : a === 'center' ? AlignCenter : AlignRight;
                return (
                  <button key={a} type="button" className="emp-img-tool" data-active={align === a ? '' : undefined} aria-label={`Align ${a}`} onClick={() => updateAttributes({ align: a })}>
                    <I size={14} />
                  </button>
                );
              })}
              <span className="emp-img-tool-sep" />
              <button type="button" className="emp-img-tool" aria-label="Replace image" onClick={() => void upload()}>
                <RefreshCw size={14} />
              </button>
              <button type="button" className="emp-img-tool" aria-label="Open original" onClick={() => assetId && void api.asset.openExternal({ id: assetId })}>
                <ArrowUpRight size={14} />
              </button>
            </div>
          </>
        ) : null}
      </div>
      {!readOnly || caption ? (
        <input
          className="emp-img-caption"
          value={captionDraft}
          readOnly={readOnly}
          placeholder="Write a caption…"
          onChange={(e) => setCaptionDraft(e.target.value)}
          onBlur={() => captionDraft !== caption && updateAttributes({ caption: captionDraft.slice(0, 500) })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
              editor.commands.focus();
            }
          }}
          data-empty={captionDraft ? undefined : ''}
        />
      ) : null}
    </figure>
  );
}
