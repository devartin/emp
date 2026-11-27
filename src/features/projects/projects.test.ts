/**
 * Sidebar sections and projects (1.0 brief §2.1–§2.3): which top-level pages list in which section, children nesting
 * whatever their kind, app hubs as single leaf rows, the project helpers, the contents summary, the "hide numbers"
 * screens, and the mock backend's `flags.project` (create, update, validation, demo seed) matching Rust.
 */
import { describe, expect, test } from 'vitest';
import type { Id, LifeAppInstance, PageMeta } from '@/backend/types';
import { showsMoney } from '@/features/shell/moneyScreens';
import { appIndexOf, EMPTY_APPS, isAppOwned, isProject, projectOf, rootSectionOf, selectProjects, selectSectionRows } from '@/stores/tree';
import { expectCode, mockApi } from '@/test/helpers';
import { contentsSummary } from './summary';

let n = 0;
function page(p: Partial<PageMeta> & Pick<PageMeta, 'id'>): PageMeta {
  n += 1;
  return {
    workspaceId: 'w',
    parentId: null,
    kind: 'doc',
    sortKey: `a${String(n).padStart(4, '0')}`,
    title: p.id,
    createdAt: 0,
    updatedAt: 0,
    rev: 1,
    flags: {},
    hasChildren: false,
    ...p,
  };
}

function state(pages: PageMeta[], expanded: Id[] = [], version = 1) {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const children = new Map<Id | null, Id[]>();
  for (const p of [...pages].sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1))) {
    const list = children.get(p.parentId) ?? [];
    list.push(p.id);
    children.set(p.parentId, list);
  }
  return { byId, children, expanded: new Set(expanded), version };
}

const inst = (id: string, appId: string, rootPageId: string, detached = false): LifeAppInstance => ({
  id,
  appId,
  version: '1',
  rootPageId,
  installedAt: 0,
  upgradeAvailable: false,
  detached,
  checklist: [],
});

const pages = [
  page({ id: 'proj', flags: { project: true } }),
  page({ id: 'proj-doc', parentId: 'proj' }),
  page({ id: 'proj-sheet', parentId: 'proj', kind: 'sheet' }),
  page({ id: 'hub-habits', parentId: 'proj', kind: 'dashboard', appInstanceId: 'i-habits' }),
  page({ id: 'habits-db', parentId: 'hub-habits', kind: 'database', appInstanceId: 'i-habits' }),
  page({ id: 'notes' }),
  page({ id: 'notes-sheet', parentId: 'notes', kind: 'sheet' }),
  page({ id: 'crm', kind: 'database' }),
  page({ id: 'budget', kind: 'sheet' }),
  page({ id: 'hub-money', kind: 'dashboard', appInstanceId: 'i-money' }),
  page({ id: 'money-db', parentId: 'hub-money', kind: 'database', appInstanceId: 'i-money' }),
  page({ id: 'stray-generated', kind: 'database', appInstanceId: 'i-money' }),
  page({ id: 'old-hub', kind: 'dashboard' }),
  page({ id: 'tpl', flags: { template: true } }),
  page({ id: 'nested-proj', parentId: 'notes', flags: { project: true } }),
];
const apps = appIndexOf([inst('i-habits', 'habits', 'hub-habits'), inst('i-money', 'money-hq', 'hub-money'), inst('i-old', 'life-os', 'old-hub', true)]);
const ids = (rows: { id: Id }[]) => rows.map((r) => r.id);

