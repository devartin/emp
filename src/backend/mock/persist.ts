/** `&persist=1`: dev-only IndexedDB persistence of the whole mock state. */
import type { DbSnapshot } from './db';

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
    req.onsuccess = () => resolve((req.result as PersistedState | undefined) ?? null);
    req.onerror = () => resolve(null);
  });
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
