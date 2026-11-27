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
 *
 * Window (1.0 brief §5): the desktop window starts hidden. Every phase (onboarding, lock, shell, error) reports
 * `app_ready` from its first commit (App.tsx → `reportReady`), which shows the window; `showWindow` after boot is the
 * backup. Neither waits on `requestAnimationFrame` alone: a hidden WebKitGTK window never runs it.
 *
 * Lock (§2.6 lifecycle): a manual lock first sends every pending save (`installLockFlush`), then asks Rust to lock;
 * before the desktop reload, the current route and the lock reason go to sessionStorage, so the lock screen says why
 * it locked and unlocking returns to the same page.
 */
import { api, backendMode, backendReady, errorMessage, listenMany, onBackendError } from '@/backend';
import type { LockReason } from '@/backend/types';
import { getMarks, mark } from '@/lib/perf';
import { isMac, shortcutLabel } from '@/lib/platform';
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
import { resumeSetup } from '@/features/vault/Onboarding/setup';
import { registerAppCommands } from './commands';
import { installGlass, syncGlassFromKv } from './glass';
import { formatRoute, initialHashRoute, isContentRoute, navigate, startRouter, type AppRoute } from './router';
import { ROUTE_READY_EVENT } from './routeReady';
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

/** Longest a Home start waits for Home to be ready before warming the editor anyway (route-ready itself gives up at 8 s). */
const PRELOAD_AFTER_MAX_MS = 9000;

/**
 * Preload the rest of the shell (the editor, the palette) once Home has its data and has painted
 * (`emp:route-ready`) and the main thread is idle, so a Home start never evaluates the editor chunk during its
 * first render, and the download does not compete with Home's own loading (1.0 brief §5: Home interactive ≤ 1.5 s).
 */
function preloadShellWhenIdle(): void {
  if (preloaded) return;
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  let started = false;
  const run = () => {
    if (started) return;
    started = true;
    window.removeEventListener(ROUTE_READY_EVENT, onReady);
    window.clearTimeout(cap);
    if (w.requestIdleCallback) w.requestIdleCallback(() => void preloadShell(), { timeout: 1500 });
    else window.setTimeout(() => void preloadShell(), 200);
  };
  const onReady = () => run();
  window.addEventListener(ROUTE_READY_EVENT, onReady);
  const cap = window.setTimeout(run, PRELOAD_AFTER_MAX_MS);
}

// ───────────────────────────────────────────────────────────────────────────── lock resume

const RESUME_KEY = 'emp.lockResume';
/** A resume older than this is ignored (the reload follows the lock within a second). */
const RESUME_MAX_AGE_MS = 60 * 60 * 1000;

interface LockResume {
  route?: AppRoute;
  reason?: LockReason;
  at: number;
}

