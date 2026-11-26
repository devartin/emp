#!/usr/bin/env node
/**
 * README media pipeline: regenerates every README screenshot and motion clip from the live browser-mock app.
 *
 *   npm run media:capture                          # everything into docs/screenshots and docs/media
 *   npm run media:capture -- --only home,money     # just these (still and/or clip names; see --list)
 *   npm run media:capture -- --out-dir /tmp/media  # somewhere else (screenshots/ and media/ are created inside)
 *
 * Determinism: demo seed, frozen clock (2026-11-26 15:30 UTC), UTC time zone, en-US locale, a seeded Math.random,
 * a fresh browser context per shot, and every shot waits for the app's `emp:route-ready` signal (src/app/routeReady.ts),
 * web fonts, no loading markers and no running finite animations before it is taken.
 *
 * Stills: 1440x900 CSS px at deviceScaleFactor 2, resampled to 2400px wide, given the same window chrome (rounded
 * corners and a hairline in the theme's line colour), then written as an optimised PNG (palette-quantised with ffmpeg
 * when the truecolour file would exceed the size budget).
 *
 * Clips: 1280x800 CSS px captured at 2x. Page time (JS clock, timers, rAF, CSS/WAAPI timeline) is slowed by --slowmo
 * while recording so 2x frames can be grabbed fast enough; every frame is stamped with page time and ffmpeg rebuilds a
 * constant-rate GIF (palettegen/paletteuse, looping) and an H.264 MP4 (yuv420p, faststart) from those stamps.
 *
 * Needs Playwright (resolved from the project, NODE_PATH, or the global npm root) and ffmpeg on PATH. Starts its own
 * Vite mock server on --port unless one is already answering there. See scripts/media/README.md.
 */
