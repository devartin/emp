// Money, Investments and Taxes on the real desktop app, with known numbers.
//
// First run with Money, Investments and Taxes, then:
//   Money        add a Savings and a Visa account; import checking.ofx, savings_v2.ofx and card.qfx through the native
//                file dialog (xdotool); check the opening balances taken from the statements, transfer linking, the
//                review lane, a budget assignment, the cleared balance and reconcile, and net worth.
//   Investments  add a buy, a dividend and a sale; check quantity, FIFO basis, the open lot and the realised gain.
//   Taxes        a single filer with $85,000 wages and $9,000 withheld (Investments figures switched off) owes
//                $9,870: 16,100 standard deduction → 68,900 taxable → 1,240 + 4,560 + 4,070; $870 due at filing.
//                A document status change persists.
//
// Hand calculations for the fixtures (crates/emp-finance/tests/fixtures):
//   checking.ofx   7 rows, net +3,553.63; LEDGERBAL 5,553.63 on 2026-01-31 → opening 2,000.00
//   savings_v2.ofx 2 rows, net +504.12;   LEDGERBAL 10,504.12          → opening 10,000.00
//   card.qfx       3 rows, net +436.41;   LEDGERBAL −1,063.59          → opening −1,500.00 (owed)
//   transfers      checking −500 (01-05) ↔ savings +500 (01-06); checking −500 (01-20) ↔ card +500 (01-21)
//   net worth      5,553.63 + 10,504.12 − 1,063.59 = 14,994.16 (assets 16,057.75, debts 1,063.59)
//
// Needs xdotool for the GTK file chooser. Runs on its own D-Bus session when E2E_DBUS is set (other desktop apps on
// the same bus would take the single-instance lock).
import { execSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopSession, sleep, KEY } from '../lib/wd.mjs';
import { ui } from '../lib/ui.mjs';
import { waitBoot } from '../lib/flows.mjs';

export const name = 'money';
const here = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(here, '..', '..', '..', 'crates', 'emp-finance', 'tests', 'fixtures');

const norm = (s) => String(s ?? '').replace(/[‘’]/g, "'").replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

function xdo(cmd) {
  try {
    return execSync(`xdotool ${cmd}`, { env: process.env, encoding: 'utf8', timeout: 10000 }).trim();
  } catch (e) {
    return `ERR ${e.message.split('\n')[0]}`;
  }
}

/** The app process whose XDG_DATA_HOME is this session's. */
function appPid(dataHome) {
  try {
    return execSync(`for p in $(pgrep -f emp-app); do if tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | grep -qx "XDG_DATA_HOME=${dataHome}"; then echo $p; fi; done 2>/dev/null`, { shell: '/bin/bash', encoding: 'utf8' }).trim().split('\n')[0];
  } catch {
    return '';
  }
}

/** Fill the app's GTK open dialog with `path` (Ctrl+L, type, Return). */
export async function gtkOpen(s, path, ms = 15000) {
  const pid = appPid(s.dataHome);
  const t0 = Date.now();
  let win = null;
  while (!win && Date.now() - t0 < ms) {
    // `--all`: xdotool matches ANY criterion by default, which would pick other apps' dialogs on a shared display.
    for (const id of xdo(`search --all --onlyvisible --pid ${pid} --name '.'`).split('\n').filter((x) => /^\d+$/.test(x))) {
      if (xdo(`getwindowpid ${id}`) !== pid) continue;
      if (/^(open|select|choose)/i.test(xdo(`getwindowname ${id}`))) win = id;
    }
    if (!win) await sleep(300);
  }
  if (!win) throw new Error(`no file dialog for pid ${pid}`);
  // The first dialog of a session can take a moment to accept the location shortcut: retry until it closes.
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(attempt ? 1500 : 900);
    xdo(`windowactivate --sync ${win}`);
    await sleep(400);
    xdo('key --clearmodifiers ctrl+l');
    await sleep(500);
    xdo('key --clearmodifiers ctrl+a');
    xdo(`type --delay 15 '${path}'`);
    await sleep(500);
    xdo('key --clearmodifiers Return');
    await sleep(1500);
    if (!xdo(`search --all --onlyvisible --pid ${pid} --name '.'`).split('\n').includes(win)) return;
  }
  throw new Error('the file dialog did not take the path');
}

