/** network_activity / network_set_offline (§9.18 NetGuard log + offline mode). */
import type { NetworkLogEntry } from '../../types';
import type { MockCtx, MockHandlers } from '../ctx';
import { patchVaultSettings } from '../lib/settings';

export interface NetLogRecord extends NetworkLogEntry {
  id: string;
}

/** Other mocks call this when they "fetch" (market data, Google …) so the network log and indicator stay honest. */
export function logNetwork(ctx: MockCtx, entry: Omit<NetworkLogEntry, 'at'> & { at?: number }): void {
  const t = ctx.db.table<NetLogRecord>('net_log');
  const at = entry.at ?? ctx.clock.now();
  t.put({ ...entry, at, id: `${at}-${t.size}` });
  if (t.size > 1000) {
    const oldest = t.all().sort((a, b) => a.at - b.at).slice(0, t.size - 1000);
    for (const o of oldest) t.delete(o.id);
  }
  if (!ctx.seeding) ctx.emit('net:activity', { connector: entry.connector, host: entry.host });
}

export const handlers: MockHandlers = {
  network_activity: (req, ctx) => {
    const limit = Math.max(1, Math.min(1000, req.limit || 100));
    return ctx.db
      .table<NetLogRecord>('net_log')
      .all()
      .sort((a, b) => b.at - a.at)
      .slice(0, limit)
      .map(({ id: _id, ...e }) => e);
  },
  network_set_offline: (req, ctx) => {
    const s = patchVaultSettings(ctx, { offline: req.offline });
    return { offline: s.offline };
  },
};
