// Sidebar (1.0 brief §2.1): the header (the workspace name in full, "+ New ▾", Hide), the sections, dragging a row to
// Favorites without the rows moving under the pointer, the visible Hide button, the edge peek's "Keep sidebar open",
// Ctrl+\, F6 in both states, and the hidden/shown state surviving restarts. Also guards the relaunch bugs where the
// docked sidebar came back hidden or off-screen (a slide started while the window was hidden; a stale "compact window"
// read before the window was shown): after every launch the sidebar must rest where its state says. Every launch
// runs with WebKit compositing ON, as users run it (the races only show with it on).
import { desktopSession, sleep, KEY } from '../lib/wd.mjs';
import { ui } from '../lib/ui.mjs';
import { waitBoot } from '../lib/flows.mjs';
import { centreOf, compositedApp, firstRun, focusedRegion, isClosed, isOpen, killApp, pointer, releaseActions, sectionText, setWindowSize, settleSidebar } from '../lib/shell.mjs';

export const name = 'shell-projects-sidebar';

const APP = process.env.ULTRANOTE_BIN || '/home/user/ultra-note/target/devurl/debug/emp-app';
const F6 = '';
/** Relaunches with the sidebar shown, each checked at rest (the compact-window race hit 1 to 4 launches in 6). */
const RELAUNCHES = Number(process.env.SHELL_RELAUNCHES || 4);
const rowSel = (section, title) => `aside.emp-sidebar [role=tree][aria-label="${section}"] [data-tree-row][aria-label="${title}"]`;
const rowTop = (s, css) => s.exec(`const e=document.querySelector(arguments[0]);return e?Math.round(e.getBoundingClientRect().top):null`, [css]);

async function f6Cycle(s, n) {
  await s.exec(`document.querySelector('.emp-content').focus()`);
  const seen = [];
  for (let i = 0; i < n; i++) {
    await s.keys(F6);
    await sleep(150);
    seen.push(await focusedRegion(s));
  }
  return seen.join(',');
}

