/** Asset store for the mock: metadata in 'assets', bytes in 'asset_blobs', served as blob: URLs. */
import type { AssetDTO, Id } from '../../types';
import type { AssetsService, MockCtx } from '../ctx';

export interface AssetRecord {
  id: Id;
  workspaceId: Id;
  name: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  source: string;
  originUrl?: string;
  createdAt: number;
  rev: number;
}

export function createAssetsService(ctx: MockCtx): AssetsService {
  const meta = () => ctx.db.table<AssetRecord>('assets');
  const blobs = () => ctx.db.table<{ id: Id; blob: Blob }>('asset_blobs');
  const urls = new Map<Id, string>();

  const urlFor = (id: Id): string => {
    const cached = urls.get(id);
    if (cached) return cached;
    const blob = blobs().get(id)?.blob;
    let url = `emp-asset://localhost/${id}`;
    if (blob && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      url = URL.createObjectURL(blob);
    }
    urls.set(id, url);
    return url;
  };

  const toDTO = (r: AssetRecord): AssetDTO => {
    const dto: AssetDTO = { id: r.id, name: r.name, mime: r.mime, size: r.size, url: urlFor(r.id) };
    if (r.width) dto.width = r.width;
    if (r.height) dto.height = r.height;
    return dto;
  };

  return {
    create(input) {
      const rec: AssetRecord = {
        id: ctx.id(),
        workspaceId: input.workspaceId ?? ctx.workspaceId(),
        name: input.name,
        mime: input.mime,
        size: input.blob.size,
        source: input.source ?? 'upload',
        createdAt: ctx.clock.now(),
        rev: 1,
      };
      if (input.width) rec.width = input.width;
      if (input.height) rec.height = input.height;
      meta().insert(rec);
      blobs().put({ id: rec.id, blob: input.blob });
      return toDTO(rec);
    },
    get(id) {
      const r = meta().get(id);
      return r ? toDTO(r) : undefined;
    },
    blob(id) {
      return blobs().get(id)?.blob;
    },
  };
}

/** Best-effort image dimensions (browser only). */
export async function measureImage(blob: Blob): Promise<{ width?: number; height?: number }> {
  if (!blob.type.startsWith('image/')) return {};
  try {
    if (typeof createImageBitmap === 'function' && blob.type !== 'image/svg+xml') {
      const bmp = await createImageBitmap(blob);
      const out = { width: bmp.width, height: bmp.height };
      bmp.close();
      return out;
    }
    if (blob.type === 'image/svg+xml') {
      const text = await blob.text();
      const m = /viewBox="\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)\s*"/.exec(text);
      if (m) return { width: Math.round(Number(m[1])), height: Math.round(Number(m[2])) };
    }
  } catch {
    /* unknown format */
  }
  return {};
}
