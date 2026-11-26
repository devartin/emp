/**
 * Builds the namespaced `EmpBackend` facade on top of a transport (Tauri invoke or the browser mock).
 * Both transports receive listener functions (`onEvent`, `onQuote`) in the request; Tauri wraps them in Channels.
 */
import {
  ALL_COMMANDS,
  COMMAND_FLAGS,
  splitCommand,
  type CommandName,
  type EmpBackend,
  type JobHandle,
  type JobListener,
} from './contract';
import { BackendError, toBackendError } from './errors';
import type { EventMap, EventName, JobEvent, JobRef } from './types';

export type Unlisten = () => void;

export interface Transport {
  readonly kind: 'tauri' | 'mock';
  call(command: CommandName, req: Record<string, unknown>): Promise<unknown>;
  listen<E extends EventName>(event: E, handler: (payload: EventMap[E]) => void): Promise<Unlisten>;
}

// ── job bus: every job event from every facade call, for the jobs store

export interface JobBusEvent {
  jobId: string;
  command: CommandName;
  event: JobEvent;
}

type JobBusListener = (e: JobBusEvent) => void;
const jobBusListeners = new Set<JobBusListener>();

export function onJobEvent(fn: JobBusListener): Unlisten {
  jobBusListeners.add(fn);
  return () => jobBusListeners.delete(fn);
}

function emitJobBus(e: JobBusEvent): void {
  for (const fn of jobBusListeners) {
    try {
      fn(e);
    } catch (err) {
      console.error('[emp] job listener failed', err);
    }
  }
}

// ── error hook: lets the app react globally (e.g. LOCKED while we believe we are unlocked)

type ErrorHook = (err: BackendError, command: CommandName) => void;
const errorHooks = new Set<ErrorHook>();

export function onBackendError(fn: ErrorHook): Unlisten {
  errorHooks.add(fn);
  return () => errorHooks.delete(fn);
}

function reportError(err: BackendError, command: CommandName): void {
  for (const fn of errorHooks) {
    try {
      fn(err, command);
    } catch {
      /* hooks never break calls */
    }
  }
}

// ── builder

export function buildFacade(getTransport: () => Promise<Transport>): EmpBackend {
  async function call(command: CommandName, req: Record<string, unknown>): Promise<unknown> {
    try {
      const t = await getTransport();
      return await t.call(command, req);
    } catch (e) {
      const err = toBackendError(e, command);
      reportError(err, command);
      throw err;
    }
  }

  async function callJob(command: CommandName, req: Record<string, unknown>): Promise<JobHandle<unknown>> {
    const { onEvent, ...rest } = req as { onEvent?: JobListener };
    let jobId: string | null = null;
    const early: JobEvent[] = [];
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const result = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Callers that only care about progress must not trigger unhandled-rejection noise.
    result.catch(() => undefined);

    const deliver = (ev: JobEvent) => {
      if (jobId) emitJobBus({ jobId, command, event: ev });
      try {
        onEvent?.(ev);
      } catch (err) {
        console.error('[emp] onEvent listener failed', err);
      }
      if (ev.kind === 'done') resolve(ev.result);
      else if (ev.kind === 'error') reject(toBackendError(ev.error, command));
    };

    const listener = (ev: JobEvent) => {
      if (!jobId) early.push(ev);
      else deliver(ev);
    };

    const ref = (await call(command, { ...rest, onEvent: listener })) as JobRef;
    jobId = ref.jobId;
    emitJobBus({ jobId, command, event: { kind: 'progress', done: 0, total: 0 } });
    for (const ev of early.splice(0)) deliver(ev);

    const id = jobId;
    return {
      jobId: id,
      command,
      result,
      cancel: () => call('job_cancel', { jobId: id }).then(() => undefined),
    };
  }

  const api: Record<string, Record<string, (req?: Record<string, unknown>) => Promise<unknown>>> = {};
  for (const command of ALL_COMMANDS) {
    const [ns, method] = splitCommand(command);
    const bucket = (api[ns] ??= {});
    bucket[method] = COMMAND_FLAGS[command].job
      ? (req) => callJob(command, req ?? {})
      : (req) => call(command, req ?? {});
  }
  return api as unknown as EmpBackend;
}

/** Convenience: await a job's final result while forwarding progress. */
export async function runJob<R>(
  start: Promise<JobHandle<R>>,
  onProgress?: (done: number, total: number, label?: string) => void,
): Promise<R> {
  const handle = await start;
  if (!onProgress) return handle.result;
  const off = onJobEvent((e) => {
    if (e.jobId === handle.jobId && e.event.kind === 'progress' && e.event.total > 0) {
      onProgress(e.event.done, e.event.total, e.event.label);
    }
  });
  try {
    return await handle.result;
  } finally {
    off();
  }
}

/**
 * Debounced callers pass `reqId` and drop stale responses (§11.1). `latest()` hands out increasing ids and tells
 * you whether a response is still the newest.
 */
export function latestRequest() {
  let current = 0;
  return {
    next(): number {
      current += 1;
      return current;
    },
    isLatest(reqId: number): boolean {
      return reqId === current;
    },
  };
}
