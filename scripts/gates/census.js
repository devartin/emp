#!/usr/bin/env node
/**
 * Census gate (PROGRAMME-v3 K6, local phase-exit gate — not CI). For each route × theme, after `emp:route-ready`
 * plus a settle wait, count on the rendered page:
 *   shadows    elements (incl. ::before/::after) whose computed box-shadow is not none
 *   gradients  elements (incl. pseudos) whose background-image contains a gradient
 *   radii      distinct non-zero border-radius values
 *   weights    distinct font weights on elements that render text
 *   sizes      distinct font sizes on elements that render text
 *   nested     bordered or filled boxes (≥ 40×24) inside another bordered box, within the route
 *   blur       elements with a backdrop-filter at rest
 * Counts are for the whole window (sidebar included) and, in brackets, the route pane only.
 * v3 targets for Home and Money HQ: shadows ≤ 12, gradients ≤ 1, radii ≤ 5, weights ≤ 4 (Flow: nested = 0 on Home).
 *
 *   NODE_PATH=/opt/node-tools/node_modules node scripts/gates/census.js --port 1702 [--routes home,money] \
 *     [--themes light,dark] [--reduced-motion] [--out census.json]
 */
'use strict';
const fs = require('fs');
const { parseArgs, loadPlaywright, openRoute, table } = require('./lib');

const TARGETS = { shadows: 12, gradients: 1, radii: 5, weights: 4 };

function measure() {
  const route = document.querySelector('.emp-route') || document.body;
  const all = [...document.body.querySelectorAll('*')];
  const visible = (el, cs) => {
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight * 3;
  };
  const alpha = (c) => {
    if (!c || c === 'transparent') return 0;
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return 1;
    const p = m[1].split(/[\s,/]+/).filter(Boolean);
    return p.length >= 4 ? parseFloat(p[3]) : 1;
  };
  const ring = (bs) => bs && bs !== 'none' && bs.split(/,(?![^()]*\))/).some((s) => /(^|\s)0px 0px 0px [0-9.]+px/.test(s.replace(/rgba?\([^)]*\)|#[0-9a-f]+/gi, '').trim()) && !/0px 0px 0px 0px/.test(s));
  const bordered = (cs) => {
    let sides = 0;
    for (const s of ['Top', 'Right', 'Bottom', 'Left']) if (parseFloat(cs[`border${s}Width`]) >= 0.5 && cs[`border${s}Style`] !== 'none' && alpha(cs[`border${s}Color`]) > 0.02) sides++;
    return sides >= 3 || ring(cs.boxShadow);
  };
  const filled = (cs) => alpha(cs.backgroundColor) > 0.02 || (cs.backgroundImage && cs.backgroundImage !== 'none');
  const tally = { shadows: 0, gradients: 0, blur: 0, nested: 0 };
  const inRoute = { shadows: 0, gradients: 0, blur: 0 };
  const radii = new Set();
  const radiiRoute = new Set();
  const weights = new Set();
  const weightsRoute = new Set();
  const sizes = new Set();
  const nestedSamples = [];
  const boxes = new Set();
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (!visible(el, cs)) continue;
    const isR = route.contains(el);
    const parts = [cs, getComputedStyle(el, '::before'), getComputedStyle(el, '::after')];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (i > 0 && (p.content === 'none' || p.content === 'normal')) continue;
      if (p.boxShadow && p.boxShadow !== 'none') {
        tally.shadows++;
        if (isR) inRoute.shadows++;
      }
      if (/gradient\(/.test(p.backgroundImage || '')) {
        tally.gradients++;
        if (isR) inRoute.gradients++;
      }
      const bf = p.backdropFilter || p.webkitBackdropFilter;
      if (bf && bf !== 'none') {
        tally.blur++;
        if (isR) inRoute.blur++;
      }
    }
    const rad = cs.borderRadius;
    if (rad && !/^0px$/.test(rad) && (bordered(cs) || filled(cs) || cs.boxShadow !== 'none')) {
      radii.add(rad);
      if (isR) radiiRoute.add(rad);
    }
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (hasText) {
      weights.add(cs.fontWeight);
      sizes.add(cs.fontSize);
      if (isR) weightsRoute.add(cs.fontWeight);
    }
    if (isR) {
      const r = el.getBoundingClientRect();
      if ((bordered(cs) || filled(cs)) && r.width >= 40 && r.height >= 24) boxes.add(el);
    }
  }
  for (const el of boxes) {
    for (let a = el.parentElement; a && a !== route.parentElement; a = a.parentElement) {
      if (boxes.has(a) && bordered(getComputedStyle(a))) {
        tally.nested++;
        if (nestedSamples.length < 8) nestedSamples.push(`${(a.className && a.className.baseVal === undefined ? String(a.className) : a.tagName).slice(0, 40)} > ${(el.className && el.className.baseVal === undefined ? String(el.className) : el.tagName).slice(0, 40)}`);
        break;
      }
    }
  }
  return {
    shadows: tally.shadows,
    gradients: tally.gradients,
    radii: radii.size,
    weights: weights.size,
    sizes: sizes.size,
    nested: tally.nested,
    blur: tally.blur,
    pane: { shadows: inRoute.shadows, gradients: inRoute.gradients, radii: radiiRoute.size, weights: weightsRoute.size, blur: inRoute.blur },
    radiiValues: [...radii].sort(),
    weightValues: [...weights].sort(),
    nestedSamples,
  };
}

(async () => {
  const opts = parseArgs(process.argv);
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const results = [];
  for (const theme of opts.themes) {
    for (const route of opts.routes) {
      const { ctx, page, ready, errors } = await openRoute(browser, opts, route, theme);
      await page.waitForTimeout(1500); // let arrival motion finish: census measures the resting state
      const m = await page.evaluate(measure);
      results.push({ route, theme, ready: !!ready, readyMs: ready ? Math.round(ready.t) : null, errors: errors.slice(0, 3), ...m });
      await ctx.close();
    }
  }
  await browser.close();
  const rows = results.map((r) => ({
    route: r.route.length > 28 ? r.route.slice(0, 26) + '…' : r.route,
    theme: r.theme,
    shadows: `${r.shadows} (${r.pane.shadows})`,
    gradients: `${r.gradients} (${r.pane.gradients})`,
    radii: `${r.radii} (${r.pane.radii})`,
    weights: `${r.weights} (${r.pane.weights})`,
    sizes: r.sizes,
    nested: r.nested,
    blur: `${r.blur} (${r.pane.blur})`,
    gate: Object.entries(TARGETS).every(([k, max]) => r[k] <= max) ? 'pass' : 'fail',
  }));
  if (opts.out) fs.writeFileSync(opts.out, JSON.stringify({ when: new Date().toISOString(), opts, targets: TARGETS, results }, null, 2));
  if (opts.json) console.log(JSON.stringify(results, null, 2));
  console.log(table(rows, ['route', 'theme', 'shadows', 'gradients', 'radii', 'weights', 'sizes', 'nested', 'blur', 'gate']));
  console.log(`window (route pane) · targets: shadows ≤ ${TARGETS.shadows}, gradients ≤ ${TARGETS.gradients}, radii ≤ ${TARGETS.radii}, weights ≤ ${TARGETS.weights}`);
  const notReady = results.filter((r) => !r.ready);
  if (notReady.length) console.log(`no emp:route-ready on: ${notReady.map((r) => r.route + '/' + r.theme).join(', ')}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
