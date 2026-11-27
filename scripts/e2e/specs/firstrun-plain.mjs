// First run without a password (1.0 brief §2.5–§2.6), on the real desktop app:
//   - the window is visible quickly (no 8 s wait) and the frontend reports ready (no Rust fallback);
//   - both screens, then Home in a few seconds; the picked apps build on Home with real progress and WORK
//     (Tasks and Habits open with their databases, not "database not found");
//   - Start here actions work; plain text in the capture field becomes a task in Tasks; the checklist ticks itself;
//   - after a restart Home opens directly with the same workspace.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { desktopSession, sleep } from '../lib/wd.mjs';
import { ui } from '../lib/ui.mjs';
import { waitBoot, onboardPlain, waitForApps, endSession } from '../lib/flows.mjs';

export const name = 'firstrun-plain';

const PORT = Number(process.env.E2E_PORT || 4710);
/** Debug builds against the dev server; a release build is far quicker (brief §5 targets 1 s / 1.5 s). */
const VISIBLE_MS = Number(process.env.E2E_VISIBLE_MS || 2500);
const TO_HOME_MS = Number(process.env.E2E_TO_HOME_MS || 12000);

function appLog(home) {
  const dir = join(home, 'com.devartin.ultranote', 'logs');
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
}

/** Poll until the window is visible; returns performance.now() at that moment (ms since the page started). */
async function visibleAt(s, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await s.exec('return document.visibilityState==="visible" ? Math.round(performance.now()) : null').catch(() => null);
    if (v !== null) return v;
    await sleep(40);
  }
  return null;
}

/**
 * The frontend reported ready by itself (`app_ready`): the `emp:app:ready` mark exists. On a release build the Rust
 * fallback must not have fired either; against the dev server, module loading under load can exceed the fallback, so
 * there only the mark counts.
 */
async function readyProblems(s, home, label) {
  const out = [];
  const st = await s.exec(
    `return {mark: performance.getEntriesByName('emp:app:ready').length>0, dev: !!document.querySelector('script[src*="/@vite/client"]')}`,
  );
  if (!st.mark) out.push(`${label}: the frontend never reported ready`);
  if (!st.dev && /did not report ready/.test(appLog(home))) out.push(`${label}: Rust had to show the window itself`);
  return out;
}

async function openFromHome(s, u, appName) {
  const ok = await s.exec(
    `const row=[...document.querySelectorAll('.hm-setup-row')].find(r=>r.querySelector('.hm-row-title')?.textContent.trim()===arguments[0]);const b=row&&[...row.querySelectorAll('button')].find(b=>b.textContent.trim()==='Open');if(!b)return false;b.click();return true`,
    [appName],
  );
  if (!ok) throw new Error(`no Open link for ${appName} on Home`);
  await sleep(2500);
}

