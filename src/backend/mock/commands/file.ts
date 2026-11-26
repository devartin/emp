/** file_pick / file_save_grant (§9.14): browser file picker and download-backed write grants. */
import type { MockHandlers } from '../ctx';

export const handlers: MockHandlers = {
  file_pick: (req, ctx) => {
    const exts = req.filters.flatMap((f) => f.extensions).filter((e) => e && e !== '*');
    const accept = req.purpose === 'image' && exts.length === 0 ? ['image/*'] : exts;
    return ctx.grants.pick(req.purpose, accept, req.multiple);
  },
  file_save_grant: (req, ctx) => ctx.grants.saveGrant(req.purpose, req.suggestedName),
};