/** Click with real pointer events (Radix tabs, menus and selects react to pointerdown). */
export async function press(s, label, { selector = 'button,[role=tab],[role=option],[role=menuitem],[role=radio]', within = 'body', ms = 10000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ok = await s.exec(
      `const norm=s=>(s||'').replace(/[\\u2018\\u2019]/g,"'").replace(/\\u00a0/g,' ').replace(/\\s+/g,' ').trim();const want=norm(arguments[0]);const root=document.querySelector(arguments[1])||document.body;` +
        `const vis=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'};` +
        `const els=[...root.querySelectorAll(arguments[2])].filter(vis);const t=e=>norm(e.textContent);const a=e=>norm(e.getAttribute('aria-label')||e.getAttribute('title')||'');` +
        `const el=els.find(e=>t(e)===want)||els.find(e=>a(e)===want)||els.find(e=>t(e).startsWith(want))||els.find(e=>a(e).startsWith(want));` +
        `if(!el||el.disabled)return false;el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();` +
        `const o={bubbles:true,cancelable:true,composed:true,button:0,buttons:1,clientX:r.x+r.width/2,clientY:r.y+r.height/2,pointerType:'mouse',pointerId:1,isPrimary:true,view:window};` +
        `el.dispatchEvent(new PointerEvent('pointerdown',o));el.dispatchEvent(new MouseEvent('mousedown',o));el.focus&&el.focus();` +
        `el.dispatchEvent(new PointerEvent('pointerup',{...o,buttons:0}));el.dispatchEvent(new MouseEvent('mouseup',{...o,buttons:0}));el.click();return true;`,
      [label, within, selector],
    );
    if (ok) return;
    await sleep(200);
  }
  throw new Error(`could not press "${label}" in ${within}`);
}

/** Choose `option` in the ui/Select labelled `label`. */
export async function choose(s, label, option, within = 'body') {
  const ok = await s.exec(
    `const norm=s=>(s||'').replace(/\\s+/g,' ').trim();const want=arguments[0];const root=document.querySelector(arguments[1])||document.body;const vis=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0};` +
      `let b=[...root.querySelectorAll('button[aria-haspopup=listbox]')].filter(vis).find(x=>norm(x.getAttribute('aria-label'))===want);` +
      `if(!b){const l=[...root.querySelectorAll('label')].filter(vis).find(x=>norm(x.textContent)===want);if(l){const f=l.getAttribute('for');b=(f&&document.getElementById(f))||l.parentElement.querySelector('button[aria-haspopup=listbox]')}}` +
      `if(!b)return false;b.scrollIntoView({block:'center'});b.click();return true`,
    [label, within],
  );
  if (!ok) throw new Error(`no select "${label}"`);
  await sleep(500);
  await press(s, option, { selector: '[role=option]' });
  await sleep(400);
}

/** Set an input (date inputs too) the way React sees typing: native value setter, then input and change events. */
export async function setInput(s, label, value, within = 'body') {
  const ok = await s.exec(
    `const norm=s=>(s||'').replace(/\\s+/g,' ').trim();const want=arguments[0];const root=document.querySelector(arguments[2])||document.body;const vis=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0};` +
      `const lab=e=>{const l=e.id&&document.querySelector('label[for="'+CSS.escape(e.id)+'"]');return norm((l&&l.textContent)||(e.closest('label')&&e.closest('label').textContent)||'')};` +
      `const el=[...root.querySelectorAll('input')].filter(vis).find(e=>norm(e.getAttribute('aria-label'))===want||lab(e)===want);if(!el)return false;` +
      `el.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,arguments[1]);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));el.blur();return true`,
    [label, value, within],
  );
  if (!ok) throw new Error(`no input "${label}"`);
  await sleep(300);
}

const main = (u) => u.text('main').then(norm);
const dialog = (u) => u.text('[role=dialog]').then(norm);

async function expectText(u, needle, problems, what, { ms = 12000, where = 'body' } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (norm(await u.text(where)).includes(norm(needle))) return true;
    await sleep(250);
  }
  problems.push(`${what}: expected "${needle}"`);
  return false;
}

