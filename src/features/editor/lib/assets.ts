/** Asset helpers: cached `asset_get`, uploads through `asset_import_bytes`, data-URI conversion (§7.7, §9.15). */
import { api } from '@/backend';
import type { AssetDTO, Id } from '@/backend/types';

const cache = new Map<Id, AssetDTO>();
const inflight = new Map<Id, Promise<AssetDTO | null>>();

export function cachedAsset(id: Id | null | undefined): AssetDTO | undefined {
  return id ? cache.get(id) : undefined;
}

export function loadAsset(id: Id): Promise<AssetDTO | null> {
  const hit = cache.get(id);
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(id);
  if (!p) {
    p = api.asset
      .get({ ids: [id] })
      .then((list) => {
        const a = list[0] ?? null;
        if (a) cache.set(id, a);
        return a;
      })
      .catch(() => null)
      .finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  return p;
}

export const IMAGE_MAX = 10 * 1024 * 1024;

export async function uploadBlob(workspaceId: Id, blob: Blob, name: string): Promise<AssetDTO> {
  const body = new Uint8Array(await blob.arrayBuffer());
  const asset = await api.asset.importBytes({ body, workspaceId, name: name || 'file', mime: blob.type || 'application/octet-stream' });
  cache.set(asset.id, asset);
  return asset;
}

export function dataUriToBlob(uri: string): Blob | null {
  const m = /^data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(uri);
  if (!m) return null;
  try {
    const bin = atob(m[2].replace(/\s+/g, ''));
    if (bin.length > IMAGE_MAX) return null;
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: m[1].toLowerCase() });
  } catch {
    return null;
  }
}

export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve(Array.from(input.files ?? []));
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}
