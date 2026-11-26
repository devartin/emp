/**
 * Long-running jobs (§11.1): every (job) command started through the facade appears here with live progress until it
 * settles (kept 4 s after finishing so progress UIs can show the end state).
 */
import { create } from 'zustand';
import { api, onJobEvent } from '@/backend';
import type { CommandName } from '@/backend';
import type { ApiError, Id } from '@/backend/types';

export type JobStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface TrackedJob {
  jobId: Id;
  command: CommandName;
  label?: string;
  done: number;
  total: number;
  /** 0..1, or null while indeterminate. */
  progress: number | null;
  status: JobStatus;
  error?: ApiError;
  startedAt: number;
  finishedAt?: number;
}

interface JobsState {
  jobs: Record<Id, TrackedJob>;
  cancel(jobId: Id): Promise<void>;
  clearFinished(): void;
}

const LINGER_MS = 4000;

export const useJobs = create<JobsState>()((set) => ({
  jobs: {},
  async cancel(jobId) {
    await api.job.cancel({ jobId });
  },
  clearFinished: () =>
    set((s) => ({ jobs: Object.fromEntries(Object.entries(s.jobs).filter(([, j]) => j.status === 'running')) })),
}));

let installed = false;
/** Subscribe the store to the facade's job bus. Idempotent. */
export function installJobTracking(): () => void {
  if (installed) return () => undefined;
  installed = true;
  const off = onJobEvent(({ jobId, command, event }) => {
    useJobs.setState((s) => {
      const cur: TrackedJob = s.jobs[jobId] ?? {
        jobId,
        command,
        done: 0,
        total: 0,
        progress: null,
        status: 'running',
        startedAt: Date.now(),
      };
      let next: TrackedJob = cur;
      if (event.kind === 'progress') {
        next = {
          ...cur,
          done: event.done,
          total: event.total,
          progress: event.total > 0 ? Math.min(1, event.done / event.total) : null,
          label: event.label ?? cur.label,
        };
      } else if (event.kind === 'done') {
        next = { ...cur, status: 'done', progress: 1, finishedAt: Date.now() };
      } else {
        next = {
          ...cur,
          status: event.error.code === 'CANCELLED' ? 'cancelled' : 'error',
          error: event.error,
          finishedAt: Date.now(),
        };
      }
      return { jobs: { ...s.jobs, [jobId]: next } };
    });
    if (event.kind !== 'progress') {
      setTimeout(() => {
        useJobs.setState((s) => {
          if (!s.jobs[jobId] || s.jobs[jobId].status === 'running') return s;
          const { [jobId]: _gone, ...rest } = s.jobs;
          return { jobs: rest };
        });
      }, LINGER_MS);
    }
  });
  return () => {
    installed = false;
    off();
  };
}

export const selectRunningJobs = (s: JobsState) => Object.values(s.jobs).filter((j) => j.status === 'running');
