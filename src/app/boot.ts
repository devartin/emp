/**
 * Boot sequence (§12, §13.1): `vault_status` → 'onboarding' | 'lock' | 'shell'. Preloads shell chunks while the KDF
 * runs, wires backend events into the stores, and handles lock (flush saves on `vault:will-lock`, then discard the
 * session: a full reload in the desktop app, a store reset in the browser preview).
 *
 *   // main.tsx
 *   initAppearance();                       // lib/bootPrefs, before first paint
 *   root.render(<App/>);  await boot();     // App renders by useVault(s => s.phase)
 *
 *   // LockScreen: preloadShell(); await useVault.getState().unlock(pw);   // the shell opens by itself
 *   // Onboarding: await api.vault.create(…); …; await enterShell({ route: { t: 'home' } });
 */
import { api, backendMode, backendReady, errorMessage, listenMany, onBackendError } from '@/backend';
import type { LockReason } from '@/backend/types';
import { getMarks, mark } from '@/lib/perf';
import { useNav } from '@/stores/nav';
import { installPrivacyWatchers, usePrivacy } from '@/stores/privacy';
import { useSearch } from '@/stores/search';
import { useSettings } from '@/stores/settings';
import { notify } from '@/stores/toasts';
import { useTree } from '@/stores/tree';
import { useUi } from '@/stores/ui';
import { useUndo } from '@/stores/undo';
import { installActivityTracking, useVault, type AppPhase } from '@/stores/vault';
import { useWorkspace } from '@/stores/workspace';
import { installJobTracking } from '@/stores/jobs';
import { resetMarket } from '@/stores/market';
import { registerAppCommands } from './commands';
import { installGlass, syncGlassFromKv } from './glass';
import { formatRoute, initialHashRoute, isContentRoute, startRouter, type AppRoute } from './router';
import { installShortcuts } from './shortcuts';

// ───────────────────────────────────────────────────────────────────────────── flush registry (autosave)

type Flusher = () => void | Promise<void>;
const flushers = new Set<Flusher>();

/** Editors/sheets register a flush for pending saves; called before lock and on close. */
export function registerFlush(fn: Flusher): () => void {
  flushers.add(fn);
  return () => flushers.delete(fn);
}

/** Run every flusher, giving up after `timeoutMs` (Rust allows 1.5 s after `vault:will-lock`). */
export async function flushAll(timeoutMs = 1500): Promise<void> {
  const all = Promise.allSettled(Array.from(flushers, (fn) => Promise.resolve().then(fn)));
  await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs))]);
}

// ───────────────────────────────────────────────────────────────────────────── shell preload

type Preload = () => Promise<unknown>;
const preloads = new Set<Preload>();
let preloaded: Promise<void> | null = null;

/** routes.tsx registers lazy chunk loaders (shell, editor) so they download while the KDF runs. */
export function registerShellPreload(fn: Preload): void {
  preloads.add(fn);
}

export function preloadShell(): Promise<void> {
  preloaded ??= Promise.allSettled(Array.from(preloads, (fn) => fn())).then(() => undefined);
  return preloaded;
}

// ───────────────────────────────────────────────────────────────────────────── phases

let pendingRoute: AppRoute | null = null;
let wired = false;
let shellInstalled = false;

function setPhase(phase: AppPhase, error?: string) {
  useVault.getState().setPhase(phase, error);
}

/** Decide the first screen. Safe to call once at startup. */
export async function boot(): Promise<AppPhase> {
  mark('boot:start');
  // Synchronous, before the first paint: takes over data-glass from initAppearance's platform default.
  installGlass();
  try {
    await backendReady();
  } catch (e) {
    setPhase('error', errorMessage(e));
    return 'error';
  }
  wireBackendEvents();
  installJobTracking();
  try {
    const [, status] = await Promise.all([useSettings.getState().load(), useVault.getState().refresh()]);
    mark('boot:status');
    const hash = initialHashRoute();
    if (hash && isContentRoute(hash)) pendingRoute = hash;
    if (status.state === 'uninitialized') {
      useNav.getState().reset({ t: 'onboarding' });
      setPhase('onboarding');
      void preloadShell();
      return 'onboarding';
    }
    if (status.state === 'locked') {
      useNav.getState().reset({ t: 'lock' });
      setPhase('lock');
      return 'lock';
    }
    await enterShell();
    return 'shell';
  } catch (e) {
    setPhase('error', errorMessage(e));
    return 'error';
  }
}

/**
 * Load everything the shell needs and switch to it. Call after unlock or after onboarding creates the vault.
 * `route` overrides the start page (onboarding lands on Home).
 */
