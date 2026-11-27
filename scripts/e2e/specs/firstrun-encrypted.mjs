// First run with a password and the lock lifecycle (1.0 brief §2.5, §2.6), on the real desktop app:
//   - "Suggest one" shows the suggested password; the recovery key is saved to a real file through the native save
//     dialog (driven with xdotool) and the file holds the 24 words; "I've saved my recovery key" → Home;
//   - text typed right before Ctrl+Shift+L survives the lock; the lock screen says it was locked by you; unlocking
//     returns to the same page; a wrong password and wrong recovery words get plain messages;
//   - after a restart the lock screen shows (without claiming an automatic lock) and unlocks into Home.
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopSession, sleep } from '../lib/wd.mjs';
import { ui } from '../lib/ui.mjs';
import { endSession, onboardEncrypted, waitBoot, waitHome } from '../lib/flows.mjs';

export const name = 'firstrun-encrypted';

const PORT = Number(process.env.E2E_PORT || 4710) + 10;
const VISIBLE_MS = Number(process.env.E2E_VISIBLE_MS || 2500);
const PASSWORD = 'plinth-ocelot-marzipan-quaver-87';
const CTRL = '';
const SHIFT = '';
const ENTER = '';

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
 * After the app reloads itself (lock): wait for the lock screen of the NEW document and re-arm the harness hooks.
 * `before` is `performance.timeOrigin` of the page that locked: until the reload, the previous lock screen can still
 * be on its way out (the unlock crossfade), and a click on it would be lost.
 */
async function waitLockScreen(s, u, before = null, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const on = await s
      .exec(`return !!document.querySelector('.emp-lock-card') && document.readyState==='complete' && performance.timeOrigin!==arguments[0]`, [before])
      .catch(() => false);
    if (on) break;
    await sleep(200);
  }
  await waitBoot(s, u);
  await u.waitText('Enter your password to unlock', 10000);
}

async function unlock(s, u, password) {
  await u.fill('Password', password);
  await s.keys(ENTER);
}

