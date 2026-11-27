/**
 * Browser mock backend (§13.6, CLAUDE.md override 1: pure TypeScript). Absent from desktop bundles.
 *
 * Command handlers: `./commands/<namespace>.ts` export `handlers` (and optionally `setup(ctx)`); auto-registered.
 * Seeds: `./seed/<name>.ts` export `seed(ctx)` (optional `order`, core = 0); run for the demo and perf seeds.
 */
import { COMMAND_FLAGS, isCommandName, type CommandName } from '../contract';
import { BackendError, toBackendError } from '../errors';
import type { Transport } from '../facade';
import type { EventMap, EventName, JobEvent } from '../types';
import { installDateShim } from './clock';
import { installControl } from './control';
import { createMockContext, type MockContextInternals } from './context';
import type { MockCallCtx, MockHandler, MockModule, SeedModule } from './ctx';
import { MockEvents } from './events';
import { loadPersisted, savePersisted } from './persist';
import { DEMO_PASSWORD, optionsFromLocation, type MockOptions } from './options';
import { generateRecoveryWords, KDF_STANDARD, newVaultId, saveVault, vaultRecord } from './lib/vault';

/** Bundle sentinel: CI fails if this string appears in the desktop `dist/` (§13.6). */
export const MOCK_SENTINEL = '__EMP_MOCK_BACKEND__';

const commandModules = import.meta.glob<MockModule>('./commands/*.ts', { eager: true });
const seedModules = import.meta.glob<SeedModule>('./seed/*.ts', { eager: true });

type AnyHandler = (req: unknown, ctx: MockCallCtx) => unknown;

function buildRegistry(): Map<CommandName, AnyHandler> {
  const registry = new Map<CommandName, AnyHandler>();
  const owner = new Map<CommandName, string>();
  for (const [path, mod] of Object.entries(commandModules)) {
    for (const [name, fn] of Object.entries(mod.handlers ?? {})) {
      if (!isCommandName(name)) {
        console.warn(`[emp mock] ${path} registers unknown command "${name}" (not in ALL_COMMANDS)`);
        continue;
      }
      if (registry.has(name)) console.warn(`[emp mock] ${name} is registered by both ${owner.get(name)} and ${path}`);
      registry.set(name, fn as MockHandler<typeof name> as AnyHandler);
      owner.set(name, path);
    }
  }
  return registry;
}

function splitListeners(req: unknown): { data: Record<string, unknown>; fns: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  const fns: Record<string, unknown> = {};
  if (req && typeof req === 'object') {
    for (const [k, v] of Object.entries(req as Record<string, unknown>)) {
      if (typeof v === 'function') fns[k] = v;
      else data[k] = v;
    }
  }
  return { data, fns };
}

function cloneOut<T>(value: T, command: string): T {
  if (value === undefined) return value;
  try {
    return structuredClone(value);
  } catch (e) {
    throw new BackendError('INTERNAL', `Mock ${command} returned a non-cloneable value: ${(e as Error).message}`);
  }
}

export class MockBackend {
  options: MockOptions;
  readonly events: MockEvents;
  private registry = buildRegistry();
  private internals!: MockContextInternals;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private unpersist: (() => void) | null = null;
  ready: Promise<void>;

  constructor(options: MockOptions, events = new MockEvents()) {
    this.options = options;
    this.events = events;
    this.ready = this.boot(options);
  }

  get ctx() {
    return this.internals.ctx;
  }

  /** Commands that have a mock handler. */
  implemented(): CommandName[] {
    return Array.from(this.registry.keys());
  }

  private async boot(options: MockOptions): Promise<void> {
    this.internals = createMockContext(options, { events: this.events });
    const { ctx } = this.internals;
    for (const [path, mod] of Object.entries(commandModules)) {
      try {
        mod.setup?.(ctx);
      } catch (err) {
        console.error(`[emp mock] setup() in ${path} failed`, err);
      }
    }

    const persisted = options.persist ? await loadPersisted(options.seed) : null;
    if (persisted && persisted.v === 1) {
      ctx.db.load(persisted.db);
      this.internals.restoreIdState(persisted.ids);
      ctx.clock.restore(persisted.clock);
      const v = vaultRecord(ctx);
      // A reload discards the session: encrypted vaults come back locked.
      if (v.encrypted && v.state === 'unlocked') {
        v.state = 'locked';
        saveVault(ctx, v);
      }
    } else {
      await this.seed();
    }

    const v = vaultRecord(ctx);
    v.lastActivity = ctx.clock.now();
    if (v.state === 'unlocked') v.unlockedAt = ctx.clock.now();

    if (options.persist) {
      this.unpersist = ctx.db.onChange(() => this.schedulePersist());
    }
  }

