const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const routes = JSON.parse(fs.readFileSync(path.join(__dirname, 'routes.json'), 'utf8'));
const themes = (process.env.THEMES || 'light,dark').split(',');
const OUT = process.env.OUT || path.join(__dirname, '..', 'smoke');
const SEED = process.env.SEED || 'demo';
fs.mkdirSync(OUT, { recursive: true });
const EMOJI = /\p{Extended_Pictographic}/u;
(async () => {
  const b = await chromium.launch();
  const report = [];
  for (const theme of themes) {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme === 'light' ? 'light' : 'dark' });
    await ctx.addInitScript((t) => { try { localStorage.setItem('emp.boot', JSON.stringify({ theme: t, accent: 'graphite', motion: 'system', density: 'comfortable', textSize: 'm' })); } catch {} }, theme);
    const p = await ctx.newPage();
    let errs = [], warns = [];
    p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 300)); else if (m.type() === 'warning') warns.push(m.text().slice(0, 200)); });
    await p.goto(`http://localhost:${process.env.PORT || 1420}/?seed=${SEED}&freeze=2026-11-26T15:30:00Z#/home`, { waitUntil: 'networkidle' });
    await p.waitForTimeout(1500);
    for (const r of routes) {
      errs = []; warns = [];
      await p.evaluate((h) => { location.hash = h; }, '#' + r);
      await p.waitForTimeout(+(process.env.WAIT || 1400));
      const info = await p.evaluate((src) => {
        const EM = new RegExp(src, 'u');
        const de = document.documentElement;
        const docOverflowX = Math.max(de.scrollWidth, document.body.scrollWidth) - innerWidth;
        const bodyScrollY = Math.max(de.scrollHeight, document.body.scrollHeight) - innerHeight;
        const txt = document.body.innerText;
        const errBoundary = /Something went wrong|Unexpected error|crashed|Couldn.t load this|failed to load/i.test(txt);
        const notFound = /not found|doesn.t exist|no longer exists|isn.t installed/i.test(txt);
        const emoji = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n; while ((n = walker.nextNode())) {
          const s = n.nodeValue.replace(/[©™®]/g, '');
          if (EM.test(s)) { const el = n.parentElement; const cs = el && getComputedStyle(el); if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) continue; emoji.push(s.trim().slice(0, 60) + ' <' + (el ? el.tagName.toLowerCase() + '.' + (typeof el.className === 'string' ? el.className.split(' ')[0] : '') : '') + '>'); }
        }
        for (const el of document.querySelectorAll('[aria-label],[title],[alt],[placeholder]')) {
          for (const a of ['aria-label', 'title', 'alt', 'placeholder']) { const v = (el.getAttribute(a) || '').replace(/[©™®]/g, ''); if (EM.test(v)) emoji.push('@' + a + '=' + v.slice(0, 60)); }
        }
        for (const el of document.querySelectorAll('body *')) {
          for (const ps of ['::before', '::after']) { const c = getComputedStyle(el, ps).content; if (c && c !== 'none' && c !== 'normal' && EM.test(c.replace(/[©™®]/g, ''))) emoji.push(ps + ' ' + c.slice(0, 20) + ' <' + el.tagName.toLowerCase() + '>'); }
        }
        const h1 = (document.querySelector('main h1, h1') || {}).innerText || '';
        return { docOverflowX, bodyScrollY, errBoundary, notFound, emoji: [...new Set(emoji)].slice(0, 8), h1: h1.slice(0, 50), title: document.title };
      }, EMOJI.source);
      const name = theme + '_' + r.replace(/\//g, '_').replace(/:/g, '-').slice(0, 60);
      await p.screenshot({ path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 55 });
      report.push({ theme, r, errs: [...new Set(errs)].slice(0, 6), warns: [...new Set(warns)].slice(0, 3), ...info });
    }
    await ctx.close();
  }
  fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 1));
  let bad = 0;
  for (const x of report) {
    if (x.errs.length || x.docOverflowX > 0 || x.errBoundary || x.notFound || x.emoji.length) { bad++; console.log(JSON.stringify(x)); }
  }
  console.log('done', report.length, 'flagged', bad);
  await b.close();
})();
