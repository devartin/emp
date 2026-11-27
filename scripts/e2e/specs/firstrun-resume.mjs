// Interrupted first run resumes cleanly (1.0 brief §2.5; audit firstrun-vault #9, #24), on the real desktop app:
// quit on the recovery-key screen (the encrypted workspace exists, nothing else is done) → relaunch → unlock →
// Home finishes the setup: the picked apps build and work, the name and the checklist are there, and Home asks to
// save the recovery key, which can be done from there (password → the same 24 words → "I've saved my recovery key").
import { desktopSession, sleep } from '../lib/wd.mjs';
import { ui } from '../lib/ui.mjs';
import { endSession, waitBoot, waitForApps, waitHome } from '../lib/flows.mjs';

export const name = 'firstrun-resume';

const PORT = Number(process.env.E2E_PORT || 4710) + 20;
const PASSWORD = 'plinth-ocelot-marzipan-quaver-87';
const ENTER = '';

export default async function run({ shots }) {
  const failures = [];
  const check = (cond, msg) => {
    if (!cond) failures.push(msg);
  };
  let s = await desktopSession({ port: PORT, nativePort: PORT + 1 });
  const home = s.dataHome;
  let u = ui(s, { shotsDir: shots, prefix: name });
  let words = [];
  try {
    await waitBoot(s, u);
    await u.waitText('Welcome to Ultranote', 20000);
    await u.fill('Your first name', 'Kai');
    for (const card of ['Tasks', 'Habits']) {
      await s.exec(`[...document.querySelectorAll('.onb-cards [role=checkbox]')].find(e=>e.querySelector('.emp-choice-title')?.textContent.trim()===arguments[0]).click()`, [card]);
    }
    await u.click('Continue');
    await u.click('Lock with a password');
    await u.fill('Password', PASSWORD);
    await u.fill('Confirm password', PASSWORD);
    await sleep(1200);
    await u.click('Continue', { within: '.onb-foot' });
    await u.waitText('Save your recovery key', 30000);
    words = await s.exec(`return [...document.querySelectorAll('.emp-words .emp-word-t')].map(e=>e.textContent.trim())`);
    await u.shot('01-recovery-screen');
    // A person reads the key for a moment before closing the window (WebKit writes local storage lazily).
    await sleep(2000);
  } finally {
    // Quit right here: no checkbox, no "Start using Ultranote".
    await endSession(s);
  }

  s = await desktopSession({ port: PORT + 2, nativePort: PORT + 3, dataHome: home });
  u = ui(s, { shotsDir: shots, prefix: name });
  try {
    await waitBoot(s, u);
    await u.waitText('Enter your password to unlock', 20000);
    check(await u.has('Kai’s workspace') || (await u.has("Kai's workspace")), 'the workspace kept the name from first run');
    await u.fill('Password', PASSWORD);
    await s.keys(ENTER);
    await waitHome(s, 20000);
    await u.waitText('Getting started', 15000).catch(() => failures.push('Home did not continue first run (no Getting started)'));
    const state = await waitForApps(s, u).catch((e) => e.message);
    check(state === 'ready', `the picked apps finished building after the restart (${state})`);
    await u.shot('02-home-resumed');
    const text = await u.text('main');
    for (const app of ['Tasks', 'Habits']) check(text.includes(app), `Home lists ${app} after resuming`);
    check(await u.has('Save your recovery key.'), 'Home asks to save the recovery key that was never confirmed');

    // The built app works.
    const opened = await s.exec(
      `const row=[...document.querySelectorAll('.hm-setup-row')].find(r=>r.querySelector('.hm-row-title')?.textContent.trim()==='Tasks');const b=row&&[...row.querySelectorAll('button')].find(b=>b.textContent.trim()==='Open');if(!b)return false;b.click();return true`,
    );
    check(opened, 'no Open link for Tasks');
    await sleep(2500);
    const appText = await u.text('main');
    check(!/not found|couldn.t open|ran into a problem/i.test(appText), `Tasks opened broken after resuming: ${appText.slice(0, 160).replace(/\s+/g, ' ')}`);
    await u.route('#/home');
    await u.waitText('Save it now', 10000);

    // Save the key from Home: password → the same words → tick → Done.
    await u.click('Save it now');
    await u.waitText('Enter your password to see your recovery key', 10000);
    await u.fill('Password', PASSWORD);
    await u.click('Show my recovery key');
    await u.waitText("I've saved my recovery key", 20000);
    const again = await s.exec(`return [...document.querySelectorAll('[role=dialog] .emp-words .emp-word-t')].map(e=>e.textContent.trim())`);
    check(JSON.stringify(again) === JSON.stringify(words), 'Home shows the same 24 words as first run');
    await u.shot('03-save-from-home');
    await u.click("I've saved my recovery key");
    await u.click('Done');
    await u.waitGone('Save it now', 10000).catch(() => failures.push('the recovery reminder stayed after saving the key'));
    await u.shot('04-saved');
    const errs = await u.errors();
    if (errs.length) failures.push(...errs.map((e) => `console: ${e}`));
  } finally {
    await endSession(s);
  }
  return failures;
}
