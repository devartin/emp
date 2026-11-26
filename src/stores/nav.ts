/**
 * Navigation state (§13.1): the current route and back/forward stacks (⌘[ / ⌘]). `lastRoute` is remembered in kv
 * `ui.nav`/`lastRoute` so "start page: last" and reloads land where you were.
 */
import { create } from 'zustand';
import { api } from '@/backend';
import type { AppRoute } from '@/app/router';

const STACK_MAX = 100;

const key = (r: AppRoute): string => JSON.stringify(r);
const same = (a: AppRoute | undefined, b: AppRoute | undefined) => !!a && !!b && key(a) === key(b);
const remember = (r: AppRoute) => r.t !== 'lock' && r.t !== 'onboarding';

interface NavOpts {
  replace?: boolean;
  /** @internal set by the router when the change came from the URL. */
  fromBrowser?: boolean;
}

interface NavState {
  route: AppRoute;
  back: AppRoute[];
  forward: AppRoute[];
  /** How the last change happened (the router mirrors pushes as history entries). */
  lastChange: 'push' | 'replace' | 'back' | 'forward' | 'browser' | 'init';
  navigate(route: AppRoute, opts?: NavOpts): void;
  goBack(opts?: NavOpts): boolean;
  goForward(opts?: NavOpts): boolean;
  /** Replace without touching the stacks (boot, lock). */
  reset(route: AppRoute): void;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistLast(route: AppRoute) {
  if (!remember(route)) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    api.kv.set({ ns: 'ui.nav', key: 'lastRoute', value: route }).catch(() => undefined);
  }, 600);
}

export const useNav = create<NavState>()((set, get) => ({
  route: { t: 'home' },
  back: [],
  forward: [],
  lastChange: 'init',

  navigate(route, opts = {}) {
    const cur = get().route;
    if (same(cur, route)) return;
    const change = opts.fromBrowser ? 'browser' : opts.replace ? 'replace' : 'push';
    if (opts.replace || !remember(cur) || !remember(route)) {
      set({ route, lastChange: change });
    } else {
      set((s) => ({ route, back: [...s.back, cur].slice(-STACK_MAX), forward: [], lastChange: change }));
    }
    persistLast(route);
  },

  goBack(opts = {}) {
    const { back, route } = get();
    const prev = back[back.length - 1];
    if (!prev) return false;
    set((s) => ({
      route: prev,
      back: s.back.slice(0, -1),
      forward: [...s.forward, route].slice(-STACK_MAX),
      lastChange: opts.fromBrowser ? 'browser' : 'back',
    }));
    persistLast(prev);
    return true;
  },

  goForward(opts = {}) {
    const { forward, route } = get();
    const next = forward[forward.length - 1];
    if (!next) return false;
    set((s) => ({
      route: next,
      forward: s.forward.slice(0, -1),
      back: [...s.back, route].slice(-STACK_MAX),
      lastChange: opts.fromBrowser ? 'browser' : 'forward',
    }));
    persistLast(next);
    return true;
  },

  reset(route) {
    set({ route, back: [], forward: [], lastChange: 'replace' });
  },
}));

export const selectCanGoBack = (s: NavState) => s.back.length > 0;
export const selectCanGoForward = (s: NavState) => s.forward.length > 0;