import { spawn, execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ───────────────────────────────────────────────────────────────────────────── constants

const FREEZE = '2026-11-26T15:30:00Z';
const TIMEZONE = 'UTC';
const LOCALE = 'en-US';
const RANDOM_SEED = 0x5eed;

const STILL = { width: 1440, height: 900, scale: 2, outWidth: 2400, budget: 600 * 1024, radius: 12 };
const CLIP = { width: 1280, height: 800, scale: 2, gifWidth: 960, gifFps: 18, gifBudget: 3 * 1024 * 1024, mp4Width: 1920, mp4Fps: 30 };
/** Hairline drawn around every still, per theme (matches the app's line colour closely enough at this size). */
const CHROME_LINE = { light: 'rgba(24, 22, 18, 0.16)', dark: 'rgba(255, 255, 255, 0.14)' };

// ───────────────────────────────────────────────────────────────────────────── args

function parseArgs(argv) {
  const o = {
    only: null,
    outDir: path.join(ROOT, 'docs'),
    port: 1490,
    themes: null, // null: each still in the theme the README shows it in (STILLS[].theme)
    clipTheme: 'light',
    slowmo: 3,
    keepFrames: false,
    server: true,
    chrome: true,
    list: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} needs a value`);
      return v;
    };
    if (a === '--only') o.only = val().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--out-dir') o.outDir = path.resolve(val());
    else if (a === '--port') o.port = Number(val());
    else if (a === '--theme') {
      const t = val();
      if (!['light', 'dark', 'both'].includes(t)) fail('--theme is light, dark or both');
      o.themes = t === 'both' ? ['light', 'dark'] : [t];
      if (t !== 'both') o.clipTheme = t;
    } else if (a === '--clip-theme') o.clipTheme = val() === 'dark' ? 'dark' : 'light';
    else if (a === '--slowmo') o.slowmo = Math.max(1, Number(val()) || 1);
    else if (a === '--keep-frames') o.keepFrames = true;
    else if (a === '--no-server') o.server = false;
    else if (a === '--no-chrome') o.chrome = false;
    else if (a === '--list') o.list = true;
    else if (a === '--help' || a === '-h') {
      console.log(HELP);
      process.exit(0);
    } else fail(`unknown option ${a} (try --help)`);
  }
  if (!Number.isInteger(o.port) || o.port <= 0) fail('--port must be a port number');
  return o;
}

const HELP = `node scripts/media/capture.mjs [options]

  --only a,b,c     only these shots: still or clip names, "still:<name>" / "clip:<name>", or the groups "stills" / "clips"
  --out-dir DIR    write DIR/screenshots/<name>-<theme>.png and DIR/media/<clip>.{gif,mp4} (default: docs/)
  --port N         mock dev server port (default 1490); started automatically unless already running
  --no-server      never start a server; fail if nothing answers on --port
  --theme T        light | dark | both for stills (default: each still in the theme the README uses); a single
                   theme also applies to clips
  --clip-theme T   light | dark (default light)
  --slowmo N       page-time slow-down while recording clips (default 3)
  --no-chrome      plain rectangular stills (no rounded corners or hairline)
  --keep-frames    keep the raw clip frames (printed path)
  --list           print the shot names and exit`;

function fail(msg) {
  console.error(`media:capture: ${msg}`);
  process.exit(2);
}

// ───────────────────────────────────────────────────────────────────────────── tooling

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const candidates = ['playwright'];
  try {
    candidates.push(path.join(execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(), 'playwright'));
  } catch {
    /* npm not on PATH */
  }
  candidates.push('/opt/node-tools/node_modules/playwright');
  for (const c of candidates) {
    try {
      return req(c);
    } catch {
      /* next */
    }
  }
  fail('Playwright not found. Install it globally (npm i -g playwright) or run with NODE_PATH=<dir containing playwright>.');
  return null;
}

function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
}

async function isUp(port) {
  try {
    const res = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureServer(opts) {
  if (await isUp(opts.port)) return null;
  if (!opts.server) fail(`nothing is answering on http://localhost:${opts.port}/ (and --no-server was given)`);
  console.log(`starting the mock dev server on :${opts.port}`);
  const child = spawn('npx', ['vite', '--port', String(opts.port), '--strictPort'], {
    cwd: ROOT,
    env: { ...process.env, VITE_ALLOW_MOCK: '1', BROWSER: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const t0 = Date.now();
  while (Date.now() - t0 < 90_000) {
    if (await isUp(opts.port)) return child;
    if (child.exitCode !== null) break;
    await sleep(300);
  }
  stopServer(child);
  fail(`the dev server did not come up on :${opts.port}\n${log.slice(-2000)}`);
  return null;
}

function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* gone */
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashName(s) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

const kb = (n) => `${Math.round(n / 1024)} KB`;

// ───────────────────────────────────────────────────────────────────────────── in-page init scripts

/**
 * Runs before any app script. Seeds Math.random, collects `emp:route-ready`, and installs a page clock that can be
 * slowed (`__media.setRate`): performance.now, Date, rAF timestamps and timer delays all follow it, so JS-driven
 * motion slows in step with the CSS/WAAPI timeline (slowed separately over CDP).
 */
function pageInit({ theme, seed, cursor }) {
  try {
    localStorage.setItem('emp.boot', JSON.stringify({ theme, accent: 'graphite', motion: 'system', density: 'comfortable', textSize: 'm' }));
  } catch {
    /* storage blocked */
  }
  let a = seed >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  window.__empReady = [];
  window.addEventListener('emp:route-ready', (e) => window.__empReady.push(e.detail));

  // A piecewise-linear page clock: virtual = vAnchor + (real - rAnchor) * rate.
  const perf = window.performance;
  const realPerf = perf.now.bind(perf);
  let rate = 1;
  let rAnchor = realPerf();
  let vAnchor = rAnchor;
  const vPerf = () => vAnchor + (realPerf() - rAnchor) * rate;
  const toVirtual = (realTs) => vAnchor + (realTs - rAnchor) * rate;
  const RealDate = window.Date;
  const realDateNow = RealDate.now.bind(RealDate);
  const dateOffset = realDateNow() - realPerf();
  const vDateNow = () => Math.round(dateOffset + vPerf());
  perf.now = vPerf;
  window.Date = new Proxy(RealDate, {
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length ? args : [vDateNow()], newTarget);
    },
    apply() {
      return new RealDate(vDateNow()).toString();
    },
    get(target, prop, receiver) {
      if (prop === 'now') return vDateNow;
      return Reflect.get(target, prop, receiver);
    },
  });
  const realSetTimeout = window.setTimeout.bind(window);
  const realSetInterval = window.setInterval.bind(window);
  const realRaf = window.requestAnimationFrame.bind(window);
  window.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, (Number(ms) || 0) / rate, ...rest);
  window.setInterval = (fn, ms, ...rest) => realSetInterval(fn, (Number(ms) || 0) / rate, ...rest);
  window.requestAnimationFrame = (cb) => realRaf((ts) => cb(toVirtual(ts)));
  window.__media = {
    setRate(r) {
      vAnchor = vPerf();
      rAnchor = realPerf();
      rate = r;
    },
  };

  const style = document.createElement('style');
  style.id = '__media-style';
  style.textContent = cursor
    ? ''
    : '*, *::before, *::after { caret-color: transparent !important; } ::selection { background: transparent; }';
  const mount = () => {
    if (style.textContent) document.head.appendChild(style);
    if (!cursor) return;
    // A synthetic pointer for clips (headless capture has none). Hidden until the first mouse move.
    const c = document.createElement('div');
    c.id = '__media-cursor';
    c.setAttribute('aria-hidden', 'true');
    c.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;display:none;transform-origin:2px 2px;will-change:transform;';
    c.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg"><path d="M3 2.5v15.2l4.1-3.9 2.6 6 2.7-1.2-2.6-5.9h5.7z" fill="#1c1b19" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
    let x = 0;
    let y = 0;
    let down = false;
    const place = () => (c.style.transform = `translate(${x - 2}px, ${y - 2}px) scale(${down ? 0.86 : 1})`);
    window.addEventListener('mousemove', (e) => {
      x = e.clientX;
      y = e.clientY;
      c.style.display = 'block';
      place();
    }, { capture: true, passive: true });
    window.addEventListener('mousedown', () => ((down = true), place()), { capture: true, passive: true });
    window.addEventListener('mouseup', () => ((down = false), place()), { capture: true, passive: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
}

// ───────────────────────────────────────────────────────────────────────────── settle helpers

/** Wait for fonts, no loading markers, and no finite animation still running; then two frames. */
async function settle(page, { timeout = 8000, extra = 250 } = {}) {
  await page.waitForFunction(
    () => {
      if (document.fonts && document.fonts.status !== 'loaded') return false;
      if (document.querySelector('.emp-route-skeleton, .emp-skeleton, [aria-busy="true"], [data-route-busy]')) return false;
      const running = document.getAnimations().filter((a) => {
        if (a.playState !== 'running') return false;
        const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
        return t && Number.isFinite(t.endTime) && t.endTime !== Infinity;
      });
      return running.length === 0;
    },
    null,
    { timeout, polling: 50 },
  ).catch(() => console.warn('    (settle timed out; capturing anyway)'));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  if (extra) await page.waitForTimeout(extra);
}

async function waitRouteReady(page, count = 1, timeout = 30000) {
  await page.waitForFunction((n) => window.__empReady && window.__empReady.length >= n, count, { timeout, polling: 50 });
  const last = await page.evaluate(() => window.__empReady[window.__empReady.length - 1]);
  if (last && last.timedOut) console.warn(`    (route-ready timed out on ${last.route})`);
}

function appUrl(port, { seed = 'demo', params = {}, route = '/home' } = {}) {
  const q = new URLSearchParams({ seed, freeze: FREEZE, ...params });
  return `http://localhost:${port}/?${q.toString()}#${route}`;
}

// ───────────────────────────────────────────────────────────────────────────── id resolution

/** Look up page and life-app instance ids by title / app id from the demo seed, so shots don't hard-code UUIDs. */
async function resolveIds(browser, port) {
  const ctx = await browser.newContext({ timezoneId: TIMEZONE, locale: LOCALE });
  const page = await ctx.newPage();
  await page.goto(appUrl(port), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__EMP_MOCK__, null, { timeout: 30000 }).catch(() => fail(`the app on :${port} has no mock backend (window.__EMP_MOCK__). Start it with VITE_ALLOW_MOCK=1.`));
  const data = await page.evaluate(async () => {
    const m = window.__EMP_MOCK__;
    const ws = await m.call('workspace_list');
    const open = await m.call('workspace_open', { id: ws[0].id });
    const inst = await m.call('lifeapp_instances', { workspaceId: ws[0].id });
    return { pages: open.pages.map((p) => ({ id: p.id, title: p.title, kind: p.kind })), apps: inst.map((i) => ({ id: i.id, appId: i.appId })) };
  });
  await ctx.close();
  const ids = {
    page(title) {
      const p = data.pages.find((x) => x.title === title);
      if (!p) throw new Error(`no page titled "${title}" in the demo seed`);
      return p.id;
    },
    app(appId) {
      const a = data.apps.find((x) => x.appId === appId);
      if (!a) throw new Error(`no "${appId}" life app in the demo seed`);
      return a.id;
    },
  };
  return ids;
}

// ───────────────────────────────────────────────────────────────────────────── shot list

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * Stills. `route(ids)` is the hash route; `seed` / `params` go in the query; `ready(page)` replaces the
 * route-ready wait for screens that are not routes (lock, first run); `prepare(page)` runs after settling.
 * `theme` is the one theme the README shows the still in (its screenshot table is light on the left, dark on the
 * right), so a default run writes only files the README uses; `--theme` overrides it. `optional` stills are not
 * part of a default run or the `stills` group and are captured only when named in --only.
 */
const STILLS = [
  { name: 'home', theme: 'light', route: () => '/home' },
  { name: 'money-hq', theme: 'dark', route: (ids) => `/app/${ids.app('money-hq')}` },
  { name: 'money-budget', theme: 'light', route: (ids) => `/app/${ids.app('money-hq')}/budget` },
  { name: 'portfolio', theme: 'dark', route: (ids) => `/app/${ids.app('portfolio')}` },
  {
    name: 'markets',
    theme: 'light',
    route: () => '/markets/NOVA:XNAS',
    async prepare(page) {
      // The ink line chart (the default); select it explicitly in case the default changes.
      const line = page.getByRole('radio', { name: 'Line', exact: true });
      if ((await line.count()) && (await line.first().getAttribute('aria-checked')) !== 'true') await line.first().click();
    },
  },
  { name: 'tax-estimator', theme: 'dark', route: (ids) => `/app/${ids.app('tax-organizer')}/estimator` },
  { name: 'database-table', theme: 'light', route: (ids) => `/page/${ids.page('Client CRM')}` },
  { name: 'database-board', theme: 'dark', route: (ids) => `/page/${ids.page('Project tracker')}` },
  { name: 'page', theme: 'light', route: (ids) => `/page/${ids.page('Website relaunch')}` },
  {
    name: 'sheet',
    theme: 'dark',
    route: (ids) => `/page/${ids.page('Household budget 2026')}`,
    async prepare(page) {
      // The default A1 selection would draw its border and fill handle through the sheet's title; select the first
      // budget figure instead (Salary, Budget / mo).
      const box = page.getByRole('textbox', { name: 'Name box' }).or(page.getByLabel('Name box')).first();
      await box.waitFor({ state: 'visible', timeout: 10000 });
      await box.click();
      await box.fill('B6');
      await box.press('Enter');
      await page.waitForFunction(() => {
        const nb = document.querySelector('[aria-label="Name box"]');
        return nb && 'value' in nb && nb.value === 'B6';
      }, null, { timeout: 5000 });
    },
  },
  { name: 'calendar', theme: 'light', route: () => '/calendar' },
  { name: 'life-os', theme: 'dark', route: (ids) => `/app/${ids.app('life-os')}` },
  { name: 'habits', theme: 'light', route: (ids) => `/app/${ids.app('habits')}` },
  { name: 'life-apps', theme: 'dark', route: () => '/lifeapps' },
  {
    name: 'command-palette',
    theme: 'light',
    route: () => '/home',
    async prepare(page) {
      await page.keyboard.press(`${MOD}+k`);
      const input = page.getByRole('combobox').or(page.locator('[cmdk-input], [role="dialog"] input')).first();
      await input.waitFor({ state: 'visible', timeout: 10000 });
      await input.pressSequentially('budget', { delay: 30 });
    },
  },
  {
    name: 'first-run',
    theme: 'dark',
    seed: 'empty',
    route: () => '/home',
    async ready(page) {
      await page.getByRole('heading', { name: /welcome/i }).first().waitFor({ state: 'visible', timeout: 30000 });
    },
  },
  {
    // Not in the README (the unlock clip shows this screen); capture with --only lock-screen.
    name: 'lock-screen',
    theme: 'light',
    optional: true,
    params: { locked: '1' },
    route: () => '/home',
    async ready(page) {
      await page.locator('input[type="password"]').first().waitFor({ state: 'visible', timeout: 30000 });
    },
  },
];

/**
 * Clips. `setup(h)` runs at normal speed before recording; `run(h)` is recorded. Times passed to h.* are page time
 * (what the viewer sees), independent of --slowmo.
 */
const CLIPS = [
  {
    name: 'unlock',
    params: { locked: '1' },
    route: () => '/home',
    async setup(h) {
      await h.page.locator('input[type="password"]').first().waitFor({ state: 'visible', timeout: 30000 });
      await settle(h.page, { extra: 600 });
    },
    async run(h) {
      const field = h.page.locator('input[type="password"]').first();
      await h.hold(1300);
      if (!(await field.evaluate((el) => el === document.activeElement))) await field.focus();
      await h.type('demo');
      await h.hold(350);
      await h.press('Enter');
      await h.routeReady(1);
      await h.hold(3000);
    },
  },
  {
    name: 'life-app-build',
    params: { persist: '1' },
    route: () => '/home',
    warm: () => ['/lifeapps'],
    async setup(h) {
      // Every life app is installed in the demo seed: remove Habits (persisted in this throwaway context) and reload,
      // so the clip can set it up from scratch.
      const page = h.page;
      await page.waitForFunction(() => window.__EMP_MOCK__, null, { timeout: 30000 });
      await waitRouteReady(page);
      await page.evaluate(async () => {
        const m = window.__EMP_MOCK__;
        const ws = await m.call('workspace_list');
        const inst = await m.call('lifeapp_instances', { workspaceId: ws[0].id });
        const habits = inst.find((i) => i.appId === 'habits' && !i.detached);
        if (habits) await m.call('lifeapp_uninstall', { instanceId: habits.id });
      });
      await page.waitForTimeout(1200); // the mock persists 400 ms after the last change
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitRouteReady(page);
      await settle(page, { extra: 400 });
      if (await page.getByRole('button', { name: 'Habits', exact: true }).count()) throw new Error('Habits is still installed after the reset');
    },
    async run(h) {
      const page = h.page;
      const t = { travel: 320 };
      await h.hold(250);
      await h.click(page.getByRole('button', { name: 'Add a life app' }), t);
      await h.routeReady(1);
      await h.hold(300);
      const row = page.locator('li').filter({ hasText: 'Habits' }).filter({ hasText: 'Daily habits' });
      await h.click(row.getByRole('button', { name: 'Set up' }), t);
      const dlg = page.getByRole('dialog');
      await dlg.getByText('Meditate', { exact: true }).waitFor({ state: 'visible', timeout: 20000 * h.slowmo });
      await h.hold(450);
      await h.click(dlg.getByText('Meditate', { exact: true }), t);
      await h.hold(400);
      // Later steps keep their recommended answers: Continue until the review step offers Create.
      const create = dlg.getByRole('button', { name: /^Create Habits/ });
      for (let i = 0; i < 6 && !(await create.isVisible().catch(() => false)); i++) {
        await h.click(dlg.getByRole('button', { name: /^Continue/ }), t);
        await h.hold(650);
      }
      await h.click(create, t);
      // The build stage runs the real install job, then hands off to the new hub.
      await h.routeReady(2);
      await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 20000 * h.slowmo }).catch(() => undefined);
      await h.hold(1300);
    },
  },
  {
    name: 'capture',
    route: () => '/home',
    async setup(h) {
      await waitRouteReady(h.page);
      await settle(h.page, { extra: 300 });
    },
    async run(h) {
      const field = h.page.getByPlaceholder(/Add a task, note or expense/);
      await h.hold(500);
      await h.click(field);
      await h.hold(250);
      await h.type('t call mum fri');
      await h.hold(700);
      await h.press('Enter');
      await h.hold(1300);
      await h.type('-12.50 coffee');
      await h.hold(700);
      await h.press('Enter');
      await h.hold(1900);
    },
  },
  {
    name: 'command-palette',
    route: () => '/home',
    warm: (ids) => [`/page/${ids.page('Website relaunch')}`],
    async setup(h) {
      const page = h.page;
      await waitRouteReady(page);
      // Run the same query once off camera so the palette's chunk, places and content search are all warm.
      await page.keyboard.press(`${MOD}+k`);
      const input = page.getByRole('combobox').or(page.locator('[cmdk-input], [role="dialog"] input')).first();
      await input.waitFor({ state: 'visible', timeout: 10000 });
      await input.pressSequentially('website', { delay: 20 });
      await page.locator('.cmdk-spinner').waitFor({ state: 'detached', timeout: 10000 }).catch(() => undefined);
      await page.keyboard.press('Escape');
      await settle(page, { extra: 400 });
    },
    async run(h) {
      const page = h.page;
      await h.hold(700);
      await h.press(`${MOD}+k`);
      await h.hold(450);
      // Content search waits for a 70 ms pause in typing and shows a spinner meanwhile; a quick burst keeps that
      // to a few frames, and the hold below starts only once the results (and their highlights) have caught up.
      await h.type('website', { min: 28, max: 40 });
      await page.locator('.cmdk-spinner').waitFor({ state: 'detached', timeout: 10000 * h.slowmo }).catch(() => undefined);
      await page.getByRole('option', { name: /Website relaunch/ }).first().waitFor({ state: 'visible', timeout: 10000 * h.slowmo }).catch(() => undefined);
      await h.hold(1000);
      await h.press('ArrowDown');
      await h.hold(350);
      await h.press('ArrowUp');
      await h.hold(450);
      await h.press('Enter');
      await h.routeReady(1);
      await h.hold(1800);
    },
  },
  {
    name: 'money',
    route: (ids) => `/app/${ids.app('money-hq')}`,
    async setup(h) {
      await waitRouteReady(h.page);
      await settle(h.page, { extra: 300 });
    },
    async run(h) {
      const page = h.page;
      await h.hold(500);
      // Scrub the net-worth chart: the header figure follows the crosshair.
      const box = await netWorthChartBox(page);
      await h.moveTo({ x: box.x + box.width * 0.92, y: box.y + box.height * 0.45 }, 500);
      await h.hold(200);
      await h.moveTo({ x: box.x + box.width * 0.18, y: box.y + box.height * 0.55 }, 1400);
      await h.hold(250);
      await h.moveTo({ x: box.x + box.width * 0.62, y: box.y + box.height * 0.5 }, 700);
      await h.hold(300);
      await h.click(page.getByRole('tab', { name: /^Transactions/ }));
      await h.hold(700);
      const firstRow = page.getByRole('grid', { name: 'Transactions' }).getByRole('checkbox').first();
      await h.click(firstRow);
      await h.hold(500);
      await h.click(page.getByRole('toolbar', { name: 'Selected transactions' }).getByRole('button', { name: 'Mark reviewed' }));
      await h.hold(1300);
    },
  },
  {
    name: 'database',
    route: (ids) => `/page/${ids.page('Client CRM')}`,
    async setup(h) {
      const page = h.page;
      await waitRouteReady(page);
      // Best effort: open a row once so the row peek's chunk and data are warm, then return to the table view.
      try {
        await page.getByRole('tab', { name: 'By stage' }).or(page.getByRole('button', { name: 'By stage' })).first().click();
        await page.getByText('Helios Health', { exact: true }).first().click();
        await page.waitForTimeout(1200);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
        await page.getByRole('tab', { name: 'Pipeline' }).or(page.getByRole('button', { name: 'Pipeline' })).first().click();
      } catch (e) {
        console.warn(`    (warm-up skipped: ${e.message.split('\n')[0]})`);
      }
      await settle(page, { extra: 400 });
    },
    async run(h) {
      const page = h.page;
      await h.hold(900);
      await h.click(page.getByRole('tab', { name: 'By stage' }).or(page.getByRole('button', { name: 'By stage' })).first());
      await h.hold(1400);
      const card = page.getByText('Helios Health', { exact: true }).first();
      await h.moveTo(card, 600);
      await h.hold(300);
      await h.click(card);
      await h.hold(2200);
    },
  },
];

/** The Money HQ overview net-worth chart: the widest visible chart in the main pane's upper half. */
async function netWorthChartBox(page) {
  const box = await page.evaluate(() => {
    const els = [...document.querySelectorAll('[data-region="content"] svg, [data-region="content"] canvas, main svg, main canvas')];
    let best = null;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width < 300 || r.height < 120 || r.top > window.innerHeight * 0.6 || r.bottom < 0) continue;
      if (!best || r.width * r.height > best.width * best.height) best = { x: r.left, y: r.top, width: r.width, height: r.height };
    }
    return best;
  });
  if (!box) throw new Error('could not find the net-worth chart');
  return box;
}

