// Projects (1.0 brief §2.2) on the real Rust backend: create a project from "+ New", add a document and a spreadsheet
// from the project view, see them under the project in the sidebar (and not under Documents / Spreadsheets), move an
// installed app into the project and see it there as one row, check it all survives a restart (flags.project is
// stored by Rust), then turn the project back into a document.
import { desktopSession, sleep } from '../lib/wd.mjs';
import { ui } from '../lib/ui.mjs';
import { waitBoot } from '../lib/flows.mjs';
import { clickRow, firstRun, killApp, nativeClick, sectionRows, sectionText } from '../lib/shell.mjs';

export const name = 'shell-projects-projects';

const APP = process.env.ULTRANOTE_BIN || '/home/user/ultra-note/target/devurl/debug/emp-app';
const PROJECT = 'Kitchen refit';
const DOC = 'Shopping list';

const summary = (s) => s.exec(`const e=document.querySelector('.emp-project-summary');return e?e.innerText:null`);
const crumbs = (s) => s.exec(`const e=document.querySelector('.emp-crumbs');return e?e.innerText.replace(/\\s+/g,' '):''`);

async function until(fn, ms = 8000) {
  const t0 = Date.now();
  let v;
  while (Date.now() - t0 < ms) {
    v = await fn();
    if (v) return v;
    await sleep(200);
  }
  return v;
}

