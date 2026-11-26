/** secret_list / secret_set / secret_delete — write-only secrets (values never leave the store). */
import { BackendError } from '../../errors';
import type { SecretInfo } from '../../types';
import type { MockCtx, MockHandlers } from '../ctx';
import { randomHex } from '../rng';

interface SecretRecord extends SecretInfo {
  /** Mock only: the desktop app encrypts this with k_secrets and never returns it. */
  value: string;
  updatedAt: number;
  rev: number;
}

const table = (ctx: MockCtx) => ctx.db.table<SecretRecord>('secrets');

const toInfo = ({ value: _v, updatedAt: _u, rev: _r, ...info }: SecretRecord): SecretInfo => info;

/** For other mocks (market providers, Google client): read a secret value by provider. */
export function secretValue(ctx: MockCtx, provider: string): string | undefined {
  const rec = table(ctx).find((s) => s.provider === provider);
  if (rec) rec.lastUsedAt = ctx.clock.now();
  return rec?.value;
}

export const handlers: MockHandlers = {
  secret_list: (_req, ctx) =>
    table(ctx)
      .all()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(toInfo),
  secret_set: (req, ctx) => {
    if (!req.value || req.value.length > 8192) throw new BackendError('INVALID', 'Enter a value', { field: 'value' });
    if (!req.label.trim()) throw new BackendError('INVALID', 'Give it a name', { field: 'label' });
    const now = ctx.clock.now();
    const last4 = req.showLast4 && req.value.length >= 8 ? req.value.slice(-4) : undefined;
    if (req.id) {
      const rec = table(ctx).require(req.id, 'Secret');
      table(ctx).update(rec.id, (r) => {
        r.value = req.value;
        r.label = req.label;
        r.provider = req.provider;
        r.kind = req.kind;
        r.updatedAt = now;
        if (last4) r.last4 = last4;
        else delete r.last4;
      });
      return toInfo(rec);
    }
    const rec: SecretRecord = {
      id: `secret:${randomHex(ctx.rng, 16)}`,
      provider: req.provider,
      label: req.label,
      kind: req.kind,
      createdAt: now,
      updatedAt: now,
      rev: 1,
      value: req.value,
    };
    if (last4) rec.last4 = last4;
    table(ctx).insert(rec);
    return toInfo(rec);
  },
  secret_delete: (req, ctx) => {
    if (!table(ctx).delete(req.id)) throw new BackendError('NOT_FOUND', 'Secret not found');
  },
};
