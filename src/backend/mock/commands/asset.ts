/** asset_* — uploads from grants or raw bytes, lookups, open/save, and remote image import (NetGuard rules). */
import { BackendError } from '../../errors';
import type { AssetDTO } from '../../types';
import type { MockHandlers } from '../ctx';
import { measureImage } from '../lib/assets';
import { vaultSettings } from '../lib/settings';
import { logNetwork } from './network';

const IMAGE_CAP = 20 * 1024 * 1024;
const UPLOAD_CAP = 512 * 1024 * 1024;
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|\[?f[cd][0-9a-f]{2}:|\[?fe80:)/i;

export const handlers: MockHandlers = {
  asset_import_grants: async (req, ctx) => {
    const out: AssetDTO[] = [];
    for (let i = 0; i < req.grantIds.length; i++) {
      ctx.checkCancelled();
      const file = ctx.grants.read(req.grantIds[i]);
      if (file.size > UPLOAD_CAP) throw new BackendError('TOO_LARGE', `${file.name} is larger than 512 MB`);
      const dims = await measureImage(file);
      out.push(
        ctx.assets.create({
          workspaceId: req.workspaceId,
          name: file.name,
          mime: file.type || 'application/octet-stream',
          blob: file,
          ...dims,
        }),
      );
      ctx.progress(i + 1, req.grantIds.length, file.name);
    }
    return out;
  },

  asset_import_bytes: async (req, ctx) => {
    const bytes = req.body instanceof ArrayBuffer ? new Uint8Array(req.body) : req.body;
    if (!bytes || !bytes.byteLength) throw new BackendError('INVALID', 'Empty file');
    if (bytes.byteLength > UPLOAD_CAP) throw new BackendError('TOO_LARGE', 'Files are limited to 512 MB');
    const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: req.mime || 'application/octet-stream' });
    const dims = await measureImage(blob);
    return ctx.assets.create({ workspaceId: req.workspaceId, name: req.name || 'file', mime: blob.type, blob, ...dims });
  },

  asset_get: (req, ctx) => req.ids.map((id) => ctx.assets.get(id)).filter((a): a is AssetDTO => !!a),

  asset_open_external: (req, ctx) => {
    const a = ctx.assets.get(req.id);
    if (!a) throw new BackendError('NOT_FOUND', 'File not found');
    if (typeof window !== 'undefined') window.open(a.url, '_blank', 'noopener');
  },

  asset_save_as: (req, ctx) => {
    const blob = ctx.assets.blob(req.id);
    if (!blob) throw new BackendError('NOT_FOUND', 'File not found');
    ctx.grants.write(req.grantId, blob);
  },

  asset_import_url: async (req, ctx) => {
    if (ctx.isOffline()) throw new BackendError('OFFLINE', 'Offline mode is on');
    if (vaultSettings(ctx).remoteImages === 'block') throw new BackendError('INVALID', 'Remote images are blocked in Settings');
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      throw new BackendError('INVALID', 'That is not a valid link', { field: 'url' });
    }
    if (url.protocol !== 'https:') throw new BackendError('INVALID', 'Only https images can be loaded', { field: 'url' });
    if (PRIVATE_HOST.test(url.hostname)) throw new BackendError('INVALID', 'Private network addresses are blocked', { field: 'url' });
    let res: Response;
    try {
      res = await fetch(url.href, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'follow' });
    } catch {
      throw new BackendError('NETWORK', `Couldn't reach ${url.hostname}`);
    }
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    logNetwork(ctx, { connector: 'remote-image', method: 'GET', host: url.hostname, path: url.pathname, status: res.status, bytes: Number(res.headers.get('content-length') ?? 0) });
    if (!res.ok) throw new BackendError('NETWORK', `${url.hostname} answered ${res.status}`);
    if (!/^image\/(png|jpeg|gif|webp|avif)$/.test(type)) throw new BackendError('INVALID', 'That link is not an image');
    const blob = await res.blob();
    if (blob.size > IMAGE_CAP) throw new BackendError('TOO_LARGE', 'Images are limited to 20 MB');
    const dims = await measureImage(blob);
    const name = decodeURIComponent(url.pathname.split('/').pop() || 'image');
    return ctx.assets.create({ workspaceId: req.workspaceId, name, mime: type, blob, source: 'remote', ...dims });
  },
};
