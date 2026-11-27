// Reusable flows for desktop specs.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { sleep } from './wd.mjs';

/**
 * End a desktop session and make sure the app process is gone. WebKitWebDriver closes the window, but the app can
 * outlive it; a leftover instance holds the single-instance lock, so the next launch would hand over to it and exit.
 */
export async function endSession(s) {
  await s.end();
  if (!s.dataHome) return;
  const mine = (pid) => {
    try {
      return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`XDG_DATA_HOME=${s.dataHome}`);
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 20; i++) {
    const pids = readdirSync('/proc').filter((p) => /^\d+$/.test(p) && mine(p));
    if (!pids.length) return;
    for (const p of pids) {
      try {
        process.kill(Number(p), i < 10 ? 'SIGTERM' : 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    await sleep(250);
  }
}

/** Wait for the first screen after launch (the window is revealed once the frontend reports ready). */
export async function waitBoot(s, u, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ready = await s.exec(`return document.readyState==='complete' && document.body && document.body.innerText.trim().length>0`).catch(() => false);
    if (ready) break;
    await sleep(250);
  }
  await u.hookErrors();
  await holdDevReloads(s);
}

/**
 * Runs against the dev-server binary (`target/devurl`) share one Vite server with people editing the code: every save
 * makes Vite hot-update or reload every open page, which would restart a spec halfway. This keeps the page on the code
 * it booted with by turning Vite's update/reload messages into no-ops. It does nothing in a production build (there is
 * no Vite client). Call again after the app reloads itself (lock).
 */
export async function holdDevReloads(s) {
  await s
    .exec(
      `if(!window.__e2eHoldHmr&&document.querySelector('script[src*="/@vite/client"]')){window.__e2eHoldHmr=1;const p=JSON.parse;` +
        `JSON.parse=function(t,r){const v=p.call(this,t,r);if(v&&typeof v==='object'&&!Array.isArray(v)&&(v.type==='full-reload'||v.type==='update'||v.type==='prune')&&Object.keys(v).length<=4)return{type:'custom',event:'e2e:held',data:null};return v}}`,
    )
    .catch(() => undefined);
}

/** First-run card labels (1.0 brief §2.5). 0.3.x onboarding labels still work: they map to the new cards. */
const CARD = {
  'Tasks and projects': 'Tasks',
  'Habits and routines': 'Habits',
  'Spending and budget': 'Money',
  Investments: 'Investments',
  Taxes: 'Taxes',
  Spreadsheets: 'Spreadsheets',
  'life-os': 'Tasks',
  habits: 'Habits',
  'money-hq': 'Money',
  portfolio: 'Investments',
  'tax-organizer': 'Taxes',
  'spreadsheet-studio': 'Spreadsheets',
};

/** Screen 1: name and the "What would you like to use it for?" cards. Tasks is picked unless `tasks: false`. */
async function welcome(s, u, { name, apps, tasks }) {
  await u.waitText('Welcome to Ultranote', 30000);
  if (name) await u.fill('Your first name', name);
  const want = new Set(apps.map((a) => CARD[a] ?? a));
  if (tasks) want.add('Tasks');
  for (const label of want) {
    const on = await s.exec(
      `const c=[...document.querySelectorAll('.onb-cards [role=checkbox]')].find(e=>e.querySelector('.emp-choice-title')?.textContent.trim()===arguments[0]);return c?c.getAttribute('aria-checked'):null`,
      [label],
    );
    if (on === null) throw new Error(`no first-run card "${label}"`);
    if (on !== 'true') {
      await s.exec(
        `[...document.querySelectorAll('.onb-cards [role=checkbox]')].find(e=>e.querySelector('.emp-choice-title')?.textContent.trim()===arguments[0]).click()`,
        [label],
      );
    }
  }
  await u.click('Continue');
  await u.waitText('Keep it private?');
}

/** Wait until the apps picked in first run have finished building on Home ("Your apps are ready"). */
export async function waitForApps(s, u, ms = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const st = await s.exec(
      `const t=document.body.innerText;return t.includes('Setting up your apps')?'building':t.includes('Your apps are ready')?'ready':'none'`,
    );
    if (st !== 'building') return st;
    await sleep(300);
  }
  throw new Error('the apps picked in first run did not finish building');
}

/**
 * Wait until Home is on screen with its content shown (`.hm-page`, its body faded in). Works at any window width:
 * below 900 px the sidebar is an overlay, so sidebar text such as "Search" is not a sign of Home.
 */
export async function waitHome(s, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ok = await s
      .exec(`const b=document.querySelector('.hm-page .hm-body');return !!b && b.hasAttribute('data-settled')`)
      .catch(() => false);
    if (ok) return;
    await sleep(150);
  }
  throw new Error('Home did not open');
}

