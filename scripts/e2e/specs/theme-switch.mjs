// Switching theme must not crash the desktop app, including when WebKitGTK runs without accelerated compositing
// (WEBKIT_DISABLE_COMPOSITING_MODE=1, which desktopSession sets). 0.3.0 crashed here via document.startViewTransition.
import { desktopSession, sleep, KEY } from '../lib/wd.mjs';
import { ui } from '../lib/ui.mjs';
import { waitBoot, onboardPlain } from '../lib/flows.mjs';

export const name = 'theme-switch';
export default async function run({ shots }) {
  const port = Number(process.env.E2E_PORT || 4444);
  const s = await desktopSession({ port, nativePort: port + 1 });
  const u = ui(s, { shotsDir: shots, prefix: name });
  const problems = [];
  try {
    await waitBoot(s, u);
    await onboardPlain(s, u);
    const before = await s.exec('return document.documentElement.dataset.theme');
    await s.chord([KEY.ctrl, KEY.shift], 'd');
    await sleep(1500);
    const after = await s.exec('return document.documentElement.dataset.theme').catch((e) => {
      problems.push(`app died after Ctrl+Shift+D: ${e.message}`);
      return null;
    });
    if (after !== null && after === before) problems.push(`theme did not change (still ${before})`);
    if (after !== null) {
      await s.chord([KEY.ctrl, KEY.shift], 'd');
      await sleep(1000);
      await u.shot('after-two-switches');
      if (await u.crashed()) problems.push('a view crashed after switching theme');
      const errs = await u.errors();
      problems.push(...errs.map((e) => `console: ${e}`));
    }
  } finally {
    await s.end();
  }
  return problems;
}
