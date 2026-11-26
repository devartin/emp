/**
 * Core seed: the "Personal" workspace, the Getting Started tour (every block type), a journal with daily notes,
 * projects, reading notes, a trip plan, a user template, favourites, recents, version history and logs.
 *
 * Other seeds can append to the tour via `ctx.seedRefs`:
 *   'core.page.gettingStarted' · 'core.page.blocks' ("Writing in EMP", ends with a "Live blocks" section)
 *   'core.page.journal' · 'core.page.projects' · 'core.page.money'
 * and append blocks with `appendBlocks(ctx, pageId, blocks)` from this module.
 */
import { generateNKeysBetween } from '@/lib/fractional-index';
import type { Icon, TipTapDoc, TipTapNode } from '../../types';
import type { MockCtx, PageRecord, WorkspaceRecord } from '../ctx';
import { b, makeDoc, t, type Inline } from '../lib/doc';
import { dailyTitle } from '../lib/templates';
import { patchVaultSettings } from '../lib/settings';
import { logNetwork } from '../commands/network';
import { localDay } from '../clock';

export const order = 0;

const DAY = 86_400_000;
const emoji = (v: string): Icon => ({ t: 'emoji', v });

// ───────────────────────────────────────────────────────────────────────────── helpers

export function appendBlocks(ctx: MockCtx, pageId: string, blocks: TipTapNode[]): void {
  const rec = ctx.docs.get(pageId);
  const doc: TipTapDoc = rec ? structuredClone(rec.doc) : makeDoc([]);
  const group = doc.content.find((n) => n.type === 'blockGroup');
  if (group) group.content = [...(group.content ?? []), ...blocks];
  ctx.docs.save(pageId, 'page', doc);
}

const dayIso = localDay;