export default async function run({ shots }) {
  const failures = [];
  const check = (cond, msg) => {
    if (!cond) failures.push(msg);
  };
  let s = await desktopSession({ port: PORT, nativePort: PORT + 1 });
  const home = s.dataHome;
  let u = ui(s, { shotsDir: shots, prefix: name });
  try {
    // ── the window shows at once
    const vis = await visibleAt(s);
    check(vis !== null && vis <= VISIBLE_MS, `window visible after ${vis} ms (want ≤ ${VISIBLE_MS})`);
    await waitBoot(s, u);
    await u.waitText('Welcome to Ultranote', 20000);
    await u.shot('01-welcome');
    const cards = await s.exec(
      `return [...document.querySelectorAll('.onb-cards [role=checkbox]')].map(e=>({t:e.querySelector('.emp-choice-title')?.textContent.trim(),on:e.getAttribute('aria-checked'),dis:e.disabled}))`,
    );
    check(
      JSON.stringify(cards.map((c) => c.t)) === JSON.stringify(['Notes and documents', 'Tasks', 'Habits', 'Money', 'Investments', 'Taxes', 'Spreadsheets']),
      `first-run cards: ${JSON.stringify(cards)}`,
    );
    check(cards[0]?.on === 'true' && cards[0]?.dis === true, 'Notes and documents must be checked and disabled');
    check(!(await u.has('Track')) && !(await u.has('Protect')), 'no step names on first run');

    // ── two screens, then Home
    const t0 = Date.now();
    await onboardPlain(s, u, { name: 'Sam', apps: ['Habits', 'Money'], waitApps: false });
    const toHome = Date.now() - t0;
    check(toHome <= TO_HOME_MS, `first run took ${toHome} ms to reach Home (want ≤ ${TO_HOME_MS})`);
    await u.shot('02-home-building');
    check(await u.has('Start here'), 'Home shows Start here for a new workspace');
    const state = await waitForApps(s, u);
    check(state === 'ready', `apps build on Home (state ${state})`);
    await u.shot('03-home-ready');
    const text = await u.text('main');
    for (const t of ['New document', 'New spreadsheet', 'New project', 'Add an app', 'Import', 'Getting started']) check(text.includes(t), `Home lacks "${t}"`);
    check(!/Life apps|Life OS|Money HQ/.test(text), 'Home uses plain app names');
    check(await s.exec(`return !!document.querySelector('.emp-sb, aside') && /Sam.s workspace|Sam’s/.test(document.body.innerText)`), 'the workspace is named after the person');

    // ── the apps work (audit: built with answers {} they had no databases)
    for (const app of ['Tasks', 'Habits', 'Money']) {
      await openFromHome(s, u, app);
      const t = await u.text('main');
      check(!/not found|couldn.t open|ran into a problem/i.test(t), `${app} opened broken: ${t.slice(0, 200).replace(/\s+/g, ' ')}`);
      await u.shot(`04-app-${app}`);
      await u.route('#/home');
      await u.waitText('Your apps are ready', 10000).catch(() => undefined);
    }

    // ── plain text in the capture field becomes a task in Tasks
    await u.fill('Add a task', 'Buy milk for the e2e test');
    await s.keys('');
    await u.waitText('Added to Tasks', 10000).catch(() => failures.push('no "Added to Tasks" toast after a plain capture'));
    await sleep(800);
    await openFromHome(s, u, 'Tasks');
    await u.waitText('Buy milk for the e2e test', 10000).catch(() => failures.push('the captured task is not in Tasks'));
    await u.shot('05-task-captured');
    await u.route('#/home');
    await sleep(1500);

    // ── Start here actions
    const act = async (label, expect) => {
      await u.route('#/home');
      await u.waitText('Start here', 10000);
      await u.click(label, { within: '.hm-start' });
      await sleep(1800);
      const h = await u.hash();
      // `expect`: a route prefix, or a check returning true or what went wrong.
      const ok = typeof expect === 'string' ? h.startsWith(expect) : await expect();
      check(ok === true, `Start here "${label}" ${typeof ok === 'string' ? ok : `went to ${h}`}`);
      await u.shot(`06-start-${label.replace(/\W+/g, '-')}`);
    };
    await act('Add an app', '#/lifeapps');
    await act('Import', async () => {
      const open = await s.exec(`return !!document.querySelector('[role=dialog]') && /Import/i.test(document.querySelector('[role=dialog]').innerText)`);
      await s.keys('');
      await sleep(400);
      return open;
    });
    // Three pages of its own retire Start here, so these come last.
    await act('New document', '#/page/');
    // "/" in the document (the slash menu, keyboard) ticks "Add a heading, list or table".
    await s.keys('Plan');
    await s.keys('\uE007');
    await sleep(300);
    await s.keys('/');
    await sleep(800);
    await s.keys('\uE007');
    await sleep(1000);
    await u.shot('06b-slash');
    // A new spreadsheet must open as a working grid, not just change the URL (it once opened "This workbook
    // couldn't be opened, too large: range").
    await act('New spreadsheet', async () => {
      if (!(await u.hash()).startsWith('#/sheet/')) return `went to ${await u.hash()}`;
      const t0 = Date.now();
      let st = null;
      while (Date.now() - t0 < 8000) {
        st = await s.exec(
          `const m=document.querySelector('main')||document.body;const c=[...m.querySelectorAll('canvas')].find(c=>c.getBoundingClientRect().width>200&&c.getBoundingClientRect().height>100);return {grid:!!c, broken:/couldn.t be opened|too large/i.test(m.innerText), text:m.innerText.slice(0,160)}`,
        );
        if (st.grid && !st.broken) return true;
        if (st.broken) break;
        await sleep(300);
      }
      return `did not open a working grid: ${JSON.stringify(st)}`;
    });
    await act('New project', '#/page/');

    // ── the checklist (the same items as the Getting Started page) ticked itself; three own pages retire Start here
    await u.route('#/home');
    await sleep(1500);
    const ticks = await s.exec(
      `return [...document.querySelectorAll('.hm-check')].map(li=>({t:li.textContent.trim(),done:li.classList.contains('is-done')}))`,
    );
    const tick = (start) => ticks.find((x) => x.t.startsWith(start))?.done;
    check(
      JSON.stringify(ticks.map((x) => x.t.split(':')[0].replace(/ with .*$/, ''))) ===
        JSON.stringify(['Write a document', 'Add a heading, list or table', 'Add a task or a note in the field above', 'Find anything']),
      `Home's checklist is the Getting Started page's list: ${JSON.stringify(ticks)}`,
    );
    check(tick('Write a document') === true, `checklist: ${JSON.stringify(ticks)}`);
    check(tick('Add a task or a note') === true, `checklist capture tick: ${JSON.stringify(ticks)}`);
    check(tick('Add a heading, list or table') === true, `checklist slash tick: ${JSON.stringify(ticks)}`);
    check(!(await u.has('Start here')), 'Start here retires once the workspace has a few pages');
    await u.shot('07-home-after');

    // ── Ctrl+Shift+L without a password explains how to turn encryption on (it used to do nothing)
    await s.exec('document.activeElement && document.activeElement.blur && document.activeElement.blur()');
    await s.chord(['\uE009', '\uE008'], 'l');
    await u.waitText('No password to lock with', 5000).catch(() => failures.push('Ctrl+Shift+L in a workspace without a password showed nothing'));
    check(await u.has('Add a password'), 'the lock hint offers to add a password');
    await u.shot('07b-lock-hint');
    const errs = await u.errors();
    if (errs.length) failures.push(...errs.map((e) => `console: ${e}`));
    failures.push(...(await readyProblems(s, home, 'first run')));

    // ── restart: straight to Home
    await endSession(s);
    // A fresh driver port: the first driver may still be releasing its port.
    s = await desktopSession({ port: PORT + 2, nativePort: PORT + 3, dataHome: home });
    u = ui(s, { shotsDir: shots, prefix: name });
    const vis2 = await visibleAt(s);
    check(vis2 !== null && vis2 <= VISIBLE_MS, `relaunch: window visible after ${vis2} ms`);
    await waitBoot(s, u);
    await u.waitText('Getting started', 20000).catch(() => failures.push('relaunch did not open Home'));
    check(!(await u.has('Welcome to Ultranote')), 'relaunch showed first run again');
    await u.shot('08-relaunch');
    failures.push(...(await readyProblems(s, home, 'relaunch')));
  } finally {
    await endSession(s);
  }
  return failures;
}
