/**
 * Test controls (§13.6): `window.__EMP_MOCK__ = { reset, lock, emit, setLatency, clock:{set,advance}, snapshot }`.
 *
 *   await __EMP_MOCK__.reset({ seed: 'empty' });  location.reload() is not needed; reload the route instead.
 *   __EMP_MOCK__.clock.advance(15 * 60_000);       // trips auto-lock within a second
 *   __EMP_MOCK__.emit('reminder:due', { id: 'x', text: 'Pay rent' });
 */
import type { EventMap, EventName } from '../types';
import type { MockBackend } from './index';
import type { MockOptions } from './options';
import { clearPersisted } from './persist';

export interface MockControl {
  reset(patch?: Partial<MockOptions>): Promise<void>;
  lock(reason?: 'manual' | 'idle' | 'sleep' | 'screen' | 'blur' | 'session_max' | 'panic'): Promise<void>;
  emit<E extends EventName>(name: E, payload: EventMap[E]): void;
  setLatency(ms: number): void;
  clock: { set(ts: number | string): void; advance(ms: number): void; now(): number };
  snapshot(): Record<string, unknown>;
  call(command: string, req?: unknown): Promise<unknown>;
  readonly options: MockOptions;
  /** Forget the `&persist=1` IndexedDB copy for the current seed. */
  clearPersisted(): Promise<void>;
}

declare global {
  interface Window {
    __EMP_MOCK__?: MockControl;
  }
}

export function installControl(backend: MockBackend): MockControl {
  const control: MockControl = {
    reset: (patch) => backend.reset(patch),
    async lock(reason = 'manual') {
      await backend.ready;
      const v = backend.ctx.vault;
      if (!v.isEncrypted()) {
        console.warn('[emp mock] lock() needs an encrypted vault — reload with ?encrypted=1');
        return;
      }
      await v.lock(reason);
    },
    emit: (name, payload) => backend.events.emit(name, payload),
    setLatency: (ms) => backend.setLatency(ms),
    clock: {
      set: (ts) => backend.ctx.clock.set(typeof ts === 'string' ? Date.parse(ts) : ts),
      advance: (ms) => backend.ctx.clock.advance(ms),
      now: () => backend.ctx.clock.now(),
    },
    snapshot: () => structuredClone(backend.ctx.db.snapshot()) as Record<string, unknown>,
    call: (command, req) => backend.call(command, req ?? {}),
    get options() {
      return backend.options;
    },
    clearPersisted: () => clearPersisted(backend.options.seed),
  };
  if (typeof window !== 'undefined') window.__EMP_MOCK__ = control;
  return control;
}
