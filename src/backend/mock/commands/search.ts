/** search_query / search_status / search_reindex. The index "builds" briefly after each unlock. */
import { BackendError } from '../../errors';
import type { MockCtx, MockHandlers } from '../ctx';
import type { SearchEngine } from '../lib/search';

const QUERY_MAX = 512;

interface IndexState {
  ready: boolean;
  building: boolean;
  progress?: number;
}

const states = new WeakMap<object, IndexState>();
const stateOf = (ctx: MockCtx): IndexState => {
  const key = ctx.db;
  let s = states.get(key);
  if (!s) states.set(key, (s = { ready: true, building: false }));
  return s;
};

function build(ctx: MockCtx, ms = 260) {
  const s = stateOf(ctx);
  s.ready = false;
  s.building = true;
  s.progress = 0;
  setTimeout(() => {
    s.ready = true;
    s.building = false;
    delete s.progress;
    ctx.emit('search:ready', { docs: (ctx.search as SearchEngine).docCount() });
  }, ms);
}

export const handlers: MockHandlers = {
  search_query: (req, ctx) => {
    const started = performance.now();
    if (typeof req.q !== 'string' || req.q.length > QUERY_MAX) throw new BackendError('INVALID', 'Search is too long', { field: 'q' });
    const limit = Math.max(1, Math.min(200, req.limit || 20));
    const hits = (ctx.search as SearchEngine).query(req.q, req.filters, limit);
    return {
      reqId: req.reqId,
      hits,
      indexReady: stateOf(ctx).ready,
      tookMs: Math.round((performance.now() - started) * 10) / 10,
    };
  },
  search_status: (_req, ctx) => {
    const s = stateOf(ctx);
    const out: { ready: boolean; docs: number; building: boolean; progress?: number } = {
      ready: s.ready,
      docs: (ctx.search as SearchEngine).docCount(),
      building: s.building,
    };
    if (s.progress !== undefined) out.progress = s.progress;
    return out;
  },
  search_reindex: async (_req, ctx) => {
    const s = stateOf(ctx);
    s.ready = false;
    s.building = true;
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      ctx.checkCancelled();
      await ctx.sleep(45, ctx.signal);
      s.progress = i / steps;
      ctx.progress(i, steps, 'Indexing pages');
    }
    s.ready = true;
    s.building = false;
    delete s.progress;
    ctx.emit('search:ready', { docs: (ctx.search as SearchEngine).docCount() });
  },
};

export function setup(ctx: MockCtx): void {
  ctx.events.on('vault:unlocked', () => build(ctx));
  ctx.events.on('vault:locked', () => {
    const s = stateOf(ctx);
    s.ready = false;
    s.building = false;
  });
}
