// Reusable flows for desktop specs.
import { sleep } from './wd.mjs';

/** Wait for the first screen after launch (the window is revealed once the frontend reports ready). */
export async function waitBoot(s, u, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ready = await s.exec(`return document.readyState==='complete' && document.body && document.body.innerText.trim().length>0`).catch(() => false);
    if (ready) break;
    await sleep(250);
  }
  await u.hookErrors();
}

/**
 * Finish first run without encryption. `apps` are the onboarding labels to tick (Life OS/"Tasks and projects" is on by
 * default in 0.3.x). Returns when the shell is visible.
 */
export async function onboardPlain(s, u, { name = 'Alex', apps = [] } = {}) {
  await u.waitText('Welcome');
  await u.fill('Your name', name).catch(() => undefined);
  await u.click('Continue');
  await u.waitText('What do you want to track?');
  for (const a of apps) await u.click(a);
  await u.click('Continue');
  await u.waitText('Protect your workspace');
  await u.click("Don't encrypt");
  await u.click('Continue');
  await u.waitText('Search', 60000);
  await sleep(1500);
}
