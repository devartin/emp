/**
 * The mock handler context. Feature mocks implement namespaces as:
 *
 *   // src/backend/mock/commands/db.ts
 *   import type { MockHandlers } from '../ctx';
 *   export const handlers: MockHandlers = {
 *     db_get_schema: (req, ctx) => { ... },                          // sync or async
 *     db_export: async (req, ctx) => { ctx.progress(1, 3); ... },    // (job): just return the result
 *   };
 *   export function setup(ctx: MockCtx) { ... }                     // optional, runs once at boot/reset
 *
 *   // src/backend/mock/seed/databases.ts
 *   export const order = 20;                                         // optional; core runs at 0, default 100
 *   export function seed(ctx: MockCtx) { if (ctx.seedKind !== 'demo') return; ... }
 *
 * Rules the dispatcher enforces for you: structuredClone of requests/responses, latency, `&fail=` injection,
 * LOCKED for data commands while locked, REAUTH_REQUIRED for (reauth) commands, activity stamping,
 * job lifecycle (JobRef + progress/done/error events + job_cancel → CANCELLED). Missing handlers → UNSUPPORTED.
 */
import type { CommandName, Req, Res } from '../contract';
import type {
  AssetDTO,
  EventMap,
  EventName,
  FileGrant,
  Icon,
  Cover,
  Id,
  PageFlags,
  PageKind,
  PageMeta,
  Rev,
  SearchFilters,
  SearchHit,
  TipTapDoc,
  VaultStatus,
  ErrorCode,
  ApiErrorDetails,
  VersionMeta,
  VersionTargetKind,
  VersionReason,
  LifeAppInstance,
} from '../types';
import type { MockClock } from './clock';
import type { MockDb } from './db';
import type { MockEvents } from './events';
import type { MockOptions, SeedKind } from './options';
import type { Rng } from './rng';

/** Requests reach handlers already cloned; (job) requests carry their `onEvent` listener (handled for you). */
export type MockHandler<K extends CommandName> = (req: Req<K>, ctx: MockCallCtx) => Res<K> | Promise<Res<K>>;

export type MockHandlers = { [K in CommandName]?: MockHandler<K> };

export interface MockModule {
  handlers?: MockHandlers;
  setup?: (ctx: MockCtx) => void;
}

export interface SeedModule {
  seed: (ctx: MockCtx) => void | Promise<void>;
  order?: number;
}

// ───────────────────────────────────────────────────────────────────────────── stored records

/** Stored page record ('pages' table). `hasChildren` is derived, never stored. */
export interface PageRecord {
  id: Id;
  workspaceId: Id;
  parentId: Id | null;
  kind: PageKind;
  sortKey: string;
  title: string;
  icon?: Icon;
  cover?: Cover;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  /** The page the user deleted (its descendants share `deletedAt` but are not roots). */
  trashRoot?: boolean;
  rev: Rev;
  flags: PageFlags;
  appInstanceId?: Id;
  /** e.g. 'daily:2026-11-26' or a life-app template key. */
  templateKey?: string;
}

export interface WorkspaceRecord {
  id: Id;
  sortKey: string;
  name: string;
  icon?: Icon;
  favorites: Id[];
  recents: Id[];
  defaults: { font: 'sans' | 'serif' | 'mono'; fullWidth: boolean; smallText: boolean };
  createdAt: number;
  updatedAt: number;
  rev: Rev;
}

export interface DocRecord {
  /** owner id (page or row) */
  id: Id;
  ownerKind: 'page' | 'row';
  rev: Rev;
  updatedAt: number;
  doc: TipTapDoc;
}

// ───────────────────────────────────────────────────────────────────────────── services

