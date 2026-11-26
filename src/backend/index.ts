/**
 * Backend entry point.
 *
 *   import { api } from '@/backend';
 *   const { meta, doc } = await api.page.get({ id });
 *   const job = await api.page.duplicate({ id, deep: true, onEvent: (e) => … });
 *   const copy = await job.result;
 *
 * Errors reject with `BackendError` ({ code, message, details }); test with `hasCode(e, 'CONFLICT')`.
 */
import { buildFacade } from './facade';
import { getTransport } from './runtime';

export const api = buildFacade(getTransport);
export default api;

export { backendMode, backendReady, type BackendMode } from './runtime';
export type { EmpBackend, CommandName, Req, Res, JobHandle, JobListener, Namespace } from './contract';
export { ALL_COMMANDS, COMMAND_FLAGS } from './contract';
export { BackendError, isApiError, hasCode, errorMessage, toBackendError } from './errors';
export { onJobEvent, onBackendError, runJob, latestRequest, type Unlisten } from './facade';
export { listen, listenMany, type EventHandler } from './events';
export type * from './types';