/**
 * Finish first run without a password (screen 1, then "Not now"). `apps` are card labels or app ids (0.3.x labels are
 * mapped); Tasks is picked too unless `tasks: false`, as 0.3.x pre-ticked it. Returns on Home once the apps are built.
 */
export async function onboardPlain(s, u, { name = 'Alex', apps = [], tasks = true, waitApps = true } = {}) {
  await welcome(s, u, { name, apps, tasks });
  await u.click('Not now');
  await u.click('Start using Ultranote');
  await waitHome(s);
  await u.waitText('Start here', 30000).catch(() => undefined);
  if (waitApps) await waitForApps(s, u);
  await sleep(500);
}

/**
 * Finish first run with a password. Returns `{ words }` (the 24 recovery words as shown). With `saveTo`, the key is
 * saved through the native save dialog to that absolute path first (needs xdotool and DISPLAY).
 */
export async function onboardEncrypted(s, u, { name = 'Alex', apps = [], tasks = true, password = 'plinth-ocelot-marzipan-quaver-87', saveTo = null, waitApps = true } = {}) {
  await welcome(s, u, { name, apps, tasks });
  await u.click('Lock with a password');
  await u.fill('Password', password);
  await u.fill('Confirm password', password);
  // Continue enables once the strength check (debounced) says the password is strong enough.
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    const ok = await s.exec(`const b=[...document.querySelectorAll('.onb-foot button')].find(e=>e.textContent.trim()==='Continue');return !!b&&!b.disabled`);
    if (ok) break;
    await sleep(200);
  }
  await u.click('Continue', { within: '.onb-foot' });
  await u.waitText('Save your recovery key', 30000);
  const words = await s.exec(`return [...document.querySelectorAll('.emp-words .emp-word-t')].map(e=>e.textContent.trim())`);
  if (saveTo) await saveRecoveryKeyFile(s, u, saveTo);
  await u.click("I've saved my recovery key");
  await u.click('Start using Ultranote');
  await waitHome(s);
  if (waitApps) await waitForApps(s, u);
  await sleep(500);
  return { words };
}

/** The X window id of a visible window whose title is `title` (xdotool). */
function findWindow(title) {
  try {
    const out = execFileSync('xdotool', ['search', '--onlyvisible', '--name', `^${title}$`], { encoding: 'utf8' }).trim();
    return out.split('\n').filter(Boolean).pop() ?? null;
  } catch {
    return null;
  }
}

/**
 * Click "Save to a file…" and answer the native save dialog with `path` (an absolute path to a new file in a folder
 * that exists).
 * GTK ignores synthetic per-window typing, so the dialog is activated and driven with plain XTEST key events. Other
 * people's xdotool runs on a shared display can steal focus, so each step is retried a few times.
 */
export async function saveRecoveryKeyFile(s, u, path, { title = 'Save your recovery key' } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let win = findWindow(title);
    if (!win) {
      await u.click('Save to a file');
      const t0 = Date.now();
      while (!win && Date.now() - t0 < 15000) {
        win = findWindow(title);
        if (!win) await sleep(250);
      }
      if (!win) throw new Error('the native save dialog did not open');
      // The GTK file chooser maps before its name field is ready for keys.
      await sleep(1500);
    }
    execFileSync('xdotool', ['windowactivate', '--sync', win]);
    await sleep(500);
    execFileSync('xdotool', ['key', '--clearmodifiers', 'ctrl+a']);
    execFileSync('xdotool', ['type', '--delay', '15', path]);
    await sleep(300);
    execFileSync('xdotool', ['key', 'Return']);
    // (Use a path that does not exist yet: GTK would ask before replacing a file.)
    const ok = await u.waitText('Saved to a file', 5000).then(() => true, () => false);
    if (ok) return;
  }
  throw new Error('the recovery key was not saved through the native dialog');
}
