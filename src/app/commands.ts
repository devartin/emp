/**
 * Palette command registry (§5.9, §12): `{ id, title, keywords, shortcut, run, when }`. Features register their own
 * commands with `registerCommand` (returns an unregister function); the app's built-ins are below.
 */
import { api, hasCode } from '@/backend';
import type { Id } from '@/backend/types';
import { isoDay } from '@/lib/dates';
import { useNav } from '@/stores/nav';
import { usePrivacy } from '@/stores/privacy';
import { useSettings } from '@/stores/settings';
import { notify } from '@/stores/toasts';
import { useTree } from '@/stores/tree';
import { useUi } from '@/stores/ui';
import { useUndo } from '@/stores/undo';
import { useVault } from '@/stores/vault';
import { useWorkspace } from '@/stores/workspace';
import { switchThemeWithReveal } from '@/ui/motion/themeTransition';
import { navigate, routePageId, type AppRoute } from './router';

export type CommandSection = 'Navigation' | 'Create' | 'Page' | 'View' | 'Privacy & security' | 'Go to' | 'Help' | string;

export interface AppCommand {
  id: string;
  title: string;
  section: CommandSection;
  /** Extra words the palette matches on. */
  keywords?: string[];
  /** Lucide icon name for the palette row. */
  icon?: string;
  /** Shortcut spec for display, e.g. 'mod+shift+l' (see app/shortcuts.ts). */
  shortcut?: string;
  /** Hidden from the palette (still runnable by shortcut). */
  hidden?: boolean;
  when?: () => boolean;
  run: () => void | Promise<void>;
}

const registry = new Map<string, AppCommand>();
const listeners = new Set<() => void>();
let snapshot: AppCommand[] = [];

function changed() {
  snapshot = Array.from(registry.values());
  listeners.forEach((l) => l());
}

export function registerCommand(cmd: AppCommand): () => void {
  registry.set(cmd.id, cmd);
  changed();
  return () => {
    if (registry.get(cmd.id) === cmd) {
      registry.delete(cmd.id);
      changed();
    }
  };
}

export function registerCommands(cmds: AppCommand[]): () => void {
  const offs = cmds.map(registerCommand);
  return () => offs.forEach((off) => off());
}

export function getCommand(id: string): AppCommand | undefined {
  return registry.get(id);
}

/** Every registered command (for `useSyncExternalStore`). Filter with `isAvailable`. */
export function getCommands(): AppCommand[] {
  return snapshot;
}

export function subscribeCommands(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isAvailable(cmd: AppCommand): boolean {
  try {
    return !cmd.when || cmd.when();
  } catch {
    return false;
  }
}

/** Palette-visible commands, in registration order. */
export function listCommands(): AppCommand[] {
  return snapshot.filter((c) => !c.hidden && isAvailable(c));
}

/** Runs a command if it exists and is available. Returns false otherwise. */
export function runCommand(id: string): boolean {
  const cmd = registry.get(id);
  if (!cmd || !isAvailable(cmd)) return false;
  Promise.resolve()
    .then(() => cmd.run())
    .catch((e) => notify.fromError(e, `Couldn't ${cmd.title.toLowerCase()}`));
  return true;
}

// ───────────────────────────────────────────────────────────────────────────── built-ins

const inShell = () => useVault.getState().phase === 'shell';
const currentPageId = (): Id | null => routePageId(useNav.getState().route);

export async function openTodayNote(): Promise<void> {
  const meta = await api.daily.noteOpen({ date: isoDay() });
  useTree.getState().upsert([meta]);
  useTree.getState().reveal(meta.id);
  navigate({ t: 'page', id: meta.id });
}

export async function createPageAndOpen(parentId: Id | null = null): Promise<void> {
  const meta = await useTree.getState().createPage({ parentId });
  navigate({ t: 'page', id: meta.id });
}

function regions(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-region]')).filter((el) => el.offsetParent !== null);
}

function cycleRegion(dir: 1 | -1) {
  const list = regions();
  if (!list.length) return;
  const i = list.findIndex((el) => el.contains(document.activeElement));
  const next = list[(i + dir + list.length) % list.length];
  const focusable = next.querySelector<HTMLElement>('[tabindex="0"], button, a[href], input, [contenteditable="true"]');
  (focusable ?? next).focus();
}

const go = (route: AppRoute) => () => navigate(route);