/** Remember where the person was (and why it locked) across the desktop reload. Never stores page content. */
function rememberForUnlock(reason?: LockReason): void {
  try {
    const prev = readResume(false);
    const route = useNav.getState().route;
    const next: LockResume = {
      route: isContentRoute(route) ? route : prev?.route,
      reason: reason ?? prev?.reason,
      at: Date.now(),
    };
    sessionStorage.setItem(RESUME_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: unlock lands on the start page */
  }
}

function readResume(consume: boolean): LockResume | null {
  try {
    const raw = sessionStorage.getItem(RESUME_KEY);
    if (consume) sessionStorage.removeItem(RESUME_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as LockResume;
    if (!v || typeof v.at !== 'number' || Date.now() - v.at > RESUME_MAX_AGE_MS) return null;
    return v;
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────── phases

let pendingRoute: AppRoute | null = null;
let wired = false;
/** The desktop reload after a lock has started (see `handleLocked`). */
let reloadingForLock = false;
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
    const resume = readResume(true);
    if (status.state === 'locked' && resume) {
      if (resume.route && isContentRoute(resume.route) && !pendingRoute) pendingRoute = resume.route;
      if (resume.reason) useVault.getState().markLocked(resume.reason);
    }
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
  // A Home start paints without the editor chunk; any other start route warms it now.
  if (route.t === 'home') preloadShellWhenIdle();
  else void preloadShell();
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
    installLockHint();
    installLockFlush();
  }
  setPhase(ws ? 'shell' : 'onboarding');
  mark('shell:ready');
  // First run continues in the background: the apps picked in onboarding build with progress on Home, and a build
  // cut short by quitting picks up where it stopped (1.0 brief §2.5).
  if (ws) void resumeSetup(ws.id).catch(() => undefined);
}

/**
 * Every manual lock (Ctrl+Shift+L, the lock indicator, the command palette, Settings) goes through
 * `useVault.getState().lock()`: wrap it so the editors' and sheets' pending saves are sent and acknowledged *before*
 * `vault_lock` runs, instead of relying on Rust's short grace after `vault:will-lock` (text typed just before the
 * shortcut used to be lost on a slow save). A second press while one lock is under way joins it.
 */
function installLockFlush(): void {
  const lock = useVault.getState().lock;
  let running: Promise<void> | null = null;
  useVault.setState({
    lock: () =>
      (running ??= (async () => {
        try {
          await flushAll(1500);
          await lock();
        } finally {
          running = null;
        }
      })()),
  });
}

/**
 * Ctrl+Shift+L in a workspace without a password has nothing to lock: explain how to turn encryption on instead of
 * doing nothing (the lock command itself only exists when the workspace is encrypted).
 */
function installLockHint(): void {
  window.addEventListener('keydown', (e) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (!mod || !e.shiftKey || e.altKey || e.code !== 'KeyL' || e.repeat) return;
    const v = useVault.getState();
    if (v.phase !== 'shell' || v.status?.state !== 'unlocked' || v.status.encrypted) return;
    e.preventDefault();
    notify.info('No password to lock with', {
      id: 'lock-hint',
      description: `Add one to lock Ultranote with ${shortcutLabel('mod+shift+l')}.`,
      action: { label: 'Add a password', onClick: () => navigate({ t: 'settings', section: 'security' }) },
    });
  });
}

/**
 * Discard the session after `vault:locked` (§13.1). `inferred`: the lock was noticed through a LOCKED error rather
 * than the event, so the reason is a guess and must not replace the one the event recorded.
 */
export async function handleLocked(reason: LockReason, opts: { inferred?: boolean } = {}): Promise<void> {
  if (backendMode === 'tauri') {
    // One reload per lock: `vault:locked` and a LOCKED error from a request still in flight both land here, and a
    // second reload would replace the lock screen just as it appears (a click on it would be lost).
    if (reloadingForLock) return;
    rememberForUnlock(opts.inferred ? undefined : reason);
  }
  await usePrivacy.getState().clearClipboard().catch(() => undefined);
  if (backendMode === 'tauri') {
    if (reloadingForLock) return;
    reloadingForLock = true;
    // A reload discards the whole JS heap, so nothing decrypted survives in memory. The URL changes in place first
    // (no navigation of its own), so the one reload opens the lock screen.
    try {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/lock`);
    } catch {
      /* the reload below still locks; the lock screen ignores the old hash */
    }
    window.location.reload();
    return;
  }
  // Browser preview: the mock lives in this heap, so reset the stores instead of reloading.
  if (opts.inferred && useVault.getState().phase === 'lock') return;
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
    'vault:will-lock': (e) => {
      if (backendMode === 'tauri') rememberForUnlock(e.reason as LockReason);
      void flushAll(1500);
    },
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
    'update:available': (e) => void notify.info(`Ultranote ${e.version} is available`, { description: 'Install it from Settings → About.' }),
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
        if (s.state === 'locked') void handleLocked('idle', { inferred: true });
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

/**
 * Resolves after the next frame, or after `ms` when no frame comes: a hidden WebKitGTK window (the desktop window
 * starts hidden) never runs `requestAnimationFrame`, so waiting on it alone would keep the window hidden.
 */
export function nextFrameOr(ms = 50): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    if (typeof requestAnimationFrame === 'function' && document.visibilityState === 'visible') requestAnimationFrame(() => finish());
    window.setTimeout(finish, document.visibilityState === 'visible' ? Math.max(ms, 100) : ms);
  });
}

/** Report boot marks and show the window (`app_ready`). Called once, from whichever phase renders first. */
export function markAppReady(): void {
  if (readySent) return;
  readySent = true;
  mark('app:ready');
  api.app.ready({ marks: getMarks() }).catch(() => undefined);
}

/** The first screen (onboarding, lock, shell or the error page) has committed: report ready on the next frame. */
export function reportReady(): void {
  if (readySent) return;
  void nextFrameOr(30).then(markAppReady);
}

/** Show the (initially hidden) desktop window once boot has decided the first screen (§3.9). No-op in the browser. */
export async function showWindow(): Promise<void> {
  if (backendMode !== 'tauri') return;
  await nextFrameOr(50);
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().show();
  } catch {
    /* window API unavailable */
  }
}