export default async function run({ shots }) {
  const failures = [];
  const check = (cond, msg) => {
    if (!cond) failures.push(msg);
  };
  const keyDir = mkdtempSync(join(tmpdir(), 'ultranote-key-'));
  const keyFile = join(keyDir, 'my recovery key.txt');
  let s = await desktopSession({ port: PORT, nativePort: PORT + 1 });
  const home = s.dataHome;
  let u = ui(s, { shotsDir: shots, prefix: name });
  try {
    await waitBoot(s, u);
    await u.waitText('Welcome to Ultranote', 20000);

    // ── "Suggest one" shows what it typed
    await u.click('Continue');
    await u.waitText('Keep it private?');
    await u.click('Lock with a password');
    await u.click('Suggest one');
    await u.waitText('Your new password', 5000).catch(() => failures.push('"Suggest one" did not show the suggested password'));
    const suggested = await s.exec(`return document.querySelector('.onb-suggest-value')?.textContent.trim() ?? ''`);
    const typed = await s.exec(`return [...document.querySelectorAll('input[type=password]')].map(i=>i.value)`);
    check(suggested.length >= 20 && typed.every((v) => v === suggested), `suggested password shown and filled (${suggested.length} chars)`);
    await u.shot('01-suggested');
    await u.click('Back');
    await u.waitText('Welcome to Ultranote');

    // ── password + recovery key saved to a real file through the native dialog
    const { words } = await onboardEncrypted(s, u, { name: 'Robin', apps: [], tasks: true, password: PASSWORD, saveTo: keyFile });
    check(words.length === 24, `24 recovery words shown (${words.length})`);
    let body = '';
    try {
      body = readFileSync(keyFile, 'utf8');
    } catch {
      failures.push(`the recovery key file was not written at ${keyFile}`);
    }
    if (body) {
      const inFile = [...body.matchAll(/\d+\. ([a-z]+)/g)].map((m) => m[1]);
      check(JSON.stringify(inFile) === JSON.stringify(words), 'the saved file lists the 24 words in order');
      check(/Ultranote recovery key/.test(body) && /cannot be recovered/.test(body), 'the saved file explains what it is');
      check((statSync(keyFile).mode & 0o077) === 0, `the key file is private to the owner (mode ${(statSync(keyFile).mode & 0o777).toString(8)})`);
    }
    await u.shot('02-home');
    check(!(await u.has('Save your recovery key')), 'no recovery reminder after the key was saved');

    // ── edits typed right before Ctrl+Shift+L survive; the lock screen says why; unlock returns to the page
    await u.click('New document', { within: '.hm-start' });
    await sleep(1500);
    const pageHash = await u.hash();
    check(pageHash.startsWith('#/page/'), `New document opened ${pageHash}`);
    await s.keys('Lock test');
    await s.keys(ENTER);
    await sleep(300);
    await s.keys('IMMEDIATE-LOCK-A1');
    const origin = await s.exec('return performance.timeOrigin');
    await s.chord([CTRL, SHIFT], 'l');
    await waitLockScreen(s, u, origin);
    await u.shot('03-locked');
    check(await u.has('You locked Ultranote'), `lock caption: ${(await u.text('.emp-lock-card')).replace(/\s+/g, ' ')}`);
    check(!(await u.has('IMMEDIATE-LOCK-A1')), 'page content is not on the lock screen');

    await unlock(s, u, 'not the password at all');
    await u.waitText("That password isn't right", 15000).catch(() => failures.push('no plain message for a wrong password'));
    await u.shot('04-wrong-password');
    await unlock(s, u, PASSWORD);
    await u.waitText('IMMEDIATE-LOCK-A1', 20000).catch(() => failures.push('edits typed right before the lock were lost (or unlock did not return to the page)'));
    const afterHash = await u.hash();
    check(afterHash === pageHash, `unlock returned to ${afterHash}, not ${pageHash}`);
    await u.shot('05-unlocked-same-page');

    // ── wrong recovery words get a plain message
    const origin2 = await s.exec('return performance.timeOrigin');
    await s.chord([CTRL, SHIFT], 'l');
    await waitLockScreen(s, u, origin2);
    await u.click('Use recovery key');
    await u.waitText('Unlock with your recovery key');
    const wrong = [...words.slice(1), words[0]].join(' ');
    // Paste the whole key into the first box (it spreads across the 24 boxes).
    await s.exec(
      `const el=document.querySelector('input[aria-label="Word 1"]');el.focus();const dt=new DataTransfer();dt.setData('text/plain',arguments[0]);el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}))`,
      [wrong],
    );
    await sleep(300);
    const filled = await s.exec(`return [...document.querySelectorAll('.emp-word-inputs input')].filter(i=>i.value).length`);
    check(filled === 24, `pasting the key filled ${filled} of 24 boxes`);
    await u.fill('New password', 'another-strong-passphrase-91');
    await u.fill('Confirm new password', 'another-strong-passphrase-91');
    await u.click('Unlock and set new password');
    await u.waitText("don't match this workspace's current recovery key", 15000).catch(() => failures.push('no plain message for wrong recovery words'));
    await u.shot('06-wrong-words');
    const raw = await u.has('wrong password or recovery key');
    check(!raw, 'raw backend error shown for wrong recovery words');
    await u.click('Back');
    await unlock(s, u, PASSWORD);
    await u.waitText('IMMEDIATE-LOCK-A1', 20000).catch(() => failures.push('second unlock did not return to the page'));

    const errs = await u.errors();
    if (errs.length) failures.push(...errs.map((e) => `console: ${e}`));

    // ── restart: the lock screen, without claiming an automatic lock
    await endSession(s);
    s = await desktopSession({ port: PORT + 2, nativePort: PORT + 3, dataHome: home });
    u = ui(s, { shotsDir: shots, prefix: name });
    const vis = await visibleAt(s);
    check(vis !== null && vis <= VISIBLE_MS, `relaunch: lock screen visible after ${vis} ms (want ≤ ${VISIBLE_MS})`);
    await waitLockScreen(s, u);
    check(await s.exec(`return performance.getEntriesByName('emp:app:ready').length>0`), 'the lock screen reported ready (app_ready)');
    check(await u.has('Your workspace is encrypted'), 'fresh launch caption');
    check(!(await u.has('Locked automatically')), 'a fresh launch does not claim an automatic lock');
    check(await u.has('Robin’s workspace') || (await u.has("Robin's workspace")), 'the lock screen names the workspace after the person');
    await u.shot('07-relaunch-lock');
    await unlock(s, u, PASSWORD);
    await waitHome(s, 20000).catch(async () =>
      failures.push(`unlock after a restart did not open Home: ${await u.hash()} ${(await u.text('main').catch(() => '')).slice(0, 160).replace(/\s+/g, ' ')}`),
    );
    await u.waitText('Getting started', 10000).catch(() => failures.push('unlock after a restart did not show Getting started on Home'));
    await u.shot('08-relaunch-home');
  } finally {
    await endSession(s);
  }
  return failures;
}
