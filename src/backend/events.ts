/**
 * Typed §11.4 event listeners. `listen` returns a synchronous unlisten function (the underlying Tauri/mock
 * subscription is established asynchronously; unlistening before it resolves is safe).
 *
 *   const off = listen('tree:changed', (e) => tree.applyChange(e));
 */
import { getTransport } from './runtime';
import type { EventMap, EventName } from './types';

export type EventHandler<E extends EventName> = (payload: EventMap[E]) => void;

export function listen<E extends EventName>(event: E, handler: EventHandler<E>): () => void {
  let disposed = false;
  let un: (() => void) | null = null;
  const safe: EventHandler<E> = (payload) => {
    if (disposed) return;
    try {
      handler(payload);
    } catch (err) {
      console.error(`[emp] handler for ${event} failed`, err);
    }
  };
  getTransport()
    .then((t) => t.listen(event, safe))
    .then((u) => {
      if (disposed) u();
      else un = u;
    })
    .catch(() => undefined);
  return () => {
    disposed = true;
    un?.();
    un = null;
  };
}

/** Subscribe to several events at once; returns one unlisten for all. */
export function listenMany(handlers: { [E in EventName]?: EventHandler<E> }): () => void {
  const offs = (Object.keys(handlers) as EventName[]).map((name) =>
    listen(name, handlers[name] as EventHandler<typeof name>),
  );
  return () => offs.forEach((off) => off());
}
