// Smoke: first run with every life app, then open Home and each app from the sidebar; nothing may crash.
import { desktopSession, sleep } from '../lib/wd.mjs';
import { ui } from '../lib/ui.mjs';
import { waitBoot, onboardPlain } from '../lib/flows.mjs';

export const name = 'smoke-apps';
export default async function run({ shots }) {
  const s = await desktopSession();
  const u = ui(s, { shotsDir: shots, prefix: name });
  const failures = [];
  try {
    await waitBoot(s, u);
    await onboardPlain(s, u, { apps: ['Habits and routines', 'Spending and budget', 'Investments', 'Taxes', 'Spreadsheets'] });
    await u.shot('home');
    if (await u.crashed()) failures.push('Home crashed after onboarding');
    const targets = ['Life OS', 'Habits', 'Money HQ', 'Portfolio', 'Tax', 'Spreadsheet Studio', 'Markets', 'Calendar', 'Home', 'Trash'];
    for (const t of targets) {
      await u.click(t, { within: 'nav, aside, [role=navigation]' }).catch((e) => failures.push(`${t}: ${e.message}`));
      await sleep(2500);
      if (await u.crashed()) failures.push(`${t} crashed`);
      await u.shot(t.replace(/\W+/g, '_'));
    }
    const errs = await u.errors();
    if (errs.length) failures.push(...errs.map((e) => `console: ${e}`));
  } finally {
    await s.end();
  }
  return failures;
}
