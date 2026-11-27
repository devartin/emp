// Apps on the real desktop app (1.0 brief §1, §2.2, §6, §9): every app installs through its setup wizard and its hub
// shows real content.
//   - Tasks: quick add lands in the list and persists; completing a task fills Done / Completed at (Rust upkeep);
//     a completed recurring task spawns the next occurrence; Lists can be added; Home's capture adds a task that
//     shows on Home's due list.
//   - Habits: the starter habit checks in, the Habits database's streak column follows (Rust upkeep), and a new
//     habit can be added in the hub.
//   - Spreadsheet Studio: every template card creates its own spreadsheet with computed values and no errors; a
//     second click makes a second one; `workbook_count` counts them.
//   - Money, Investments and Taxes open their hubs; Markets shows prices or a clear "not available" message (never
//     endless placeholders) and no demo tickers.
//   - One instance per app (CONFLICT), apps inside a project (`parentId`), and the 1.0 names in the sidebar.
// Run: DISPLAY=:99 dbus-run-session -- node scripts/e2e/run.mjs apps-core
//   E2E_PORT (default 4600; the native driver uses E2E_PORT+1) and ULTRANOTE_BIN override the defaults. A private D-Bus
//   (dbus-run-session) keeps the single-instance lock of other running copies from swallowing this launch.
import { desktopSession, sleep } from '../lib/wd.mjs';
import { ui } from '../lib/ui.mjs';
import { waitBoot, onboardPlain, endSession } from '../lib/flows.mjs';

export const name = 'apps-core';

const PORT = Number(process.env.E2E_PORT || 4600);
const APP = process.env.ULTRANOTE_BIN || '/home/user/ultra-note/target/devurl/debug/emp-app';

/** Calls a backend command from the page (the same IPC the app uses). Resolves `{ ok }` or `{ err: { code, message } }`. */
function ipc(s, cmd, req) {
  return s.execAsync(
    `const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke(arguments[0],{req:arguments[1]})` +
      `.then(v=>done({ok:v===undefined?null:v}))` +
      `.catch(e=>done({err:typeof e==='object'&&e?{code:e.code,message:e.message}:{code:'?',message:String(e)}}))`,
    [cmd, req],
  );
}

async function call(s, cmd, req) {
  const r = await ipc(s, cmd, req);
  if (r.err) throw new Error(`${cmd}: ${r.err.code} ${r.err.message}`);
  return r.ok;
}

async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await fn().catch((e) => ({ __err: e.message }));
    if (last && !last.__err) return last;
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${what}${last?.__err ? ` (${last.__err})` : ''}`);
}

/**
 * Clicks the first visible, enabled button whose label is `label` (its own text, ignoring a trailing keyboard hint
 * such as "Enter") inside `within`; false when there is none.
 */
function clickExact(s, label, within = 'body') {
  return s.exec(
    `const root=document.querySelector(arguments[1])||document.body;const own=e=>{const c=e.cloneNode(true);c.querySelectorAll('kbd,.emp-kbd,[class*=kbd]').forEach(k=>k.remove());return c.textContent.replace(/\\s+/g,' ').trim()};` +
      `const b=[...root.querySelectorAll('button')].find(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&!e.disabled&&own(e)===arguments[0]});if(!b)return false;b.click();return true`,
    [label, within],
  );
}

/** Waits for an enabled input with this aria-label. */
function waitField(s, label, ms = 15000) {
  return waitFor(
    () => s.exec(`const e=document.querySelector('input[aria-label="'+arguments[0]+'"]');return e&&!e.disabled?true:null`, [label]),
    ms,
    `the "${label}" field`,
  );
}

const APPS = [
  { id: 'life-os', name: 'Tasks' },
  { id: 'habits', name: 'Habits' },
  { id: 'spreadsheet-studio', name: 'Spreadsheet Studio' },
  { id: 'money-hq', name: 'Money' },
  { id: 'portfolio', name: 'Investments' },
  { id: 'tax-organizer', name: 'Taxes' },
];

/** Opens the app's setup wizard, answers Quick mode with the defaults and creates the app. Returns its instance. */
async function installViaWizard(s, u, app, failures) {
  await u.route(`#/lifeapps/${app.id}`);
  await u.waitText(`Set up ${app.name}`, 20000);
  let created = false;
  for (let i = 0; i < 25 && !created; i++) {
    await sleep(450);
    if (await clickExact(s, `Create ${app.name}`, '.la-wiz')) {
      created = true;
      break;
    }
    // Sensitive apps ask about encryption first in an unencrypted workspace.
    if (await clickExact(s, 'Skip for now', '.la-wiz')) continue;
    await clickExact(s, 'Continue', '.la-wiz');
  }
  if (!created) {
    failures.push(`${app.name}: the wizard never offered "Create ${app.name}"`);
    await u.shot(`wizard-${app.id}-stuck`);
  }
  const inst = await waitFor(
    async () => {
      const ws = await call(s, 'workspace_list', {});
      for (const w of ws) {
        const list = await call(s, 'lifeapp_instances', { workspaceId: w.id });
        const hit = list.find((x) => x.appId === app.id && !x.detached);
        if (hit) return hit;
      }
      return null;
    },
    60000,
    `${app.name} to be installed`,
  );
  // The build stage hands over to the hub.
  await waitFor(async () => ((await u.hash()).startsWith('#/app/') ? true : null), 60000, `${app.name} hub`).catch(() => u.route(`#/app/${inst.id}`));
  await sleep(1200);
  return inst;
}

