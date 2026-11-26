/**
 * Reminders (§11.3 "Reminders and jobs"): reminder_list / upsert / delete / snooze. A scheduler tick (every 15 s of
 * wall time) fires due reminders as `reminder:due` events, the way the Rust scheduler raises in-app toasts.
 * Life apps create reminders through `createReminder` (rituals, bills, habits, deadlines).
 */
import { BackendError } from '../../errors';
import type { Id, Reminder, ReminderTargetKind } from '../../types';
import type { MockCtx, MockHandlers } from '../ctx';

export interface ReminderRecord extends Reminder {
  blockId?: string;
  /** Life-app instance that generated it (uninstall removes it). */
  instanceId?: Id;
  /** Recurring rule (life-app rituals); the scheduler re-arms the next occurrence after firing. */
  everyMs?: number;
  createdAt: number;
}

export const reminders = (ctx: MockCtx) => ctx.db.table<ReminderRecord>('reminders');

const MAX_TEXT = 1024;

export function createReminder(
  ctx: MockCtx,
  input: { fireAt: number; targetKind: ReminderTargetKind; targetId: Id; text: string; blockId?: string; instanceId?: Id; everyMs?: number },
): ReminderRecord {
  const rec: ReminderRecord = {
    id: ctx.id(),
    fireAt: input.fireAt,
    targetKind: input.targetKind,
    targetId: input.targetId,
    text: input.text.slice(0, MAX_TEXT),
    fired: false,
    createdAt: ctx.clock.now(),
  };
  if (input.blockId) rec.blockId = input.blockId;
  if (input.instanceId) rec.instanceId = input.instanceId;
  if (input.everyMs) rec.everyMs = input.everyMs;
  reminders(ctx).insert(rec);
  return rec;
}

const toDto = (r: ReminderRecord): Reminder => ({ id: r.id, fireAt: r.fireAt, targetKind: r.targetKind, targetId: r.targetId, text: r.text, fired: r.fired });

function tick(ctx: MockCtx): void {
  if (!ctx.vault.isUnlocked()) return;
  const now = ctx.clock.now();
  for (const r of reminders(ctx).all()) {
    if (r.fired || r.fireAt > now) continue;
    // Missed by more than a day (e.g. the app was closed): mark fired silently, like the Rust catch-up pass.
    const stale = now - r.fireAt > 86_400_000;
    reminders(ctx).update(r.id, (x) => {
      if (x.everyMs) {
        let next = x.fireAt;
        while (next <= now) next += x.everyMs;
        x.fireAt = next;
      } else x.fired = true;
    });
    if (!stale) ctx.emit('reminder:due', { id: r.id, text: r.text });
  }
}

export function setup(ctx: MockCtx): void {
  ctx.every(15_000, () => tick(ctx));
}

export const handlers: MockHandlers = {
  reminder_list: (req, ctx) => {
    if (!Number.isFinite(req.from) || !Number.isFinite(req.to) || req.to < req.from) throw new BackendError('INVALID', 'Choose a valid time range');
    return reminders(ctx)
      .filter((r) => r.fireAt >= req.from && r.fireAt <= req.to)
      .sort((a, b) => a.fireAt - b.fireAt)
      .slice(0, 1000)
      .map(toDto);
  },
  reminder_upsert: (req, ctx) => {
    if (!Number.isFinite(req.fireAt)) throw new BackendError('INVALID', 'Pick a time', { field: 'fireAt' });
    const text = (req.text ?? '').trim();
    if (!text) throw new BackendError('INVALID', 'Add a note for the reminder', { field: 'text' });
    if (text.length > MAX_TEXT) throw new BackendError('INVALID', 'That note is too long', { field: 'text' });
    if (req.id) {
      reminders(ctx).update(req.id, (r) => {
        r.fireAt = req.fireAt;
        r.targetKind = req.targetKind;
        r.targetId = req.targetId;
        r.text = text;
        r.fired = req.fireAt <= ctx.clock.now() ? r.fired : false;
        if (req.blockId) r.blockId = req.blockId;
      });
      return { id: req.id };
    }
    const rec = createReminder(ctx, { fireAt: req.fireAt, targetKind: req.targetKind, targetId: req.targetId, text, blockId: req.blockId });
    return { id: rec.id };
  },
  reminder_delete: (req, ctx) => {
    if (!reminders(ctx).delete(req.id)) throw new BackendError('NOT_FOUND', 'Reminder not found');
  },
  reminder_snooze: (req, ctx) => {
    if (![5, 15, 60, 1440].includes(req.minutes)) throw new BackendError('INVALID', 'Snooze for 5, 15, 60 or 1,440 minutes');
    reminders(ctx).update(req.id, (r) => {
      r.fireAt = ctx.clock.now() + req.minutes * 60_000;
      r.fired = false;
    });
  },
};
