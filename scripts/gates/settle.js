#!/usr/bin/env node
/**
 * Settle gate (PROGRAMME-v3 K6 / chair resolution: must pass ≤ 300 ms after data-ready, target ≤ 150 ms; local
 * phase-exit gate, not CI). For each route × theme it loads the route fresh, waits for `emp:route-ready`, then for a
 * window (default 3 s) without any user input records:
 *   settle      ms from route-ready to the last DOM mutation or finite animation frame in <body>
 *   continuous  the DOM was still changing in the last 300 ms of the window (live ticker, JS-driven loop)
 *   idle        infinite animations still running at the end of the window (spinners, pulses, live dots)
 *   changed     numbers on screen at route-ready whose text changed later (count-up / late data on arrival)
 *   late        numbers that appeared after route-ready (counted per parent element)
 *   rolling     elements holding a number that were animated (style mutation or WAAPI) after route-ready
 * Run with --runs 3 for a median. Output: a table, and JSON with --out.
 *
 *   NODE_PATH=/opt/node-tools/node_modules node scripts/gates/settle.js --port 1702 [--routes home,money] \
 *     [--themes light,dark] [--reduced-motion] [--runs 3] [--window 3000] [--out settle.json]
 */
'use strict';
const fs = require('fs');
const { parseArgs, loadPlaywright, openRoute, median, table } = require('./lib');

const MUST = 300;
const TARGET = 150;

/**
 * Installed before any app code. Records DOM mutations and animation frames from the start, then evaluates the
 * window that begins at the route-ready timestamp (`detail.at`: the first frame from which the route stayed idle).
 */
const SETTLE_INIT = (windowMs) => {
  const NUM = /[$€£¥]?\s?[-−+]?\d[\d,.\s]*\d?\s?%?/;
  const isNumberText = (s) => !!s && s.length <= 32 && NUM.test(s) && /\d/.test(s);
  const describe = (n) => {
    const el = n && n.nodeType === 1 ? n : n && n.parentElement;
    if (!el) return '?';
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + (cls ? '.' + cls : '');
  };
  const pathOf = (el, root) => {
    const parts = [];
    for (let e = el; e && e !== root; e = e.parentElement) {
      const p = e.parentElement;
      parts.push(p ? Array.prototype.indexOf.call(p.children, e) : 0);
    }
    return parts.reverse().join('/');
  };
  const snapshot = () => {
    const root = document.querySelector('.emp-route') || document.body;
    const out = {};
    for (const el of root.querySelectorAll('*')) {
      if (el.children.length > 3) continue;
      const own = [...el.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join('').trim();
      const text = own || (el.children.length ? '' : el.textContent.trim());
      if (!isNumberText(text)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      out[pathOf(el, root)] = (el.innerText || text).trim();
    }
    return out;
  };
  const numberHost = (n) => {
    for (let e = n && n.nodeType === 1 ? n : n && n.parentElement, k = 0; e && k < 3; e = e.parentElement, k++) {
      const t = (e.textContent || '').trim();
      if (t.length <= 32 && /\d/.test(t)) return e;
    }
    return null;
  };
  const R = { muts: [], anims: 0, lastAnim: 0, rolling: new Map(), input: 0 };
  window.__empSettle = null;
  const onInput = () => (R.input = performance.now());
  window.addEventListener('pointerdown', onInput, true);
  window.addEventListener('keydown', onInput, true);
  window.addEventListener('wheel', onInput, true);
  const mo = new MutationObserver((list) => {
    const t = performance.now();
    for (const m of list) {
      if (!document.body || !document.body.contains(m.target)) continue;
      R.muts.push([t, describe(m.target)]);
      if (m.type === 'attributes' && m.attributeName === 'style') {
        const host = numberHost(m.target);
        if (host) R.rolling.set(host, t);
      }
    }
  });
  mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  let t0 = null;
  const tick = () => {
    const t = performance.now();
    for (const a of document.getAnimations()) {
      if (a.playState !== 'running') continue;
      const timing = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : {};
      if (timing.iterations === Infinity) continue;
      R.lastAnim = t;
      const target = a.effect && a.effect.target;
      const host = target && numberHost(target);
      if (host) R.rolling.set(host, t);
    }
    if (t0 === null || t < t0 + windowMs) requestAnimationFrame(tick);
    else finish();
  };
  requestAnimationFrame(tick);
  const S = { samples: [] };
  const finish = () => {
    mo.disconnect();
    const after = R.muts.filter(([t]) => t >= t0);
    const tail = {};
    for (const [t, d] of after) if (t > t0 + windowMs - 300) tail[d] = (tail[d] || 0) + 1;
    const hosts = [...new Set([...R.rolling].filter(([, t]) => t >= t0).map(([h]) => h.parentElement || h))];
    window.__empSettle = {
      done: true,
      muts: after.length,
      lastMut: after.length ? after[after.length - 1][0] - t0 : 0,
      lastAnim: R.lastAnim >= t0 ? R.lastAnim - t0 : 0,
      tail,
      input: R.input >= t0,
      samples: S.samples,
      rollingCount: hosts.filter((h) => !hosts.some((o) => o !== h && o.contains(h))).length,
      idle: document
        .getAnimations()
        .filter((a) => a.playState === 'running' && a.effect && a.effect.getComputedTiming && a.effect.getComputedTiming().iterations === Infinity)
        .map((a) => `${a.animationName || a.id || 'anim'}@${describe(a.effect.target)}`),
    };
  };
  window.addEventListener('emp:route-ready', (e) => {
    if (t0 !== null) return;
    t0 = e.detail && typeof e.detail.at === 'number' ? e.detail.at : performance.now();
    const since = performance.now() - t0;
    S.samples.push({ t: 0, nums: snapshot() });
    for (const at of [100, 300, 1000, windowMs - 50]) setTimeout(() => S.samples.push({ t: at, nums: snapshot() }), Math.max(0, at - since));
  });
};

function analyse(S, windowMs) {
  const first = S.samples.find((s) => s.t === 0) || { nums: {} };
  const later = S.samples.filter((s) => s.t > 0);
  const changed = new Set();
  const late = new Set();
  for (const s of later) {
    for (const [k, v] of Object.entries(s.nums)) {
      if (!(k in first.nums)) late.add(k);
      else if (first.nums[k] !== v) changed.add(k);
    }
  }
  // Count the outermost element only (a rolling number adds one span per digit).
  // Digits of a rolling number are sibling spans: collapse each set to distinct parents, then to outermost.
  const outermost = (set) => {
    const parents = new Set([...set].map((k) => k.split('/').slice(0, -1).join('/')));
    return [...parents].filter((k) => ![...parents].some((o) => o !== k && k.startsWith(o + '/'))).length;
  };
  const settle = Math.round(Math.max(S.lastMut, S.lastAnim));
  const continuous = S.lastMut > windowMs - 300;
  const tail = Object.entries(S.tail)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, n]) => `${k}×${n}`);
  return { settle, continuous, mutations: S.muts, idle: S.idle, changed: outermost(changed), late: outermost(late), rolling: S.rollingCount || 0, input: S.input, tail };
}