/** First run choosing apps (1.0 two-screen flow; the 0.3 flow as a fallback). */
export async function onboard(s, u, apps) {
  const w0 = Date.now();
  while (Date.now() - w0 < 30000 && !(await u.has('What would you like to use it for?')) && !(await u.has('Protect your workspace')) && !(await u.has('Your name'))) await sleep(250);
  if (await u.has('What would you like to use it for?')) {
    for (const a of apps) await u.click(a);
    await u.click('Continue');
    await u.waitText('Not now');
    await u.click('Not now');
    await sleep(300);
    await u.click('Start using Ultranote');
  } else {
    await u.click('Continue');
    await u.waitText('What do you want to track?');
    for (const a of ['Spending and budget', 'Investments', 'Taxes']) await u.click(a);
    await u.click('Continue');
    await u.click("Don't encrypt");
    await u.click('Continue');
  }
  await u.waitText('Search', 60000);
  // The apps build in the background.
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    const side = norm(await u.text('nav, aside, [role=navigation]').catch(() => ''));
    const alias = { Money: /Money/, Investments: /Investments|Portfolio/, Taxes: /Tax/ };
    if (apps.every((a) => (alias[a] ?? new RegExp(a)).test(side))) break;
    await sleep(500);
  }
  await sleep(1500);
}

export async function openApp(u, labels) {
  for (const l of labels) {
    try {
      await u.click(l, { within: 'nav, aside, [role=navigation]', ms: 3000 });
      await sleep(2500);
      return;
    } catch {
      /* next name */
    }
  }
  throw new Error(`no sidebar entry ${labels.join(' / ')}`);
}

/** Import a statement file into an account through the wizard. Returns the wizard's final text. */
export async function importFile(s, u, file, account, expectRows) {
  await press(s, 'Import', { within: 'main' });
  await u.waitText('Choose a statement');
  await u.click('Drop a bank statement or click to choose');
  await gtkOpen(s, join(FIX, file));
  await u.waitText('Import into', 15000);
  await sleep(800);
  await choose(s, 'Import into', account, '[role=dialog]');
  await u.waitText(`Review ${expectRows} rows`, 15000);
  await sleep(600);
  await press(s, `Review ${expectRows} rows`, { within: '[role=dialog]' });
  await u.waitText('Review transactions', 10000);
  await sleep(600);
  await press(s, 'Continue', { within: '[role=dialog]', ms: 15000 });
  await u.waitText('Rules & profile', 10000);
  await sleep(600);
  await press(s, 'Import', { within: '[role=dialog]', selector: 'button', ms: 15000 });
  await u.waitText('Imported', 30000);
  await sleep(800);
  const t = await dialog(u);
  await press(s, 'Done', { within: '[role=dialog]' });
  await u.waitGone('Import transactions', 10000).catch(() => undefined);
  await sleep(1200);
  return t;
}

