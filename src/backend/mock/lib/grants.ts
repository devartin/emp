/**
 * File grants (§9.14) emulated in the browser: `file_pick` opens an `<input type=file>`, `file_save_grant` returns a
 * write grant that downloads when written. Grants are single use and expire after 10 minutes.
 */
import { BackendError } from '../../errors';
import type { FileGrant, Id } from '../../types';
import type { GrantInfo, GrantsService, MockCtx } from '../ctx';
import { randomHex } from '../rng';

const TTL_MS = 10 * 60 * 1000;

export function createGrantsService(ctx: MockCtx): GrantsService {
  const grants = new Map<Id, GrantInfo>();

  const newId = () => `grant:${randomHex(ctx.rng, 16)}`;

  const add = (info: Omit<GrantInfo, 'grantId' | 'expiresAt' | 'used'>): FileGrant => {
    const grantId = newId();
    grants.set(grantId, { ...info, grantId, expiresAt: ctx.clock.now() + TTL_MS, used: false });
    return { grantId, displayName: info.displayName, size: info.size };
  };

  const take = (grantId: Id, mode: 'read' | 'write', purpose?: string): GrantInfo => {
    const g = grants.get(grantId);
    if (!g) throw new BackendError('INVALID', 'Unknown file grant', { field: 'grantId' });
    if (g.used) throw new BackendError('INVALID', 'This file grant was already used', { field: 'grantId' });
    if (g.expiresAt < ctx.clock.now()) throw new BackendError('INVALID', 'This file grant expired', { field: 'grantId' });
    if (g.mode !== mode) throw new BackendError('INVALID', 'Wrong kind of file grant', { field: 'grantId' });
    if (purpose && g.purpose !== purpose) throw new BackendError('INVALID', 'File grant purpose mismatch', { field: 'grantId' });
    g.used = true;
    return g;
  };

  return {
    pick(purpose, accept, multiple) {
      if (typeof document === 'undefined') return Promise.resolve([]);
      return new Promise<FileGrant[]>((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = multiple;
        if (accept.length) input.accept = accept.map((e) => (e.startsWith('.') || e.includes('/') ? e : `.${e}`)).join(',');
        input.style.position = 'fixed';
        input.style.left = '-9999px';
        let done = false;
        const finish = (files: File[]) => {
          if (done) return;
          done = true;
          input.remove();
          resolve(files.map((file) => add({ displayName: file.name, size: file.size, purpose, mode: 'read', file })));
        };
        input.addEventListener('change', () => finish(Array.from(input.files ?? [])));
        input.addEventListener('cancel', () => finish([]));
        document.body.appendChild(input);
        input.click();
      });
    },
    saveGrant(purpose, suggestedName) {
      return add({ displayName: suggestedName, size: 0, purpose, mode: 'write' });
    },
    read(grantId, purpose) {
      const g = take(grantId, 'read', purpose);
      if (!g.file) throw new BackendError('IO', 'The file is no longer available');
      return g.file;
    },
    write(grantId, data, mime = 'application/octet-stream') {
      const g = take(grantId, 'write');
      const blob = typeof data === 'string' ? new Blob([data], { type: mime }) : data;
      if (typeof document !== 'undefined' && typeof URL.createObjectURL === 'function') {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = g.displayName;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
      return blob.size;
    },
    register(file, purpose) {
      return add({ displayName: file.name, size: file.size, purpose, mode: 'read', file });
    },
  };
}
