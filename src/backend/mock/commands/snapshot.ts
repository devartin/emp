/**
 * snapshot_list / snapshot_now / snapshot_set_folder / snapshot_verify (§9.21 `.empsnap`).
 *
 * Automatic snapshots run daily (and on quit, at most every 6 h) while encryption is on: a plaintext vault needs a
 * backup password first, so its snapshots are skipped and Security Center warns. Retention keeps 7 daily, 4 weekly
 * and 6 monthly snapshots (from the vault settings). Payloads sealed in this session stay in memory so `Verify`
 * re-checks the real MAC and digest; older entries (seeded history) verify their sealed manifest.
 */
import { BackendError } from '../../errors';
import type { SnapshotInfo } from '../../types';
import type { MockCallCtx, MockCtx, MockHandlers } from '../ctx';
import { patchVaultSettings, vaultSettings } from '../lib/settings';
import { vaultRecord } from '../lib/vault';
import { dumpDb, openContainer, parseContainer, sealContainer, sha256Hex, SNAPSHOT_MAGIC, vaultSecrets } from './backup';

const DAY = 86_400_000;

interface SnapshotRecord extends SnapshotInfo {
  /** SHA-256 of the sealed file. */
  digest: string;
  /** Digest of the manifest line (seeded history). */
  manifestDigest?: string;
  reason: 'daily' | 'quit' | 'manual';
  /** Mock fault injection: verification fails. */
  tampered?: boolean;
}

const table = (ctx: MockCtx) => ctx.db.table<SnapshotRecord>('snapshots');
/** Sealed files kept for this session (never persisted). */
const payloads = new WeakMap<object, Map<string, string>>();
const payloadsOf = (ctx: MockCtx) => {
  let m = payloads.get(ctx.db);
  if (!m) payloads.set(ctx.db, (m = new Map()));
  return m;
};

const toInfo = ({ id, at, bytes, schemaVersion, location }: SnapshotRecord): SnapshotInfo => ({ id, at, bytes, schemaVersion, location });

function snapshotsAllowed(ctx: MockCtx): boolean {
  const v = vaultRecord(ctx);
  return v.state === 'unlocked' && v.encrypted;
}

/** Seed a realistic history once (demo seed, encrypted vault), sized like a real sealed snapshot of this vault. */
async function ensureHistory(ctx: MockCtx): Promise<void> {
  if (ctx.db.meta<boolean>('snapshots.seeded')) return;
  ctx.db.setMeta('snapshots.seeded', true);
  if (ctx.seedKind !== 'demo' || !vaultRecord(ctx).encrypted) return;
  const now = ctx.clock.now();
  const created = vaultRecord(ctx).createdAt ?? now - 60 * DAY;
  const { text } = await sealContainer(ctx, await dumpDb(ctx), {}, SNAPSHOT_MAGIC);
  const base = new TextEncoder().encode(text).length;
  const ages = [2.2 / 24, 1, 2, 3, 4, 5, 6, 9, 16, 23, 30, 45, 61];
  for (const age of ages) {
    const at = Math.round(now - age * DAY - ctx.rng.float(0, 40) * 60_000);
    if (at < created) continue;
    const bytes = Math.round(base * (1 - age / 160) * ctx.rng.float(0.985, 1.015));
    table(ctx).put({
      id: `snap-${new Date(at).toISOString().slice(0, 19).replace(/[-:T]/g, '')}`,
      at,
      bytes,
      schemaVersion: 1,
      location: 'local',
      digest: '',
      manifestDigest: `seeded:${at}:${bytes}`,
      reason: age < 1 ? 'quit' : 'daily',
    });
  }
}

/** §9.21 retention: newest per day (7), per ISO week (4), per month (6). */
export function prune(ctx: MockCtx): number {
  const s = vaultSettings(ctx).snapshots;
  const all = table(ctx).all().sort((a, b) => b.at - a.at);
  const keep = new Set<string>();
  const bucket = (fmt: (d: Date) => string, n: number) => {
    const seen = new Set<string>();
    for (const r of all) {
      const k = fmt(new Date(r.at));
      if (seen.has(k)) continue;
      seen.add(k);
      if (seen.size > n) break;
      keep.add(r.id);
    }
  };
  bucket((d) => d.toISOString().slice(0, 10), s.keepDaily);
  bucket((d) => {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const y = t.getUTCFullYear();
    return `${y}-W${Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / DAY + 1) / 7)}`;
  }, s.keepWeekly);
  bucket((d) => d.toISOString().slice(0, 7), s.keepMonthly);
  let removed = 0;
  for (const r of all) {
    if (keep.has(r.id)) continue;
    table(ctx).delete(r.id);
    payloadsOf(ctx).delete(r.id);
    removed++;
  }
  return removed;
}