function stackSvg(): string {
  // Three opaque isometric slabs (the app icon's stack), lit from the top left.
  const slab = (y: number, top: string, left: string, right: string, stroke: string) => {
    const t = `600,${y - 92} 784,${y} 600,${y + 92} 416,${y}`;
    const l = `416,${y} 600,${y + 92} 600,${y + 118} 416,${y + 26}`;
    const r = `600,${y + 92} 784,${y} 784,${y + 26} 600,${y + 118}`;
    return `<polygon points="${l}" fill="${left}"/><polygon points="${r}" fill="${right}"/><polygon points="${t}" fill="${top}" stroke="${stroke}" stroke-width="1.2" stroke-linejoin="round"/>`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 560" width="1200" height="560">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1b1b20"/><stop offset="1" stop-color="#0c0c0f"/></linearGradient>
<radialGradient id="glow" cx="0.5" cy="0.45" r="0.5"><stop offset="0" stop-color="#9a9aff" stop-opacity="0.22"/><stop offset="1" stop-color="#9a9aff" stop-opacity="0"/></radialGradient>
<linearGradient id="t1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#dcdcf5"/></linearGradient>
<linearGradient id="t2" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8c8c96"/><stop offset="1" stop-color="#6a6a74"/></linearGradient>
<linearGradient id="t3" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4a4a52"/><stop offset="1" stop-color="#36363c"/></linearGradient>
<pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="rgba(255,255,255,0.05)"/></pattern>
</defs>
<rect width="1200" height="560" rx="28" fill="url(#bg)"/>
<rect width="1200" height="560" rx="28" fill="url(#dots)"/>
<ellipse cx="600" cy="250" rx="440" ry="240" fill="url(#glow)"/>
<ellipse cx="600" cy="452" rx="250" ry="30" fill="rgba(0,0,0,0.55)"/>
${slab(352, 'url(#t3)', '#2a2a2f', '#1f1f23', 'rgba(255,255,255,0.10)')}
${slab(276, 'url(#t2)', '#55555d', '#424249', 'rgba(255,255,255,0.18)')}
${slab(200, 'url(#t1)', '#b9b9cc', '#9d9db2', 'rgba(255,255,255,0.9)')}
</svg>`;
}

function azulejoSvg(): string {
  const tiles: string[] = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 12; x++) {
      const cx = x * 120 + 60;
      const cy = y * 120 + 60;
      tiles.push(
        `<g transform="translate(${cx} ${cy})"><rect x="-58" y="-58" width="116" height="116" rx="4" fill="#f6f4ee"/>` +
          `<path d="M0,-46 C18,-24 24,-18 46,0 C24,18 18,24 0,46 C-18,24 -24,18 -46,0 C-24,-18 -18,-24 0,-46Z" fill="#1d4e89"/>` +
          `<circle r="13" fill="#f6f4ee"/><circle r="6" fill="#2f6fb8"/>` +
          `<path d="M-58,-58 L-36,-58 A22,22 0 0 1 -58,-36Z M58,-58 L58,-36 A22,22 0 0 1 36,-58Z M58,58 L36,58 A22,22 0 0 1 58,36Z M-58,58 L-58,36 A22,22 0 0 1 -36,58Z" fill="#2f6fb8"/></g>`,
      );
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 600" width="1440" height="600"><rect width="1440" height="600" fill="#e9e4d8"/>${tiles.join('')}</svg>`;
}

const QUICK_REFERENCE = `# Ultra Note quick reference

## Everyday
- ⌘K — command palette · ⌘P — quick find · ⌘N — new page
- ⌘⌥D — today's daily note · ⌘[ / ⌘] — back / forward
- ⌘⇧H — hide numbers · ⌘⇧L — lock now · ⌘⇧D — light/dark

## Writing
- Type / for any block · [[ to link a page · @ to mention a page or a date
- # ## ### headings · - bullets · 1. numbers · [] to-dos · > toggles · " quotes
- ⌘⇧↑ / ⌘⇧↓ move a block with its children · Esc selects the block
`;

// ───────────────────────────────────────────────────────────────────────────── workspace + tour

interface TourIds {
  workspaceId: string;
  gettingStarted: string;
  blocks: string;
}

function createWorkspace(ctx: MockCtx, name: string): WorkspaceRecord {
  const now = ctx.clock.now();
  const ws: WorkspaceRecord = {
    id: ctx.id(),
    sortKey: ctx.keyBetween(null, null),
    name,
    icon: { t: 'lucide', v: 'layers', color: 'accent' },
    favorites: [],
    recents: [],
    defaults: { font: 'sans', fullWidth: false, smallText: false },
    createdAt: now,
    updatedAt: now,
    rev: 1,
  };
  ctx.db.table<WorkspaceRecord>('workspaces').insert(ws);
  return ws;
}

const GS_ITEMS: { key: string; content: Inline[] }[] = [
  { key: 'create_page', content: [t.bold('Create a page'), ' — press ', t.code('⌘N'), ' or the + next to Pages.'] },
  { key: 'try_slash', content: [t.bold('Try /'), ' — type ', t.code('/'), ' on an empty line to add any block.'] },
  { key: 'open_palette', content: [t.bold('Open ⌘K'), ' — search everything and run any command.'] },
  { key: 'add_transaction', content: [t.bold('Add a transaction'), ' in Money HQ, or import a bank statement.'] },
  { key: 'hide_numbers', content: [t.bold('Try ⌘⇧H'), ' — hide every number on screen when someone is looking.'] },
  { key: 'lock', content: [t.bold('Lock with ⌘⇧L'), ' — encrypted workspaces lock instantly.'] },
  { key: 'templates', content: [t.bold('Explore Templates'), ' — meeting notes, weekly reviews, trip plans and more.'] },
];

/** Creates the workspace and the Getting Started tour. Used by vault_create (onboarding) and the demo seed. */
export function createStarterWorkspace(ctx: MockCtx, opts: { name?: string; demo?: boolean } = {}): TourIds {
  const now = ctx.clock.now();
  const ws = createWorkspace(ctx, opts.name ?? 'Personal');
  const created = (daysAgo: number) => now - daysAgo * DAY;

  // Assets used by the tour.
  const stack = ctx.assets.create({
    workspaceId: ws.id,
    name: 'emp-stack.svg',
    mime: 'image/svg+xml',
    blob: new Blob([stackSvg()], { type: 'image/svg+xml' }),
    width: 1200,
    height: 560,
    source: 'builtin',
  });
  const reference = ctx.assets.create({
    workspaceId: ws.id,
    name: 'Ultra Note quick reference.md',
    mime: 'text/markdown',
    blob: new Blob([QUICK_REFERENCE], { type: 'text/markdown' }),
    source: 'builtin',
  });

  const gs = ctx.pages.create({
    workspaceId: ws.id,
    parentId: null,
    kind: 'doc',
    title: 'Getting Started',
    icon: emoji('👋'),
    cover: { t: 'gradient', v: 'aurora' },
    createdAt: created(opts.demo ? 58 : 0),
    updatedAt: created(opts.demo ? 0.2 : 0),
    silent: true,
  });

  const writing = ctx.pages.create({
    workspaceId: ws.id,
    parentId: gs.id,
    kind: 'doc',
    title: 'Writing in Ultra Note',
    icon: emoji('✍️'),
    createdAt: created(opts.demo ? 58 : 0),
    updatedAt: created(opts.demo ? 3 : 0),
    silent: true,
  });
  const shortcuts = ctx.pages.create({
    workspaceId: ws.id,
    parentId: gs.id,
    kind: 'doc',
    title: 'Keyboard shortcuts',
    icon: emoji('⌨️'),
    createdAt: created(opts.demo ? 58 : 0),
    updatedAt: created(opts.demo ? 12 : 0),
    silent: true,
  });
  const privacy = ctx.pages.create({
    workspaceId: ws.id,
    parentId: gs.id,
    kind: 'doc',
    title: 'Privacy & encryption',
    icon: emoji('🔒'),
    createdAt: created(opts.demo ? 58 : 0),
    updatedAt: created(opts.demo ? 20 : 0),
    silent: true,
  });
  const money = ctx.pages.create({
    workspaceId: ws.id,
    parentId: gs.id,
    kind: 'doc',
    title: 'Money & life apps',
    icon: emoji('🧭'),
    createdAt: created(opts.demo ? 58 : 0),
    updatedAt: created(opts.demo ? 9 : 0),
    silent: true,
  });

  // ── Getting Started
  const itemIds: Record<string, string> = {};
  const todos = GS_ITEMS.map((item) => {
    const id = ctx.blockId();
    itemIds[item.key] = id;
    return b.todo(item.content, false, { id });
  });
  ctx.docs.save(
    gs.id,
    'page',
    makeDoc([
      b.p([
        'Ultra Note keeps your notes, money, plans and life admin in ',
        t.bold('one private place on this device'),
        '. This page is a short tour — the checklist below ticks itself as you try each thing.',
      ]),
      b.callout(
        [
          t.bold('Your workspace lives on your computer.'),
          ' Ultra Note has no servers and no accounts, and we never receive your data. Nothing connects to the internet unless you turn on an integration.',
        ],
        { icon: emoji('🛡️'), tone: 'gray' },
      ),
      b.toc(),
      b.h2('Your first ten minutes'),
      ...todos,
      b.h2('Find your way around'),
      b.columns([
        [
          b.h3('Write'),
          b.p('Docs with headings, toggles, tables, math, code and columns — all keyboard-first.'),
          b.pageLink(writing.id),
        ],
        [
          b.h3('Move fast'),
          b.p([
            'Press ',
            t.code('⌘K'),
            ' anywhere. Jump to pages, run commands, even do quick maths with ',
            t.code('='),
            '.',
          ]),
          b.pageLink(shortcuts.id),
        ],
        [
          b.h3('Stay private'),
          b.p('Optional encryption with a password only you know, plus a recovery key you keep safe.'),
          b.pageLink(privacy.id),
        ],
      ]),
      b.h2('Go deeper'),
      b.pageRef(writing.id),
      b.pageRef(shortcuts.id),
      b.pageRef(privacy.id),
      b.pageRef(money.id),
      b.divider(),
      b.p([t.italic('Everything here is a normal page. Edit it, move it, or send it to Trash when you’re done.')], {
        color: 'gray',
      }),
    ]),
  );
  ctx.db.setMeta('gettingStarted', { pageId: gs.id, items: itemIds });

  // ── Writing in EMP (every block type)
  const today = ctx.clock.today();
  ctx.docs.save(
    writing.id,
    'page',
    makeDoc([
      b.p([
        'Everything in a page is a ',
        t.bold('block'),
        '. Type ',
        t.code('/'),
        ' to add one, drag the ',
        t.code('⋮⋮'),
        ' handle to move it, or press ',
        t.code('Esc'),
        ' to select it.',
      ]),
      b.image(stack.id, { caption: 'Three layers, one place: your notes, your numbers, your plans.' }),
      b.h1('Heading 1'),
      b.h2('Heading 2'),
      b.h3('Heading 3'),
      b.toggleHeading(2, 'A toggle heading — click the arrow', {
        children: [b.p('Toggle headings fold whole sections away. Great for long pages and FAQs.')],
      }),
      b.h2('Text that says more'),
      b.p([
        ...t.bold('Bold'),
        ', ',
        ...t.italic('italic'),
        ', ',
        ...t.underline('underline'),
        ', ',
        ...t.strike('strikethrough'),
        ', ',
        ...t.code('inline code'),
        ', ',
        ...t.link('links', 'https://github.com/devartin/ultra-note'),
        ', ',
        ...t.color('coloured text', 'blue'),
        ' and ',
        ...t.highlight('highlights', 'yellow'),
        '.',
      ]),
      b.p([
        'Mention a page like ',
        t.mention(shortcuts.id),
        ', a date like ',
        t.date({ start: today, time: false }),
        ', an emoji ',
        t.emoji('🎉', 'tada'),
        ' or inline maths ',
        t.math('e^{i\\pi} + 1 = 0'),
        '.',
      ]),
      b.h2('Lists'),
      b.bullet('Bulleted lists nest with Tab', {
        children: [b.bullet('Shift+Tab brings them back', { children: [b.bullet('Any block can have children')] })],
      }),
      b.numbered('Numbered lists count themselves'),
      b.numbered('Type 1. and a space to start one'),
      b.todo('To-dos tick with ⌘↵', true),
      b.todo('…or with a click'),
      b.toggle('Toggles hide details until you need them', {
        children: [b.p('Type > and a space to make one. Everything inside moves with it.')],
      }),
      b.h2('Callouts and quotes'),
      b.callout('Callouts draw the eye. Change the icon and colour from the block menu.', { icon: emoji('💡'), tone: 'yellow' }),
      b.callout([t.bold('Heads up: '), 'callouts come in every block colour.'], { icon: emoji('⚠️'), tone: 'orange' }),
      b.callout('Use green for wins and good news.', { icon: emoji('✅'), tone: 'green' }),
      b.quote('Simple can be harder than complex: you have to work hard to get your thinking clean to make it simple.'),
      b.h2('Code and maths'),
      b.code(
        `// Every page autosaves 400 ms after you stop typing.\nexport function debounce<T extends unknown[]>(fn: (...args: T) => void, ms = 400) {\n  let timer: ReturnType<typeof setTimeout> | undefined;\n  return (...args: T) => {\n    clearTimeout(timer);\n    timer = setTimeout(() => fn(...args), ms);\n  };\n}`,
        'ts',
        { caption: 'debounce.ts' },
      ),
      b.math('FV = PV \\times \\left(1 + \\frac{r}{n}\\right)^{n t}'),
      b.p([
        t.italic('The future value of savings: principal '),
        t.math('PV'),
        t.italic(', annual rate '),
        t.math('r'),
        t.italic(', compounded '),
        t.math('n'),
        t.italic(' times a year for '),
        t.math('t'),
        t.italic(' years.'),
      ]),
      b.h2('Tables and columns'),
      b.table(
        [
          ['Block', 'Shortcut', 'Good for'],
          ['Heading', '#  ##  ###', 'Structure'],
          ['To-do', '[]', 'Checklists'],
          ['Toggle', '>', 'Hiding detail'],
          ['Quote', '"', 'Highlights'],
          ['Code', '```', 'Snippets'],
        ],
        { colWidths: [160, 140, 220] },
      ),
      b.columns(
        [
          [b.h3('Columns'), b.p('Drag a block to the side of another to make columns — up to five across.')],
          [b.h3('Resizable'), b.p('Drag the gap between columns to change their widths.')],
        ],
        { widths: [0.5, 0.5] },
      ),
      b.h2('Files and links'),
      b.file(reference.id),
      b.pageLink(privacy.id),
      b.divider(),
      b.h2('Live blocks'),
      b.p([
        'Databases, charts, KPIs, spreadsheet ranges and market watchlists can live inside any page — type ',
        t.code('/database'),
        ', ',
        t.code('/chart'),
        ', ',
        t.code('/kpi'),
        ', ',
        t.code('/sheet'),
        ' or ',
        t.code('/watchlist'),
        '.',
      ]),
    ]),
  );

  // ── Keyboard shortcuts
  ctx.docs.save(
    shortcuts.id,
    'page',
    makeDoc([
      b.p(['On Windows and Linux, ', t.code('⌘'), ' is ', t.code('Ctrl'), ' and ', t.code('⌥'), ' is ', t.code('Alt'), '. Press ', t.code('?'), ' anywhere outside a text field for the cheat sheet.']),
      b.h2('Everywhere'),
      b.table(
        [
          ['Keys', 'Action'],
          ['⌘K', 'Command palette'],
          ['⌘P', 'Quick find pages'],
          ['⌘⇧P', 'Run a command'],
          ['⌘N', 'New page'],
          ['⌘[  /  ⌘]', 'Back / forward'],
          ['⌘⇧U', 'Go to parent page'],
          ['⌘\\', 'Toggle sidebar'],
          ['⌘⌥D', 'Today’s daily note'],
          ['⌘⇧H', 'Hide numbers'],
          ['⌘⇧L', 'Lock now'],
          ['⌘⇧D', 'Light / dark theme'],
          ['⌘⇧O', 'Offline mode'],
          ['⌘,', 'Settings'],
          ['⌘L', 'Copy link to page'],
        ],
        { colWidths: [160, 320] },
      ),
      b.h2('Formatting'),
      b.table(
        [
          ['Keys', 'Action'],
          ['⌘B  ⌘I  ⌘U', 'Bold, italic, underline'],
          ['⌘⇧S', 'Strikethrough'],
          ['⌘E', 'Inline code'],
          ['⌘⇧E', 'Inline equation'],
          ['⌘K with text selected', 'Add a link'],
          ['⌘⌥H', 'Apply the last colour'],
          ['⌘⇧V', 'Paste as plain text'],
        ],
        { colWidths: [200, 280] },
      ),
      b.h2('Blocks'),
      b.table(
        [
          ['Keys', 'Action'],
          ['Esc', 'Select the current block'],
          ['⇧↑  ⇧↓', 'Extend the block selection'],
          ['⌘D', 'Duplicate'],
          ['⌘⇧↑  ⌘⇧↓', 'Move the block with its children'],
          ['Tab  ⇧Tab', 'Indent / outdent'],
          ['⌘↵', 'Tick a to-do, open a toggle, follow a link'],
          ['⌘⌥T', 'Expand or collapse all toggles'],
          ['⌘⌥0–9', 'Turn into another block type'],
        ],
        { colWidths: [180, 300] },
      ),
      b.callout(['Markdown works as you type: ', t.code('#'), ' headings, ', t.code('-'), ' bullets, ', t.code('[]'), ' to-dos, ', t.code('---'), ' dividers.'], {
        icon: emoji('⚡'),
        tone: 'blue',
      }),
    ]),
  );

  // ── Privacy & encryption
  ctx.docs.save(
    privacy.id,
    'page',
    makeDoc([
      b.callout(
        'Your password never leaves this device, and we can’t reset it. Your recovery key is the only other way in, so keep it safe.',
        { icon: emoji('🔑'), tone: 'yellow' },
      ),
      b.h2('How it works'),
      b.numbered([
        'Your password is stretched with ',
        t.bold('Argon2id'),
        ' (256 MiB, 3 passes) into a key that unlocks a random 256-bit data key.',
      ]),
      b.numbered(['Every page, row and file is encrypted on your device with ', t.bold('XChaCha20-Poly1305'), '.']),
      b.numbered('Ultra Note locks itself after 15 idle minutes, when your computer sleeps, or when you press ⌘⇧L.'),
      b.numbered('Tamper-evident: Ultra Note detects if encrypted items are modified outside the app.'),
      b.h2('What encryption protects'),
      b.table(
        [
          ['Protected', 'Still visible on disk'],
          ['Titles, text and documents', 'That a vault exists, and its creation day'],
          ['Property names and values, views', 'How many pages, rows and files there are'],
          ['File names, types and contents', 'The shape of the page tree'],
          ['Tickers, accounts and amounts', 'When things were created and edited'],
          ['Tokens, keys and the search index', 'Approximate (padded) sizes'],
        ],
        { colWidths: [260, 280] },
      ),
      b.p([
        'Turn on full-disk encryption (FileVault, BitLocker or LUKS) to cover the rest. Read more in ',
        t.bold('Settings → Security'),
        '.',
      ]),
      b.toggle('Is Ultra Note military-grade encryption?', {
        children: [
          b.p(
            '“Military grade” isn’t a technical standard, so we don’t use the term. Ultra Note uses modern, widely reviewed cryptography (XChaCha20-Poly1305 with 256-bit keys and Argon2id password hashing) with conservative settings. It has not been certified by any government program. In practice, your security depends most on a strong password and keeping your computer free of malware. If someone can run software on your computer while Ultra Note is unlocked, no app-level encryption can stop them.',
          ),
        ],
      }),
      b.toggle('What if I forget my password?', {
        children: [b.p('Choose “Use recovery key” on the lock screen and enter your 24 words. You’ll set a new password straight away.')],
      }),
      b.toggle('Does Ultra Note connect to the internet?', {
        children: [
          b.p('Only for integrations you turn on — market data, Google, update checks. Every request is listed in Security Center, and Offline mode (⌘⇧O) blocks them all.'),
        ],
      }),
    ]),
  );

  // ── Money & life apps
  ctx.docs.save(
    money.id,
    'page',
    makeDoc([
      b.p('Life apps are guided set-ups that build real pages, databases and dashboards for you — then get out of the way.'),
      b.h2('The six apps'),
      b.columns([
        [
          b.callout([t.bold('Money HQ'), ' — budget, spending, bills and net worth.'], { icon: emoji('💳'), tone: 'green' }),
          b.callout([t.bold('Portfolio'), ' — holdings, performance, allocation and rebalancing.'], { icon: emoji('📈'), tone: 'blue' }),
          b.callout([t.bold('Tax Organizer'), ' — documents, deductions and quarterly estimates.'], { icon: emoji('🧾'), tone: 'yellow' }),
        ],
        [
          b.callout([t.bold('Spreadsheet Studio'), ' — calculators and models with real formulas.'], { icon: emoji('🧮'), tone: 'purple' }),
          b.callout([t.bold('Life OS'), ' — goals, projects and tasks in one system.'], { icon: emoji('🗂️'), tone: 'gray' }),
          b.callout([t.bold('Habits'), ' — streaks and gentle check-ins.'], { icon: emoji('🌱'), tone: 'red' }),
        ],
      ]),
      b.h2('How the advice works'),
      b.bullet('Every number shows its maths — tap a figure to see where it came from.'),
      b.bullet('Suggestions use common guidelines, never a sales pitch. Nothing is ever bought, filed or paid for you.'),
      b.callout(
        'Estimates for planning only. Not financial or tax advice. Verify with official sources or a qualified professional.',
        { icon: emoji('ℹ️'), tone: 'gray' },
      ),
    ]),
  );

  // Order children explicitly (create() appended them in this order already).
  ctx.pages.emitTree(ws.id, [gs.id, writing.id, shortcuts.id, privacy.id, money.id]);

  ctx.db.table<WorkspaceRecord>('workspaces').update(ws.id, (w) => {
    w.favorites = [gs.id];
    w.recents = [gs.id];
  });

  ctx.seedRefs.set('core.workspace', ws.id);
  ctx.seedRefs.set('core.page.gettingStarted', gs.id);
  ctx.seedRefs.set('core.page.blocks', writing.id);
  ctx.seedRefs.set('core.page.money', money.id);
  return { workspaceId: ws.id, gettingStarted: gs.id, blocks: writing.id };
}

// ───────────────────────────────────────────────────────────────────────────── demo extras

function createJournal(ctx: MockCtx, workspaceId: string): string {
  const now = ctx.clock.now();
  const journal = ctx.pages.create({
    workspaceId,
    parentId: null,
    kind: 'doc',
    title: 'Journal',
    icon: emoji('📓'),
    templateKey: 'daily:root',
    createdAt: now - 45 * DAY,
    updatedAt: now - 0.1 * DAY,
    silent: true,
    doc: makeDoc([
      b.p(['One page per day. Press ', t.code('⌘⌥D'), ' to open today’s.']),
    ]),
  });

  const entries: { daysAgo: number; blocks: () => TipTapNode[] }[] = [
    {
      daysAgo: 2,
      blocks: () => [
        b.h3('Focus'),
        b.todo('Draft the relaunch brief', true),
        b.todo('Call the contractor about the kitchen quote', true),
        b.todo('30 min reading', true),
        b.h3('Notes'),
        b.p('Quiet morning. Wrote the first half of the brief before 10 — mornings really are better for deep work.'),
        b.h3('End of day'),
        b.toggle('What went well?', { collapsed: false, children: [b.p('Got the contractor to itemise the quote. Cabinets are 41% of it.')] }),
      ],
    },
    {
      daysAgo: 1,
      blocks: () => [
        b.h3('Focus'),
        b.todo('Review homepage wireframes', true),
        b.todo('Book Lisbon flights'),
        b.todo('Weekly review', true),
        b.h3('Notes'),
        b.p(['Wireframes look strong. Hero copy still too long — ask for a version under 12 words. Logged in ', t.bold('Website relaunch'), '.']),
        b.bullet('Flights are ~€40 cheaper on Tuesdays.'),
        b.h3('End of day'),
        b.toggle('What went well?', { collapsed: false, children: [b.p('Inbox zero for the first time this month.')] }),
      ],
    },
    {
      daysAgo: 0,
      blocks: () => [
        b.h3('Focus'),
        b.todo('Finalise launch checklist'),
        b.todo('Pay the quarterly estimate'),
        b.todo('Walk before lunch'),
        b.h3('Notes'),
        b.p(''),
        b.h3('End of day'),
        b.toggle('What went well?', { collapsed: false, children: [b.p('')] }),
      ],
    },
  ];
  // Newest first under Journal.
  const keys = generateNKeysBetween(null, null, entries.length);
  const sorted = [...entries].sort((a, b2) => a.daysAgo - b2.daysAgo);
  sorted.forEach((e, i) => {
    const ts = now - e.daysAgo * DAY;
    const date = dayIso(ts);
    const rec = ctx.pages.create({
      workspaceId,
      parentId: journal.id,
      kind: 'doc',
      title: dailyTitle(date),
      icon: emoji(e.daysAgo === 0 ? '☀️' : '🗓️'),
      templateKey: `daily:${date}`,
      createdAt: ts - 3 * 3600_000,
      updatedAt: ts - (e.daysAgo === 0 ? 0.05 * DAY : 0.2 * DAY),
      silent: true,
      doc: makeDoc(e.blocks()),
    });
    ctx.pages.table().update(rec.id, (r) => {
      r.sortKey = keys[i];
    });
  });
  ctx.seedRefs.set('core.page.journal', journal.id);
  return journal.id;
}

function createProjects(ctx: MockCtx, workspaceId: string, journalId: string): { relaunch: string; kitchen: string } {
  const now = ctx.clock.now();
  const projects = ctx.pages.create({
    workspaceId,
    parentId: null,
    kind: 'doc',
    title: 'Projects',
    icon: emoji('🎯'),
    createdAt: now - 40 * DAY,
    updatedAt: now - 2 * DAY,
    silent: true,
  });
  const relaunch = ctx.pages.create({
    workspaceId,
    parentId: projects.id,
    kind: 'doc',
    title: 'Website relaunch',
    icon: emoji('🚀'),
    cover: { t: 'gradient', v: 'dusk' },
    createdAt: now - 38 * DAY,
    updatedAt: now - 0.3 * DAY,
    silent: true,
  });
  const checklist = ctx.pages.create({
    workspaceId,
    parentId: relaunch.id,
    kind: 'doc',
    title: 'Launch checklist',
    icon: emoji('✅'),
    createdAt: now - 20 * DAY,
    updatedAt: now - 1 * DAY,
    silent: true,
  });
  const kitchen = ctx.pages.create({
    workspaceId,
    parentId: projects.id,
    kind: 'doc',
    title: 'Kitchen renovation',
    icon: emoji('🏡'),
    createdAt: now - 30 * DAY,
    updatedAt: now - 2 * DAY,
    silent: true,
  });
  const launchDay = dayIso(now + 18 * DAY);

  ctx.docs.save(
    projects.id,
    'page',
    makeDoc([b.p('Active projects, newest first. Each one starts from the Project brief template.'), b.pageRef(relaunch.id), b.pageRef(kitchen.id)]),
  );

  ctx.docs.save(
    relaunch.id,
    'page',
    makeDoc([
      b.callout(
        [t.bold('One sentence: '), 'a faster, clearer site that turns visitors into trial sign-ups — live by ', t.date({ start: launchDay, time: false }), '.'],
        { icon: emoji('💡'), tone: 'yellow' },
      ),
      b.h2('Goals'),
      b.bullet(['Lift trial sign-ups from ', t.bold('2.1%'), ' to ', t.bold('3%'), ' of visitors']),
      b.bullet('Largest contentful paint under 1.5 s on mobile'),
      b.bullet('One message per page, written for people, not search engines'),
      b.h2('Non-goals'),
      b.bullet('A new brand identity — we keep the current logo and palette'),
      b.bullet('Blog migration (separate project next quarter)'),
      b.h2('Milestones'),
      b.table(
        [
          ['Milestone', 'Owner', 'Status'],
          ['Wireframes', 'Maya', 'Done'],
          ['Copy for 6 core pages', 'Sam', 'In review'],
          ['Build + QA', 'Ana', 'In progress'],
          ['Launch', 'Everyone', launchDay],
        ],
        { colWidths: [220, 120, 140] },
      ),
      b.h2('This week'),
      b.todo('Shorten hero copy to under 12 words', true),
      b.todo('Approve pricing page layout'),
      b.todo('Set up redirects for 40 legacy URLs'),
      b.pageRef(checklist.id),
      b.h2('Risks'),
      b.toggle('Redirect gaps cost search traffic', {
        children: [b.p('Mitigation: crawl the old site, map every URL, and watch 404s daily for two weeks after launch.')],
      }),
      b.toggle('Copy review drags on', {
        children: [b.p('Mitigation: one reviewer per page, 48-hour turnaround, changes batched on Thursdays.')],
      }),
      b.p(['Notes from the wireframe review are in ', t.mention(journalId), '.'], { color: 'gray' }),
    ]),
  );

  ctx.docs.save(
    checklist.id,
    'page',
    makeDoc([
      b.h2('Before launch'),
      b.todo('Every page has a title and description', true),
      b.todo('Open-graph images for the 6 core pages', true),
      b.todo('Forms send to the right inbox'),
      b.todo('Cookie banner only where legally required'),
      b.todo('Lighthouse ≥ 95 on mobile'),
      b.h2('Launch day'),
      b.todo('Switch DNS at 9:00'),
      b.todo('Purge CDN cache'),
      b.todo('Post the announcement'),
      b.h2('After'),
      b.todo('Watch 404s and sign-ups daily for two weeks'),
      b.p(['Back to ', t.mention(relaunch.id), '.']),
    ]),
  );

  ctx.docs.save(
    kitchen.id,
    'page',
    makeDoc([
      b.p(['Budget ', t.bold('$24,000'), ' all-in, with a 10% contingency. Target finish before the spring.']),
      b.h2('Quotes'),
      b.table(
        [
          ['Item', 'Quote A', 'Quote B', 'Notes'],
          ['Cabinets', '$9,800', '$8,450', 'B uses plywood boxes'],
          ['Counters (quartz)', '$4,200', '$4,650', ''],
          ['Plumbing + electrical', '$3,100', '$2,900', 'Permit included in A'],
          ['Labour', '$4,500', '$5,200', ''],
          ['Total', '$21,600', '$21,200', ''],
        ],
        { colWidths: [200, 100, 100, 200] },
      ),
      b.h2('Decision'),
      b.toggleHeading(3, 'Why we’re leaning towards Quote A', {
        collapsed: false,
        children: [
          b.bullet('Permit is included and they file it'),
          b.bullet('Two references we trust, both finished on time'),
          b.bullet('Only $400 more once the permit is counted'),
        ],
      }),
      b.callout('Ask both for a written schedule before signing.', { icon: emoji('📌'), tone: 'red' }),
    ]),
  );

  ctx.seedRefs.set('core.page.projects', projects.id);
  return { relaunch: relaunch.id, kitchen: kitchen.id };
}

function createReading(ctx: MockCtx, workspaceId: string): string {
  const now = ctx.clock.now();
  const reading = ctx.pages.create({
    workspaceId,
    parentId: null,
    kind: 'doc',
    title: 'Reading notes',
    icon: emoji('📚'),
    createdAt: now - 50 * DAY,
    updatedAt: now - 6 * DAY,
    silent: true,
  });
  const psych = ctx.pages.create({
    workspaceId,
    parentId: reading.id,
    kind: 'doc',
    title: 'The Psychology of Money',
    icon: emoji('💭'),
    createdAt: now - 49 * DAY,
    updatedAt: now - 6 * DAY,
    silent: true,
  });
  const habits = ctx.pages.create({
    workspaceId,
    parentId: reading.id,
    kind: 'doc',
    title: 'Atomic Habits',
    icon: emoji('⚛️'),
    createdAt: now - 33 * DAY,
    updatedAt: now - 14 * DAY,
    silent: true,
  });
  ctx.docs.save(
    reading.id,
    'page',
    makeDoc([b.p('Notes, highlights and the one thing I’ll do differently after each book.'), b.pageRef(psych.id), b.pageRef(habits.id)]),
  );
  ctx.docs.save(
    psych.id,
    'page',
    makeDoc([
      b.table(
        [
          ['Author', 'Morgan Housel'],
          ['Finished', dayIso(now - 6 * DAY)],
          ['Rating', '★★★★★'],
        ],
        { headerRow: false, headerCol: true },
      ),
      b.h2('The big idea'),
      b.p('Doing well with money has less to do with how smart you are and more to do with how you behave.'),
      b.h2('Highlights'),
      b.quote('Saving money is the gap between your ego and your income.'),
      b.quote('Room for error is underappreciated: plan on your plan not going according to plan.'),
      b.bullet(['Compounding is counter-intuitive: most of the result comes from ', t.bold('time'), ', not rate.']),
      b.bullet('“Enough” is a decision. Without it, the goalposts keep moving.'),
      b.h2('What I’ll do differently'),
      b.todo('Keep six months of expenses in cash, even if it “earns nothing”', true),
      b.todo('Automate investing on payday so I never decide twice'),
    ]),
  );
  ctx.docs.save(
    habits.id,
    'page',
    makeDoc([
      b.h2('The four laws'),
      b.numbered([t.bold('Make it obvious'), ' — cue'], { children: [b.bullet('Implementation intention: “I will [behaviour] at [time] in [place].”')] }),
      b.numbered([t.bold('Make it attractive'), ' — craving'], { children: [b.bullet('Temptation bundling: pair what you need with what you want.')] }),
      b.numbered([t.bold('Make it easy'), ' — response'], { children: [b.bullet('The two-minute rule: scale it down until it takes two minutes.')] }),
      b.numbered([t.bold('Make it satisfying'), ' — reward'], { children: [b.bullet('Never miss twice.')] }),
      b.quote('You do not rise to the level of your goals. You fall to the level of your systems.'),
      b.callout('Track these in the Habits app — it keeps streaks honest and forgiving.', { icon: emoji('🌱'), tone: 'green' }),
    ]),
  );
  return reading.id;
}

function createTrip(ctx: MockCtx, workspaceId: string): string {
  const now = ctx.clock.now();
  const tiles = ctx.assets.create({
    workspaceId,
    name: 'azulejos.svg',
    mime: 'image/svg+xml',
    blob: new Blob([azulejoSvg()], { type: 'image/svg+xml' }),
    width: 1440,
    height: 600,
    source: 'builtin',
  });
  const depart = dayIso(now + 104 * DAY);
  const back = dayIso(now + 110 * DAY);
  const trip = ctx.pages.create({
    workspaceId,
    parentId: null,
    kind: 'doc',
    title: 'Lisbon in March',
    icon: emoji('✈️'),
    cover: { t: 'asset', assetId: tiles.id, posY: 0.5 },
    createdAt: now - 12 * DAY,
    updatedAt: now - 1.2 * DAY,
    silent: true,
    doc: makeDoc([
      b.p([t.date({ start: depart, end: back, time: false }), ' · 6 nights · two of us']),
      b.h2('Itinerary'),
      b.table(
        [
          ['Day', 'Plan', 'Booked'],
          ['1', 'Arrive, Alfama walk, dinner at a tasca', '✓'],
          ['2', 'Belém: tower, monastery, pastéis', ''],
          ['3', 'Day trip to Sintra (train from Rossio)', ''],
          ['4', 'LX Factory, sunset at Miradouro da Senhora do Monte', ''],
          ['5', 'Cascais beach day', ''],
          ['6', 'Gulbenkian museum, last fado night', '✓'],
        ],
        { colWidths: [60, 380, 80] },
      ),
      b.h2('Budget'),
      b.bullet(['Flights ', t.bold('€360'), ' · Stay ', t.bold('€780'), ' · Food & fun ', t.bold('€600')]),
      b.h2('Packing'),
      b.todo('Passports', true),
      b.todo('Comfortable shoes — Lisbon is all hills'),
      b.todo('Light rain jacket'),
      b.todo('EU plug adapter'),
      b.toggle('Phrases', {
        children: [b.bullet('Obrigado / obrigada — thank you'), b.bullet('Uma bica, por favor — an espresso, please'), b.bullet('A conta, por favor — the bill, please')],
      }),
    ]),
  });
  return trip.id;
}

function createUserTemplate(ctx: MockCtx, workspaceId: string): string {
  const now = ctx.clock.now();
  const tpl = ctx.pages.create({
    workspaceId,
    parentId: null,
    kind: 'doc',
    title: 'Weekly 1:1',
    icon: emoji('🤝'),
    flags: { template: true },
    createdAt: now - 25 * DAY,
    updatedAt: now - 25 * DAY,
    silent: true,
    doc: makeDoc([
      b.callout('Their agenda first. Keep a running page per person and add to the top each week.', { icon: emoji('🗣️'), tone: 'blue' }),
      b.h2('Wins since last time'),
      b.bullet(''),
      b.h2('Blockers'),
      b.bullet(''),
      b.h2('Growth'),
      b.p(''),
      b.h2('Follow-ups'),
      b.todo(''),
    ]),
  });
  return tpl.id;
}

function seedVersions(ctx: MockCtx, pageId: string, label: string) {
  const rec = ctx.docs.get(pageId);
  if (!rec) return;
  const now = ctx.clock.now();
  const base = structuredClone(rec.doc);
  const trimmed = structuredClone(rec.doc);
  const group = trimmed.content.find((n) => n.type === 'blockGroup');
  if (group?.content && group.content.length > 4) group.content = group.content.slice(0, group.content.length - 3);
  ctx.versions.create({ targetId: pageId, targetKind: 'page_doc', reason: 'auto', snapshot: trimmed, createdAt: now - 9 * DAY });
  ctx.versions.create({ targetId: pageId, targetKind: 'page_doc', reason: 'manual', label, snapshot: trimmed, createdAt: now - 5 * DAY });
  ctx.versions.create({ targetId: pageId, targetKind: 'page_doc', reason: 'auto', snapshot: base, createdAt: now - 26 * 3600_000 });
  ctx.versions.create({ targetId: pageId, targetKind: 'page_doc', reason: 'auto', snapshot: base, createdAt: now - 40 * 60_000 });
}

function seedLogs(ctx: MockCtx) {
  const now = ctx.clock.now();
  const sec = ctx.db.table<{ id: string; at: number; event: string }>('security_log');
  const events: [number, string][] = [
    [62 * DAY, 'enc_on'],
    [9 * DAY, 'unlock_ok'],
    [9 * DAY - 3600_000, 'lock'],
    [3 * DAY, 'unlock_fail'],
    [3 * DAY - 20_000, 'unlock_ok'],
    [2 * DAY, 'lock'],
    [0.4 * DAY, 'unlock_ok'],
  ];
  if (ctx.options.encrypted) for (const [ago, event] of events) sec.put({ id: `seed-${ago}-${event}`, at: now - ago, event });

  const net: [number, string, string, string, number, number][] = [
    [0.02 * DAY, 'frankfurter', 'api.frankfurter.app', '/latest', 200, 1_184],
    [0.03 * DAY, 'stooq', 'stooq.com', '/q/d/l/', 200, 24_310],
    [0.03 * DAY, 'coingecko', 'api.coingecko.com', '/api/v3/simple/price', 200, 612],
    [1.1 * DAY, 'frankfurter', 'api.frankfurter.app', '/latest', 200, 1_190],
    [1.1 * DAY, 'stooq', 'stooq.com', '/q/d/l/', 200, 23_980],
  ];
  for (const [ago, connector, host, path, status, bytes] of net) {
    logNetwork(ctx, { at: now - ago, connector, method: 'GET', host, path, status, bytes });
  }
}

function seedDemo(ctx: MockCtx) {
  const tour = createStarterWorkspace(ctx, { demo: true });
  const ws = tour.workspaceId;
  const journal = createJournal(ctx, ws);
  const { relaunch, kitchen } = createProjects(ctx, ws, journal);
  createReading(ctx, ws);
  const trip = createTrip(ctx, ws);
  createUserTemplate(ctx, ws);

  seedVersions(ctx, tour.gettingStarted, 'Before the tour rewrite');
  seedVersions(ctx, relaunch, 'Brief v1 — sent to team');

  const todayNote = ctx.pages
    .table()
    .find((p: PageRecord) => p.templateKey === `daily:${ctx.clock.today()}` && !p.deletedAt);
  ctx.db.table<WorkspaceRecord>('workspaces').update(ws, (w) => {
    w.favorites = [tour.gettingStarted, relaunch, trip];
    w.recents = [todayNote?.id, relaunch, tour.blocks, trip, kitchen, tour.gettingStarted].filter(
      (x): x is string => typeof x === 'string',
    );
  });

  // A page already in Trash, to make the Trash view meaningful.
  const old = ctx.pages.create({
    workspaceId: ws,
    parentId: null,
    kind: 'doc',
    title: 'Old gym routine',
    icon: emoji('🏋️'),
    createdAt: ctx.clock.now() - 70 * DAY,
    updatedAt: ctx.clock.now() - 20 * DAY,
    silent: true,
    doc: makeDoc([b.bullet('Mon — push'), b.bullet('Wed — pull'), b.bullet('Fri — legs')]),
  });
  ctx.pages.trash([old.id]);
  ctx.pages.table().update(old.id, (r) => {
    r.deletedAt = ctx.clock.now() - 4 * DAY;
  });

  patchVaultSettings(ctx, { profileName: 'Alex' });
  seedLogs(ctx);
}

// ───────────────────────────────────────────────────────────────────────────── perf seed

const PERF_WORDS = (
  'roadmap budget research notes ideas meeting review plan draft archive design launch hiring travel health ' +
  'garden recipes reading finance taxes home car insurance projects goals quarterly weekly ops support sales ' +
  'marketing legal vendors contracts onboarding retro backlog metrics experiments'
).split(' ');

function seedPerf(ctx: MockCtx) {
  const tour = createStarterWorkspace(ctx, { demo: false });
  const ws = tour.workspaceId;
  const now = ctx.clock.now();
  const table = ctx.pages.table();
  const title = () => {
    const a = ctx.rng.pick(PERF_WORDS);
    const b2 = ctx.rng.pick(PERF_WORDS);
    return `${a[0].toUpperCase()}${a.slice(1)} ${b2} ${ctx.rng.int(1, 999)}`;
  };
  // 50 areas × 99 children ≈ 5,000 pages (bulk insert, no per-page events).
  const areaKeys = generateNKeysBetween(table.get(tour.gettingStarted)?.sortKey ?? null, null, 50);
  let made = 0;
  for (let a = 0; a < 50; a++) {
    const areaId = ctx.id();
    table.insert({
      id: areaId,
      workspaceId: ws,
      parentId: null,
      kind: 'doc',
      sortKey: areaKeys[a],
      title: `Area ${a + 1} — ${title()}`,
      icon: emoji(ctx.rng.pick(['📁', '🗂️', '📦', '🧩', '🗃️'])),
      createdAt: now - ctx.rng.int(30, 400) * DAY,
      updatedAt: now - ctx.rng.int(0, 30) * DAY,
      rev: 1,
      flags: {},
    });
    made++;
    const keys = generateNKeysBetween(null, null, 99);
    for (let i = 0; i < 99; i++) {
      const id = ctx.id();
      const updatedAt = now - ctx.rng.int(0, 365) * DAY;
      table.insert({
        id,
        workspaceId: ws,
        parentId: areaId,
        kind: 'doc',
        sortKey: keys[i],
        title: title(),
        createdAt: updatedAt - ctx.rng.int(0, 90) * DAY,
        updatedAt,
        rev: 1,
        flags: {},
      });
      if (i % 3 === 0) {
        ctx.docs.save(
          id,
          'page',
          makeDoc([b.p(`Notes about ${title().toLowerCase()} and ${title().toLowerCase()}.`), b.bullet(title()), b.todo(title(), ctx.rng.chance(0.5))]),
        );
      }
      made++;
    }
  }

  // ~2 MB document.
  const big = ctx.pages.create({ workspaceId: ws, parentId: null, kind: 'doc', title: 'Large document (2 MB)', icon: emoji('🐘'), silent: true });
  const blocks: TipTapNode[] = [];
  const sentence =
    'The quick brown fox jumps over the lazy dog while the budget review waits patiently for the quarterly numbers to arrive. ';
  for (let i = 0; i < 9000; i++) {
    if (i % 200 === 0) blocks.push(b.h2(`Section ${i / 200 + 1}`));
    else if (i % 17 === 0) blocks.push(b.todo(`Follow up on item ${i}`, i % 2 === 0));
    else blocks.push(b.p(`${i}. ${sentence}`));
  }
  ctx.docs.save(big.id, 'page', makeDoc(blocks));
  ctx.seedRefs.set('core.perf.pages', String(made));
}

// ───────────────────────────────────────────────────────────────────────────── entry

export function seed(ctx: MockCtx): void {
  if (ctx.seedKind === 'perf') seedPerf(ctx);
  else if (ctx.seedKind === 'demo') seedDemo(ctx);
}
