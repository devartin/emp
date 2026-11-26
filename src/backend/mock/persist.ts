/** `&persist=1`: dev-only IndexedDB persistence of the whole mock state. */
import type { DbSnapshot } from './db';
import { CALLOUT_FALLBACK, iconOf, lucide, migrateIcon } from './lib/icons';
import type { Icon } from '../types';

const DB_NAME = 'emp-mock';
const STORE = 'state';

export interface PersistedState {
  v: 1;
  seed: string;
  db: DbSnapshot;
  ids: { rng: number; seedTick: number };
  clock: { frozenAt: number | null; offset: number };
  savedAt: number;
}

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

export async function loadPersisted(seed: string): Promise<PersistedState | null> {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(seed);
    req.onsuccess = () => {
      const st = (req.result as PersistedState | undefined) ?? null;
      if (st) migrateIcons(st.db);
      resolve(st);
    };
    req.onerror = () => resolve(null);
  });
}

/**
 * The mock twin of the store's schema-v2 payload migration (`crates/emp-store/src/db/payload_migrate.rs`, and
 * `crates/emp-store/src/icons.rs` `migrate_doc_icons` for documents): every `icon: {t:'emoji'}` in a saved state
 * becomes a Lucide icon through the canonical map, or is dropped when unmapped — except a callout's icon, which
 * (bare legacy strings included) becomes its Lucide icon or `lightbulb`. Text is never touched.
 */
export function migrateIcons(node: unknown, depth = 0): void {
  if (!node || typeof node !== 'object' || depth > 256) return;
  if (Array.isArray(node)) {
    for (const x of node) migrateIcons(x, depth + 1);
    return;
  }
  const o = node as Record<string, unknown>;
  const attrs = o.attrs as Record<string, unknown> | undefined;
  if (o.type === 'callout' && attrs && typeof attrs === 'object' && attrs.icon) {
    const next = calloutIcon(attrs.icon);
    if (next) attrs.icon = next;
  }
  for (const [k, v] of Object.entries(o)) {
    if (k === 'icon' && v && typeof v === 'object' && (v as Icon).t === 'emoji') {
      const next = migrateIcon(v as Icon);
      if (next) o[k] = next;
      else delete o[k];
    } else if (v && typeof v === 'object') migrateIcons(v, depth + 1);
  }
}

/** A callout's legacy icon (bare emoji / `lucide:` / Lucide name string, or `{t:'emoji'}`) → Lucide; `undefined` = keep. */
function calloutIcon(icon: unknown): Icon | undefined {
  if (typeof icon === 'string') return iconOf(icon) ?? lucide(CALLOUT_FALLBACK);
  if (icon && typeof icon === 'object' && (icon as Icon).t === 'emoji') return migrateIcon(icon as Icon) ?? lucide(CALLOUT_FALLBACK);
  return undefined;
}

export async function savePersisted(state: PersistedState): Promise<void> {
  const db = await open();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(state, state.seed);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function clearPersisted(seed: string): Promise<void> {
  const db = await open();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(seed);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}