(async () => {
  const opts = parseArgs(process.argv);
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const results = [];
  for (const theme of opts.themes) {
    for (const route of opts.routes) {
      const runs = [];
      for (let i = 0; i < opts.runs; i++) {
        const ctxOpts = { ...opts };
        const { ctx, page, ready, errors } = await (async () => {
          // openRoute adds the ready collector; the settle recorder must be installed before navigation too.
          const pw = { newContext: async (o) => {
            const c = await browser.newContext(o);
            await c.addInitScript(SETTLE_INIT, opts.window);
            return c;
          } };
          return openRoute(pw, ctxOpts, route, theme);
        })();
        if (!ready) {
          runs.push({ ready: false, errors });
          await ctx.close();
          continue;
        }
        await page.waitForFunction(() => window.__empSettle && window.__empSettle.done, null, { timeout: opts.window + 15000, polling: 100 });
        const S = await page.evaluate(() => window.__empSettle);
        runs.push({ ready: true, readyAt: Math.round(ready.t), readyDetail: ready.detail, errors, ...analyse(S, opts.window) });
        await ctx.close();
      }
      const ok = runs.filter((r) => r.ready);
      results.push({
        route,
        theme,
        motion: opts.motion,
        runs,
        settle: median(ok.map((r) => r.settle)),
        continuous: ok.some((r) => r.continuous),
        idle: ok.length ? Math.max(...ok.map((r) => r.idle.length)) : null,
        changed: ok.length ? Math.max(...ok.map((r) => r.changed)) : null,
        late: ok.length ? Math.max(...ok.map((r) => r.late)) : null,
        rolling: ok.length ? Math.max(...ok.map((r) => r.rolling)) : null,
      });
    }
  }
  await browser.close();
  const rows = results.map((r) => ({
    route: r.route.length > 28 ? r.route.slice(0, 26) + '…' : r.route,
    theme: r.theme,
    'settle ms': r.settle === null ? 'no ready' : r.continuous ? `${r.settle}+ (live)` : r.settle,
    idle: r.idle,
    changed: r.changed,
    late: r.late,
    rolling: r.rolling,
    gate: r.settle === null ? 'fail' : !r.continuous && r.settle <= MUST && r.changed === 0 && r.rolling === 0 ? (r.settle <= TARGET ? 'pass' : 'pass (> target)') : 'fail',
  }));
  if (opts.out) fs.writeFileSync(opts.out, JSON.stringify({ when: new Date().toISOString(), opts, must: MUST, target: TARGET, results }, null, 2));
  if (opts.json) console.log(JSON.stringify(results, null, 2));
  console.log(table(rows, ['route', 'theme', 'settle ms', 'idle', 'changed', 'late', 'rolling', 'gate']));
  console.log(`median of ${opts.runs} run(s), window ${opts.window} ms, motion ${opts.motion} · gate: settle ≤ ${MUST} ms (target ≤ ${TARGET}), no number changes or rolls after route-ready`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
