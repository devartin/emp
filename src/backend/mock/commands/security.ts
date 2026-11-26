/** security_log — newest first. */
import type { MockHandlers } from '../ctx';

export const handlers: MockHandlers = {
  security_log: (req, ctx) =>
    ctx.db
      .table<{ id: string; at: number; event: string }>('security_log')
      .all()
      .sort((a, b) => b.at - a.at)
      .slice(0, Math.max(1, Math.min(1000, req.limit || 50)))
      .map(({ at, event }) => ({ at, event })),
};
