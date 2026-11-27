/**
 * The app catalogue for "Add an app…" (brief §2.2), fetched once per session (it is fixed for a build) and warmed
 * when a project opens, so the dialog usually opens with its list already there.
 */
import { api } from "@/backend";
import type { LifeAppSummary } from "@/backend/types";

let cache: LifeAppSummary[] | null = null;
let pending: Promise<LifeAppSummary[]> | null = null;

/** The catalogue if it has loaded (v1 apps only), else null. */
export function cachedAppCatalog(): LifeAppSummary[] | null {
  return cache;
}

export function loadAppCatalog(): Promise<LifeAppSummary[]> {
  if (cache) return Promise.resolve(cache);
  pending ??= api.lifeapp
    .list()
    .then((list) => (cache = list.filter((a) => a.v1)))
    .finally(() => {
      pending = null;
    });
  return pending;
}