export async function enterShell(opts: { route?: AppRoute } = {}): Promise<void> {
  mark('shell:enter');
  void preloadShell();
  const ui = useUi.getState();
  await Promise.all([useSettings.getState().load(), ui.loadPrefs(), useSearch.getState().load(), syncGlassFromKv()]);
  const ws = await useWorkspace.getState().openDefault();
  const vault = useSettings.getState().vault;

  usePrivacy.getState().setHidden(!!vault?.hideNumbersOnLaunch);

  let route: AppRoute = opts.route ?? pendingRoute ?? { t: 'home' };
  if (!opts.route && !pendingRoute && vault) {
    if (vault.startPage === 'last' && useWorkspace.getState().lastRoute) route = useWorkspace.getState().lastRoute as AppRoute;
    else if (vault.startPage !== 'home' && vault.startPage !== 'last' && useTree.getState().byId.has(vault.startPage)) {
      route = { t: 'page', id: vault.startPage };
    }
  }
  if (!isContentRoute(route)) route = { t: 'home' };
  pendingRoute = null;
  useNav.getState().reset(route);
  // The URL shows where the shell opened (first run lands on #/home), so a reload returns there.
  if (typeof window !== 'undefined' && window.location.hash !== formatRoute(route)) {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${formatRoute(route)}`);
  }
  if (route.t === 'page') useTree.getState().reveal(route.id);

  if (!shellInstalled) {
    shellInstalled = true;
    registerAppCommands();
    installShortcuts();
    startRouter();
    installActivityTracking();
    installPrivacyWatchers();
  }
  setPhase(ws ? 'shell' : 'onboarding');
  mark('shell:ready');
}

/** Discard the session after `vault:locked` (§13.1). */
export async function handleLocked(reason: LockReason): Promise<void> {
  await usePrivacy.getState().clearClipboard().catch(() => undefined);
  if (backendMode === 'tauri') {
    // A reload discards the whole JS heap, so nothing decrypted survives in memory.
    window.location.replace('/#/lock');
    window.location.reload();
    return;
  }
  // Browser preview: the mock lives in this heap, so reset the stores instead of reloading.
  const route = useNav.getState().route;
  if (isContentRoute(route)) pendingRoute = route;
  resetSessionStores();
  useVault.getState().markLocked(reason);
  useNav.getState().reset({ t: 'lock' });
  setPhase('lock');
}

export function resetSessionStores(): void {
  useTree.getState().reset();
  useWorkspace.getState().reset();
  useSearch.getState().clear();
  useUndo.getState().clear();
  useSettings.getState().resetVault();
  resetMarket();
  const ui = useUi.getState();
  ui.closePalette();
  ui.closePeek();
  ui.setShortcutsOpen(false);
  ui.setTemplatesOpen(false);
  ui.setImportOpen(false);
  usePrivacy.getState().setHidden(false);
}

// ───────────────────────────────────────────────────────────────────────────── events → stores

export function wireBackendEvents(): () => void {
  if (wired) return () => undefined;
  wired = true;
  const offEvents = listenMany({
    'tree:changed': (e) => useTree.getState().applyChange(e),
    'vault:will-lock': () => void flushAll(1500),
    'vault:locked': (e) => void handleLocked(e.reason),
    'vault:status': (s) => useVault.getState().setStatus(s),
    'vault:autolock-soon': (e) => useVault.getState().setCountdown(e.secondsLeft > 0 ? e.secondsLeft : null),
    'search:ready': (e) => useSearch.getState().setIndexReady(true, e.docs),
    'net:activity': (e) => useUi.getState().pulseNet(e.connector, e.host),
    'open-external:confirm': (e) => useUi.getState().pushOpenExternal(e),
    'file:dropped': (e) => useUi.getState().setDroppedFiles(e),
    'reminder:due': (e) => void notify.info('Reminder', { description: e.text, duration: 8000 }),
    'market:alert': (e) =>
      void notify.info(`${e.symbol.split(':')[0]} ${e.kind === 'above' ? 'rose above' : e.kind === 'below' ? 'fell below' : 'moved past'} your alert`, {
        description: `Now ${e.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
      }),
    'update:available': (e) => void notify.info(`Ultra Note ${e.version} is available`, { description: 'Install it from Settings → About.' }),
    'integrity:warning': (e) =>
      void notify.error('Integrity check found a problem', {
        description: `${e.damaged} item${e.damaged === 1 ? '' : 's'} could not be verified. Open Security Center for details.`,
        duration: Infinity,
      }),
    'clipboard:cleared': () => void notify.info('Clipboard cleared'),
  });
  // Unlocking from the lock screen enters the shell automatically (onboarding drives its own transition).
  const offUnlock = useVault.subscribe((s, prev) => {
    if (s.phase === 'lock' && s.status?.state === 'unlocked' && prev.status?.state !== 'unlocked') {
      void enterShell().catch((e) => setPhase('error', errorMessage(e)));
    }
  });
  const offErrors = onBackendError((err) => {
    if (err.code !== 'LOCKED' || useVault.getState().phase !== 'shell') return;
    void useVault
      .getState()
      .refresh()
      .then((s) => {
        if (s.state === 'locked') void handleLocked('idle');
      })
      .catch(() => undefined);
  });
  return () => {
    wired = false;
    offEvents();
    offUnlock();
    offErrors();
  };
}

// ───────────────────────────────────────────────────────────────────────────── readiness

let readySent = false;

/** Report boot marks once the first shell frame is on screen (`app_ready`). */
export function markAppReady(): void {
  if (readySent) return;
  readySent = true;
  mark('app:ready');
  api.app.ready({ marks: getMarks() }).catch(() => undefined);
}

/** Show the (initially hidden) desktop window after the first frame (§3.9). No-op in the browser. */
export async function showWindow(): Promise<void> {
  if (backendMode !== 'tauri') return;
  await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().show();
  } catch {
    /* window API unavailable */
  }
}
