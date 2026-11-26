/**
 * Tauri transport: `invoke('<snake_name>', { req })` (§11.1). Listener functions in the request (`onEvent`,
 * `onQuote`) become `Channel`s; `asset_import_bytes` uses a raw-body invoke with `x-emp-*` headers.
 */
import { Channel, invoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import type { CommandName } from './contract';
import { toBackendError } from './errors';
import type { Transport, Unlisten } from './facade';
import type { EventMap, EventName } from './types';

function withChannels(req: Record<string, unknown>): Record<string, unknown> {
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(req)) {
    if (typeof v === 'function') {
      out ??= { ...req };
      const ch = new Channel<unknown>();
      const fn = v as (msg: unknown) => void;
      ch.onmessage = (msg) => fn(msg);
      out[k] = ch;
    }
  }
  return out ?? req;
}

async function invokeRawAsset(req: Record<string, unknown>): Promise<unknown> {
  const body = req.body instanceof ArrayBuffer ? new Uint8Array(req.body) : (req.body as Uint8Array);
  return invoke('asset_import_bytes', body, {
    headers: {
      'x-emp-workspace': String(req.workspaceId),
      // Header values must be ISO-8859-1; names are percent-encoded and decoded in Rust.
      'x-emp-name': encodeURIComponent(String(req.name)),
      'x-emp-mime': String(req.mime),
    },
  });
}

export function createTauriTransport(): Transport {
  return {
    kind: 'tauri',
    async call(command: CommandName, req: Record<string, unknown>) {
      try {
        if (command === 'asset_import_bytes') return await invokeRawAsset(req);
        return await invoke(command, { req: withChannels(req) });
      } catch (e) {
        throw toBackendError(e, command);
      }
    },
    async listen<E extends EventName>(event: E, handler: (payload: EventMap[E]) => void): Promise<Unlisten> {
      const un = await tauriListen<EventMap[E]>(event, (e) => handler(e.payload));
      return un;
    },
  };
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
