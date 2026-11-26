/**
 * Shared helpers for the local phase-exit gates (census.js, settle.js). Not run in CI.
 *
 * Playwright is not a project dependency: run with the global install, e.g.
 *   NODE_PATH=/opt/node-tools/node_modules node scripts/gates/census.js --port 1702
 */
'use strict';

const DEFAULT_ROUTES = ['home', 'money'];
/** Demo-seed aliases (ids are deterministic in ?seed=demo). */
const ALIASES = {
  home: '/home',
  money: '/app/01a0f6b1-2757-71b8-8c81-3a4143032a79',
  'money-hq': '/app/01a0f6b1-2757-71b8-8c81-3a4143032a79',
  portfolio: '/app/01a0f6b1-2978-7eec-88f4-d59b704c64c2',
  taxes: '/app/01a0f6b1-2b55-7b49-969e-78be62408c14',
  markets: '/markets',
  calendar: '/calendar',
  lifeapps: '/lifeapps',
};

function parseArgs(argv) {
  const out = { port: 1420, routes: DEFAULT_ROUTES, themes: ['light', 'dark'], motion: 'no-preference', out: null, runs: 1, window: 3000, width: 1440, height: 900, seed: 'demo', freeze: '2026-11-26T15:30:00Z', json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--port') out.port = Number(v());
    else if (a === '--routes') out.routes = v().split(',').filter(Boolean);
    else if (a === '--routes-file') out.routes = JSON.parse(require('fs').readFileSync(v(), 'utf8'));
    else if (a === '--themes') out.themes = v().split(',').filter(Boolean);
    else if (a === '--reduced-motion') out.motion = 'reduce';
    else if (a === '--out') out.out = v();
    else if (a === '--runs') out.runs = Math.max(1, Number(v()));
    else if (a === '--window') out.window = Number(v());
    else if (a === '--seed') out.seed = v();
    else if (a === '--width') out.width = Number(v());
    else if (a === '--height') out.height = Number(v());
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') {
      console.log('options: --port N --routes home,money,/calendar --routes-file routes.json --themes light,dark --reduced-motion --runs N --window ms --out file.json --json');
      process.exit(0);
    }
  }
  out.routes = out.routes.map((r) => ALIASES[r] || (r.startsWith('/') ? r : '/' + r));
  return out;
}

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (e) {
    console.error('Playwright not found. Run with NODE_PATH pointing at a global install, e.g.\n  NODE_PATH=/opt/node-tools/node_modules node ' + process.argv[1]);
    process.exit(2);
  }
}

/** Collect `emp:route-ready` events from the very first script on the page. */
const READY_INIT = () => {
  window.__empReady = [];
  window.addEventListener('emp:route-ready', (e) => window.__empReady.push({ t: performance.now(), detail: e.detail }));
};

async function openRoute(browser, opts, route, theme) {
  const ctx = await browser.newContext({ viewport: { width: opts.width, height: opts.height }, colorScheme: theme === 'light' ? 'light' : 'dark', reducedMotion: opts.motion, deviceScaleFactor: 1 });
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem('emp.boot', JSON.stringify({ theme: t, accent: 'graphite', motion: 'system', density: 'comfortable', textSize: 'm' }));
    } catch {
      /* storage blocked */
    }
  }, theme);
  await ctx.addInitScript(READY_INIT);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const url = `http://localhost:${opts.port}/?seed=${encodeURIComponent(opts.seed)}&freeze=${encodeURIComponent(opts.freeze)}#${route}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  let ready = null;
  try {
    await page.waitForFunction(() => window.__empReady && window.__empReady.length > 0, null, { timeout: 30000, polling: 16 });
    ready = await page.evaluate(() => window.__empReady[0]);
  } catch {
    ready = null;
  }
  return { ctx, page, ready, errors };
}

function median(xs) {
  const s = [...xs].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function table(rows, cols) {
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (vals) => '| ' + vals.map((v, i) => String(v ?? '').padEnd(w[i])).join(' | ') + ' |';
  return [line(cols), '|' + w.map((n) => '-'.repeat(n + 2)).join('|') + '|', ...rows.map((r) => line(cols.map((c) => r[c])))].join('\n');
}

module.exports = { parseArgs, loadPlaywright, openRoute, median, table, ALIASES };