describe('sidebar sections (brief §2.1)', () => {
  test('each top-level page lists in exactly one section', () => {
    const s = state(pages);
    const top = pages.filter((p) => !p.parentId);
    const where = Object.fromEntries(top.map((p) => [p.id, rootSectionOf(p, apps)]));
    expect(where).toEqual({
      proj: 'projects',
      notes: 'documents',
      crm: 'documents',
      budget: 'sheets',
      'hub-money': 'apps',
      'stray-generated': null, // an app's generated page never lists by itself
      'old-hub': 'documents', // a detached hub is an ordinary page, never an app
      tpl: null,
    });
    expect(ids(selectSectionRows(s, 'projects', apps))).toEqual(['proj']);
    expect(ids(selectSectionRows(s, 'documents', apps))).toEqual(['notes', 'crm', 'old-hub']);
    expect(ids(selectSectionRows(s, 'sheets', apps))).toEqual(['budget']);
    expect(ids(selectSectionRows(s, 'apps', apps))).toEqual(['hub-money']);
  });

  test('children nest under their parent whatever their kind; hubs are leaf rows', () => {
    const s = state(pages, ['proj', 'notes', 'hub-habits', 'hub-money'], 2);
    const projects = selectSectionRows(s, 'projects', apps);
    expect(projects.map((r) => [r.id, r.depth])).toEqual([
      ['proj', 0],
      ['proj-doc', 1],
      ['proj-sheet', 1],
      ['hub-habits', 1],
    ]);
    const hub = projects.find((r) => r.id === 'hub-habits');
    expect(hub?.hub).toEqual({ instanceId: 'i-habits', appId: 'habits' });
    expect(hub?.hasChildren).toBe(false);
    // A spreadsheet inside a document stays under the document, not in Spreadsheets.
    expect(ids(selectSectionRows(s, 'documents', apps))).toEqual(['notes', 'notes-sheet', 'nested-proj', 'crm', 'old-hub']);
    expect(ids(selectSectionRows(s, 'sheets', apps))).toEqual(['budget']);
    const appRows = selectSectionRows(s, 'apps', apps);
    expect(appRows.map((r) => [r.id, r.hasChildren])).toEqual([['hub-money', false]]);
  });

  test('rows are memoised per section and recomputed when the apps change', () => {
    const s = state(pages, [], 3);
    const a = selectSectionRows(s, 'documents', apps);
    expect(selectSectionRows(s, 'documents', apps)).toBe(a);
    expect(selectSectionRows(s, 'sheets', apps)).not.toBe(a);
    // Without the app index the hubs are ordinary dashboards (Documents).
    expect(ids(selectSectionRows(s, 'documents', EMPTY_APPS))).toContain('hub-money');
  });

  test('app index skips detached instances', () => {
    expect([...apps.hubs.keys()]).toEqual(['hub-habits', 'hub-money']);
    expect(apps.live.has('i-old')).toBe(false);
    expect(isAppOwned(pages.find((p) => p.id === 'money-db') as PageMeta, apps)).toBe(true);
    expect(isAppOwned(pages.find((p) => p.id === 'hub-money') as PageMeta, apps)).toBe(false);
  });
});

describe('projects (brief §2.2)', () => {
  test('a project is a document with flags.project', () => {
    expect(isProject({ kind: 'doc', flags: { project: true } })).toBe(true);
    expect(isProject({ kind: 'doc', flags: {} })).toBe(false);
    expect(isProject({ kind: 'sheet', flags: { project: true } })).toBe(false);
  });

  test('projects list top-level first; projectOf finds the nearest one', () => {
    const s = state(pages);
    expect(selectProjects(s).map((p) => p.id)).toEqual(['proj', 'nested-proj']);
    expect(projectOf(s, 'habits-db')?.id).toBe('proj');
    expect(projectOf(s, 'proj')?.id).toBe('proj');
    expect(projectOf(s, 'crm')).toBeNull();
  });

  test('contents summary', () => {
    expect(contentsSummary({ documents: 3, sheets: 1, apps: 1 })).toBe('3 documents · 1 spreadsheet · 1 app');
    expect(contentsSummary({ databases: 2 })).toBe('2 databases');
    expect(contentsSummary({})).toBe('');
  });
});

