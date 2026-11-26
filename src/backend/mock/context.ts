/** Builds the shared mock context (services wired to one db/clock/rng/event bus). */
import { generateKeyBetween } from '@/lib/fractional-index';
import { BackendError } from '../errors';
import type { EventMap, EventName, Id } from '../types';
import { createClock, type MockClock } from './clock';
import type { MockCtx, MockJobInfo, ServiceRegistry, WorkspaceRecord } from './ctx';
import { MockDb } from './db';
import { MockEvents } from './events';
import { createAssetsService } from './lib/assets';
import { createDocsService } from './lib/docs';
import { setBlockIdGenerator } from './lib/doc';
import { createGrantsService } from './lib/grants';
import { createPagesService } from './lib/pages';
import { createSearchEngine, type SearchEngine } from './lib/search';
import { vaultSettings } from './lib/settings';
import { createVaultService } from './lib/vault';
import { createVersionsService, type VersionsEngine } from './lib/versions';
import type { MockOptions } from './options';
import { createRng, nanoid12, uuidv7, type Rng } from './rng';

/** Seeded ids are stamped from this instant so demo URLs stay stable across reloads. */
export const SEED_EPOCH = Date.UTC(2026, 9, 1, 9, 0, 0);

export interface MockContextInternals {
  ctx: MockCtx;
  searchEngine: SearchEngine;
  versionsEngine: VersionsEngine;
  setSeeding(on: boolean): void;
  dispose(): void;
  /** For persistence. */
  idState(): { rng: number; seedTick: number };
  restoreIdState(s: { rng: number; seedTick: number }): void;
}

export function createMockContext(
  options: MockOptions,
  opts: { events?: MockEvents; db?: MockDb; clock?: MockClock } = {},
): MockContextInternals {
  const db = opts.db ?? new MockDb();
  const events = opts.events ?? new MockEvents();
  const clock = opts.clock ?? createClock(options.freeze);
  const rng: Rng = createRng(`emp:${options.seed}`);
  const timers = new Set<ReturnType<typeof setInterval>>();
  const jobs = new Map<Id, MockJobInfo>();
  const services = new Map<string, unknown>();
  const seedRefs = new Map<string, string>();
  let seeding = false;
  let seedTick = 0;

  const registry: ServiceRegistry = {
    provide: (name, impl) => void services.set(name, impl),
    get: <T>(name: string) => services.get(name) as T | undefined,
  };

  // Services are attached after construction (they close over ctx).
  const ctx = {
    options,
    get seedKind() {
      return options.seed;
    },
    db,
    events,
    clock,
    rng,
    id(): Id {
      if (seeding) {
        seedTick += 1;
        return uuidv7(SEED_EPOCH + seedTick, rng);
      }
      return uuidv7(clock.now(), rng);
    },
    blockId: () => nanoid12(rng),
    fail(code, message, details) {
      throw new BackendError(code, message, details);
    },
    keyBetween: (a, b) => generateKeyBetween(a ?? null, b ?? null),
    workspaceId(): Id {
      const ws = db
        .table<WorkspaceRecord>('workspaces')
        .all()
        .sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1))[0];
      if (!ws) throw new BackendError('NOT_FOUND', 'No workspace yet');
      return ws.id;
    },
    emit<E extends EventName>(name: E, payload: EventMap[E]) {
      events.emit(name, payload);
    },
    every(ms, fn) {
      const h = setInterval(() => {
        try {
          fn();
        } catch (err) {
          console.error('[emp mock] timer failed', err);
        }
      }, ms);
      timers.add(h);
      return () => {
        clearInterval(h);
        timers.delete(h);
      };
    },
    sleep(ms, signal) {
      return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new BackendError('CANCELLED', 'Cancelled'));
          return;
        }
        const h = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
          clearTimeout(h);
          reject(new BackendError('CANCELLED', 'Cancelled'));
        });
      });
    },
    isOffline: () => vaultSettings(ctx as MockCtx).offline,
    get seeding() {
      return seeding;
    },
    services: registry,
    jobs,
    seedRefs,
  } as Partial<MockCtx> as MockCtx & Record<string, unknown>;

  const c = ctx as unknown as Record<string, unknown>;
  c.docs = createDocsService(ctx);
  c.pages = createPagesService(ctx);
  c.grants = createGrantsService(ctx);
  c.assets = createAssetsService(ctx);
  const searchEngine = createSearchEngine(ctx);
  c.search = searchEngine;
  const versionsEngine = createVersionsService(ctx);
  c.versions = versionsEngine;
  c.vault = createVaultService(ctx);

  setBlockIdGenerator(() => nanoid12(rng));

  return {
    ctx,
    searchEngine,
    versionsEngine,
    setSeeding(on) {
      seeding = on;
    },
    dispose() {
      for (const h of timers) clearInterval(h);
      timers.clear();
      for (const j of jobs.values()) j.controller.abort();
      jobs.clear();
      events.clearInternal();
    },
    idState: () => ({ rng: rng.state(), seedTick }),
    restoreIdState(s) {
      rng.setState(s.rng);
      seedTick = s.seedTick;
    },
  };
}
