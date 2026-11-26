import { beforeEach, describe, expect, test } from 'vitest';
import { formatRoute, parseRoute, routeKey, routesEqual, type AppRoute } from '@/app/router';
import { useNav } from '@/stores/nav';

const ROUTES: AppRoute[] = [
  { t: 'home' },
  { t: 'today' },
  { t: 'calendar' },
  { t: 'trash' },
  { t: 'lock' },
  { t: 'onboarding' },
  { t: 'page', id: '01937a2b-0000-7000-8000-000000000001' },
  { t: 'page', id: '01937a2b-0000-7000-8000-000000000001', blockId: 'aB3_x-9Qz0Lm' },
  { t: 'row', id: 'r1' },
  { t: 'db', id: 'd1' },
  { t: 'db', id: 'd1', viewId: 'v2' },
  { t: 'sheet', id: 's1' },
  { t: 'sheet', id: 's1', sheetId: 'tab3' },
  { t: 'app', instanceId: 'i1' },
  { t: 'app', instanceId: 'i1', tab: 'budget' },
  { t: 'markets' },
  { t: 'markets', symbol: 'BTC:CRYPTO' },
  { t: 'markets', symbol: 'VOD:XLON' },
  { t: 'settings', section: 'security' },
  { t: 'lifeapps' },
  { t: 'lifeapps', appId: 'money-hq' },
];

describe('router', () => {
  test.each(ROUTES.map((r) => [formatRoute(r), r] as const))('%s round-trips', (hash, route) => {
    expect(hash.startsWith('#/')).toBe(true);
    expect(parseRoute(hash)).toEqual(route);
  });

  test('symbols are percent-encoded', () => {
    expect(formatRoute({ t: 'markets', symbol: 'EURUSD:FX' })).toBe('#/markets/EURUSD%3AFX');
  });

  test('empty and unknown hashes fall back', () => {
    expect(parseRoute('')).toEqual({ t: 'home' });
    expect(parseRoute('#/')).toEqual({ t: 'home' });
    expect(parseRoute('#/nope/x', { t: 'trash' })).toEqual({ t: 'trash' });
    expect(parseRoute('#/page', { t: 'today' })).toEqual({ t: 'today' });
    expect(parseRoute('#/page/%E0%A4%A', { t: 'today' })).toEqual({ t: 'today' });
  });

  test('query strings after the hash are ignored', () => {
    expect(parseRoute('#/page/p1?seed=demo')).toEqual({ t: 'page', id: 'p1' });
  });

  test('settings defaults to general', () => {
    expect(parseRoute('#/settings')).toEqual({ t: 'settings', section: 'general' });
  });

  test('routesEqual and routeKey', () => {
    expect(routesEqual({ t: 'page', id: 'a' }, { t: 'page', id: 'a' })).toBe(true);
    expect(routesEqual({ t: 'page', id: 'a' }, { t: 'page', id: 'a', blockId: 'b' })).toBe(false);
    expect(routeKey({ t: 'page', id: 'a', blockId: 'b' })).toBe(routeKey({ t: 'page', id: 'a' }));
  });
});

describe('nav store', () => {
  beforeEach(() => useNav.getState().reset({ t: 'home' }));

  test('navigate pushes, back/forward move between stacks', () => {
    const nav = useNav.getState();
    nav.navigate({ t: 'page', id: 'a' });
    nav.navigate({ t: 'page', id: 'b' });
    expect(useNav.getState().back).toHaveLength(2);
    expect(useNav.getState().goBack()).toBe(true);
    expect(useNav.getState().route).toEqual({ t: 'page', id: 'a' });
    expect(useNav.getState().forward).toEqual([{ t: 'page', id: 'b' }]);
    expect(useNav.getState().goForward()).toBe(true);
    expect(useNav.getState().route).toEqual({ t: 'page', id: 'b' });
  });

  test('navigating clears forward; replace keeps the stack', () => {
    const nav = useNav.getState();
    nav.navigate({ t: 'page', id: 'a' });
    nav.navigate({ t: 'page', id: 'b' });
    useNav.getState().goBack();
    useNav.getState().navigate({ t: 'trash' });
    expect(useNav.getState().forward).toEqual([]);
    useNav.getState().navigate({ t: 'calendar' }, { replace: true });
    expect(useNav.getState().back).toEqual([{ t: 'home' }, { t: 'page', id: 'a' }]);
  });

  test('same route is a no-op; lock/onboarding never enter history', () => {
    const nav = useNav.getState();
    nav.navigate({ t: 'home' });
    expect(useNav.getState().back).toEqual([]);
    nav.navigate({ t: 'lock' });
    nav.navigate({ t: 'home' });
    expect(useNav.getState().back).toEqual([]);
    expect(useNav.getState().goBack()).toBe(false);
  });
});
