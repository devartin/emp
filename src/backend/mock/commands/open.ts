/**
 * open_external / open_external_confirm (§9.13, §9.15): https, http (with warning) and mailto only. Unless the host
 * was remembered, the mock emits `open-external:confirm` and waits for the UI's answer.
 */
import { BackendError } from '../../errors';
import type { Id } from '../../types';
import type { MockHandlers } from '../ctx';
import { randomHex } from '../rng';

interface Pending {
  id: Id;
  url: string;
  host: string;
  at: number;
}

const URL_MAX = 4096;

function openInBrowser(url: string) {
  if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
}

export const handlers: MockHandlers = {
  open_external: (req, ctx) => {
    if (typeof req.url !== 'string' || req.url.length > URL_MAX) {
      throw new BackendError('INVALID', 'That link is too long', { field: 'url' });
    }
    let parsed: URL;
    try {
      parsed = new URL(req.url);
    } catch {
      throw new BackendError('INVALID', 'That is not a valid link', { field: 'url' });
    }
    if (!['https:', 'http:', 'mailto:'].includes(parsed.protocol)) {
      throw new BackendError('INVALID', `Links of type ${parsed.protocol} can't be opened`, { field: 'url' });
    }
    const host = parsed.protocol === 'mailto:' ? 'mail' : parsed.hostname;
    const remembered = new Set(ctx.db.meta<string[]>('open.rememberedHosts') ?? []);
    if (remembered.has(host) && parsed.protocol !== 'http:') {
      openInBrowser(parsed.href);
      return;
    }
    const requestId = `open:${randomHex(ctx.rng, 8)}`;
    ctx.db.table<Pending>('open_pending').put({ id: requestId, url: parsed.href, host, at: ctx.clock.now() });
    ctx.emit('open-external:confirm', {
      requestId,
      url: parsed.href,
      host,
      punycode: /(^|\.)xn--/.test(host),
    });
  },
  open_external_confirm: (req, ctx) => {
    const pending = ctx.db.table<Pending>('open_pending');
    const p = pending.get(req.requestId);
    if (!p) throw new BackendError('NOT_FOUND', 'That request expired');
    pending.delete(p.id);
    if (!req.allow) return;
    if (req.rememberHost) {
      const hosts = new Set(ctx.db.meta<string[]>('open.rememberedHosts') ?? []);
      hosts.add(p.host);
      ctx.db.setMeta('open.rememberedHosts', Array.from(hosts));
    }
    openInBrowser(p.url);
  },
};