export default async function run({ shots }) {
  const port = Number(process.env.E2E_PORT || 4700);
  const problems = [];
  const launch = async (dataHome, prefix) => {
    const s = await desktopSession({ app: APP, port, nativePort: port + 1, dataHome });
    const u = ui(s, { shotsDir: shots, prefix: `${name}-${prefix}` });
    await waitBoot(s, u);
    return { s, u };
  };

  let { s, u } = await launch(undefined, '1');
  const home = s.dataHome;
  let appName = null;
  try {
    await firstRun(s, u, { apps: ['Habits'] });
    appName = await s.exec(`const r=document.querySelector('aside.emp-sidebar [role=tree][aria-label="Apps"] [data-app="habits"]');return r?r.getAttribute('aria-label'):null`);
    if (!appName) problems.push('the Habits app picked in first run is not listed under Apps');

    // "+ New" → Project: the project opens with its title ready to type.
    await nativeClick(s, 'aside.emp-sidebar .emp-sb-new');
    await u.click('Project', { selector: '[role=menuitem]' });
    await u.waitText('Nothing in this project yet');
    await sleep(400);
    const titleFocused = await s.exec(`return !!document.activeElement && document.activeElement.matches('textarea.emp-title')`);
    if (!titleFocused) problems.push('the new project did not focus its title');
    await s.keys(PROJECT);
    if (!(await until(async () => (await sectionRows(s, 'Projects'))?.includes(PROJECT)))) problems.push(`"${PROJECT}" is not listed under Projects`);
    const empty = await s.exec(`return [...document.querySelectorAll('.emp-project-empty button')].map(b=>b.innerText.trim())`);
    for (const b of ['New document', 'New spreadsheet', 'New database', 'Add an app…']) if (!empty.includes(b)) problems.push(`empty project has no "${b}" button (${JSON.stringify(empty)})`);
    await u.shot('empty-project');

    // A document from the empty project's buttons.
    const projectHash = await u.hash();
    await u.click('New document', { within: '.emp-project-empty' });
    const docReady = await until(
      () => s.exec(`const a=document.activeElement;return location.hash!==arguments[0]&&!!a&&a.matches('textarea.emp-title')&&a.value===''`, [projectHash]),
      8000,
    );
    if (!docReady) problems.push('the new document did not open with its title ready');
    await s.keys(DOC);
    await sleep(700);
    await clickRow(s, 'Projects', PROJECT);
    if (!(await until(async () => (await summary(s)) === '1 document'))) problems.push(`project summary after adding a document: ${JSON.stringify(await summary(s))}`);

    // A spreadsheet from the Add menu.
    await nativeClick(s, '.emp-project-add');
    await u.click('New spreadsheet', { selector: '[role=menuitem]' });
    await sleep(2000);
    await clickRow(s, 'Projects', PROJECT);
    if (!(await until(async () => (await summary(s)) === '1 document · 1 spreadsheet'))) problems.push(`project summary after adding a spreadsheet: ${JSON.stringify(await summary(s))}`);
    const contents = await u.text('.emp-project-contents');
    if (!contents.includes(DOC) || !/Untitled spreadsheet/.test(contents)) problems.push(`project contents miss the new pages: ${JSON.stringify(contents)}`);

    // In the sidebar they live under the project only.
    const projRows = await sectionRows(s, 'Projects');
    if (!projRows.includes(DOC) || !projRows.includes('Untitled spreadsheet')) problems.push(`Projects tree doesn't show the contents under the project: ${JSON.stringify(projRows)}`);
    if ((await sectionRows(s, 'Documents')).includes(DOC)) problems.push(`"${DOC}" also listed under Documents`);
    if ((await sectionRows(s, 'Spreadsheets')).length) problems.push(`the project's spreadsheet also listed under Spreadsheets: ${JSON.stringify(await sectionRows(s, 'Spreadsheets'))}`);

    // Move the installed app into the project: one row there, gone from Apps.
    await nativeClick(s, '.emp-project-add');
    await u.click('Add an app…', { selector: '[role=menuitem]' });
    await u.waitText('Add an app to');
    // It opens with its list (the project view fetched it), or with placeholder rows and a loading line: never blank.
    const listed = await s.exec(`const d=document.querySelector('[role=dialog]');return d?{apps:d.querySelectorAll('[data-app]').length,loading:d.querySelectorAll('[data-loading]').length,text:d.innerText}:null`);
    if (!listed || (!listed.apps && !(listed.loading && /Loading the apps/.test(listed.text)))) problems.push(`"Add an app…" opened empty: ${JSON.stringify(listed)}`);
    if (!(await until(() => s.exec(`return document.querySelectorAll('[role=dialog] [data-app]').length>=6`), 8000))) problems.push('"Add an app…" never listed the apps');
    await u.shot('add-app');
    const moved = await s.exec(`const row=document.querySelector('[role=dialog] [data-app="habits"]');const b=row&&[...row.querySelectorAll('button')].find(x=>x.innerText.trim()==='Move here');if(!b)return false;b.click();return true`);
    if (!moved) problems.push('no "Move here" for the installed Habits app');
    if (!(await until(() => s.exec(`return !!document.querySelector('aside.emp-sidebar [role=tree][aria-label="Projects"] [data-app="habits"]')`)))) problems.push('the app is not listed under the project');
    if (!(await until(() => u.has(`Moved “${appName || 'Habits'}” to “${PROJECT}”`), 4000))) problems.push('moving the app showed no "Moved … to …" toast naming the app');
    const appRows = await s.exec(`return [...document.querySelectorAll('aside.emp-sidebar [data-tree-row][data-app="habits"]')].map(e=>({tree:e.closest('[role=tree]').getAttribute('aria-label'),expandable:e.hasAttribute('aria-expanded')}))`);
    if (appRows.length !== 1 || appRows[0].tree !== 'Projects' || appRows[0].expandable) problems.push(`the app should be one leaf row under Projects: ${JSON.stringify(appRows)}`);
    if (!(await until(async () => (await summary(s)) === '1 document · 1 spreadsheet · 1 app'))) problems.push(`project summary after moving the app: ${JSON.stringify(await summary(s))}`);
    await u.shot('with-app');

    // The app opens from its row, with the project in its breadcrumbs.
    await s.exec(`document.querySelector('aside.emp-sidebar [role=tree][aria-label="Projects"] [data-app="habits"]').click()`);
    if (!(await until(async () => (await crumbs(s)).includes(PROJECT) && (await crumbs(s)).includes(appName || 'Habits')))) problems.push(`app breadcrumbs don't show the project: ${JSON.stringify(await crumbs(s))}`);
    await sleep(500);
    await u.shot('app-in-project');
    if (await u.crashed()) problems.push('the app crashed when opened from the project');
    problems.push(...(await u.errors()).map((e) => `console: ${e}`));
  } finally {
    await s.end();
    killApp(home);
  }

  // Restart: the project, its contents and the app are still there (Rust stores flags.project).
  ({ s, u } = await launch(home, '2'));
  try {
    await u.waitText('Projects', 30000);
    if (!(await until(async () => (await sectionRows(s, 'Projects'))?.includes(PROJECT), 10000))) problems.push(`after a restart "${PROJECT}" is not under Projects: ${JSON.stringify(await sectionRows(s, 'Projects'))}`);
    await clickRow(s, 'Projects', PROJECT);
    if (!(await until(async () => (await summary(s)) === '1 document · 1 spreadsheet · 1 app', 10000))) problems.push(`after a restart the project shows: ${JSON.stringify(await summary(s))}`);
    if ((await sectionRows(s, 'Apps')).length) problems.push(`after a restart the app is listed under Apps again: ${JSON.stringify(await sectionRows(s, 'Apps'))}`);

    // Turn it back into a document.
    await nativeClick(s, '[aria-label="Page options"]');
    await u.click('Turn back into a document', { selector: '[role=menuitem]' });
    if (!(await until(async () => /Add a project for related work/.test((await sectionText(s, 'Projects')) || ''), 6000))) problems.push(`Projects is not empty after turning the project back: ${JSON.stringify(await sectionText(s, 'Projects'))}`);
    if (!(await sectionRows(s, 'Documents')).includes(PROJECT)) problems.push(`"${PROJECT}" is not under Documents after turning it back`);
    if (!(await until(() => s.exec(`return !document.querySelector('.emp-project-contents')`), 4000))) problems.push('the document still shows the project contents');
    await u.shot('back-to-document');
    problems.push(...(await u.errors()).map((e) => `console: ${e}`));
  } finally {
    await s.end();
    killApp(home);
  }
  return problems;
}