export interface CreatePageInput {
  workspaceId?: Id;
  parentId: Id | null;
  kind: PageKind;
  title?: string;
  icon?: Icon;
  cover?: Cover;
  flags?: PageFlags;
  appInstanceId?: Id;
  templateKey?: string;
  /** Place after this sibling (default: last). */
  afterId?: Id;
  /** Place before this sibling. */
  beforeId?: Id;
  /** Optional initial document (doc pages). Block ids are kept as given. */
  doc?: TipTapDoc;
  /** Override timestamps (seeds). */
  createdAt?: number;
  updatedAt?: number;
  /** Skip the `tree:changed` event (bulk inserts emit once themselves). */
  silent?: boolean;
}

export interface PagesService {
  table(): import('./db').MockTable<PageRecord>;
  /** Live (not deleted) record or NOT_FOUND. */
  require(id: Id): PageRecord;
  get(id: Id): PageRecord | undefined;
  meta(id: Id): PageMeta;
  toMeta(rec: PageRecord): PageMeta;
  create(input: CreatePageInput): PageRecord;
  /** Patch meta fields, bump rev/updatedAt, emit tree:changed + page:changed. */
  update(id: Id, patch: Partial<Pick<PageRecord, 'title' | 'icon' | 'cover' | 'flags' | 'appInstanceId'>>): PageRecord;
  /** Bump updatedAt (doc saved). */
  touch(id: Id): void;
  children(parentId: Id | null, workspaceId?: Id): PageRecord[];
  ancestors(id: Id): PageRecord[];
  /** All live descendants (depth-first, excluding `id`). */
  descendants(id: Id): PageRecord[];
  /** Sort key placing a page among `parentId`'s live children. */
  sortKeyFor(parentId: Id | null, workspaceId: Id, opts?: { afterId?: Id; beforeId?: Id; excludeId?: Id }): string;
  move(id: Id, parentId: Id | null, opts?: { afterId?: Id; beforeId?: Id }): PageRecord;
  trash(ids: Id[]): void;
  restore(ids: Id[]): PageRecord[];
  purge(ids: Id[]): void;
  emitTree(workspaceId: Id, upserted: Id[], removed?: Id[]): void;
}

export interface DocsService {
  get(ownerId: Id): DocRecord | undefined;
  /** Write a doc, bumping rev. Throws CONFLICT {currentRev} when `baseRev` is given and stale. */
  save(ownerId: Id, ownerKind: 'page' | 'row', doc: TipTapDoc, baseRev?: Rev): DocRecord;
  delete(ownerId: Id): void;
  /** Plain text of a doc (cached per rev). */
  text(ownerId: Id): string;
  emptyDoc(): TipTapDoc;
}

export interface GrantInfo {
  grantId: Id;
  displayName: string;
  size: number;
  purpose: string;
  mode: 'read' | 'write';
  file?: File;
  expiresAt: number;
  used: boolean;
}

export interface GrantsService {
  /** Opens the browser file picker (needs a recent user gesture). */
  pick(purpose: string, accept: string[], multiple: boolean): Promise<FileGrant[]>;
  /** A write grant; writing triggers a browser download with `suggestedName`. */
  saveGrant(purpose: string, suggestedName: string): FileGrant;
  /** Consume a read grant (single use, 10-minute expiry). Optionally check the purpose. */
  read(grantId: Id, purpose?: string): File;
  /** Consume a write grant by downloading `data`. */
  write(grantId: Id, data: Blob | string, mime?: string): number;
  /** Register a File directly (drag-and-drop, tests). */
  register(file: File, purpose: string): FileGrant;
}

export interface AssetsService {
  create(input: { workspaceId?: Id; name: string; mime: string; blob: Blob; width?: number; height?: number; source?: string }): AssetDTO;
  get(id: Id): AssetDTO | undefined;
  blob(id: Id): Blob | undefined;
}