export default async function run({ shots }) {
  const port = Number(process.env.E2E_PORT || 4610);
  const env = { ...process.env };
  if (process.env.E2E_DBUS) process.env.DBUS_SESSION_BUS_ADDRESS = process.env.E2E_DBUS;
  const s = await desktopSession({ app: process.env.ULTRANOTE_BIN || resolve(here, '..', '..', '..', 'target', 'devurl', 'debug', 'emp-app'), port, nativePort: port + 1 });
  const u = ui(s, { shotsDir: shots, prefix: name });
  const problems = [];
  const step = async (label, fn) => {
    try {
      await fn();
    } catch (e) {
      problems.push(`${label}: ${e.message}`);
      await u.shot(`fail-${label.replace(/\W+/g, '_')}`).catch(() => undefined);
    }
  };
  try {
    await waitBoot(s, u);
    await onboard(s, u, ['Money', 'Investments', 'Taxes']);

    // ── Money
    await step('open Money', () => openApp(u, ['Money', 'Money HQ']));
    await step('add accounts', async () => {
      await press(s, 'Accounts', { selector: '[role=tab]' });
      await u.waitText('Checking');
      for (const [nm, kind] of [['Savings', 'Savings'], ['Visa', 'Credit card']]) {
        await press(s, 'Add account', { within: 'main' });
        await u.waitText('Add an account');
        await u.fill('Name', nm);
        await choose(s, 'Kind', kind, '[role=dialog]');
        await press(s, 'Add account', { within: '[role=dialog]' });
        await u.waitGone('Add an account');
        await expectText(u, nm, problems, `account ${nm} listed`, { where: 'main' });
      }
    });
    await step('import checking.ofx', async () => {
      const t = await importFile(s, u, 'checking.ofx', 'Checking', 7);
      if (!t.includes('Imported 7 transactions')) problems.push(`checking import: ${t.slice(0, 300)}`);
      if (!t.includes('$2,000.00')) problems.push('checking import: opening balance $2,000.00 not set from the statement');
    });
    await step('import savings_v2.ofx', async () => {
      const t = await importFile(s, u, 'savings_v2.ofx', 'Savings', 2);
      if (!t.includes('Imported 2 transactions')) problems.push(`savings import: ${t.slice(0, 300)}`);
      if (!t.includes('1 linked as transfers')) problems.push('savings import: the 500.00 transfer was not linked');
      if (!t.includes('$10,000.00')) problems.push('savings import: opening balance $10,000.00 not set');
    });
    await step('import card.qfx', async () => {
      const t = await importFile(s, u, 'card.qfx', 'Visa', 3);
      if (!t.includes('Imported 3 transactions')) problems.push(`card import: ${t.slice(0, 300)}`);
      if (!t.includes('1 linked as transfers')) problems.push('card import: the card payment was not linked');
    });
    await step('balances and net worth', async () => {
      await press(s, 'Accounts', { selector: '[role=tab]' });
      await sleep(1500);
      await u.shot('accounts');
      const t = await main(u);
      for (const v of ['$5,553.63', '$10,504.12', '$1,063.59']) if (!t.includes(v)) problems.push(`Accounts: missing ${v}`);
      // Net worth tiles: whole dollars.
      for (const v of ['$16,058', '$14,994']) if (!t.includes(v)) problems.push(`Accounts tiles: missing ${v}`);
      await press(s, 'Overview', { selector: '[role=tab]' });
      await expectText(u, '$14,994', problems, 'Overview net worth', { where: 'main' });
      await u.shot('overview');
    });
    await step('review lane', async () => {
      await press(s, 'Transactions', { selector: '[role=tab]' });
      await expectText(u, 'To review · 12', problems, 'review count after three imports', { where: 'main' });
      // Mark the newest row reviewed.
      await s.exec(`const c=document.querySelector('main [role=grid] [role=checkbox],main [role=grid] button[role=checkbox]');c&&c.click()`);
      await sleep(400);
      await press(s, 'Mark reviewed');
      await expectText(u, 'To review · 11', problems, 'review count after marking one', { where: 'main' });
      // Search narrows with exact totals.
      await press(s, 'All', { selector: '[role=radio]' });
      await u.fill('Search transactions', 'payroll');
      await expectText(u, '2 transactions', problems, 'search "payroll"', { where: 'main' });
      await expectText(u, '$6,200.00', problems, 'payroll inflow total', { where: 'main' });
      await setInput(s, 'Search transactions', '');
      await expectText(u, '12 transactions', problems, 'all transactions after clearing the search', { where: 'main' });
      await u.shot('transactions');
    });
    await step('add a transaction', async () => {
      await press(s, 'Add', { within: 'main' });
      await u.waitText('Add a transaction');
      await u.fill('Payee', 'Corner Cafe');
      await u.fill('Amount', '12.50');
      await s.keys(KEY.tab);
      await press(s, 'Add', { within: '[role=dialog]' });
      await u.waitGone('Add a transaction');
      await expectText(u, 'Corner Cafe', problems, 'manual transaction listed', { where: 'main' });
      await expectText(u, '13 transactions', problems, 'count after adding one', { where: 'main' });
    });
    await step('budget assignment', async () => {
      await press(s, 'Budget', { selector: '[role=tab]' });
      await sleep(1500);
      // The first category's Assigned field: type 250 and commit.
      const ok = await s.exec(`const i=[...document.querySelectorAll('main .fh-bud-row input')].find(e=>e.offsetParent);if(!i)return false;i.setAttribute('data-e2e','b');return true`);
      if (!ok) throw new Error('no budget input');
      const el = await s.find('[data-e2e="b"]');
      await s.click(el);
      await s.clear(el).catch(() => undefined);
      await s.type(el, '250');
      await s.keys(KEY.tab);
      await sleep(2000);
      const row = norm(await s.exec(`return document.querySelector('[data-e2e="b"]').closest('.fh-bud-row').innerText`));
      if (!row.includes('250.00')) problems.push(`budget: the category row shows "${row}" after assigning 250`);
      await expectText(u, '$250', problems, 'budget: assigned total', { where: 'main' });
      await u.shot('budget');
    });
    await step('add a goal', async () => {
      await press(s, 'Plan', { selector: '[role=tab]' });
      await sleep(1000);
      await press(s, 'Goals', { selector: '[role=radio]' });
      await sleep(1000);
      await press(s, 'New goal', { within: 'main' });
      await u.waitText('Name, target and an optional date');
      await u.fill('Name', 'Holiday');
      await u.fill('Target', '1200');
      await s.keys(KEY.tab);
      await setInput(s, 'By', '2027-06-01', '[role=dialog]');
      await press(s, 'Add goal', { within: '[role=dialog]' });
      await u.waitGone('Name, target and an optional date');
      await expectText(u, 'Holiday', problems, 'goal listed', { where: 'main' });
      await expectText(u, '$1,200', problems, 'goal target', { where: 'main' });
      await u.shot('goals');
    });
    await step('reconcile Checking', async () => {
      await press(s, 'Accounts', { selector: '[role=tab]' });
      await sleep(1000);
      await s.exec(`const row=[...document.querySelectorAll('main .fh-acct')].find(r=>r.textContent.includes('Checking'));const b=row&&[...row.querySelectorAll('button')].find(x=>x.textContent.includes('Reconcile'));b&&b.click();`);
      await u.waitText('Reconcile Checking');
      // The statement balance is offered from the imported file; enter it if not.
      // The statement balance and date are offered from the imported file (checking.ofx LEDGERBAL).
      await sleep(1500);
      const d = await s.exec(`return document.querySelector('[role=dialog] input[type=date]')?.value`);
      if (d !== '2026-01-31') problems.push(`reconcile: statement date ${d}, expected 2026-01-31 from the file`);
      await expectText(u, 'Matches the cleared balance', problems, 'reconcile match', { where: '[role=dialog]' });
      await expectText(u, '$5,553.63', problems, 'cleared balance on Jan 31', { where: '[role=dialog]' });
      await press(s, 'Finish reconciling', { within: '[role=dialog]' });
      await u.waitText('Reconciled to', 10000);
      await sleep(2000);
      await expectText(u, 'Checking reconciled', problems, 'reconcile toast');
      await u.shot('reconciled');
    });

    // ── Investments
    await step('open Investments', () => openApp(u, ['Investments', 'Portfolio']));
    await step('trades', async () => {
      await expectText(u, 'No investments yet', problems, 'Investments empty state', { where: 'main' });
      const trade = async (kind, fields) => {
        await press(s, 'Add trade', { within: 'main' });
        await u.waitText('Add a trade');
        await press(s, kind, { within: '[role=dialog]', selector: '[role=radio],button' });
        for (const [label, value] of fields) {
          if (label === 'Date') await setInput(s, 'Date', value, '[role=dialog]');
          else {
            await u.fill(label, value);
            await s.keys(KEY.tab);
          }
        }
        await sleep(300);
        await press(s, kind === 'Buy' ? 'Add buy' : kind === 'Sell' ? 'Add sale' : 'Add dividend', { within: '[role=dialog]' });
        await u.waitGone('Add a trade', 15000);
        await sleep(1500);
      };
      await trade('Buy', [['Ticker', 'VTI'], ['Date', '2026-01-15'], ['Shares', '10'], ['Price per share', '200']]);
      await trade('Dividend', [['Ticker', 'VTI'], ['Date', '2026-03-20'], ['Amount paid', '30']]);
      await trade('Sell', [['Ticker', 'VTI'], ['Date', '2026-06-15'], ['Shares', '4'], ['Price per share', '250']]);
      await press(s, 'Holdings', { selector: '[role=tab]' });
      await sleep(2000);
      let t = await main(u);
      if (!/VTI/.test(t)) problems.push('Holdings: VTI missing');
      if (!t.includes('$1,200')) problems.push('Holdings: cost basis $1,200 missing (6 shares × $200)');
      for (const v of ['Buy', 'Sell', 'Dividend']) if (!t.includes(v)) problems.push(`Recent activity: ${v} missing`);
      await s.exec(`const r=[...document.querySelectorAll('main tr[data-clickable]')].find(x=>x.textContent.includes('VTI'));r&&r.click()`);
      await sleep(1200);
      t = await main(u);
      if (!t.includes('Short-term')) problems.push('Holdings lots: the open lot is not short-term');
      await u.shot('holdings');
      await press(s, 'Performance', { selector: '[role=tab]' });
      await sleep(2500);
      await expectText(u, '$200', problems, 'realised short-term gain 4 × (250 − 200)', { where: 'main' });
      await u.shot('performance');
    });

    // ── Taxes
    await step('open Taxes', () => openApp(u, ['Taxes', 'Tax Organizer', 'Tax year']));
    await step('tax estimate', async () => {
      await press(s, 'Estimator', { selector: '[role=tab]' });
      await u.waitText('Filing status');
      // A known case: figures from Investments off.
      const pulled = await s.exec(`const sw=document.querySelector('[aria-label="Include figures from Investments"]');if(!sw)return 'none';if(sw.getAttribute('aria-checked')==='true'||sw.getAttribute('data-state')==='checked'){sw.click();return 'off'}return 'already'`);
      if (pulled === 'none') problems.push('Taxes: the Investments figures (gain $200, dividends $30) were not pulled');
      await sleep(500);
      const amountId = await s.exec(`const i=[...document.querySelectorAll('main input[aria-label="Amount"]')].find(e=>e.offsetParent);if(!i)return false;i.setAttribute('data-e2e','w');return true`);
      if (!amountId) throw new Error('no wages field');
      const w = await s.find('[data-e2e="w"]');
      await s.click(w);
      await s.clear(w).catch(() => undefined);
      await s.type(w, '85000');
      await s.keys(KEY.tab);
      await u.fill('Withholding (full year)', '9000');
      await s.keys(KEY.tab);
      await sleep(2500);
      const t = await main(u);
      if (!t.includes('9,870')) problems.push(`Taxes: total tax should be $9,870, page shows ${(t.match(/\$[\d,]+/g) || []).slice(0, 12).join(' ')}`);
      if (!t.includes('870')) problems.push('Taxes: $870 due at filing missing');
      await u.shot('estimator');
    });
    await step('tax document status', async () => {
      await press(s, 'Documents', { selector: '[role=tab]' });
      await sleep(1500);
      const before = await main(u);
      if (!before.includes('Waiting for')) {
        problems.push('Taxes documents: no documents waiting');
        return;
      }
      await s.exec(`const b=[...document.querySelectorAll('main button[aria-label="Received"]')].find(e=>e.offsetParent);b&&b.click()`);
      await sleep(1500);
      const after = await main(u);
      if (!after.includes('In hand')) problems.push('Taxes documents: marking one Received did not move it to In hand');
      await u.shot('documents');
    });

    // ── Persistence: reload the webview and check the figures again.
    await step('persist across reload', async () => {
      await openApp(u, ['Money', 'Money HQ']);
      await s.exec('location.reload()');
      await sleep(6000);
      await u.hookErrors();
      await openApp(u, ['Money', 'Money HQ']);
      await press(s, 'Accounts', { selector: '[role=tab]' });
      await sleep(2000);
      await u.shot('after-reload');
      const t = await main(u);
      // Cash: 5,553.63 less the 12.50 coffee, plus 10,504.12; the card still owes 1,063.59.
      for (const v of ['$16,045.25', '$5,541.13', '$1,063.59']) if (!t.includes(v)) problems.push(`after reload: missing ${v}`);
      if (!/Reconciled|Last reconciled|reconciled Jan/i.test(t)) problems.push('after reload: Checking does not show its reconcile date');
      // Net worth = cash minus the card plus Investments (valued by its own quotes, or at cost without them).
      const inv = await s.exec(`const r=[...document.querySelectorAll('main .fh-acct')].find(x=>/Valued by/.test(x.textContent));return r?r.textContent:''`);
      const m = /\$([\d,]+\.\d\d)\s*$/.exec(norm(inv));
      const invValue = m ? Number(m[1].replace(/,/g, '')) : 0;
      const expected = Math.round(16045.25 - 1063.59 + invValue).toLocaleString('en-US');
      if (!t.includes(`$${expected}`)) problems.push(`after reload: net worth should be $${expected} (investments ${invValue})`);
    });

    const errs = await u.errors();
    problems.push(...errs.map((e) => `console: ${e}`));
  } finally {
    await s.end();
    process.env.DBUS_SESSION_BUS_ADDRESS = env.DBUS_SESSION_BUS_ADDRESS;
  }
  return problems;
}
