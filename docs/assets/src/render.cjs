#!/usr/bin/env node
/*
 * Ultranote brand art generator.
 *
 *   npm run media:art                 capture fresh screenshots, then render every PNG
 *   npm run media:art -- --port 1907  use (or start) the mock app on this port
 *   npm run media:art -- --compose    re-render from the last captures only (no app needed)
 *
 * Step 1 captures real screens from the mock app (seed "demo", clock frozen at
 * 2026-11-26 15:30 UTC) at 2x into docs/assets/src/.shots/. If nothing answers on the port,
 * the script starts `vite` with the mock backend itself and stops it when done.
 * Step 2 lays those captures out with art.html (IBM Plex Sans from node_modules, the app mark
 * from public/emp.svg) and writes the final PNGs to docs/assets/.
 *
 * Nothing in the art is drawn by hand except the window frame around a screenshot.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '../../..');
const OUT = path.resolve(HERE, '..');
const SHOTS = path.join(HERE, '.shots');
const FREEZE = '2026-11-26T15:30:00Z';

function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    try {
      return require('/opt/node-tools/node_modules/playwright');
    } catch {
      console.error('Playwright is not installed. Point NODE_PATH at a global install that has it.');
      process.exit(2);
    }
  }
}

function args() {
  const out = { port: Number(process.env.MEDIA_PORT || 1907), capture: true, compose: true };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--port') out.port = Number(a[++i]);
    else if (a[i] === '--compose') out.capture = false;
    else if (a[i] === '--capture') out.compose = false;
  }
  return out;
}

function ping(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function ensureServer(port) {
  if (await ping(port)) return null;
  console.log(`starting the mock app on port ${port}`);
  const child = spawn('npx', ['vite', '--port', String(port), '--strictPort'], {
    cwd: ROOT,
    env: { ...process.env, VITE_ALLOW_MOCK: '1' },
    stdio: 'ignore',
    detached: true,
  });
  for (let i = 0; i < 120; i++) {
    if (await ping(port)) return child;
    await new Promise((r) => setTimeout(r, 500));
  }
  stopServer(child);
  throw new Error(`the mock app did not start on port ${port}`);
}

function stopServer(child) {
  if (!child) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
}

// What to capture. `open` is a sidebar row to click after Home has loaded (stable across seed
// edits, unlike page ids). deviceScaleFactor 2; sizes match SHOTS in art.html. Money HQ is captured
// at 960 wide, where its overview is one column, so the feature crop can hold net worth, the chart
// and the month's figures without catching the edge of a second column.
const SCREENS = [
  { id: 'home', open: null, width: 1280, height: 960 },
  { id: 'money', open: 'Money HQ', width: 960, height: 1040 },
  { id: 'crm', open: 'Client CRM', width: 1280, height: 900 },
];

async function capture(pw, port) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await pw.chromium.launch();
  try {
    for (const theme of ['light', 'dark']) {
      for (const s of SCREENS) {
        const ctx = await browser.newContext({
          viewport: { width: s.width, height: s.height },
          deviceScaleFactor: 2,
          colorScheme: theme,
          reducedMotion: 'reduce',
        });
        await ctx.addInitScript((t) => {
          try {
            localStorage.setItem('emp.boot', JSON.stringify({ theme: t, accent: 'graphite', motion: 'system', density: 'comfortable', textSize: 'm' }));
          } catch {
            /* storage blocked */
          }
          window.__empReady = [];
          window.addEventListener('emp:route-ready', (e) => window.__empReady.push(e.detail));
        }, theme);
        const page = await ctx.newPage();
        await page.goto(`http://localhost:${port}/?seed=demo&freeze=${encodeURIComponent(FREEZE)}#/home`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__empReady.length > 0, null, { timeout: 45000 });
        if (s.open) {
          const before = await page.evaluate(() => window.__empReady.length);
          await page.getByText(s.open, { exact: true }).first().click();
          await page
            .waitForFunction((n) => window.__empReady.length > n, before, { timeout: 20000 })
            .catch(() => {});
        }
        await page.mouse.move(s.width - 1, s.height - 1);
        await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(1500);
        const file = path.join(SHOTS, `${s.id}-${theme}.png`);
        await page.screenshot({ path: file });
        console.log('captured', path.relative(ROOT, file));
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
  }
}

// The renders. `scale` is the deviceScaleFactor of the art page.
const RENDERS = [
  { kind: 'banner', theme: 'light', w: 1200, h: 500, scale: 2, file: 'banner.png' },
  { kind: 'banner', theme: 'dark', w: 1200, h: 500, scale: 2, file: 'banner-dark.png' },
  { kind: 'social', theme: 'light', w: 1280, h: 640, scale: 1, file: 'social-preview.png' },
  { kind: 'features', theme: 'light', w: 1200, h: 536, scale: 2, file: 'features.png' },
  { kind: 'features', theme: 'dark', w: 1200, h: 536, scale: 2, file: 'features-dark.png' },
];

async function compose(pw) {
  for (const s of SCREENS) {
    for (const t of ['light', 'dark']) {
      const f = path.join(SHOTS, `${s.id}-${t}.png`);
      if (!fs.existsSync(f)) throw new Error(`missing capture ${path.relative(ROOT, f)}; run without --compose first`);
    }
  }
  const browser = await pw.chromium.launch();
  try {
    for (const r of RENDERS) {
      const ctx = await browser.newContext({ viewport: { width: r.w, height: r.h }, deviceScaleFactor: r.scale, colorScheme: r.theme });
      const page = await ctx.newPage();
      const url = 'file://' + path.join(HERE, 'art.html') + `#${r.kind}/${r.theme}`;
      await page.goto(url);
      await page.waitForFunction(() => window.__artReady === true, null, { timeout: 15000 });
      const file = path.join(OUT, r.file);
      await page.screenshot({ path: file });
      await ctx.close();
      console.log('rendered', path.relative(ROOT, file), `${Math.round(fs.statSync(file).size / 1024)} KB`);
    }
  } finally {
    await browser.close();
  }
}

(async () => {
  const opts = args();
  const pw = loadPlaywright();
  let server = null;
  try {
    if (opts.capture) {
      server = await ensureServer(opts.port);
      await capture(pw, opts.port);
    }
    if (opts.compose) await compose(pw);
  } finally {
    stopServer(server);
  }
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
