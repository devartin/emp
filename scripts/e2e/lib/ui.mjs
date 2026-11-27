// UI helpers on top of a WebDriver session: find by visible text, wait for text, capture errors, screenshots.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sleep } from './wd.mjs';

const CLICKABLE = 'button,[role=button],[role=radio],[role=checkbox],[role=switch],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=tab],[role=option],[role=treeitem],[role=link],a,label,summary';

/** Normalise text the way the app writes it (curly apostrophes, nbsp, collapsed whitespace). */
const NORM = `const norm=s=>(s||'').replace(/[\\u2018\\u2019]/g,"'").replace(/[\\u201C\\u201D]/g,'"').replace(/\\u00a0/g,' ').replace(/\\s+/g,' ').trim();`;

export function ui(s, { shotsDir = process.env.E2E_SHOTS || 'e2e-shots', prefix = 'shot' } = {}) {
  mkdirSync(shotsDir, { recursive: true });
  const api = {
    /** Visible text of the main region (or the whole body). */
    text: (sel = 'body') => s.exec(`const e=document.querySelector(arguments[0])||document.body;return e.innerText`, [sel]),
    has: (needle) => s.exec(`${NORM}return norm(document.body.innerText).includes(norm(arguments[0]))`, [needle]),
    /** Wait until `needle` (string or /regex/ source via {re}) appears in the page text. */
    waitText: async (needle, ms = 15000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (await api.has(needle)) return true;
        await sleep(200);
      }
      throw new Error(`timed out waiting for text: ${needle}`);
    },
    waitGone: async (needle, ms = 15000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (!(await api.has(needle))) return true;
        await sleep(200);
      }
      throw new Error(`timed out waiting for text to disappear: ${needle}`);
    },
    /**
     * Click the first visible clickable element whose text (or aria-label/title) matches `label`: exact, then prefix,
     * then substring. Retries until `ms` so it survives enter animations. `within` scopes the search to a selector.
     */
    click: async (label, { within = 'body', ms = 8000, selector = CLICKABLE } = {}) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const ok = await s.exec(
          `${NORM}const want=norm(arguments[0]);const root=document.querySelector(arguments[1])||document.body;` +
            `const vis=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'};` +
            `const els=[...root.querySelectorAll(arguments[2])].filter(vis);const t=e=>norm(e.textContent);const a=e=>norm(e.getAttribute('aria-label')||e.getAttribute('title')||'');` +
            `const el=els.find(e=>t(e)===want)||els.find(e=>a(e)===want)||els.find(e=>t(e).startsWith(want))||els.find(e=>a(e).startsWith(want))||els.find(e=>t(e).includes(want));` +
            `if(!el)return false;el.scrollIntoView({block:'center'});el.click();return true;`,
          [label, within, selector],
        );
        if (ok) return true;
        await sleep(200);
      }
      throw new Error(`could not find clickable "${label}" within ${within}`);
    },
    /** Click via CSS selector (first visible match). */
    clickSel: async (css, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const ok = await s.exec(`const e=[...document.querySelectorAll(arguments[0])].find(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0});if(!e)return false;e.scrollIntoView({block:'center'});e.click();return true`, [css]);
        if (ok) return true;
        await sleep(200);
      }
      throw new Error(`no visible element for ${css}`);
    },
    /** Focus an input by label/placeholder/aria-label and type into it (clears first). */
    fill: async (label, value, { ms = 8000 } = {}) => {
      const t0 = Date.now();
      let id = null;
      while (!id && Date.now() - t0 < ms) {
        id = await s.exec(
          `${NORM}const want=norm(arguments[0]);const vis=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0};` +
            `const fields=[...document.querySelectorAll('input,textarea,[contenteditable=true]')].filter(vis);` +
            `const lab=e=>{const id=e.id&&document.querySelector('label[for="'+CSS.escape(e.id)+'"]');return norm((id&&id.textContent)||(e.closest('label')&&e.closest('label').textContent)||'')};` +
            `const el=fields.find(e=>norm(e.getAttribute('aria-label'))===want)||fields.find(e=>norm(e.getAttribute('placeholder'))===want)||fields.find(e=>lab(e)===want)||fields.find(e=>norm(e.getAttribute('placeholder')).includes(want)||norm(e.getAttribute('aria-label')).includes(want)||lab(e).includes(want));` +
            `if(!el)return null;el.setAttribute('data-e2e-target','1');return '1';`,
          [label],
        );
        if (!id) await sleep(200);
      }
      if (!id) throw new Error(`no field labelled "${label}"`);
      const e = await s.find('[data-e2e-target="1"]');
      await s.exec(`document.querySelector('[data-e2e-target="1"]').removeAttribute('data-e2e-target')`);
      await s.click(e);
      await s.clear(e).catch(() => undefined);
      await s.type(e, value);
      return e;
    },
    /** Install error capture (window errors, rejections, console.error). Call after every full reload. */
    hookErrors: () =>
      s.exec(
        `if(!window.__e2eErrs){window.__e2eErrs=[];const push=m=>window.__e2eErrs.push(String(m).slice(0,400));` +
          `addEventListener('error',e=>push('error: '+(e.message||e.error)));addEventListener('unhandledrejection',e=>push('rejection: '+(e.reason&&e.reason.message||e.reason)));` +
          `const ce=console.error;console.error=(...a)=>{push('console.error: '+a.map(x=>x&&x.stack?x.stack:String(x)).join(' '));ce.apply(console,a)}}`,
      ),
    errors: () => s.exec('return window.__e2eErrs||[]'),
    clearErrors: () => s.exec('window.__e2eErrs=[]'),
    /** True when a route error boundary is showing. */
    crashed: () => s.exec(`return /ran into a problem|couldn.t open your workspace/i.test(document.body.innerText)`),
    shot: (name) => s.shot(join(shotsDir, `${prefix}-${name}.png`)),
    route: (hash) => s.exec(`location.hash=arguments[0]`, [hash]),
    hash: () => s.exec('return location.hash'),
  };
  return api;
}