export function registerAppCommands(): () => void {
  return registerCommands([
    // Palette
    { id: 'palette.open', title: 'Search or run a command', section: 'Navigation', shortcut: 'mod+k', hidden: true, run: () => useUi.getState().togglePalette('all'), when: inShell },
    { id: 'palette.pages', title: 'Quick find', section: 'Navigation', shortcut: 'mod+p', hidden: true, run: () => useUi.getState().togglePalette('pages'), when: inShell },
    { id: 'palette.commands', title: 'Run a command', section: 'Navigation', shortcut: 'mod+shift+p', hidden: true, run: () => useUi.getState().togglePalette('commands'), when: inShell },

    // Create
    { id: 'page.new', title: 'New page', section: 'Create', icon: 'file-plus', keywords: ['create', 'add', 'document'], shortcut: 'mod+n', when: inShell, run: () => createPageAndOpen(null) },
    {
      id: 'page.newChild',
      title: 'New sub-page here',
      section: 'Create',
      icon: 'file-plus-2',
      keywords: ['child', 'nested'],
      when: () => inShell() && useNav.getState().route.t === 'page',
      run: () => createPageAndOpen(currentPageId()),
    },
    { id: 'daily.today', title: 'Open today’s daily note', section: 'Create', icon: 'calendar-days', keywords: ['journal', 'daily', 'today'], shortcut: 'mod+alt+d', when: inShell, run: openTodayNote },
    { id: 'templates.open', title: 'Browse templates', section: 'Create', icon: 'layout-template', keywords: ['template', 'gallery'], when: inShell, run: () => useUi.getState().setTemplatesOpen(true) },
    { id: 'import.open', title: 'Import…', section: 'Create', icon: 'file-down', keywords: ['notion', 'markdown', 'csv', 'xlsx', 'import'], when: inShell, run: () => useUi.getState().setImportOpen(true) },

    // Navigation
    { id: 'nav.back', title: 'Back', section: 'Navigation', icon: 'arrow-left', shortcut: 'mod+[', when: () => inShell() && useNav.getState().back.length > 0, run: () => void useNav.getState().goBack() },
    { id: 'nav.forward', title: 'Forward', section: 'Navigation', icon: 'arrow-right', shortcut: 'mod+]', when: () => inShell() && useNav.getState().forward.length > 0, run: () => void useNav.getState().goForward() },
    {
      id: 'nav.parent',
      title: 'Go to parent page',
      section: 'Navigation',
      icon: 'corner-left-up',
      shortcut: 'mod+shift+u',
      when: () => {
        const id = currentPageId();
        return inShell() && !!id && !!useTree.getState().byId.get(id)?.parentId;
      },
      run: () => {
        const id = currentPageId();
        const parent = id ? useTree.getState().byId.get(id)?.parentId : null;
        if (parent) navigate({ t: 'page', id: parent });
      },
    },
    { id: 'go.home', title: 'Home', section: 'Go to', icon: 'house', keywords: ['dashboard', 'start'], when: inShell, run: go({ t: 'home' }) },
    { id: 'go.calendar', title: 'Calendar', section: 'Go to', icon: 'calendar', keywords: ['events', 'schedule'], when: inShell, run: go({ t: 'calendar' }) },
    { id: 'go.markets', title: 'Markets', section: 'Go to', icon: 'candlestick-chart', keywords: ['stocks', 'quotes', 'watchlist'], when: inShell, run: go({ t: 'markets' }) },
    { id: 'go.lifeapps', title: 'Life apps', section: 'Go to', icon: 'sparkles', keywords: ['apps', 'gallery', 'money', 'habits'], when: inShell, run: go({ t: 'lifeapps' }) },
    { id: 'go.trash', title: 'Trash', section: 'Go to', icon: 'trash-2', keywords: ['deleted', 'restore'], when: inShell, run: go({ t: 'trash' }) },
    { id: 'settings.open', title: 'Settings', section: 'Go to', icon: 'settings', keywords: ['preferences', 'options'], shortcut: 'mod+,', when: inShell, run: go({ t: 'settings', section: 'general' }) },
    { id: 'settings.security', title: 'Security Center', section: 'Privacy & security', icon: 'shield-check', keywords: ['encryption', 'password', 'recovery', 'backup'], when: inShell, run: go({ t: 'settings', section: 'security' }) },

    // Page
    {
      id: 'page.copyLink',
      title: 'Copy link to page',
      section: 'Page',
      icon: 'link',
      shortcut: 'mod+l',
      when: () => inShell() && !!currentPageId(),
      run: async () => {
        const id = currentPageId();
        if (!id) return;
        const route = useNav.getState().route;
        const block = route.t === 'page' && route.blockId ? `#${route.blockId}` : '';
        await navigator.clipboard.writeText(`emp://page/${id}${block}`);
        notify.success('Link copied');
      },
    },
    {
      id: 'page.favorite',
      title: 'Add to Favorites',
      section: 'Page',
      icon: 'star',
      keywords: ['pin', 'favourite', 'bookmark'],
      when: () => {
        const id = currentPageId();
        return inShell() && !!id && !useWorkspace.getState().isFavorite(id);
      },
      run: () => useWorkspace.getState().toggleFavorite(currentPageId() as Id),
    },
    {
      id: 'page.unfavorite',
      title: 'Remove from Favorites',
      section: 'Page',
      icon: 'star-off',
      when: () => {
        const id = currentPageId();
        return inShell() && !!id && useWorkspace.getState().isFavorite(id);
      },
      run: () => useWorkspace.getState().toggleFavorite(currentPageId() as Id),
    },
    {
      id: 'page.duplicate',
      title: 'Duplicate page',
      section: 'Page',
      icon: 'copy',
      when: () => inShell() && useNav.getState().route.t === 'page',
      run: async () => {
        const id = currentPageId();
        if (!id) return;
        const copy = await useTree.getState().duplicate(id, true);
        if (copy) navigate({ t: 'page', id: copy.id });
      },
    },
    {
      id: 'page.delete',
      title: 'Move page to Trash',
      section: 'Page',
      icon: 'trash-2',
      keywords: ['delete', 'remove'],
      when: () => inShell() && !!currentPageId(),
      run: async () => {
        const id = currentPageId();
        if (!id) return;
        const parent = useTree.getState().byId.get(id)?.parentId ?? null;
        await useTree.getState().trash([id]);
        navigate(parent ? { t: 'page', id: parent } : { t: 'home' }, { replace: true });
      },
    },

    // View
    { id: 'sidebar.toggle', title: 'Toggle sidebar', section: 'View', icon: 'panel-left', shortcut: 'mod+\\', when: inShell, run: () => useUi.getState().toggleSidebar() },
    { id: 'panel.toggle', title: 'Toggle right panel', section: 'View', icon: 'panel-right', keywords: ['outline', 'info'], when: inShell, run: () => useUi.getState().toggleRightPanel() },
    {
      id: 'theme.toggle',
      title: 'Toggle light / dark',
      section: 'View',
      icon: 'sun-moon',
      keywords: ['theme', 'dark mode', 'appearance'],
      shortcut: 'mod+shift+d',
      run: () => switchThemeWithReveal(() => void useSettings.getState().toggleTheme()),
    },
    { id: 'zoom.in', title: 'Zoom in', section: 'View', icon: 'zoom-in', shortcut: 'mod+=', run: () => useUi.getState().zoomIn() },
    { id: 'zoom.out', title: 'Zoom out', section: 'View', icon: 'zoom-out', shortcut: 'mod+-', run: () => useUi.getState().zoomOut() },
    { id: 'zoom.reset', title: 'Actual size', section: 'View', icon: 'search', shortcut: 'mod+0', run: () => useUi.getState().zoomReset() },
    { id: 'region.next', title: 'Focus next region', section: 'View', hidden: true, shortcut: 'f6', run: () => cycleRegion(1) },
    { id: 'region.prev', title: 'Focus previous region', section: 'View', hidden: true, shortcut: 'shift+f6', run: () => cycleRegion(-1) },

    // Privacy & security
    {
      id: 'privacy.toggle',
      title: 'Hide numbers',
      section: 'Privacy & security',
      icon: 'eye-off',
      keywords: ['privacy', 'mask', 'amounts', 'balance'],
      shortcut: 'mod+shift+h',
      when: inShell,
      run: () => usePrivacy.getState().toggleHidden(),
    },
    {
      id: 'vault.lock',
      title: 'Lock EMP',
      section: 'Privacy & security',
      icon: 'lock',
      keywords: ['lock', 'secure', 'away'],
      shortcut: 'mod+shift+l',
      when: () => inShell() && !!useVault.getState().status?.encrypted,
      run: () => useVault.getState().lock(),
    },
    {
      id: 'network.offline',
      title: 'Toggle offline mode',
      section: 'Privacy & security',
      icon: 'wifi-off',
      keywords: ['network', 'internet', 'airplane'],
      shortcut: 'mod+shift+o',
      when: inShell,
      run: async () => {
        const cur = useSettings.getState().vault?.offline ?? false;
        const { offline } = await api.network.setOffline({ offline: !cur });
        const v = useSettings.getState().vault;
        if (v) useSettings.setState({ vault: { ...v, offline } });
        notify.info(offline ? 'Offline mode on' : 'Offline mode off', {
          description: offline ? 'EMP will not connect to the internet.' : 'Integrations can connect again.',
        });
      },
    },

    // Help
    { id: 'shortcuts.open', title: 'Keyboard shortcuts', section: 'Help', icon: 'keyboard', keywords: ['keys', 'cheat sheet', 'help'], shortcut: 'mod+/', run: () => useUi.getState().setShortcutsOpen(true) },

    // Undo (app stack; editor/sheet handle their own)
    { id: 'app.undo', title: 'Undo', section: 'Page', hidden: true, shortcut: 'mod+z', when: () => inShell() && useUndo.getState().past.length > 0, run: () => void useUndo.getState().undo() },
    { id: 'app.redo', title: 'Redo', section: 'Page', hidden: true, shortcut: 'mod+shift+z', when: () => inShell() && useUndo.getState().future.length > 0, run: () => void useUndo.getState().redo() },
  ]);
}

/** True when a lock is impossible (unencrypted vault) — the UI explains instead of failing. */
export function lockUnavailableReason(e: unknown): string | null {
  return hasCode(e, 'UNSUPPORTED') ? 'Turn on encryption in Settings → Security to lock EMP.' : null;
}
