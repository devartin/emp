/** row_secret_reveal (§8.1 `secret`, reauth): the only command that returns a secret's plaintext; the UI clears it after 30 s. */
import { BackendError } from '../../errors';
import type { MockHandlers } from '../ctx';

export const handlers: MockHandlers = {
  row_secret_reveal: (req, ctx) => {
    const row = ctx.db.table<{ id: string; deletedAt?: number; databaseId: string }>('db_rows').get(req.rowId);
    if (!row || row.deletedAt) throw new BackendError('NOT_FOUND', 'Row not found');
    const prop = ctx.db.table<{ id: string; type: string; databaseId: string; deletedAt?: number }>('db_properties').get(req.propertyId);
    if (!prop || prop.deletedAt || prop.type !== 'secret' || prop.databaseId !== row.databaseId) throw new BackendError('NOT_FOUND', 'Secret not found');
    const rec = ctx.db.table<{ id: string; value: string }>('db_secrets').get(`secret:${req.rowId}:${req.propertyId}`);
    if (!rec) throw new BackendError('NOT_FOUND', 'Nothing is stored here yet');
    ctx.vault.securityLog('secret_revealed');
    return { value: rec.value };
  },
};
