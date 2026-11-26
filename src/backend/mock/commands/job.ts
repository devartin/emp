/** job_list / job_cancel. Cancellation aborts the job's signal; the dispatcher emits CANCELLED. */
import type { MockHandlers } from '../ctx';

export const handlers: MockHandlers = {
  job_list: (_req, ctx) =>
    Array.from(ctx.jobs.values()).map(({ jobId, kind, done, total, startedAt, cancellable }) => ({
      jobId,
      kind,
      done,
      total,
      startedAt,
      cancellable,
    })),
  job_cancel: (req, ctx) => {
    const job = ctx.jobs.get(req.jobId);
    if (job?.cancellable) job.controller.abort();
  },
};
