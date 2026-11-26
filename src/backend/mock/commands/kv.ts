/** kv_get / kv_set / kv_get_many — UI state in `ui.*` namespaces (§10.2 kv). */
import { BackendError } from '../../errors';
import type { MockCtx, MockHandlers } from '../ctx';

interface KvRecord {
  id: string;
  ns: string;
  key: string;
  value: unknown;
  updatedAt: number;
}

const MAX_VALUE = 1024 * 1024;
const kid = (ns: string, key: string) => `${ns}\u0000${key}`;

function checkNs(ns: string) {
  if (typeof ns !== 'string' || !/^ui\.[a-zA-Z0-9_.-]{1,64}$/.test(ns)) {
    throw new BackendError('INVALID', 'kv namespaces must start with "ui."', { field: 'ns' });
  }
}

function checkKey(key: string) {
  if (typeof key !== 'string' || !key || key.length > 256) throw new BackendError('INVALID', 'Invalid key', { field: 'key' });
}

export function kvRead(ctx: MockCtx, ns: string, key: string): unknown | null {
  return ctx.db.table<KvRecord>('kv').get(kid(ns, key))?.value ?? null;
}

export function kvWrite(ctx: MockCtx, ns: string, key: string, value: unknown): void {
  const t = ctx.db.table<KvRecord>('kv');
  if (value === null || value === undefined) t.delete(kid(ns, key));
  else t.put({ id: kid(ns, key), ns, key, value, updatedAt: ctx.clock.now() });
}

export const handlers: MockHandlers = {
  kv_get: (req, ctx) => {
    checkNs(req.ns);
    checkKey(req.key);
    return kvRead(ctx, req.ns, req.key);
  },
  kv_set: (req, ctx) => {
    checkNs(req.ns);
    checkKey(req.key);
    if (JSON.stringify(req.value ?? null).length > MAX_VALUE) throw new BackendError('TOO_LARGE', 'Value too large');
    kvWrite(ctx, req.ns, req.key, req.value);
    // Getting Started items the UI reports (try `/`, open ⌘K, try ⌘⇧H …).
    if (req.ns === 'ui.gettingStarted' && req.value) ctx.events.internal('gettingStarted:tick', { item: req.key });
  },
  kv_get_many: (req, ctx) => {
    checkNs(req.ns);
    const out: Record<string, unknown> = {};
    for (const key of req.keys.slice(0, 500)) {
      const v = kvRead(ctx, req.ns, key);
      if (v !== null) out[key] = v;
    }
    return out;
  },
};