export default async function run({ shots }) {
  const port = Number(process.env.E2E_PORT || 4700);
  const problems = [];
  const app = compositedApp(APP);
  const launch = async (dataHome, prefix) => {
    const s = await desktopSession({ app, port, nativePort: port + 1, dataHome });
    const u = ui(s, { shotsDir: shots, prefix: `${name}-${prefix}` });
    await waitBoot(s, u);
    return { s, u };
  };

  let { s, u } = await launch(undefined, '1');
  const home = s.dataHome;
  try {
    await firstRun(s, u);
    await u.waitText('Projects');
    let v = await settleSidebar(s, isOpen);
    if (!isOpen(v)) problems.push(`sidebar not open after first run: ${JSON.stringify(v)}`);
    if (!v?.hideBtn) problems.push('no visible "Hide sidebar" button in the sidebar header');

    // Header: the default workspace name shows in full; "+ New" reads as a menu (a caret) and opens one.
    const ws = await s.exec(`const n=document.querySelector('aside.emp-sidebar .emp-ws-button .name');return n?{text:n.textContent,cw:n.clientWidth,sw:n.scrollWidth}:null`);
    if (!ws || !/Alex/.test(ws.text) || ws.sw > ws.cw) problems.push(`the workspace name is cut off in the header: ${JSON.stringify(ws)}`);
    const newRow = await s.exec(`const b=document.querySelector('aside.emp-sidebar .emp-sb-new');return b?{text:b.innerText.trim(),caret:!!b.querySelector('.caret'),popup:b.getAttribute('aria-haspopup')}:null`);
    if (!newRow || newRow.text !== 'New' || !newRow.caret || !newRow.popup) problems.push(`"+ New" is not a menu button with a caret: ${JSON.stringify(newRow)}`);

    // Sections, top to bottom, each with content or its one quiet line; no Templates / Import rows in the body.
    const order = await s.exec(`return [...document.querySelectorAll('aside.emp-sidebar section[aria-label]')].map(e=>e.getAttribute('aria-label'))`);
    const want = ['Projects', 'Documents', 'Spreadsheets', 'Apps'];
    if (JSON.stringify(order.filter((t) => want.includes(t))) !== JSON.stringify(want)) problems.push(`sections out of order: ${JSON.stringify(order)}`);
    if (order.includes('Favorites')) problems.push('Favorites shows while there are no favourites');
    const docs = await sectionText(s, 'Documents');
    if (!docs?.includes('Getting Started')) problems.push(`Documents does not list Getting Started: ${JSON.stringify(docs)}`);
    // Empty sections say how to add one and what goes there.
    const projects = await sectionText(s, 'Projects');
    if (!projects || !/Add a project for related work/.test(projects)) problems.push(`empty Projects has no explanation line: ${JSON.stringify(projects)}`);
    const sheets = await sectionText(s, 'Spreadsheets');
    if (!sheets || !/Add a spreadsheet for budgets/.test(sheets)) problems.push(`empty Spreadsheets has no explanation line: ${JSON.stringify(sheets)}`);
    const apps = await sectionText(s, 'Apps');
    if (!apps?.includes('Markets')) problems.push(`Apps does not list Markets: ${JSON.stringify(apps)}`);
    const body = await s.exec(`return document.querySelector('aside.emp-sidebar .emp-sb-body').innerText`);
    if (/\bTemplates\b|\bImport\b/.test(body)) problems.push('Templates / Import still listed in the sidebar body');
    const footer = await s.exec(`return document.querySelector('aside.emp-sidebar footer').innerText`);
    if (!/Trash/.test(footer) || !/Settings/.test(footer) || !/Not encrypted|Encrypted/.test(footer)) problems.push(`footer is missing Trash, Settings or the lock status: ${JSON.stringify(footer)}`);
    await u.shot('open');

    // Drag a row to Favorites (there are none yet): the drop zone lays over the rows above the sections, so the row
    // under the pointer stays where it was; dropping there adds the favourite.
    const gs = rowSel('Documents', 'Getting Started');
    const before = await rowTop(s, gs);
    const from = await centreOf(s, gs);
    if (!from) problems.push('no Getting Started row to drag');
    else {
      await pointer(s, port, [
        { type: 'pointerMove', duration: 0, x: from.x, y: from.y, origin: 'viewport' },
        { type: 'pointerDown', button: 0 },
        { type: 'pointerMove', duration: 80, x: from.x + 4, y: from.y + 8, origin: 'viewport' },
        { type: 'pointerMove', duration: 80, x: from.x + 8, y: from.y + 14, origin: 'viewport' },
        { type: 'pause', duration: 200 },
      ]);
      const during = await s.exec(`return {zone:!!document.querySelector('aside.emp-sidebar .emp-sb-favdrop'),top:(()=>{const e=document.querySelector(arguments[0]);return e?Math.round(e.getBoundingClientRect().top):null})()}`, [gs]);
      if (!during.zone) problems.push('dragging a row shows no Favorites drop zone');
      if (during.top !== before) problems.push(`starting a drag moved the rows: Getting Started went from y=${before} to y=${during.top}`);
      await u.shot('drag-favorites');
      const zone = await centreOf(s, 'aside.emp-sidebar .emp-sb-favdrop');
      if (zone)
        await pointer(s, port, [
          { type: 'pointerMove', duration: 120, x: zone.x, y: zone.y, origin: 'viewport' },
          { type: 'pause', duration: 200 },
          { type: 'pointerUp', button: 0 },
        ]);
      await releaseActions(s, port);
      await sleep(600);
      const favs = await sectionText(s, 'Favorites');
      if (!favs?.includes('Getting Started')) problems.push(`dropping on the Favorites zone didn't add the favourite: ${JSON.stringify(favs)}`);
    }

    // F6 with the sidebar open: sidebar → top bar → content.
    const open6 = await f6Cycle(s, 3);
    if (open6 !== 'sidebar,topbar,content') problems.push(`F6 (sidebar open) went ${open6}`);

    // Hide with the header button.
    await u.clickSel('aside.emp-sidebar [aria-label="Hide sidebar"]');
    v = await settleSidebar(s, isClosed);
    if (!isClosed(v)) problems.push(`Hide sidebar did not hide it: ${JSON.stringify(v)}`);
    await u.shot('hidden');

    // F6 with the sidebar hidden: the top bar and the content only.
    const hidden6 = await f6Cycle(s, 3);
    if (hidden6 !== 'topbar,content,topbar') problems.push(`F6 (sidebar hidden) went ${hidden6}`);

    // Hovering the left edge peeks the sidebar over the page; its "Keep sidebar open" docks it again.
    await pointer(s, port, [
      { type: 'pointerMove', duration: 0, x: 400, y: 400, origin: 'viewport' },
      { type: 'pointerMove', duration: 120, x: 3, y: 400, origin: 'viewport' },
      { type: 'pause', duration: 600 },
    ]);
    const peek = await s.exec(`return document.querySelector('aside.emp-sidebar').dataset.state`);
    if (peek !== 'peek') problems.push(`hovering the left edge did not peek the sidebar (state ${peek})`);
    else {
      await s.exec(`document.querySelector('aside.emp-sidebar [aria-label="Keep sidebar open"]').click()`);
      v = await settleSidebar(s, isOpen);
      if (!isOpen(v)) problems.push(`"Keep sidebar open" did not dock the sidebar: ${JSON.stringify(v)}`);
      await pointer(s, port, [{ type: 'pointerMove', duration: 0, x: 700, y: 400, origin: 'viewport' }]);
      await u.clickSel('aside.emp-sidebar [aria-label="Hide sidebar"]');
      v = await settleSidebar(s, isClosed);
      if (!isClosed(v)) problems.push(`Hide sidebar (after docking from the peek) did not hide it: ${JSON.stringify(v)}`);
    }

    // Ctrl+\ shows it, Ctrl+\ hides it again.
    await s.exec(`document.querySelector('.emp-content').focus()`);
    await s.chord([KEY.ctrl], '\\');
    v = await settleSidebar(s, isOpen);
    if (!isOpen(v)) problems.push(`Ctrl+\\ did not show the sidebar: ${JSON.stringify(v)}`);
    await s.chord([KEY.ctrl], '\\');
    v = await settleSidebar(s, isClosed);
    if (!isClosed(v)) problems.push(`Ctrl+\\ did not hide the sidebar: ${JSON.stringify(v)}`);
    await sleep(800); // the vault copy of the preference is saved after a short debounce
    problems.push(...(await u.errors()).map((e) => `console: ${e}`));
  } finally {
    await s.end();
    killApp(home);
  }

  // Restart: still hidden, nothing blank where it was.
  ({ s, u } = await launch(home, '2'));
  try {
    await u.waitText('Home', 30000);
    let v = await settleSidebar(s, isClosed, 6000);
    if (!isClosed(v)) problems.push(`after a restart the hidden sidebar is not hidden: ${JSON.stringify(v)}`);
    await u.shot('restart-hidden');
    if (v?.show) {
      await u.clickSel('[aria-label="Show sidebar"]');
      v = await settleSidebar(s, isOpen);
      if (!isOpen(v)) problems.push(`Show sidebar did not show it: ${JSON.stringify(v)}`);
    } else {
      await s.exec(`document.querySelector('aside.emp-sidebar [aria-label="Hide sidebar"]')?.click()`);
      await sleep(400);
      await s.exec(`document.querySelector('[aria-label="Show sidebar"]')?.click()`);
    }
    await sleep(800);
    problems.push(...(await u.errors()).map((e) => `console: ${e}`));
  } finally {
    await s.end();
    killApp(home);
  }

  // Restart again, several times: shown, at rest at the left edge every time (the relaunch bugs left it off-screen
  // beside a blank column, or hidden behind a "Show sidebar" that only floated a peek).
  for (let i = 0; i < RELAUNCHES; i++) {
    ({ s, u } = await launch(home, `3-${i + 1}`));
    try {
      await u.waitText('Projects', 30000);
      const v = await settleSidebar(s, isOpen, 6000);
      if (!isOpen(v)) {
        const vp = await s.exec(`return {w:innerWidth,compact:matchMedia('(max-width: 899px)').matches,stored:localStorage.getItem('emp.shell.sidebar')}`);
        problems.push(`relaunch ${i + 1}: the shown sidebar is not at rest on screen: ${JSON.stringify(v)} ${JSON.stringify(vp)}`);
      }
      if (i === 0) await u.shot('restart-open');
      if (i === RELAUNCHES - 1) {
        // A compact window (< 900px): the sidebar is an overlay; Show floats it and Escape closes it. Widened again,
        // it docks where it was, and the saved preference never changed.
        await setWindowSize(s, port, 820, 820);
        let c = await settleSidebar(s, isClosed, 4000);
        if (!isClosed(c)) problems.push(`in a compact window the sidebar is not an overlay: ${JSON.stringify(c)}`);
        await u.clickSel('[aria-label="Show sidebar"]');
        await sleep(500);
        const st = await s.exec(`const a=document.querySelector('aside.emp-sidebar');return {state:a.dataset.state,floating:a.hasAttribute('data-floating')}`);
        if (st.state !== 'peek' || !st.floating) problems.push(`in a compact window "Show sidebar" did not float it: ${JSON.stringify(st)}`);
        await s.keys(KEY.escape);
        await sleep(500);
        await setWindowSize(s, port, 1280, 820);
        c = await settleSidebar(s, isOpen, 4000);
        if (!isOpen(c)) problems.push(`widened again, the sidebar did not dock: ${JSON.stringify(c)}`);
        const stored = await s.exec(`return JSON.parse(localStorage.getItem('emp.shell.sidebar')||'{}').collapsed`);
        if (stored !== false) problems.push(`the compact window changed the saved preference (collapsed: ${stored})`);
      }
      problems.push(...(await u.errors()).map((e) => `console: ${e}`));
    } finally {
      await s.end();
      killApp(home);
    }
  }
  return problems;
}