  private async seed(): Promise<void> {
    const { ctx } = this.internals;
    if (this.options.seed === 'empty') return;
    // Seeded vaults start initialised: unlocked (or locked with ?locked=1), encrypted with password "demo" on request.
    const v = vaultRecord(ctx);
    v.state = this.options.locked ? 'locked' : 'unlocked';
    v.encrypted = this.options.encrypted;
    v.vaultId = newVaultId(ctx);
    v.recoveryConfirmed = true;
    v.integrity = 'ok';
    v.createdAt = ctx.clock.now() - 64 * 86_400_000;
    if (this.options.encrypted) {
      v.password = DEMO_PASSWORD;
      v.recoveryWords = generateRecoveryWords(ctx);
      v.kdf = { ...KDF_STANDARD, estMs: 870 };
    }
    saveVault(ctx, v);
    const mods = Object.entries(seedModules)
      .map(([path, m]) => ({ path, m, order: m.order ?? (path.endsWith('/core.ts') ? 0 : 100) }))
      .sort((a, b) => a.order - b.order || a.path.localeCompare(b.path));
    this.internals.setSeeding(true);
    try {
      for (const { path, m } of mods) {
        try {
          await this.events.muteWhile(async () => m.seed(ctx));
        } catch (err) {
          console.error(`[emp mock] seed ${path} failed`, err);
        }
      }
    } finally {
      this.internals.setSeeding(false);
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      const { ctx } = this.internals;
      void savePersisted({
        v: 1,
        seed: this.options.seed,
        db: ctx.db.snapshot(),
        ids: this.internals.idState(),
        clock: ctx.clock.snapshot(),
        savedAt: Date.now(),
      });
    }, 400);
  }

  /** Re-seed in place (keeps webview listeners). */
  async reset(patch: Partial<MockOptions> = {}): Promise<void> {
    this.unpersist?.();
    this.internals.dispose();
    this.options = { ...this.options, ...patch };
    this.ready = this.boot({ ...this.options, persist: false });
    await this.ready;
  }

  setLatency(ms: number): void {
    this.options = { ...this.options, latency: Math.max(0, ms) };
  }

  listen<E extends EventName>(name: E, fn: (payload: EventMap[E]) => void): () => void {
    return this.events.listen(name, fn);
  }

  /** Dispatch one command with IPC fidelity. */
  async call(command: string, req: unknown): Promise<unknown> {
    await this.ready;
    if (!isCommandName(command)) throw new BackendError('INVALID', `Unknown command ${command}`);
    const flags = COMMAND_FLAGS[command];
    const { ctx } = this.internals;

    for (const rule of this.options.fail) {
      if ((rule.command === command || rule.command === '*') && Math.random() < rule.prob) {
        throw new BackendError(rule.code, `Injected failure (${rule.code}) for ${command}`);
      }
    }
    if (this.options.latency > 0) {
      await new Promise((r) => setTimeout(r, this.options.latency * (0.65 + Math.random() * 0.7)));
    }

    const handler = this.registry.get(command);
    if (!handler) throw new BackendError('UNSUPPORTED', `${command} is not available in the browser preview`);

    const vault = vaultRecord(ctx);
    if (!flags.preUnlock) {
      if (vault.state === 'uninitialized') throw new BackendError('LOCKED', 'Set up Ultranote first');
      if (vault.state !== 'unlocked') throw new BackendError('LOCKED', 'Ultranote is locked');
      ctx.vault.stampActivity();
    }
    if (flags.reauth) ctx.vault.requireReauth();

    const { data, fns } = splitListeners(req);
    let cloned: Record<string, unknown>;
    try {
      cloned = structuredClone(data);
    } catch (e) {
      throw new BackendError('INVALID', `Request is not serialisable: ${(e as Error).message}`);
    }
    const fullReq = { ...cloned, ...fns };

    if (flags.job) return this.startJob(command, handler, fullReq, fns.onEvent as ((e: JobEvent) => void) | undefined);

    const callCtx = this.callCtx(command, new AbortController(), () => undefined);
    try {
      const out = await handler(fullReq, callCtx);
      return cloneOut(out, command);
    } catch (e) {
      throw this.normalise(e, command);
    }
  }

  private normalise(e: unknown, command: string): BackendError {
    const err = toBackendError(e, command);
    if (err.code === 'INTERNAL') console.error(`[emp mock] ${command} failed`, e);
    // Fresh instance so callers never share mutable error objects with the mock.
    return new BackendError(err.code, err.message, err.details ? structuredClone(err.details) : undefined, command);
  }

  private callCtx(command: CommandName, controller: AbortController, progress: MockCallCtx['progress']): MockCallCtx {
    const base = this.internals.ctx;
    const c = Object.create(base) as { -readonly [K in keyof MockCallCtx]: MockCallCtx[K] };
    c.command = command;
    c.progress = progress;
    c.signal = controller.signal;
    c.checkCancelled = () => {
      if (controller.signal.aborted) throw new BackendError('CANCELLED', 'Cancelled');
    };
    return c;
  }

  private startJob(
    command: CommandName,
    handler: AnyHandler,
    req: Record<string, unknown>,
    onEvent: ((e: JobEvent) => void) | undefined,
  ): { jobId: string } {
    const { ctx } = this.internals;
    const jobId = ctx.id();
    const controller = new AbortController();
    const info = { jobId, kind: command, done: 0, total: 0, startedAt: ctx.clock.now(), cancellable: true, controller };
    ctx.jobs.set(jobId, info);
    let finished = false;
    const send = (ev: JobEvent) => {
      if (finished) return;
      if (ev.kind !== 'progress') finished = true;
      let out: JobEvent = ev;
      try {
        out = structuredClone(ev);
      } catch {
        out = ev;
      }
      try {
        onEvent?.(out);
      } catch (err) {
        console.error('[emp mock] job listener failed', err);
      }
    };
    const progress = (done: number, total: number, label?: string) => {
      info.done = done;
      info.total = total;
      send(label ? { kind: 'progress', done, total, label } : { kind: 'progress', done, total });
    };
    const callCtx = this.callCtx(command, controller, progress);
    controller.signal.addEventListener('abort', () => {
      ctx.jobs.delete(jobId);
      send({ kind: 'error', error: { code: 'CANCELLED', message: 'Cancelled' } });
    });
    setTimeout(() => {
      Promise.resolve()
        .then(() => handler(req, callCtx))
        .then(
          (result) => {
            ctx.jobs.delete(jobId);
            send({ kind: 'done', result: cloneOut(result, command) });
          },
          (e) => {
            ctx.jobs.delete(jobId);
            send({ kind: 'error', error: this.normalise(e, command).toJSON() });
          },
        );
    }, 0);
    return { jobId };
  }
}