// ───────────────────────────────────────────────────────────────────────────── stills

async function newContext(browser, { viewport, scale, theme, cursor, seed }) {
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: scale,
    colorScheme: theme === 'light' ? 'light' : 'dark',
    reducedMotion: 'no-preference',
    timezoneId: TIMEZONE,
    locale: LOCALE,
  });
  await ctx.addInitScript(pageInit, { theme, seed, cursor });
  return ctx;
}

async function captureStill(browser, opts, ids, shot, theme, finisher) {
  const ctx = await newContext(browser, { viewport: { width: STILL.width, height: STILL.height }, scale: STILL.scale, theme, cursor: false, seed: RANDOM_SEED });
  try {
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(appUrl(opts.port, { seed: shot.seed, params: shot.params, route: shot.route(ids) }), { waitUntil: 'domcontentloaded' });
    if (shot.ready) await shot.ready(page);
    else await waitRouteReady(page);
    await settle(page, { extra: 300 });
    if (shot.prepare) {
      await shot.prepare(page);
      await settle(page, { extra: 400 });
    }
    // Park the (invisible) pointer where it hovers nothing.
    await page.mouse.move(STILL.width - 2, STILL.height - 2);
    const raw = await page.screenshot({ type: 'png', animations: 'allow', caret: 'hide' });
    if (errors.length) console.warn(`    page errors: ${errors.slice(0, 3).join(' | ')}`);
    const finished = await finisher.finish(raw, theme, opts.chrome);
    const out = path.join(opts.outDir, 'screenshots', `${shot.name}-${theme}.png`);
    return writeOptimisedPng(finished, out);
  } finally {
    await ctx.close();
  }
}

