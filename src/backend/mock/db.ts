/**
 * In-memory tables for the mock backend. Any namespace may create its own table by name:
 *
 *   const rows = ctx.db.table<MyRow>('db_rows');
 *   rows.insert({ id, rev: 1, ... });            // throws CONFLICT if the id exists
 *   rows.update(id, { title: 'x' });             // shallow merge; bumps `rev` when the record has a numeric rev
 *   rows.update(id, (r) => { r.values[p] = v }); // or mutate in place
 *
 * Records are stored by reference; the dispatcher `structuredClone`s every request and response, so handlers may
 * return stored records directly. Every mutation bumps `db.version` and notifies change listeners (persistence).
 * Records must be structured-cloneable (plain data, Blob/ArrayBuffer allowed).
 */
import { BackendError } from '../errors';

export interface Keyed {
  id: string;
}

export class MockTable<T extends Keyed> {
  readonly name: string;
  private readonly rows: Map<string, T>;
  private readonly touch: () => void;

  constructor(name: string, rows: Map<string, T>, touch: () => void) {
    this.name = name;
    this.rows = rows;
    this.touch = touch;
  }

  get size(): number {
    return this.rows.size;
  }

  has(id: string): boolean {
    return this.rows.has(id);
  }

  get(id: string | null | undefined): T | undefined {
    return id == null ? undefined : this.rows.get(id);
  }

  /** Like `get`, but throws NOT_FOUND. */
  require(id: string | null | undefined, what = this.name): T {
    const row = id == null ? undefined : this.rows.get(id);
    if (!row) throw new BackendError('NOT_FOUND', `${what} not found`);
    return row;
  }

  all(): T[] {
    return Array.from(this.rows.values());
  }

  values(): IterableIterator<T> {
    return this.rows.values();
  }

  filter(pred: (row: T) => boolean): T[] {
    const out: T[] = [];
    for (const r of this.rows.values()) if (pred(r)) out.push(r);
    return out;
  }

  find(pred: (row: T) => boolean): T | undefined {
    for (const r of this.rows.values()) if (pred(r)) return r;
    return undefined;
  }

  insert(row: T): T {
    if (this.rows.has(row.id)) throw new BackendError('CONFLICT', `${this.name} ${row.id} already exists`);
    this.rows.set(row.id, row);
    this.touch();
    return row;
  }

  /** Insert or replace. */
  put(row: T): T {
    this.rows.set(row.id, row);
    this.touch();
    return row;
  }

  update(id: string, patch: Partial<T> | ((row: T) => void)): T {
    const row = this.require(id);
    if (typeof patch === 'function') patch(row);
    else Object.assign(row, patch);
    const r = row as unknown as { rev?: unknown };
    if (typeof r.rev === 'number') r.rev += 1;
    this.touch();
    return row;
  }

  delete(id: string): boolean {
    const had = this.rows.delete(id);
    if (had) this.touch();
    return had;
  }

  deleteWhere(pred: (row: T) => boolean): number {
    let n = 0;
    for (const [id, r] of this.rows) {
      if (pred(r)) {
        this.rows.delete(id);
        n++;
      }
    }
    if (n) this.touch();
    return n;
  }

  clear(): void {
    if (this.rows.size) {
      this.rows.clear();
      this.touch();
    }
  }
}

export type DbSnapshot = Record<string, unknown[]>;

export class MockDb {
  private tables = new Map<string, Map<string, Keyed>>();
  private listeners = new Set<() => void>();
  /** Monotonic mutation counter. */
  version = 0;
  /** Tables listed here are kept in memory but never persisted (e.g. Blob caches rebuilt on load). */
  readonly volatile = new Set<string>();

  private touch = () => {
    this.version += 1;
    for (const fn of this.listeners) fn();
  };

  table<T extends Keyed>(name: string): MockTable<T> {
    let rows = this.tables.get(name);
    if (!rows) {
      rows = new Map();
      this.tables.set(name, rows);
    }
    return new MockTable<T>(name, rows as Map<string, T>, this.touch);
  }

  /** Single-record convenience store: `db.meta<T>('vault')`. */
  meta<T>(key: string): T | undefined {
    const row = this.table<{ id: string; value: T }>('_meta').get(key);
    return row?.value;
  }

  setMeta<T>(key: string, value: T): void {
    this.table<{ id: string; value: T }>('_meta').put({ id: key, value });
  }

  tableNames(): string[] {
    return Array.from(this.tables.keys());
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  snapshot(): DbSnapshot {
    const out: DbSnapshot = {};
    for (const [name, rows] of this.tables) {
      if (this.volatile.has(name)) continue;
      out[name] = Array.from(rows.values());
    }
    return out;
  }

  load(snap: DbSnapshot): void {
    this.tables.clear();
    for (const [name, rows] of Object.entries(snap)) {
      const m = new Map<string, Keyed>();
      for (const r of rows as Keyed[]) m.set(r.id, r);
      this.tables.set(name, m);
    }
    this.touch();
  }

  reset(): void {
    this.tables.clear();
    this.touch();
  }
}
