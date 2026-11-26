/**
 * Version history (D-24): keep everything for 24 h at 10-minute granularity, hourly for 7 days, daily for 90 days,
 * then weekly; cap 500 per target. Manual and pre_* versions are always kept (until the cap).
 */
import { BackendError } from '../../errors';
import type { Id, Rev, VersionMeta, VersionReason, VersionTargetKind } from '../../types';
import type { MockCtx, VersionsService } from '../ctx';

export interface VersionRecord {
  id: Id;
  targetId: Id;
  targetKind: VersionTargetKind;
  createdAt: number;
  reason: VersionReason;
  label?: string;
  size: number;
  snapshot: unknown;
  /** Insertion order (tie-breaker for equal timestamps). */
  seq: number;
}

/** Newest first. */
export function byNewest(a: VersionRecord, b: VersionRecord): number {
  return b.createdAt - a.createdAt || (b.seq ?? 0) - (a.seq ?? 0);
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const VERSION_CAP = 500;

function bucketFor(age: number, at: number): string {
  if (age <= DAY) return `m10:${Math.floor(at / (10 * MIN))}`;
  if (age <= 7 * DAY) return `h:${Math.floor(at / HOUR)}`;
  if (age <= 90 * DAY) return `d:${Math.floor(at / DAY)}`;
  return `w:${Math.floor(at / (7 * DAY))}`;
}

/** Returns the ids to drop. `versions` may be in any order. */
export function thinVersions(versions: VersionRecord[], now: number): Id[] {
  const sorted = [...versions].sort(byNewest);
  const seen = new Set<string>();
  const drop: Id[] = [];
  const keep: VersionRecord[] = [];
  for (const v of sorted) {
    if (v.reason !== 'auto') {
      keep.push(v);
      continue;
    }
    const bucket = bucketFor(now - v.createdAt, v.createdAt);
    if (seen.has(bucket)) drop.push(v.id);
    else {
      seen.add(bucket);
      keep.push(v);
    }
  }
  if (keep.length > VERSION_CAP) drop.push(...keep.slice(VERSION_CAP).map((v) => v.id));
  return drop;
}

export function toVersionMeta(v: VersionRecord): VersionMeta {
  const m: VersionMeta = { id: v.id, createdAt: v.createdAt, reason: v.reason, size: v.size };
  if (v.label) m.label = v.label;
  return m;
}

export interface VersionsEngine extends VersionsService {
  restorer(kind: VersionTargetKind): ((targetId: Id, snapshot: unknown) => Rev) | undefined;
}

export function createVersionsService(ctx: MockCtx): VersionsEngine {
  const table = () => ctx.db.table<VersionRecord>('versions');
  const restorers = new Map<VersionTargetKind, (targetId: Id, snapshot: unknown) => Rev>();
  let seq = table().all().reduce((m, v) => Math.max(m, v.seq ?? 0), 0);

  return {
    create(input) {
      const json = JSON.stringify(input.snapshot ?? null);
      if (json.length > 64 * 1024 * 1024) throw new BackendError('TOO_LARGE', 'Snapshot too large');
      const rec: VersionRecord = {
        id: ctx.id(),
        targetId: input.targetId,
        targetKind: input.targetKind,
        createdAt: input.createdAt ?? ctx.clock.now(),
        reason: input.reason,
        size: json.length,
        snapshot: input.snapshot,
        seq: ++seq,
      };
      if (input.label) rec.label = input.label;
      table().insert(rec);
      const drop = thinVersions(
        table().filter((v) => v.targetId === input.targetId),
        ctx.clock.now(),
      );
      for (const id of drop) table().delete(id);
      return toVersionMeta(rec);
    },
    onRestore(kind, fn) {
      restorers.set(kind, fn);
    },
    restorer: (kind) => restorers.get(kind),
  };
}
