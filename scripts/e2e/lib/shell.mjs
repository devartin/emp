// Helpers for the shell and projects specs (sidebar, project view). First run goes through flows.mjs when it knows
// the current first-run screens, and through the 1.0 two-screen first run otherwise.
import { execSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sleep } from './wd.mjs';
import { onboardPlain } from './flows.mjs';

/** The app can outlive its WebDriver session; a second launch on the same data must not meet the first. */
export function killApp(dataHome) {
  if (!dataHome) return;
  try {
    execSync(
      `for p in $(pgrep -f emp-app); do if tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | grep -qx "XDG_DATA_HOME=${dataHome}"; then kill $p; fi; done`,
      { shell: '/bin/bash', stdio: 'ignore' },
    );
  } catch {
    /* nothing to kill */
  }
}

/**
 * Finish first run without a password, picking `apps` by their card labels ("Habits", "Money", …). Returns once the
 * shell shows and every picked app is listed in the sidebar.
 */
export async function firstRun(s, u, { name = 'Alex', apps = [] } = {}) {
  await u.waitText('Welcome');
  if (!(await u.has('What would you like to use it for?'))) {
    await onboardPlain(s, u, { name, apps });
    return;
  }
  await u.fill('Your first name', name).catch(() => undefined);
  for (const a of apps) await u.click(a, { selector: '[role=checkbox]' });
  await u.click('Continue');
  await u.waitText('Keep it private?');
  await u.click('Not now', { selector: '[role=radio]' });
  await u.click('Start using Ultranote');
  await u.waitText('Search', 60000);
  // The picked apps build in the background: wait for their rows.
  const t0 = Date.now();
  while (apps.length && Date.now() - t0 < 60000) {
    const n = await s.exec(`return document.querySelectorAll('aside.emp-sidebar [role=tree][aria-label="Apps"] [data-app]').length`);
    if (n >= apps.length) break;
    await sleep(500);
  }
  await sleep(800);
}

/** The sidebar as the user sees it: its state, where it rests, and the main column beside it. */
export const sidebarState = (s) =>
  s.exec(`const a=document.querySelector('aside.emp-sidebar');const m=document.querySelector('.emp-main');if(!a||!m)return null;
    const r=a.getBoundingClientRect();const cs=getComputedStyle(a);
    return {state:a.dataset.state,hidden:a.getAttribute('aria-hidden')==='true',inert:a.hasAttribute('inert'),x:Math.round(r.left),w:Math.round(r.width),
      transform:cs.transform,visibility:cs.visibility,mainLeft:Math.round(m.getBoundingClientRect().left),show:!!document.querySelector('[aria-label="Show sidebar"]'),
      hideBtn:!!document.querySelector('aside.emp-sidebar [aria-label="Hide sidebar"]')}`);

export const isOpen = (v) => !!v && v.state === 'open' && !v.hidden && v.x === 0 && v.transform === 'none' && v.visibility === 'visible' && v.mainLeft >= v.w - 1;
export const isClosed = (v) => !!v && v.state === 'closed' && v.hidden && v.inert && v.visibility === 'hidden' && v.x + v.w <= 0 && v.mainLeft === 0 && v.show;

/** Poll the sidebar state until `predicate` holds (or time runs out); returns the last state. */
export async function settleSidebar(s, predicate, ms = 4000) {
  const t0 = Date.now();
  let v = null;
  while (Date.now() - t0 < ms) {
    v = await sidebarState(s);
    if (predicate(v)) return v;
    await sleep(150);
  }
  return v;
}

/** Visible text of one sidebar section (its rows, or its one empty line); null when the section isn't there. */
export const sectionText = (s, title) =>
  s.exec(`const sec=document.querySelector('aside.emp-sidebar section[aria-label="'+arguments[0]+'"]');return sec?sec.innerText:null`, [title]);

/** Titles of a section tree's rows (aria-labels, so app rows give their display name). */
export const sectionRows = (s, title) =>
  s.exec(`return [...document.querySelectorAll('aside.emp-sidebar [role=tree][aria-label="'+arguments[0]+'"] [data-tree-row]')].map(e=>e.getAttribute('aria-label'))`, [title]);

/** Click a sidebar row by its title within one section's tree. */
export async function clickRow(s, section, title, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ok = await s.exec(
      `const row=[...document.querySelectorAll('aside.emp-sidebar [role=tree][aria-label="'+arguments[0]+'"] [data-tree-row]')].find(e=>e.getAttribute('aria-label')===arguments[1]);if(!row)return false;row.scrollIntoView({block:'center'});row.click();return true`,
      [section, title],
    );
    if (ok) return true;
    await sleep(200);
  }
  throw new Error(`no row "${title}" in ${section}`);
}

/** Which region has keyboard focus (sidebar, topbar, content, panel). */
export const focusedRegion = (s) => s.exec(`const a=document.activeElement;const r=a&&a.closest('[data-region]');return r?r.dataset.region:'none'`);

/** A real (WebDriver) click on the first match: Radix menu triggers open on pointerdown, which a script click skips. */
export async function nativeClick(s, css, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const el = await s.find(css);
      await s.click(el);
      return true;
    } catch {
      await sleep(200);
    }
  }
  throw new Error(`no element for ${css}`);
}

/**
 * The app as users run it, with WebKit compositing ON. `desktopSession` turns compositing off for stable screenshots,
 * but launch-time races (the window is shown after the first render) only show with it on: this returns a launcher
 * that clears WEBKIT_DISABLE_COMPOSITING_MODE and execs the real binary (pass it as `app`).
 */
export function compositedApp(app) {
  const dir = mkdtempSync(join(tmpdir(), 'ultranote-composited-'));
  const file = join(dir, 'launch');
  writeFileSync(file, `#!/bin/sh\nunset WEBKIT_DISABLE_COMPOSITING_MODE\nexec '${app.replace(/'/g, `'\\''`)}' "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}

/** W3C pointer actions on the session's driver (`port` is the one passed to desktopSession). Ends with the button up. */
export async function pointer(s, port, actions) {
  const base = `http://127.0.0.1:${port}/session/${s.id}/actions`;
  const r = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions }] }) });
  if (!r.ok) throw new Error(`pointer actions failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

/** Release whatever pointer buttons and keys the last actions left down. */
export const releaseActions = (s, port) => fetch(`http://127.0.0.1:${port}/session/${s.id}/actions`, { method: 'DELETE' }).catch(() => undefined);

/** Viewport centre of the first element matching `css` (null when there is none). */
export const centreOf = (s, css) =>
  s.exec(`const e=document.querySelector(arguments[0]);if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}`, [css]);

/** Set the window's size through the session's driver (`port` as passed to desktopSession). */
export async function setWindowSize(s, port, width, height) {
  const r = await fetch(`http://127.0.0.1:${port}/session/${s.id}/window/rect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ width, height }) });
  if (!r.ok) throw new Error(`window resize failed: ${r.status}`);
}