async function appDatabases(s, instanceId) {
  const ws = (await call(s, 'workspace_list', {}))[0].id;
  const metas = (await call(s, 'workspace_open', { id: ws })).pages;
  const out = {};
  for (const m of metas.filter((x) => x.kind === 'database' && x.appInstanceId === instanceId && !x.deletedAt)) out[m.id] = await call(s, 'db_get_schema', { id: m.id });
  const byRole = (role) => Object.values(out).find((d) => role in (d.database.roles ?? {}));
  return { byRole };
}

async function rowsOf(s, databaseId) {
  const r = await call(s, 'db_query', { databaseId, window: { offset: 0, limit: 500 }, reqId: 1 });
  return r.rows ?? [];
}

const textOf = (v) => (v && v.t === 'text' ? v.v.map((x) => x.text).join('') : '');
const day = (d) => d.toISOString().slice(0, 10);
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export default async function run({ shots }) {
  const failures = [];
  const check = (cond, msg) => {
    if (!cond) failures.push(msg);
  };
  const s = await desktopSession({ app: APP, port: PORT, nativePort: PORT + 1 });
  const u = ui(s, { shotsDir: shots, prefix: name });
  try {
    await waitBoot(s, u);
    // Start with no apps: each one is set up through its own wizard below.
    await onboardPlain(s, u, { name: 'Robin', apps: [], tasks: false, waitApps: false });
    await u.shot('00-home');

    const inst = {};
    for (const app of APPS) {
      try {
        inst[app.id] = await installViaWizard(s, u, app, failures);
      } catch (e) {
        failures.push(`${app.name}: install failed: ${e.message}`);
        await u.shot(`install-${app.id}-failed`);
      }
      check(!(await u.crashed()), `${app.name}: the hub crashed after setup`);
      check(!(await u.has('database not found')) && !(await u.has('databases not found')), `${app.name}: hub says a database is missing`);
      await u.shot(`01-${app.id}`);
    }

    // ── Tasks
    if (inst['life-os']) {
      const id = inst['life-os'].id;
      await u.route(`#/app/${id}/tasks`);
      await waitField(s, 'Add a task');
      await u.fill('Add a task', 'Call the bank');
      await s.keys('\uE007');
      await u.waitText('Call the bank', 10000).catch(() => failures.push('Tasks: a quick-added task did not appear in the Inbox'));
      await u.fill('Add a task', 'Pay rent today');
      await s.keys('\uE007');
      await u.waitText('Pay rent', 10000).catch(() => failures.push('Tasks: "Pay rent today" did not appear in Next'));
      await u.fill('Add a task', 'Renew passport today');
      await s.keys('\uE007');
      await u.waitText('Renew passport', 10000).catch(() => failures.push('Tasks: "Renew passport today" did not appear'));
      await u.shot('10-tasks');
      // Complete it from the hub: the backend fills Done and Completed at.
      const clicked = await s.exec(`const b=document.querySelector('[aria-label="Complete “Pay rent”"]');if(!b)return false;b.click();return true`);
      check(clicked, 'Tasks: no complete button for "Pay rent"');
      const { byRole } = await appDatabases(s, id);
      const tasks = byRole('task.status');
      check(!!tasks, 'Tasks: no database carries the task.status role');
      if (tasks) {
        const R = tasks.database.roles;
        const done = await waitFor(
          async () => {
            const r = (await rowsOf(s, tasks.database.id)).find((x) => textOf(x.values[R['task.title']]) === 'Pay rent');
            return r && r.values[R['task.done']]?.v === true && r.values[R['task.completed']]?.v ? r : null;
          },
          15000,
          'Done / Completed at on the completed task',
        ).catch((e) => failures.push(`Tasks: ${e.message}`));
        check(!!done, 'Tasks: completing a task did not keep Done in step');
        // A recurring task: completing it spawns the next occurrence, due on the next day.
        const today = localDay();
        const created = await call(s, 'db_row_create', {
          databaseId: tasks.database.id,
          values: {
            [R['task.title']]: { t: 'text', v: [{ text: 'Water the plants' }] },
            [R['task.status']]: { t: 'status', v: 'next' },
            [R['task.due']]: { t: 'date', v: { start: today, time: false } },
            [R['task.recurrence']]: { t: 'recurrence', v: { rrule: 'FREQ=DAILY', dtstart: today, mode: 'schedule' } },
          },
        });
        await call(s, 'db_rows_update', { updates: [{ id: created.id, values: { [R['task.status']]: { t: 'status', v: 'done' } } }] });
        const tomorrow = new Date(`${today}T12:00:00`);
        tomorrow.setDate(tomorrow.getDate() + 1);
        await waitFor(
          async () => {
            const rows = (await rowsOf(s, tasks.database.id)).filter((x) => textOf(x.values[R['task.title']]) === 'Water the plants');
            const next = rows.find((x) => x.id !== created.id);
            return next && next.values[R['task.due']]?.v?.start?.slice(0, 10) === localDay(tomorrow) && next.values[R['task.status']]?.v === 'next' ? next : null;
          },
          15000,
          'the next occurrence of a recurring task',
        ).catch((e) => failures.push(`Tasks: ${e.message}`));
        const m = await call(s, 'lifeapp_metrics', { instanceId: id, names: ['task_count', 'done_count'] });
        check(Number(m.task_count?.value) >= 4, `Tasks: task_count is ${m.task_count?.value}`);
        check(Number(m.done_count?.value) >= 2, `Tasks: done_count is ${m.done_count?.value}`);
      }
      // Lists
      await u.route(`#/app/${id}/lists`);
      await waitField(s, 'New list').catch(() => failures.push('Tasks: the Lists tab has no "New list" field'));
      await u.fill('New list', 'Plan the move');
      await s.keys('\uE007');
      await waitFor(
        () => s.exec(`return [...document.querySelectorAll('.lo-project')].some(c=>c.textContent.includes('Plan the move'))||null`),
        10000,
        'the new list card',
      ).catch(() => failures.push('Tasks: a new list did not appear'));
      check(await u.has('Lists'), 'Tasks: the tab is not called Lists');
      await u.shot('11-lists');
      // Home: today's tasks show in To do, and plain text in the capture field becomes a task in Tasks.
      await u.route('#/');
      await u.waitText('Renew passport', 15000).catch(() => failures.push("Home: today's task does not show in To do"));
      const homeField = await u.fill('Add a task', 'Buy stamps').then(() => true).catch(() => false);
      check(homeField, 'Home: the capture field does not offer "Add a task" with Tasks installed');
      if (homeField) {
        await s.keys('\uE007');
        await u.waitText('Added to Tasks', 10000).catch(() => failures.push('Home: capture did not add a task'));
        const { byRole: br } = await appDatabases(s, id);
        const tdb = br('task.status');
        const R = tdb?.database.roles ?? {};
        await waitFor(
          async () => ((await rowsOf(s, tdb.database.id)).some((x) => textOf(x.values[R['task.title']]) === 'Buy stamps') ? true : null),
          10000,
          'the captured task in Tasks',
        ).catch((e) => failures.push(`Home: ${e.message}`));
      }
      await u.shot('12-home-tasks');
    }

    // ── Habits
    if (inst.habits) {
      const id = inst.habits.id;
      await u.route(`#/app/${id}/checkin`);
      await sleep(1500);
      const habitName = 'Walk 8k steps';
      const checked = await waitFor(
        () => s.exec(`const b=document.querySelector('[aria-label="Check in ${habitName}"]');if(!b)return null;b.click();return true`),
        10000,
        'the starter habit on Check-in',
      ).catch((e) => failures.push(`Habits: ${e.message}`));
      if (checked) await u.waitText('1 of 1 done today', 10000).catch(() => failures.push('Habits: checking in did not count'));
      await u.shot('20-habits-checkin');
      const { byRole } = await appDatabases(s, id);
      const habits = byRole('habit.name');
      check(!!habits && !!byRole('log.date'), 'Habits: the databases do not carry habit.* / log.* roles');
      if (habits && checked) {
        const R = habits.database.roles;
        await waitFor(
          async () => {
            const r = (await rowsOf(s, habits.database.id)).find((x) => textOf(x.values[R['habit.name']]) === habitName);
            return r && Number(r.values[R['habit.streak']]?.v?.value) === 1 ? r : null;
          },
          15000,
          'the Current streak column to read 1',
        ).catch((e) => failures.push(`Habits: ${e.message}`));
      }
      await u.route(`#/app/${id}/habits`);
      await waitField(s, 'New habit').catch(() => failures.push('Habits: no "New habit" field'));
      await u.fill('New habit', 'Read 10 pages');
      await s.keys('\uE007');
      await waitFor(
        () => s.exec(`return [...document.querySelectorAll('.hb-card')].some(c=>c.textContent.includes('Read 10 pages'))||null`),
        10000,
        'the new habit card',
      ).catch(() => failures.push('Habits: a new habit did not appear in the Habits tab'));
      await u.shot('21-habits');
    }

    // ── Spreadsheet Studio
    if (inst['spreadsheet-studio']) {
      const id = inst['spreadsheet-studio'].id;
      const m = await call(s, 'lifeapp_manifest', { id: 'spreadsheet-studio' });
      const templates = m.steps.find((x) => x.id === 'intent').options.filter((o) => o.value !== 'import');
      for (const t of templates) {
        await u.route(`#/app/${id}`);
        await u.waitText('Start from a template', 15000);
        await sleep(400);
        const ok = await s.exec(
          `const b=[...document.querySelectorAll('.st-tpl')].find(e=>e.textContent.includes(arguments[0]));if(!b)return false;b.click();return true`,
          [t.label],
        );
        if (!ok) {
          failures.push(`Studio: no template card "${t.label}"`);
          continue;
        }
        const pageId = await waitFor(
          async () => {
            const h = await u.hash();
            const mm = /^#\/(?:page|sheet)\/([^/]+)/.exec(h);
            return mm ? decodeURIComponent(mm[1]) : null;
          },
          20000,
          `the "${t.label}" spreadsheet`,
        ).catch((e) => {
          failures.push(`Studio: ${e.message}`);
          return null;
        });
        if (!pageId) continue;
        const wb = await call(s, 'sheet_workbook_get', { id: pageId });
        let numbers = 0;
        const errors = [];
        for (const sh of wb.sheets) {
          const r = await call(s, 'sheet_get_range', { sheetId: sh.id, rect: { r0: 0, c0: 0, r1: 60, c1: 12 } });
          r.cells.d.forEach((d, i) => {
            if (/^#[A-Z/0!?]+/.test(d)) errors.push(`${sh.name}!R${r.cells.r[i] + 1}C${r.cells.c[i] + 1}=${d}`);
            if (r.cells.f[i] && /\d/.test(d)) numbers += 1;
          });
        }
        check(numbers > 0, `Studio: "${t.label}" has no computed value`);
        check(!errors.length, `Studio: "${t.label}" shows errors: ${errors.slice(0, 4).join(', ')}`);
      }
      await u.shot('30-studio-sheet');
      // A second click makes a second spreadsheet.
      const again = await call(s, 'lifeapp_add_workbook', { instanceId: id, intent: 'loan' });
      check(/Loan calculator \d/.test(again.title), `Studio: a second loan calculator is called "${again.title}"`);
      const wc = await call(s, 'lifeapp_metrics', { instanceId: id, names: ['workbook_count'] });
      check(Number(wc.workbook_count?.value) >= templates.length + 1, `Studio: workbook_count is ${wc.workbook_count?.value}`);
      await u.route(`#/app/${id}`);
      await u.waitText('Recent spreadsheets', 10000).catch(() => failures.push('Studio: no recent spreadsheets'));
      await u.shot('31-studio');
    }

    // ── Money: account balances are calculated columns kept current by the backend
    if (inst['money-hq']) {
      const { byRole } = await appDatabases(s, inst['money-hq'].id);
      const accts = byRole('acct.balance');
      const txns = byRole('txn.amount');
      check(!!accts && !!txns, 'Money: the accounts / transactions databases lack their roles');
      if (accts && txns) {
        const A = accts.database.roles;
        const T = txns.database.roles;
        const cur = 'USD';
        const acct = await call(s, 'db_row_create', {
          databaseId: accts.database.id,
          values: {
            [accts.database.primaryPropId]: { t: 'text', v: [{ text: 'Everyday checking' }] },
            [A['acct.type']]: { t: 'select', v: 'checking' },
            [A['acct.opening']]: { t: 'money', v: '100', cur },
            [A['acct.on_budget']]: { t: 'check', v: true },
          },
        });
        await call(s, 'db_row_create', {
          databaseId: txns.database.id,
          values: {
            [T['txn.raw']]: { t: 'text', v: [{ text: 'Groceries' }] },
            [T['txn.date']]: { t: 'date', v: { start: localDay(), time: false } },
            [T['txn.amount']]: { t: 'money', v: '-30', cur },
            [T['txn.account']]: { t: 'relation', v: [acct.id] },
            [T['txn.cleared']]: { t: 'status', v: 'cleared' },
          },
        });
        await waitFor(
          async () => {
            const r = (await rowsOf(s, accts.database.id)).find((x) => x.id === acct.id);
            const bal = Number(r?.values[A['acct.balance']]?.v?.value);
            const clr = Number(r?.values[A['acct.cleared']]?.v?.value);
            return bal === 70 && clr === 70 ? true : null;
          },
          15000,
          'Balance and Cleared balance of 70',
        ).catch((e) => failures.push(`Money: ${e.message}`));
        // A budget line shows the month's activity and what is left; a recurring bill shows its next date.
        const cats = byRole('cat.group');
        const budgets = byRole('budget.available');
        const recurring = byRole('rec.next');
        const cat = cats && (await rowsOf(s, cats.database.id)).find((r) => r.values[cats.database.roles['cat.group']]?.v !== 'income');
        if (cat && budgets) {
          const B = budgets.database.roles;
          const month = localDay().slice(0, 7);
          const line = await call(s, 'db_row_create', {
            databaseId: budgets.database.id,
            values: {
              [B['budget.month']]: { t: 'text', v: [{ text: month }] },
              [B['budget.category']]: { t: 'relation', v: [cat.id] },
              [B['budget.assigned']]: { t: 'money', v: '200', cur },
            },
          });
          await call(s, 'db_row_create', {
            databaseId: txns.database.id,
            values: {
              [T['txn.raw']]: { t: 'text', v: [{ text: 'Corner shop' }] },
              [T['txn.date']]: { t: 'date', v: { start: localDay(), time: false } },
              [T['txn.amount']]: { t: 'money', v: '-45', cur },
              [T['txn.account']]: { t: 'relation', v: [acct.id] },
              [T['txn.category']]: { t: 'relation', v: [cat.id] },
            },
          });
          await waitFor(
            async () => {
              const r = (await rowsOf(s, budgets.database.id)).find((x) => x.id === line.id);
              return Number(r?.values[B['budget.activity']]?.v?.value) === -45 && Number(r?.values[B['budget.available']]?.v?.value) === 155 ? true : null;
            },
            15000,
            'a budget line with Activity −45 and Available 155',
          ).catch((e) => failures.push(`Money: ${e.message}`));
        } else failures.push('Money: no category or budgets database to check budget lines');
        if (recurring) {
          const Rr = recurring.database.roles;
          const bill = await call(s, 'db_row_create', {
            databaseId: recurring.database.id,
            values: {
              [recurring.database.primaryPropId]: { t: 'text', v: [{ text: 'Phone' }] },
              [Rr['rec.amount']]: { t: 'money', v: '-60', cur },
              [Rr['rec.schedule']]: { t: 'recurrence', v: { rrule: 'FREQ=MONTHLY;BYMONTHDAY=1', dtstart: '2026-01-01', mode: 'schedule' } },
            },
          });
          await waitFor(
            async () => {
              const r = (await rowsOf(s, recurring.database.id)).find((x) => x.id === bill.id);
              const next = r?.values[Rr['rec.next']]?.v?.value;
              return typeof next === 'string' && next.endsWith('-01') && next >= localDay() ? true : null;
            },
            15000,
            'the Next date of a recurring bill',
          ).catch((e) => failures.push(`Money: ${e.message}`));
        }
      }
    }

    // ── Money, Investments, Taxes: the hubs open with their content
    for (const [appId, want] of [
      ['money-hq', 'Money'],
      ['portfolio', 'Investments'],
      ['tax-organizer', 'Taxes'],
    ]) {
      if (!inst[appId]) continue;
      await u.route(`#/app/${inst[appId].id}`);
      await sleep(2500);
      check(!(await u.crashed()), `${want}: hub crashed`);
      check(await u.has(want), `${want}: the hub does not show its name`);
      await u.shot(`40-${appId}`);
    }

    // ── Sidebar: one row per app with the 1.0 names
    const side = await s.exec(`const n=document.querySelector('nav, aside, [role=navigation]');return n?n.innerText:''`);
    for (const nm of ['Tasks', 'Habits', 'Money', 'Investments', 'Taxes', 'Spreadsheet Studio', 'Markets']) check(side.includes(nm), `Sidebar: no "${nm}"`);
    for (const old of ['Life OS', 'Money HQ', 'Tax Organizer', 'Tax Year']) check(!side.includes(old), `Sidebar still says "${old}"`);

    // ── One instance per app; an app inside a project
    const ws = (await call(s, 'workspace_list', {}))[0].id;
    const dup = await ipc(s, 'lifeapp_install', { appId: 'habits', answers: {}, mode: 'quick', disabledKeys: [], workspaceId: ws, sampleData: false, onEvent: '__CHANNEL__:4242' });
    check(dup.err?.code === 'CONFLICT', `a second Habits was not refused: ${JSON.stringify(dup)}`);
    if (inst['spreadsheet-studio']) {
      const project = await call(s, 'page_create', { workspaceId: ws, parentId: null, kind: 'doc', title: 'Move to Lisbon', flags: { project: true } });
      await call(s, 'lifeapp_detach', { instanceId: inst['spreadsheet-studio'].id });
      const job = await ipc(s, 'lifeapp_install', { appId: 'spreadsheet-studio', answers: {}, mode: 'quick', disabledKeys: [], workspaceId: ws, sampleData: false, parentId: project.meta.id, onEvent: '__CHANNEL__:4243' });
      check(!job.err, `install inside a project failed: ${JSON.stringify(job.err)}`);
      const inside = await waitFor(
        async () => (await call(s, 'lifeapp_instances', { workspaceId: ws })).find((x) => x.appId === 'spreadsheet-studio' && !x.detached) ?? null,
        30000,
        'Spreadsheet Studio inside the project',
      ).catch((e) => failures.push(e.message));
      if (inside) {
        const [root] = await call(s, 'page_get_meta', { ids: [inside.rootPageId] });
        check(root.parentId === project.meta.id, 'the hub was not created inside the project');
        const sheet = await call(s, 'lifeapp_add_workbook', { instanceId: inside.id, intent: 'budget' });
        check(sheet.parentId === project.meta.id, 'a Studio spreadsheet of a hub in a project does not land in the project');
      }
      const bad = await ipc(s, 'lifeapp_install', { appId: 'habits', answers: {}, mode: 'quick', disabledKeys: [], workspaceId: ws, sampleData: false, parentId: 'no-such-page', onEvent: '__CHANNEL__:4244' });
      check(!!bad.err, 'install accepted a missing parent');
    }

    // ── Markets: real symbols; prices or a clear message within seconds
    await u.route('#/markets');
    await sleep(14000);
    const mk = await s.exec(
      `const strip=document.querySelector('.mk-indices');return {text:document.body.innerText,skeletons:strip?strip.querySelectorAll('.emp-skeleton,[class*=skeleton]').length:-1,tickers:[...document.querySelectorAll('.mk-tile-ticker')].map(e=>e.textContent)}`,
    );
    check(!/EMP500|EMPX|US 500/.test(mk.text), 'Markets shows demo tickers on desktop');
    check(mk.tickers.includes('SPY'), `Markets: the strip is ${JSON.stringify(mk.tickers)}`);
    const priced = /\d/.test(mk.text.split('Watchlists')[0] ?? '');
    const said = /Prices aren.t available right now|Offline mode is on/.test(mk.text);
    check(said || (priced && mk.skeletons === 0), `Markets: neither prices nor a message after 14 s (skeletons: ${mk.skeletons})`);
    check(mk.skeletons === 0, `Markets: ${mk.skeletons} placeholders still showing after 14 s`);
    await u.shot('50-markets');

    const errs = (await u.errors()).filter((e) => !/ResizeObserver/.test(e));
    if (errs.length) failures.push(...errs.slice(0, 10).map((e) => `console: ${e}`));
  } catch (e) {
    failures.push(`threw: ${e.message}`);
    await u.shot('zz-error').catch(() => undefined);
  } finally {
    await endSession(s);
  }
  return failures;
}