describe('page menu project items (brief §2.1, §2.2)', () => {
  test("offered on documents and pages; not on an app's generated pages or templates; an app's hub moves but never becomes a project", async () => {
    const { useWorkspace } = await import('@/stores/workspace');
    const { pageActions } = await import('@/features/shell/PageMenu');
    useWorkspace.setState({ lifeapps: [inst('i-habits', 'habits', 'hub-habits')] });
    const ids = (m: PageMeta) => pageActions(m).map((a) => a.id);
    expect(ids(page({ id: 'doc' }))).toEqual(expect.arrayContaining(['project-on', 'move-project']));
    expect(ids(page({ id: 'proj2', flags: { project: true } }))).toEqual(expect.arrayContaining(['project-off', 'move-project']));
    expect(ids(page({ id: 'sheet', kind: 'sheet' }))).toContain('move-project');
    expect(ids(page({ id: 'sheet', kind: 'sheet' }))).not.toContain('project-on');
    const owned = ids(page({ id: 'habits-db2', kind: 'database', parentId: 'hub-habits', appInstanceId: 'i-habits' }));
    expect(owned).not.toContain('move-project');
    expect(owned).not.toContain('project-on');
    const hub = ids(page({ id: 'hub-habits', kind: 'doc', appInstanceId: 'i-habits' }));
    expect(hub).toContain('move-project');
    expect(hub).not.toContain('project-on');
    const tpl = ids(page({ id: 'tpl', flags: { template: true } }));
    expect(tpl).not.toContain('move-project');
    expect(tpl).not.toContain('project-on');
    // A page from a removed (or detached) app is an ordinary page again.
    useWorkspace.setState({ lifeapps: [] });
    expect(ids(page({ id: 'orphan', appInstanceId: 'i-gone' }))).toContain('move-project');
  });
});

describe('hide numbers only where money shows (brief §2.3)', () => {
  const lifeapps = [inst('m', 'money-hq', 'hm'), inst('h', 'habits', 'hh')];
  test.each([
    [{ t: 'app', instanceId: 'm' }, undefined, true],
    [{ t: 'app', instanceId: 'h' }, undefined, false],
    [{ t: 'markets' }, undefined, true],
    [{ t: 'home' }, undefined, true],
    [{ t: 'page', id: 'x' }, 'm', true],
    [{ t: 'db', id: 'x' }, undefined, false],
    [{ t: 'calendar' }, undefined, false],
    [{ t: 'settings', section: 'general' }, undefined, false],
  ] as const)('%j (owner %s) → %s', (route, owner, want) => {
    expect(showsMoney(route, lifeapps, owner)).toBe(want);
  });
  test('Home without a money app shows no eye', () => {
    expect(showsMoney({ t: 'home' }, [inst('h', 'habits', 'hh')])).toBe(false);
  });
});

describe('mock backend: flags.project (same rules as Rust)', () => {
  test('page_create takes flags; only documents can be projects; updates merge', async () => {
    const { api } = await mockApi();
    const [ws] = await api.workspace.list();
    const { meta } = await api.page.create({ workspaceId: ws.id, parentId: null, kind: 'doc', title: 'Garden', flags: { project: true } });
    expect(meta.flags.project).toBe(true);
    await expectCode(api.page.create({ workspaceId: ws.id, parentId: null, kind: 'dashboard', title: 'Board', flags: { project: true } }), 'INVALID');
    const wide = await api.page.updateMeta({ id: meta.id, patch: { flags: { fullWidth: true } } });
    expect(wide.flags.project).toBe(true);
    const back = await api.page.updateMeta({ id: meta.id, patch: { flags: { project: false } } });
    expect(back.flags.project).toBe(false);
    const sheet = await api.sheet.workbookCreate({ workspaceId: ws.id, parentId: meta.id, title: 'Costs' });
    await expectCode(api.page.updateMeta({ id: sheet.page.id, patch: { flags: { project: true } } }), 'INVALID');
  });

  test('the demo has two projects with documents, spreadsheets and a database inside', async () => {
    const { api } = await mockApi();
    const [ws] = await api.workspace.list();
    const { pages: all } = await api.workspace.open({ id: ws.id });
    const live = all.filter((p) => !p.deletedAt);
    const byTitle = (t: string) => live.find((p) => p.title === t);
    const relaunch = byTitle('Website relaunch');
    const trip = byTitle('Lisbon in March');
    for (const p of [relaunch, trip]) {
      expect(p?.flags.project).toBe(true);
      expect(p?.parentId).toBeNull();
    }
    const kinds = (id: Id | undefined) => live.filter((p) => p.parentId === id).map((p) => p.kind).sort();
    expect(kinds(relaunch?.id)).toEqual(['database', 'doc', 'sheet']);
    expect(kinds(trip?.id)).toEqual(['doc', 'doc', 'sheet']);
    expect(byTitle('Kitchen renovation')?.parentId).toBeNull();
    expect(live.some((p) => p.title === 'Projects' && p.kind === 'doc' && !p.parentId)).toBe(false);
  });
});
