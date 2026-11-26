/**
 * Typed hash router (§12): SPEC `Route` variants plus `{ t: 'calendar' }`, mirrored to `location.hash`.
 *
 *   #/home  #/today  #/calendar  #/trash  #/lock  #/onboarding
 *   #/page/<id>[/b/<blockId>]  #/row/<id>  #/db/<id>[/v/<viewId>]  #/sheet/<id>[/s/<sheetId>]
 *   #/app/<instanceId>[/<tab>]  #/markets[/<SYMBOL:MIC>]  #/settings/<section>  #/lifeapps[/<appId>]
 *
 * State lives in the nav store (back/forward stacks); `startRouter()` keeps the hash in sync both ways.
 */
import type { Id, Route } from '@/backend/types';
import { useNav } from '@/stores/nav';

export type AppRoute = Route | { t: 'calendar' };
export type RouteKind = AppRoute['t'];

const enc = encodeURIComponent;
const dec = (s: string | undefined): string | undefined => {
  if (s === undefined || s === '') return undefined;
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
};

export const HOME: AppRoute = { t: 'home' };

/** Route → '#/…' */
export function formatRoute(r: AppRoute): string {
  switch (r.t) {
    case 'page':
      return `#/page/${enc(r.id)}${r.blockId ? `/b/${enc(r.blockId)}` : ''}`;
    case 'row':
      return `#/row/${enc(r.id)}`;
    case 'db':
      return `#/db/${enc(r.id)}${r.viewId ? `/v/${enc(r.viewId)}` : ''}`;
    case 'sheet':
      return `#/sheet/${enc(r.id)}${r.sheetId ? `/s/${enc(r.sheetId)}` : ''}`;
    case 'app':
      return `#/app/${enc(r.instanceId)}${r.tab ? `/${enc(r.tab)}` : ''}`;
    case 'markets':
      return r.symbol ? `#/markets/${enc(r.symbol)}` : '#/markets';
    case 'settings':
      return `#/settings/${enc(r.section || 'general')}`;
    case 'lifeapps':
      return r.appId ? `#/lifeapps/${enc(r.appId)}` : '#/lifeapps';
    default:
      return `#/${r.t}`;
  }
}

/** '#/…' (or '/…') → Route; unknown paths fall back to `fallback`. */
export function parseRoute(hash: string, fallback: AppRoute = HOME): AppRoute {
  const path = hash.replace(/^#/, '').replace(/\?.*$/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  const [head, a, b, c] = path.split('/');
  const id = dec(a);
  switch (head) {
    case '':
    case 'home':
      return { t: 'home' };
    case 'today':
    case 'calendar':
    case 'trash':
    case 'lock':
    case 'onboarding':
      return { t: head };
    case 'page':
      if (!id) return fallback;
      return b === 'b' && dec(c) ? { t: 'page', id, blockId: dec(c) as string } : { t: 'page', id };
    case 'row':
      return id ? { t: 'row', id } : fallback;
    case 'db':
      if (!id) return fallback;
      return b === 'v' && dec(c) ? { t: 'db', id, viewId: dec(c) as Id } : { t: 'db', id };
    case 'sheet':
      if (!id) return fallback;
      return b === 's' && dec(c) ? { t: 'sheet', id, sheetId: dec(c) as Id } : { t: 'sheet', id };
    case 'app':
      if (!id) return fallback;
      return dec(b) ? { t: 'app', instanceId: id, tab: dec(b) as string } : { t: 'app', instanceId: id };
    case 'markets':
      return id ? { t: 'markets', symbol: id } : { t: 'markets' };
    case 'settings':
      return { t: 'settings', section: id ?? 'general' };
    case 'lifeapps':
      return id ? { t: 'lifeapps', appId: id } : { t: 'lifeapps' };
    default:
      return fallback;
  }
}

export function routesEqual(a: AppRoute | null | undefined, b: AppRoute | null | undefined): boolean {
  if (!a || !b) return a === b;
  return formatRoute(a) === formatRoute(b);
}

/** Stable key (e.g. for AnimatePresence); ignores sub-targets that don't remount the view. */
export function routeKey(r: AppRoute): string {
  switch (r.t) {
    case 'page':
    case 'row':
    case 'db':
    case 'sheet':
      return `${r.t}:${r.id}`;
    case 'app':
      return `app:${r.instanceId}`;
    default:
      return r.t;
  }
}

/** Routes that represent content (remembered as `lastRoute`, kept in back/forward history). */
export function isContentRoute(r: AppRoute): boolean {
  return r.t !== 'lock' && r.t !== 'onboarding';
}

/** The id of the page-like target, if any (for favourites, breadcrumbs, ⌘L). */
export function routePageId(r: AppRoute): Id | null {
  if (r.t === 'page' || r.t === 'db' || r.t === 'sheet') return r.id;
  return null;
}

/** Use as `<a href={href(route)}>` — clicks should still call `navigate()` to keep the stacks. */
export const href = formatRoute;

export function navigate(route: AppRoute, opts?: { replace?: boolean }): void {
  useNav.getState().navigate(route, opts);
}

export function currentRoute(): AppRoute {
  return useNav.getState().route;
}

/** Shorthand hook for components. */
export function useRoute(): AppRoute {
  return useNav((s) => s.route);
}

let started = false;

/**
 * Two-way hash sync. Store navigations push a history entry (replace for replace/back/forward); hash changes from the
 * browser (back button, pasted links) become store navigations. Returns a stop function.
 */
export function startRouter(): () => void {
  if (started || typeof window === 'undefined') return () => undefined;
  started = true;
  let applying = false;

  const onHash = () => {
    if (applying) return;
    const next = parseRoute(window.location.hash, useNav.getState().route);
    const nav = useNav.getState();
    if (routesEqual(next, nav.route)) return;
    if (routesEqual(next, nav.back[nav.back.length - 1])) nav.goBack({ fromBrowser: true });
    else if (routesEqual(next, nav.forward[nav.forward.length - 1])) nav.goForward({ fromBrowser: true });
    else nav.navigate(next, { fromBrowser: true });
  };

  const unsub = useNav.subscribe((s, prev) => {
    if (routesEqual(s.route, prev.route) || s.lastChange === 'browser') return;
    const target = formatRoute(s.route);
    if (window.location.hash === target) return;
    applying = true;
    const url = `${window.location.pathname}${window.location.search}${target}`;
    if (s.lastChange === 'push') window.history.pushState(null, '', url);
    else window.history.replaceState(null, '', url);
    applying = false;
  });

  window.addEventListener('hashchange', onHash);
  window.addEventListener('popstate', onHash);
  return () => {
    started = false;
    unsub();
    window.removeEventListener('hashchange', onHash);
    window.removeEventListener('popstate', onHash);
  };
}

/** The route encoded in the current URL, if any (used at boot to honour deep links and reloads). */
export function initialHashRoute(): AppRoute | null {
  if (typeof window === 'undefined') return null;
  const h = window.location.hash;
  if (!h || h === '#' || h === '#/') return null;
  return parseRoute(h, HOME);
}
