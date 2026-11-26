/**
 * Chooses the transport (§12): `'__TAURI_INTERNALS__' in window ? tauri : (VITE_ALLOW_MOCK==='1' ? mock : reject)`.
 * The mock is dynamically imported behind a compile-time constant so desktop builds (`VITE_ALLOW_MOCK=0`) never
 * contain it.
 */
import { BackendError } from './errors';
import type { Transport } from './facade';
import { createTauriTransport, isTauri } from './tauri';

export type BackendMode = 'tauri' | 'mock' | 'unavailable';

export const backendMode: BackendMode = isTauri()
  ? 'tauri'
  : import.meta.env.VITE_ALLOW_MOCK === '1'
    ? 'mock'
    : 'unavailable';

let transportPromise: Promise<Transport> | null = null;

export function getTransport(): Promise<Transport> {
  if (transportPromise) return transportPromise;
  if (backendMode === 'tauri') {
    transportPromise = Promise.resolve(createTauriTransport());
  } else if (import.meta.env.VITE_ALLOW_MOCK === '1') {
    transportPromise = import('./mock').then((m) => m.createMockTransport());
  } else {
    transportPromise = Promise.reject(
      new BackendError('UNSUPPORTED', 'Ultra Note must run inside the desktop app (browser preview is disabled in this build).'),
    );
    transportPromise.catch(() => undefined);
  }
  return transportPromise;
}

/** Resolves once the backend transport is ready (instant in Tauri; the mock seeds itself first). */
export function backendReady(): Promise<void> {
  return getTransport().then(() => undefined);
}