/** A blank page that resamples the 2x capture to STILL.outWidth with high-quality filtering and draws the chrome. */
async function createFinisher(browser) {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 300 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.setContent('<!doctype html><title>finisher</title>');
  return {
    async finish(pngBuffer, theme, chrome) {
      const b64 = await page.evaluate(
        async ({ src, outWidth, radius, cssWidth, line, chrome }) => {
          const blob = await (await fetch(`data:image/png;base64,${src}`)).blob();
          const full = await createImageBitmap(blob);
          const w = outWidth;
          const h = Math.round((full.height * outWidth) / full.width);
          const scaled = await createImageBitmap(full, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
          const canvas = new OffscreenCanvas(w, h);
          const g = canvas.getContext('2d');
          const k = w / cssWidth; // output px per CSS px
          if (chrome) {
            const r = radius * k;
            g.save();
            g.beginPath();
            g.roundRect(0, 0, w, h, r);
            g.clip();
            g.drawImage(scaled, 0, 0);
            g.restore();
            const lw = Math.max(1, Math.round(k));
            g.beginPath();
            g.roundRect(lw / 2, lw / 2, w - lw, h - lw, r - lw / 2);
            g.lineWidth = lw;
            g.strokeStyle = line;
            g.stroke();
          } else g.drawImage(scaled, 0, 0);
          const out = await canvas.convertToBlob({ type: 'image/png' });
          const bytes = new Uint8Array(await out.arrayBuffer());
          let s = '';
          for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          return btoa(s);
        },
        { src: pngBuffer.toString('base64'), outWidth: STILL.outWidth, radius: STILL.radius, cssWidth: STILL.width, line: CHROME_LINE[theme], chrome },
      );
      return Buffer.from(b64, 'base64');
    },
    close: () => ctx.close(),
  };
}

let FFMPEG = false;

/** Recompress losslessly; if that is still over budget, quantise to a 256-colour palette (binary alpha corners). */
function writeOptimisedPng(buf, out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (!FFMPEG) {
    fs.writeFileSync(out, buf);
    return { file: out, bytes: buf.length, mode: 'truecolour (ffmpeg missing: not optimised)' };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emp-still-'));
  try {
    const src = path.join(tmp, 'src.png');
    fs.writeFileSync(src, buf);
    const full = path.join(tmp, 'full.png');
    ffmpeg(['-i', src, '-pred', 'mixed', '-compression_level', '9', full]);
    let pick = fs.statSync(full).size <= buf.length ? full : src;
    let mode = 'truecolour';
    if (fs.statSync(pick).size > STILL.budget) {
      const pal = path.join(tmp, 'pal.png');
      ffmpeg([
        '-i', src,
        '-filter_complex', '[0:v]split[a][b];[a]palettegen=max_colors=256:stats_mode=full:reserve_transparent=1[p];[b][p]paletteuse=dither=sierra2_4a:alpha_threshold=128',
        '-pred', 'mixed', '-compression_level', '9', pal,
      ]);
      pick = pal;
      mode = 'palette (256)';
    }
    fs.copyFileSync(pick, out);
    return { file: out, bytes: fs.statSync(out).size, mode };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ───────────────────────────────────────────────────────────────────────────── clips

class Recorder {
  constructor(cdp, dir, slowmo) {
    this.cdp = cdp;
    this.dir = dir;
    this.slowmo = slowmo;
    this.frames = [];
    this.writes = [];
    this.running = false;
  }
  start() {
    this.running = true;
    this.t0 = performance.now();
    this.loop = (async () => {
      while (this.running) {
        const a = performance.now();
        let res;
        try {
          res = await this.cdp.send('Page.captureScreenshot', {
            format: 'png',
            optimizeForSpeed: true,
            captureBeyondViewport: false,
            clip: { x: 0, y: 0, width: CLIP.width, height: CLIP.height, scale: CLIP.scale },
          });
        } catch (e) {
          if (!this.running) break;
          throw e;
        }
        const b = performance.now();
        const file = path.join(this.dir, `f${String(this.frames.length).padStart(5, '0')}.png`);
        this.frames.push({ file, t: ((a + b) / 2 - this.t0) / this.slowmo / 1000 });
        this.writes.push(fs.promises.writeFile(file, Buffer.from(res.data, 'base64')));
      }
    })();
  }
  async stop() {
    this.running = false;
    await this.loop;
    await Promise.all(this.writes);
    this.end = (performance.now() - this.t0) / this.slowmo / 1000;
    return this.frames;
  }
}

/** Interaction helpers; every duration is page time. */
function makeHelpers(page, slowmo, name) {
  const rand = mulberry32(hashName(name));
  const pos = { x: CLIP.width * 0.62, y: CLIP.height * 0.7 };
  const h = {
    page,
    slowmo,
    rate: 1,
    real: (ms) => ms * h.slowmoNow(),
    slowmoNow: () => (h.rate === 1 ? 1 : slowmo),
    async hold(ms) {
      await page.waitForTimeout(ms * h.slowmoNow());
    },
    async type(text, { min = 40, max = 80 } = {}) {
      for (const ch of text) {
        await page.keyboard.type(ch);
        await h.hold(min + Math.round(rand() * (max - min)));
      }
    },
    async press(key) {
      await page.keyboard.press(key, { delay: Math.round(50 * h.slowmoNow()) });
    },
    async target(t) {
      if (t && typeof t.x === 'number' && typeof t.y === 'number' && !t.boundingBox) return t;
      await t.waitFor({ state: 'visible', timeout: 20000 * h.slowmoNow() });
      await t.scrollIntoViewIfNeeded();
      const b = await t.boundingBox();
      if (!b) throw new Error('target has no box');
      return { x: b.x + Math.min(b.width / 2, 40 + b.width * 0.1), y: b.y + b.height / 2 };
    },
    async moveTo(t, duration = 450) {
      const to = await h.target(t);
      const from = { ...pos };
      const steps = Math.max(2, Math.round(duration / 16));
      for (let i = 1; i <= steps; i++) {
        const p = i / steps;
        const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; // ease-in-out cubic
        pos.x = from.x + (to.x - from.x) * e;
        pos.y = from.y + (to.y - from.y) * e;
        await page.mouse.move(pos.x, pos.y);
        await h.hold(duration / steps);
      }
    },
    async click(t, { travel = 420 } = {}) {
      await h.moveTo(t, travel);
      await h.hold(90);
      await page.mouse.down();
      await h.hold(70);
      await page.mouse.up();
    },
    base: 0,
    /** Wait for the k-th `emp:route-ready` since recording started. */
    routeReady: (k = 1) => waitRouteReady(page, h.base + k, 30000 * h.slowmoNow()),
    async setRate(r) {
      h.rate = r;
      await page.evaluate((x) => window.__media && window.__media.setRate(x), r);
      const cdp = h.cdp;
      await cdp.send('Animation.setPlaybackRate', { playbackRate: r });
    },
  };
  return h;
}

async function recordClip(browser, opts, ids, clip) {
  const ctx = await newContext(browser, { viewport: { width: CLIP.width, height: CLIP.height }, scale: CLIP.scale, theme: opts.clipTheme, cursor: true, seed: RANDOM_SEED });
  const frameDir = fs.mkdtempSync(path.join(os.tmpdir(), `emp-clip-${clip.name}-`));
  try {
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Animation.enable');
    const h = makeHelpers(page, opts.slowmo, clip.name);
    h.cdp = cdp;
    await page.goto(appUrl(opts.port, { seed: clip.seed, params: clip.params, route: clip.route(ids) }), { waitUntil: 'domcontentloaded' });
    await clip.setup(h);
    if (clip.warm) {
      // Visit the routes the clip will open so their lazy chunks and data are warm (no loading frames mid-clip).
      const home = clip.route(ids);
      for (const r of [...clip.warm(ids), home]) {
        const n = await page.evaluate(() => window.__empReady.length);
        await page.evaluate((hash) => (window.location.hash = hash), `#${r}`);
        await waitRouteReady(page, n + 1);
      }
      await settle(page, { extra: 300 });
    }
    h.base = await page.evaluate(() => (window.__empReady || []).length);
    await page.mouse.move(CLIP.width * 0.62, CLIP.height * 0.7);
    await page.evaluate(() => {
      const c = document.getElementById('__media-cursor');
      if (c) c.style.display = 'none'; // shown again by the clip's first real move
    });
    await h.setRate(1 / opts.slowmo);
    const rec = new Recorder(cdp, frameDir, opts.slowmo);
    rec.start();
    try {
      await clip.run(h);
    } catch (e) {
      const shot = path.join(os.tmpdir(), `emp-clip-${clip.name}-failure.png`);
      await page.screenshot({ path: shot }).catch(() => undefined);
      e.message = `${e.message.split('\n')[0]} (page at failure: ${shot})`;
      throw e;
    } finally {
      await rec.stop();
      await h.setRate(1).catch(() => undefined);
    }
    if (errors.length) console.warn(`    page errors: ${errors.slice(0, 3).join(' | ')}`);
    const results = encodeClip(rec, path.join(opts.outDir, 'media'), clip.name);
    if (opts.keepFrames) console.log(`    frames kept in ${frameDir}`);
    return results;
  } finally {
    await ctx.close();
    if (!opts.keepFrames) fs.rmSync(frameDir, { recursive: true, force: true });
  }
}

function encodeClip(rec, dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const frames = [...rec.frames].sort((a, b) => a.t - b.t);
  if (frames.length < 2) throw new Error('recorded fewer than two frames');
  // ffconcat with per-frame durations rebuilds page time; ffmpeg's fps filter then resamples to a constant rate.
  const lines = ['ffconcat version 1.0'];
  for (let i = 0; i < frames.length; i++) {
    const next = i + 1 < frames.length ? frames[i + 1].t : Math.max(rec.end, frames[i].t + 0.05);
    lines.push(`file '${frames[i].file.replace(/'/g, "'\\''")}'`, `duration ${Math.max(0.001, next - (i ? frames[i].t : 0)).toFixed(4)}`);
  }
  lines.push(`file '${frames[frames.length - 1].file.replace(/'/g, "'\\''")}'`);
  const list = path.join(path.dirname(frames[0].file), 'frames.ffconcat');
  fs.writeFileSync(list, lines.join('\n') + '\n');

  const mp4 = path.join(dir, `${name}.mp4`);
  ffmpeg([
    '-f', 'concat', '-safe', '0', '-i', list,
    '-vf', `fps=${CLIP.mp4Fps},scale=${CLIP.mp4Width}:-2:flags=lanczos,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4,
  ]);

  const gif = path.join(dir, `${name}.gif`);
  const ladder = [
    { fps: CLIP.gifFps, width: CLIP.gifWidth, colors: 256, dither: 'bayer:bayer_scale=5' },
    { fps: 15, width: CLIP.gifWidth, colors: 256, dither: 'bayer:bayer_scale=5' },
    { fps: 15, width: CLIP.gifWidth, colors: 160, dither: 'bayer:bayer_scale=4' },
    { fps: 15, width: 880, colors: 128, dither: 'bayer:bayer_scale=3' },
  ];
  let used = null;
  for (const step of ladder) {
    ffmpeg([
      '-f', 'concat', '-safe', '0', '-i', list,
      '-filter_complex',
      `[0:v]fps=${step.fps},scale=${step.width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${step.colors}:stats_mode=diff[p];[b][p]paletteuse=dither=${step.dither}:diff_mode=rectangle`,
      '-loop', '0', gif,
    ]);
    used = step;
    if (fs.statSync(gif).size <= CLIP.gifBudget) break;
  }
  const duration = rec.end;
  return [
    { file: gif, bytes: fs.statSync(gif).size, mode: `${used.width}px ${used.fps} fps ${used.colors} colours, ${duration.toFixed(1)} s, ${frames.length} frames captured` },
    { file: mp4, bytes: fs.statSync(mp4).size, mode: `${CLIP.mp4Width}px ${CLIP.mp4Fps} fps H.264` },
  ];
}

// ───────────────────────────────────────────────────────────────────────────── main

function select(opts) {
  if (!opts.only) return { stills: STILLS.filter((s) => !s.optional), clips: CLIPS };
  const want = new Set(opts.only);
  const stills = STILLS.filter((s) => (want.has('stills') && !s.optional) || want.has(s.name) || want.has(`still:${s.name}`));
  const clips = CLIPS.filter((c) => want.has('clips') || want.has(c.name) || want.has(`clip:${c.name}`));
  const known = new Set(['stills', 'clips', ...STILLS.flatMap((s) => [s.name, `still:${s.name}`]), ...CLIPS.flatMap((c) => [c.name, `clip:${c.name}`])]);
  const unknown = opts.only.filter((n) => !known.has(n));
  if (unknown.length) fail(`unknown shot name(s): ${unknown.join(', ')} (see --list)`);
  return { stills, clips };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.list) {
    const themeOf = (s) => (opts.themes || [s.theme]).join(' + ');
    console.log(`stills:\n  ${STILLS.map((s) => `${s.name.padEnd(18)} ${themeOf(s)}${s.optional ? '  (optional: only with --only)' : ''}`).join('\n  ')}`);
    console.log(`clips (gif + mp4):\n  ${CLIPS.map((c) => c.name).join('\n  ')}`);
    return 0;
  }
  const { stills, clips } = select(opts);
  FFMPEG = hasFfmpeg();
  if (!FFMPEG && clips.length) fail('ffmpeg is required for clips (and for optimising stills); install it and retry');
  if (!FFMPEG) console.warn('ffmpeg not found: stills will be written unoptimised');

  const { chromium } = loadPlaywright();
  const server = await ensureServer(opts);
  const cleanup = () => stopServer(server);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  const browser = await chromium.launch();
  const results = [];
  let failures = 0;
  try {
    const ids = await resolveIds(browser, opts.port);
    if (stills.length) {
      const finisher = await createFinisher(browser);
      for (const shot of stills) {
        for (const theme of opts.themes || [shot.theme]) {
          const label = `${shot.name}-${theme}`;
          process.stdout.write(`still ${label}\n`);
          try {
            results.push(await captureStill(browser, opts, ids, shot, theme, finisher));
          } catch (e) {
            failures++;
            console.error(`    FAILED: ${e.message.split('\n')[0]}`);
            results.push({ file: label, bytes: 0, mode: `FAILED: ${e.message.split('\n')[0]}` });
          }
        }
      }
      await finisher.close();
    }
    for (const clip of clips) {
      process.stdout.write(`clip ${clip.name}\n`);
      try {
        results.push(...(await recordClip(browser, opts, ids, clip)));
      } catch (e) {
        failures++;
        console.error(`    FAILED: ${e.message.split('\n')[0]}`);
        results.push({ file: clip.name, bytes: 0, mode: `FAILED: ${e.message.split('\n')[0]}` });
      }
    }
  } finally {
    await browser.close();
    cleanup();
  }

  console.log(`\nOutput (${opts.outDir}):`);
  for (const r of results) {
    const rel = r.bytes ? path.relative(opts.outDir, r.file) : r.file;
    const over = (r.file.endsWith('.png') && r.bytes > STILL.budget) || (r.file.endsWith('.gif') && r.bytes > CLIP.gifBudget) ? '  OVER BUDGET' : '';
    console.log(`  ${rel.padEnd(56)} ${r.bytes ? kb(r.bytes).padStart(8) : '       -'}  ${r.mode}${over}`);
  }
  if (failures) console.error(`\n${failures} shot(s) failed`);
  return failures ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