async function takeSnapshot(ctx: MockCtx, reason: SnapshotRecord['reason'], progress?: MockCallCtx): Promise<SnapshotRecord> {
  const p = (d: number, label: string) => progress?.progress(d, 5, label);
  const pause = (ms: number) => (progress ? progress.sleep(ms, progress.signal) : Promise.resolve());
  p(0, 'Saving pending changes');
  await pause(90);
  progress?.checkCancelled();
  p(1, 'Copying the database');
  const dump = await dumpDb(ctx, { signal: progress?.signal });
  await pause(120);
  p(2, 'Copying encrypted attachments');
  await pause(90);
  p(3, 'Sealing the snapshot');
  const { text } = await sealContainer(ctx, dump, { vault: vaultSecrets(ctx) }, SNAPSHOT_MAGIC);
  const digest = await sha256Hex(text);
  await pause(80);
  p(4, 'Applying retention');
  const at = ctx.clock.now();
  const folder = vaultSettings(ctx).snapshots.folderGrantLabel;
  const rec: SnapshotRecord = {
    id: `snap-${new Date(at).toISOString().slice(0, 19).replace(/[-:T]/g, '')}`,
    at,
    bytes: new TextEncoder().encode(text).length,
    schemaVersion: 1,
    location: folder ? 'folder' : 'local',
    digest,
    reason,
  };
  table(ctx).put(rec);
  payloadsOf(ctx).set(rec.id, text);
  prune(ctx);
  ctx.db.setMeta('snapshots.last', at);
  return rec;
}

export const handlers: MockHandlers = {
  snapshot_list: async (_req, ctx) => {
    await ensureHistory(ctx);
    return table(ctx)
      .all()
      .sort((a, b) => b.at - a.at)
      .map(toInfo);
  },

  snapshot_now: async (_req, ctx) => {
    await ensureHistory(ctx);
    if (!snapshotsAllowed(ctx)) {
      throw new BackendError('UNSUPPORTED', 'Automatic backups are off: set a backup password. Turn on encryption, or save a password-protected backup file instead.');
    }
    const rec = await takeSnapshot(ctx, 'manual', ctx);
    ctx.progress(5, 5, 'Done');
    return { id: rec.id };
  },

  snapshot_set_folder: (req, ctx) => {
    if (req.grantId !== null && (typeof req.grantId !== 'string' || !req.grantId.startsWith('grant:'))) {
      throw new BackendError('INVALID', 'Choose a folder', { field: 'grantId' });
    }
    const cur = vaultSettings(ctx).snapshots;
    if (req.grantId === null) {
      const { folderGrantLabel: _drop, ...rest } = cur;
      ctx.db.setMeta('settings.vault', { ...vaultSettings(ctx), snapshots: rest });
    } else {
      patchVaultSettings(ctx, { snapshots: { ...cur, folderGrantLabel: cur.folderGrantLabel ?? 'Chosen folder' } });
    }
  },

  snapshot_verify: async (req, ctx) => {
    const rec = table(ctx).require(req.id, 'Snapshot');
    const total = 4;
    ctx.progress(0, total, 'Reading the snapshot');
    await ctx.sleep(140, ctx.signal);
    ctx.checkCancelled();
    const text = payloadsOf(ctx).get(rec.id);
    ctx.progress(1, total, 'Checking the seal');
    await ctx.sleep(160, ctx.signal);
    if (rec.tampered) return { ok: false };
    if (text) {
      if ((await sha256Hex(text)) !== rec.digest) return { ok: false };
      try {
        const secrets = vaultSecrets(ctx);
        ctx.progress(2, total, 'Opening with your vault key');
        await openContainer(parseContainer(text), { password: secrets?.password });
      } catch (e) {
        if (e instanceof BackendError && (e.code === 'INTEGRITY' || e.code === 'CRYPTO')) return { ok: false };
        // Password changed since: the seal still verified above; restore will ask for the old password.
      }
    } else if (!rec.manifestDigest) {
      return { ok: false };
    }
    ctx.progress(3, total, 'Checking the database structure');
    await ctx.sleep(180, ctx.signal);
    ctx.progress(total, total, 'Verified');
    ctx.db.setMeta('snapshots.lastVerify', { id: rec.id, at: ctx.clock.now(), ok: true });
    return { ok: true };
  },
};

export function setup(ctx: MockCtx): void {
  // Daily automatic snapshot while unlocked and encrypted (checked once a minute; the real app also snapshots on quit).
  ctx.every(60_000, () => {
    const s = vaultSettings(ctx).snapshots;
    if (!s.enabled || !snapshotsAllowed(ctx) || ctx.seeding) return;
    const last = table(ctx).all().reduce((m, r) => Math.max(m, r.at), 0);
    if (ctx.clock.now() - last < DAY) return;
    void takeSnapshot(ctx, 'daily').catch(() => undefined);
  });
}