/** For tests and tools: a fresh, seeded backend. */
export async function createMockBackend(options: Partial<MockOptions> = {}): Promise<MockBackend> {
  const { DEFAULT_OPTIONS } = await import('./options');
  const backend = new MockBackend({ ...DEFAULT_OPTIONS, ...options });
  await backend.ready;
  return backend;
}

let singleton: MockBackend | null = null;

export function mockTransportFor(backend: MockBackend): Transport {
  return {
    kind: 'mock',
    call: (command, req) => backend.call(command, req),
    listen: async (event, handler) => backend.listen(event, handler),
  };
}

/** Entry used by `src/backend/runtime.ts` in browser mode. */
export async function createMockTransport(): Promise<Transport> {
  if (!singleton) {
    singleton = new MockBackend(optionsFromLocation());
    installControl(singleton);
    // One "now" for the preview: UI code reads Date.now()/new Date(), handlers read ctx.clock — make them the same
    // clock (see clock.ts). Follows reset() too, which swaps in a fresh context and clock.
    const backend = singleton;
    installDateShim(() => backend.ctx.clock.wallNow());
    if (typeof console !== 'undefined') {
      console.info(
        `%cUltranote%c browser preview · mock backend (${singleton.options.seed}${singleton.options.encrypted ? ', encrypted — password "demo"' : ''})`,
        'font-weight:700',
        'color:gray',
      );
    }
  }
  await singleton.ready;
  return mockTransportFor(singleton);
}
