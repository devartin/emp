/**
 * Data hooks for life-app screens. Server state lives in component state fed by commands and kept fresh by events
 * (§13.1 — no query library): `db:changed` refetches rows and (debounced 250 ms, like the Rust metric cache) metrics.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api, listen } from "@/backend";
import type { DbSchema, Id, Insight, LifeAppInstance, LifeAppManifest, LifeAppMetric, Property, RowDTO } from "@/backend/types";
import { useTree } from "@/stores/tree";
import { useWorkspace } from "@/stores/workspace";

export function useInstance(instanceId: Id | null | undefined): LifeAppInstance | undefined {
  return useWorkspace(useShallow((s) => (instanceId ? s.lifeapps.find((i) => i.id === instanceId) : undefined)));
}

const manifestCache = new Map<string, Promise<LifeAppManifest>>();
export function loadManifest(appId: string): Promise<LifeAppManifest> {
  let p = manifestCache.get(appId);
  if (!p) {
    p = api.lifeapp.manifest({ id: appId });
    p.catch(() => manifestCache.delete(appId));
    manifestCache.set(appId, p);
  }
  return p;
}

export function useManifest(appId: string | null | undefined): LifeAppManifest | null {
  const [m, setM] = useState<LifeAppManifest | null>(null);
  useEffect(() => {
    if (!appId) return;
    let live = true;
    loadManifest(appId).then((x) => live && setM(x)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [appId]);
  return appId ? m : null;
}

/** Calls `fn` (debounced) whenever any database changes. */
export function useDbChanged(fn: (databaseId: Id) => void, delay = 250): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    let last: Id = "";
    const off = listen("db:changed", (e) => {
      last = e.databaseId;
      if (t) clearTimeout(t);
      t = setTimeout(() => ref.current(last), delay);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  }, [delay]);
}

export function useMetrics(instanceId: Id | null | undefined, names: string[] = []): { metrics: Record<string, LifeAppMetric> | null; refresh: () => void } {
  const [metrics, setMetrics] = useState<Record<string, LifeAppMetric> | null>(null);
  const key = names.join(",");
  const seq = useRef(0);
  const refresh = useCallback(() => {
    if (!instanceId) return;
    const n = ++seq.current;
    api.lifeapp
      .metrics({ instanceId, names })
      .then((m) => n === seq.current && setMetrics(m))
      .catch(() => n === seq.current && setMetrics((prev) => prev ?? {}));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId, key]);
  useEffect(() => {
    setMetrics(null);
    refresh();
  }, [refresh]);
  useDbChanged(() => refresh());
  return { metrics, refresh };
}

export function useInsights(instanceId?: Id): { insights: Insight[] | null; refresh: () => void; dismiss: (i: Insight, until: number | null) => Promise<void> } {
  const [insights, setInsights] = useState<Insight[] | null>(null);
  const refresh = useCallback(() => {
    api.lifeapp
      .insights(instanceId ? { instanceId } : {})
      .then(setInsights)
      .catch(() => setInsights((p) => p ?? []));
  }, [instanceId]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useDbChanged(() => refresh(), 600);
  const dismiss = useCallback(async (i: Insight, until: number | null) => {
    setInsights((list) => (list ? list.filter((x) => x.id !== i.id) : list));
    try {
      await api.lifeapp.insightMute({ instanceId: i.appInstanceId, ruleId: i.ruleId, until });
    } catch {
      refresh();
    }
  }, [refresh]);
  return { insights, refresh, dismiss };
}

// ───────────────────────────────────────────────────────────────────────────── app databases by role

export interface AppDb {
  id: Id;
  title: string;
  schema: DbSchema;
  /** Property by role (falls back to name). */
  p(roleOrName: string): Property | undefined;
}

function toAppDb(schema: DbSchema): AppDb {
  const byRole = new Map<string, Property>();
  for (const p of schema.properties) if (p.role) byRole.set(p.role, p);
  for (const [role, pid] of Object.entries(schema.database.roles ?? {})) {
    const p = schema.properties.find((x) => x.id === pid);
    if (p && !byRole.has(role)) byRole.set(role, p);
  }
  const byName = new Map(schema.properties.map((p) => [p.name, p] as const));
  return { id: schema.database.id, title: schema.database.title, schema, p: (k) => byRole.get(k) ?? byName.get(k) };
}

/** Databases generated for an instance, keyed by a role they carry (e.g. 'task.status' → Tasks). */
export function useAppDatabases(instanceId: Id | null | undefined): { dbs: AppDb[] | null; byRole: (role: string) => AppDb | undefined; refresh: () => void } {
  const ids = useTree(useShallow((s) => {
    if (!instanceId) return [] as Id[];
    const out: Id[] = [];
    for (const p of s.byId.values()) if (p.kind === "database" && p.appInstanceId === instanceId && !p.deletedAt) out.push(p.id);
    return out.sort();
  }));
  const [dbs, setDbs] = useState<AppDb[] | null>(null);
  const key = ids.join(",");
  const load = useCallback(() => {
    if (!ids.length) {
      setDbs([]);
      return;
    }
    Promise.all(ids.map((id) => api.db.getSchema({ id }).then(toAppDb).catch(() => null))).then((list) => setDbs(list.filter((x): x is AppDb => !!x)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => load(), [load]);
  const byRole = useCallback((role: string) => dbs?.find((d) => d.schema.properties.some((p) => p.role === role) || role in (d.schema.database.roles ?? {})), [dbs]);
  return { dbs, byRole, refresh: load };
}

/** All rows of a database (up to 500), refetched on `db:changed` for it. */
export function useRows(databaseId: Id | null | undefined): { rows: RowDTO[] | null; refresh: () => void; setRows: (fn: (rows: RowDTO[]) => RowDTO[]) => void } {
  const [rows, setRowsState] = useState<RowDTO[] | null>(null);
  const seq = useRef(0);
  const refresh = useCallback(() => {
    if (!databaseId) return;
    const n = ++seq.current;
    api.db
      .query({ databaseId, window: { offset: 0, limit: 500 }, reqId: n })
      .then((res) => {
        if (n !== seq.current || "notModified" in res) return;
        setRowsState(res.rows);
      })
      .catch(() => n === seq.current && setRowsState((p) => p ?? []));
  }, [databaseId]);
  useEffect(() => {
    setRowsState(null);
    refresh();
  }, [refresh]);
  useEffect(() => {
    if (!databaseId) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = listen("db:changed", (e) => {
      if (e.databaseId !== databaseId) return;
      if (t) clearTimeout(t);
      t = setTimeout(refresh, 60);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  }, [databaseId, refresh]);
  const setRows = useCallback((fn: (rows: RowDTO[]) => RowDTO[]) => setRowsState((r) => (r ? fn(r) : r)), []);
  return { rows, refresh, setRows };
}

/** Root + child pages of an instance (for "Pages" lists and dashboard routing). */
export function useAppPages(rootPageId: Id | null | undefined) {
  return useTree(useShallow((s) => {
    if (!rootPageId) return [];
    return (s.children.get(rootPageId) ?? []).map((id) => s.byId.get(id)).filter((p): p is NonNullable<typeof p> => !!p && !p.deletedAt);
  }));
}

export function useStableNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const h = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(h);
  }, [intervalMs]);
  return useMemo(() => now, [now]);
}