export interface VaultService {
  status(): VaultStatus;
  isUnlocked(): boolean;
  isEncrypted(): boolean;
  /** Throws REAUTH_REQUIRED unless `vault_reauth` succeeded in the last 5 minutes (no-op when unencrypted). */
  requireReauth(): void;
  /** Lock now (emits vault:will-lock, then vault:locked). No-op if unencrypted or already locked. */
  lock(reason: 'manual' | 'idle' | 'sleep' | 'screen' | 'blur' | 'session_max' | 'panic'): Promise<void>;
  stampActivity(): void;
  securityLog(event: string): void;
}

export interface SearchCandidate extends Omit<SearchHit, 'score' | 'snippet'> {
  /** Searchable body text (optional). */
  text?: string;
  /** Workspace page id this hit lives under (for `in:` filters). */
  ancestorIds?: Id[];
  databaseId?: Id;
}

export type SearchProvider = (q: string, filters: SearchFilters) => SearchCandidate[];

export interface SearchService {
  /** Contribute rows, sheets, assets … to `search_query`. Called per query; return cheap candidates. */
  register(name: string, provider: SearchProvider): void;
}

export interface VersionsService {
  create(input: {
    targetId: Id;
    targetKind: VersionTargetKind;
    reason: VersionReason;
    label?: string;
    snapshot: unknown;
    createdAt?: number;
  }): VersionMeta;
  /** How to restore a snapshot of `kind` (page_doc is built in). Return the new rev. */
  onRestore(kind: VersionTargetKind, fn: (targetId: Id, snapshot: unknown) => Rev): void;
}

/** A tiny service locator for cross-namespace lookups (e.g. 'lifeapp.instances'). */
export interface ServiceRegistry {
  provide<T>(name: string, impl: T): void;
  get<T>(name: string): T | undefined;
}

/** Well-known service names. */
export interface KnownServices {
  /** Provided by the life-apps mock; used by workspace_open. */
  'lifeapp.instances': (workspaceId: Id) => LifeAppInstance[];
}

export interface MockJobInfo {
  jobId: Id;
  kind: string;
  done: number;
  total: number;
  startedAt: number;
  cancellable: boolean;
  controller: AbortController;
}

// ───────────────────────────────────────────────────────────────────────────── context

export interface MockCtx {
  readonly options: MockOptions;
  readonly seedKind: SeedKind;
  readonly db: MockDb;
  readonly events: MockEvents;
  readonly clock: MockClock;
  readonly rng: Rng;
  /** Lowercase UUIDv7. */
  id(): Id;
  /** 12-char block id (§7.1). */
  blockId(): string;
  /** Throws an ApiError. */
  fail(code: ErrorCode, message: string, details?: ApiErrorDetails): never;
  /** Fractional sort key strictly between a and b. */
  keyBetween(a: string | null | undefined, b: string | null | undefined): string;
  /** The (single, v1) workspace id. Throws NOT_FOUND before onboarding. */
  workspaceId(): Id;
  emit<E extends EventName>(name: E, payload: EventMap[E]): void;
  /** Interval tied to the mock lifetime (cleared on reset). */
  every(ms: number, fn: () => void): () => void;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** True while offline mode is on (vault setting). */
  isOffline(): boolean;
  /** True while seed modules run. */
  readonly seeding: boolean;

  readonly vault: VaultService;
  readonly pages: PagesService;
  readonly docs: DocsService;
  readonly grants: GrantsService;
  readonly assets: AssetsService;
  readonly search: SearchService;
  readonly versions: VersionsService;
  readonly services: ServiceRegistry;
  readonly jobs: Map<Id, MockJobInfo>;
  /** Shared ids between seed modules, e.g. seedRefs.get('core.page.gettingStarted'). */
  readonly seedRefs: Map<string, string>;
}

/** Per-call context: the base context plus call details. */
export interface MockCallCtx extends MockCtx {
  readonly command: CommandName;
  /** (job) Report progress. */
  progress(done: number, total: number, label?: string): void;
  /** (job) Aborted by job_cancel. */
  readonly signal: AbortSignal;
  /** (job) Throws CANCELLED if the job was cancelled. */
  checkCancelled(): void;
}
