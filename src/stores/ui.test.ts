/**
 * The sidebar's hidden state and width are remembered per device (brief §2.1): read synchronously at start (so the
 * first frame and the skeleton are right), written at once on change, clamped, and preferred over the vault's copy.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

describe('sidebar layout per device', () => {
  let storage: MemoryStorage;
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    storage = new MemoryStorage();
    vi.stubGlobal('localStorage', storage);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('starts from what this device remembers', async () => {
    storage.setItem('emp.shell.sidebar', JSON.stringify({ collapsed: true, width: 300 }));
    const { useUi, deviceSidebar } = await import('./ui');
    expect(useUi.getState().sidebarCollapsed).toBe(true);
    expect(useUi.getState().sidebarWidth).toBe(300);
    expect(deviceSidebar()).toEqual({ collapsed: true, width: 300 });
  });

  test('defaults when nothing (or nonsense) is stored, and clamps the width', async () => {
    storage.setItem('emp.shell.sidebar', '{"collapsed":"yes"}');
    let { useUi } = await import('./ui');
    expect(useUi.getState().sidebarCollapsed).toBe(false);
    expect(useUi.getState().sidebarWidth).toBe(248);
    vi.resetModules();
    storage.setItem('emp.shell.sidebar', JSON.stringify({ collapsed: false, width: 9999 }));
    ({ useUi } = await import('./ui'));
    expect(useUi.getState().sidebarWidth).toBe(420);
  });

  test('hiding and resizing are written for this device at once', async () => {
    const { useUi } = await import('./ui');
    useUi.getState().toggleSidebar();
    expect(JSON.parse(storage.getItem('emp.shell.sidebar') as string)).toEqual({ collapsed: true, width: 248 });
    useUi.getState().setSidebarWidth(150);
    expect(JSON.parse(storage.getItem('emp.shell.sidebar') as string)).toEqual({ collapsed: true, width: 200 });
    useUi.getState().setSidebarCollapsed(false);
    expect(JSON.parse(storage.getItem('emp.shell.sidebar') as string).collapsed).toBe(false);
  });
});

/**
 * Compact window (< 900px): one live answer for the shell and the commands. A launch can cross the breakpoint while
 * the window is still hidden, before anything listens and without a media-query `change` (the relaunch bug where the
 * docked sidebar came back hidden): the answer is read fresh each time, and resize / focus / visibility re-read it.
 */
describe('compact window', () => {
  let width = 800;
  const listeners = new Map<string, Set<() => void>>();
  const on = (type: string, fn: () => void) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type))!.add(fn);
  const off = (type: string, fn: () => void) => void listeners.get(type)?.delete(fn);
  const fire = (type: string) => listeners.get(type)?.forEach((fn) => fn());
  beforeEach(() => {
    vi.resetModules();
    listeners.clear();
    width = 800;
    vi.stubGlobal('localStorage', new MemoryStorage());
    vi.stubGlobal('window', {
      // Each query evaluates the viewport as it is now, like a new MediaQueryList.
      matchMedia: (q: string) => ({ media: q, get matches() { return width <= 899; }, addEventListener: (t: string, fn: () => void) => on(`mq:${t}`, fn), removeEventListener: (t: string, fn: () => void) => off(`mq:${t}`, fn) }),
      addEventListener: on,
      removeEventListener: off,
    });
    vi.stubGlobal('document', { addEventListener: (t: string, fn: () => void) => on(`doc:${t}`, fn), removeEventListener: (t: string, fn: () => void) => off(`doc:${t}`, fn) });
  });
  afterEach(() => vi.unstubAllGlobals());

  test('the answer follows the viewport, with no event in between', async () => {
    const { isCompactWindow } = await import('./ui');
    expect(isCompactWindow()).toBe(true);
    width = 1280; // resized while hidden: no `change` fired
    expect(isCompactWindow()).toBe(false);
  });

  test('resize, focus, visibility and the media query all tell the shell to look again; unsubscribing stops them', async () => {
    const { subscribeCompact } = await import('./ui');
    let n = 0;
    const stop = subscribeCompact(() => (n += 1));
    for (const t of ['resize', 'focus', 'doc:visibilitychange', 'mq:change']) fire(t);
    expect(n).toBe(4);
    stop();
    for (const t of ['resize', 'focus', 'doc:visibilitychange', 'mq:change']) fire(t);
    expect(n).toBe(4);
  });

  test('⌘\\ and Show agree with it: Show docks a hidden sidebar (never a toggle); compact, both open the overlay', async () => {
    const { useUi } = await import('./ui');
    const { showSidebar } = await import('@/app/commands');
    width = 1280;
    useUi.getState().setSidebarCollapsed(true);
    showSidebar();
    expect(useUi.getState().sidebarCollapsed).toBe(false);
    showSidebar();
    expect(useUi.getState().sidebarCollapsed).toBe(false);
    width = 800;
    showSidebar();
    expect(useUi.getState().sidebarPeeking).toBe(true);
    expect(useUi.getState().sidebarCollapsed).toBe(false);
  });
});
