/**
 * Databases seed (demo): four rich, interlinked databases that show off every view —
 *   • Client CRM (table · pipeline board · chart) — money, percent, formula, rollup, two-way relation, IDs
 *   • Project tracker (board · table · calendar · chart) — status groups, priorities, progress, formulas
 *   • Reading list (gallery with generated covers · board · table) — files, ratings, multi-select
 *   • Content calendar (calendar · board · donut chart) — dates around today, channels, word counts
 * plus an inline database on "Writing in EMP" and linked views on the core Projects / Reading notes pages.
 * The perf seed gets a 10k-row, 14-property database for virtualisation.
 */
import type { CellValue, DateValue, Icon, Id, TipTapNode } from '../../types';
import type { MockCtx } from '../ctx';
import { b, makeDoc, t } from '../lib/doc';
import { createRng, type Rng } from '../rng';
import { appendBlocks } from './core';
import { createDatabase, createProperty, createRow, refreshResultTypes, type NewProp } from '../commands/db';

export const order = 20;

const DAY = 86_400_000;
const emoji = (v: string): Icon => ({ t: 'emoji', v });

type Opt = { id: string; name: string; color: string; group?: 'todo' | 'in_progress' | 'complete' };
const slug = (s: string) => 'o_' + s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const opts = (list: [string, string, Opt['group']?][]): Opt[] => list.map(([name, color, group]) => ({ id: slug(name), name, color, ...(group ? { group } : {}) }));

const V = {
  text: (s: string): CellValue => ({ t: 'text', v: s ? [{ text: s }] : [] }),
  num: (n: number | null): CellValue => ({ t: 'number', v: n }),
  money: (s: string, cur = 'USD'): CellValue => ({ t: 'money', v: s, cur }),
  sel: (name: string): CellValue => ({ t: 'select', v: slug(name) }),
  status: (name: string): CellValue => ({ t: 'status', v: slug(name) }),
  multi: (...names: string[]): CellValue => ({ t: 'multi', v: names.map(slug) }),
  date: (start: string, end?: string): CellValue => ({ t: 'date', v: (end ? { start, end, time: false } : { start, time: false }) as DateValue }),
  dateTime: (iso: string): CellValue => ({ t: 'date', v: { start: iso, time: true } }),
  check: (v: boolean): CellValue => ({ t: 'check', v }),
  url: (v: string): CellValue => ({ t: 'url', v }),
  email: (v: string): CellValue => ({ t: 'email', v }),
  phone: (v: string): CellValue => ({ t: 'phone', v }),
  rating: (v: number): CellValue => ({ t: 'rating', v }),
  progress: (v: number): CellValue => ({ t: 'progress', v }),
  rel: (ids: Id[]): CellValue => ({ t: 'relation', v: ids }),
  files: (f: { assetId: Id; name: string }[]): CellValue => ({ t: 'files', v: f }),
  ticker: (v: string): CellValue => ({ t: 'ticker', v }),
};

function dayOf(ctx: MockCtx, offset: number): string {
  return ctx.clock.today(ctx.clock.now() + offset * DAY);
}

// ───────────────────────────────────────────────────────────────────────────── covers

const COVER_PALETTES: [string, string, string][] = [
  ['#1d2b53', '#7e2553', '#ffccaa'],
  ['#0f3d3e', '#100f0f', '#e2dcc8'],
  ['#f4eee0', '#d8c3a5', '#3d2c2e'],
  ['#2b2d42', '#8d99ae', '#edf2f4'],
  ['#ff6b35', '#f7c59f', '#1a1a2e'],
  ['#004e64', '#00a5cf', '#f2f7f2'],
  ['#3a0ca3', '#7209b7', '#f8f7ff'],
  ['#e9d8a6', '#94d2bd', '#001219'],
  ['#14213d', '#fca311', '#ffffff'],
  ['#bc4749', '#f2e8cf', '#386641'],
  ['#222222', '#e63946', '#f1faee'],
  ['#ede0d4', '#7f5539', '#2b2118'],
  ['#0b132b', '#5bc0be', '#ffffff'],
  ['#f6bd60', '#f28482', '#2d1e2f'],
  ['#2d6a4f', '#95d5b2', '#081c15'],
  ['#5f0f40', '#fb8b24', '#fff3e6'],
];

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function wrapWords(s: string, max: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const w of s.split(' ')) {
    if ((line + ' ' + w).trim().length > max && line) {
      out.push(line);
      line = w;
    } else line = (line + ' ' + w).trim();
  }
  if (line) out.push(line);
  return out.slice(0, 4);
}

function bookCover(title: string, author: string, i: number, rng: Rng): string {
  const [bg, accent, ink] = COVER_PALETTES[i % COVER_PALETTES.length];
  const style = i % 4;
  const lines = wrapWords(title, style === 2 ? 12 : 14);
  const shapes: string[] = [];
  if (style === 0) {
    for (let k = 0; k < 7; k++) shapes.push(`<circle cx="${rng.int(40, 360)}" cy="${rng.int(60, 300)}" r="${rng.int(20, 110)}" fill="${accent}" opacity="${(0.18 + rng.next() * 0.4).toFixed(2)}"/>`);
  } else if (style === 1) {
    for (let k = 0; k < 9; k++) shapes.push(`<rect x="0" y="${40 + k * 34}" width="400" height="14" fill="${accent}" opacity="${(0.15 + (k % 3) * 0.2).toFixed(2)}"/>`);
  } else if (style === 2) {
    shapes.push(`<polygon points="0,600 400,180 400,600" fill="${accent}" opacity="0.85"/>`, `<circle cx="300" cy="150" r="70" fill="${ink}" opacity="0.12"/>`);
  } else {
    shapes.push(`<rect x="36" y="36" width="328" height="528" rx="6" fill="none" stroke="${ink}" stroke-opacity="0.5" stroke-width="2"/>`, `<rect x="56" y="300" width="288" height="4" fill="${accent}"/>`);
  }
  const ty = style === 2 ? 110 : style === 3 ? 380 : 360;
  const titleSvg = lines.map((l, k) => `<text x="${style === 3 ? 56 : 32}" y="${ty + k * 44}" font-family="Georgia, 'Newsreader', serif" font-size="38" font-weight="700" fill="${ink}">${escapeXml(l)}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 600" width="400" height="600"><rect width="400" height="600" fill="${bg}"/>${shapes.join('')}${titleSvg}<text x="${style === 3 ? 56 : 32}" y="560" font-family="Inter, system-ui, sans-serif" font-size="16" letter-spacing="2" fill="${ink}" opacity="0.8">${escapeXml(author.toUpperCase())}</text></svg>`;
}

function svgAsset(ctx: MockCtx, ws: Id, name: string, svg: string, width: number, height: number): Id {
  return ctx.assets.create({ workspaceId: ws, name, mime: 'image/svg+xml', blob: new Blob([svg], { type: 'image/svg+xml' }), width, height, source: 'seed' }).id;
}

// ───────────────────────────────────────────────────────────────────────────── CRM

const PEOPLE = ['Maya Chen', 'Jonah Reyes', 'Priya Natarajan', 'Leo Fischer', 'Amara Okafor'];

function seedCrm(ctx: MockCtx, ws: Id, now: number) {
  const stage = opts([
    ['Lead', 'gray', 'todo'],
    ['Contacted', 'blue', 'todo'],
    ['Proposal', 'purple', 'in_progress'],
    ['Negotiation', 'orange', 'in_progress'],
    ['Won', 'green', 'complete'],
    ['Lost', 'red', 'complete'],
  ]);
  const industry = opts([
    ['SaaS', 'blue'],
    ['Fintech', 'green'],
    ['Retail', 'orange'],
    ['Healthcare', 'red'],
    ['Media', 'pink'],
    ['Logistics', 'brown'],
    ['Education', 'yellow'],
  ]);
  const props: NewProp[] = [
    { name: 'Company', type: 'title' },
    { name: 'Stage', type: 'status', config: { options: stage } },
    { name: 'Deal value', type: 'money', config: { currency: 'USD', decimals: 0 } },
    { name: 'Probability', type: 'number', config: { format: 'percent', decimals: 0, display: 'ring' } },
    { name: 'Weighted', type: 'formula', config: { expression: 'prop("Deal value") * prop("Probability")' } },
    { name: 'Industry', type: 'select', config: { options: industry } },
    { name: 'Owner', type: 'select', config: { options: opts(PEOPLE.map((p, i) => [p, ['blue', 'purple', 'green', 'orange', 'pink'][i]] as [string, string])) } },
    { name: 'Contact', type: 'text' },
    { name: 'Email', type: 'email' },
    { name: 'Phone', type: 'phone' },
    { name: 'Website', type: 'url' },
    { name: 'Last contacted', type: 'date', config: { format: 'relative' } },
    { name: 'Next step', type: 'text' },
    { name: 'Account', type: 'unique_id', config: { prefix: 'ACC' } },
    { name: 'Ticker', type: 'ticker', config: { showQuote: true } },
  ];
  const { db } = createDatabase(ctx, {
    workspaceId: ws,
    parentId: null,
    title: 'Client CRM',
    icon: emoji('🤝'),
    description: 'Every relationship, deal and next step in one place.',
    properties: props,
    createdAt: now - 40 * DAY,
    views: [
      { name: 'Pipeline', layout: 'table' },
      { name: 'By stage', layout: 'board' },
      { name: 'Forecast', layout: 'chart' },
    ],
  });
  const P = schemaIds(ctx, db.id);
  const data: [string, string, string, number, string, string, string, number, string, string?][] = [
    ['Northwind Analytics', 'Negotiation', '48000', 0.7, 'SaaS', 'Maya Chen', 'Elena Park', 3, 'Send revised MSA with SSO addendum', 'NWND'],
    ['Helios Health', 'Proposal', '126000', 0.45, 'Healthcare', 'Jonah Reyes', 'Dr. Samuel Ortiz', 6, 'Security review call on Thursday'],
    ['Juniper Retail Group', 'Won', '72000', 1, 'Retail', 'Priya Natarajan', 'Kara Lindqvist', 12, 'Kickoff scheduled — intro to onboarding team'],
    ['Atlas Freight', 'Contacted', '35000', 0.2, 'Logistics', 'Leo Fischer', 'Marcus Bell', 2, 'Share the logistics case study'],
    ['Quill & Co.', 'Lead', '18000', 0.1, 'Media', 'Amara Okafor', 'Ivy Moreau', 9, 'Find a warm intro via Jonah'],
    ['Ledgerline', 'Negotiation', '210000', 0.6, 'Fintech', 'Maya Chen', 'Tom Hartley', 1, 'Pricing approval from their CFO', 'LDGR'],
    ['Brightpath Learning', 'Proposal', '54000', 0.4, 'Education', 'Priya Natarajan', 'Nadia Rahman', 4, 'Pilot scope for two schools'],
    ['Cobalt Systems', 'Won', '96000', 1, 'SaaS', 'Jonah Reyes', 'Hugo Martins', 21, 'Expansion conversation in Q1', 'CBLT'],
    ['Meridian Bank', 'Lost', '180000', 0, 'Fintech', 'Leo Fischer', 'Grace Whitfield', 30, 'Chose an incumbent — revisit next year'],
    ['Pinecrest Clinics', 'Contacted', '42000', 0.25, 'Healthcare', 'Amara Okafor', 'Owen Blake', 5, 'Demo for the operations lead'],
    ['Riverstone Media', 'Lead', '22000', 0.1, 'Media', 'Maya Chen', 'Sofia Ricci', 14, 'Qualify budget and timeline'],
    ['Vantage Logistics', 'Proposal', '88000', 0.5, 'Logistics', 'Leo Fischer', 'Daniel Kim', 2, 'Proposal walkthrough with procurement'],
    ['Orbit Payments', 'Negotiation', '154000', 0.65, 'Fintech', 'Jonah Reyes', 'Lena Vogel', 0, 'Redlines back from legal', 'ORBT'],
    ['Lumen Books', 'Won', '28000', 1, 'Retail', 'Priya Natarajan', 'Ana Souza', 18, 'Case study interview'],
    ['Tidewater Schools', 'Lead', '31000', 0.15, 'Education', 'Amara Okafor', 'Peter Novak', 11, 'Intro email sent'],
    ['Kite Robotics', 'Contacted', '64000', 0.3, 'SaaS', 'Maya Chen', 'Yuki Tanaka', 7, 'Technical deep-dive with their CTO', 'KITE'],
    ['Summit Outfitters', 'Lost', '45000', 0, 'Retail', 'Leo Fischer', 'Rachel Adams', 26, 'Budget frozen until spring'],
    ['Nova Diagnostics', 'Proposal', '112000', 0.5, 'Healthcare', 'Jonah Reyes', 'Ines Duarte', 3, 'Clinical workflow mapping session', 'NOVA'],
  ];
  const ids: Record<string, Id> = {};
  data.forEach(([company, st, value, prob, ind, owner, contact, ago, next, tick], i) => {
    const domain = company.toLowerCase().replace(/&/g, 'and').replace(/[^a-z]+/g, '') + '.com';
    const first = contact.split(' ').slice(-2, -1)[0]?.replace(/\W/g, '').toLowerCase() || 'hello';
    const values: Record<Id, CellValue> = {
      [P.Company]: V.text(company),
      [P.Stage]: V.status(st),
      [P['Deal value']]: V.money(value),
      [P.Probability]: V.num(prob),
      [P.Industry]: V.sel(ind),
      [P.Owner]: V.sel(owner),
      [P.Contact]: V.text(contact),
      [P.Email]: V.email(`${first}@${domain}`),
      [P.Phone]: V.phone(`+1 (415) 555-${String(1200 + i * 37).slice(-4)}`),
      [P.Website]: V.url(`https://${domain}`),
      [P['Last contacted']]: V.date(dayOf(ctx, -ago)),
      [P['Next step']]: V.text(next),
    };
    if (tick) values[P.Ticker] = V.ticker(`${tick}:XNAS`);
    const r = createRow(ctx, db.id, { values, createdAt: now - (38 - i * 2) * DAY, updatedAt: now - ago * DAY, silent: true, icon: undefined });
    ids[company] = r.id;
  });
  // Rich body on one deal
  ctx.docs.save(
    ids['Northwind Analytics'],
    'row',
    makeDoc([
      b.h2('Account summary'),
      b.p(['Northwind runs ', t.bold('analytics for 40+ retail brands'), '. They want SSO, audit logs and a 99.9% SLA before signing.']),
      b.h3('Stakeholders'),
      b.bullet([t.bold('Elena Park'), ' — VP Operations, champion']),
      b.bullet([t.bold('Raj Mehta'), ' — Security lead, needs the SOC 2 report']),
      b.bullet([t.bold('Tom Becker'), ' — Procurement']),
      b.h3('Open questions'),
      b.todo('Confirm SSO provider (Okta vs Entra ID)', true),
      b.todo('Agree on data residency (EU region)', false),
      b.todo('Send revised MSA', false),
      b.callout('Decision expected before the end of the month.', { icon: emoji('📅'), tone: 'blue' }),
    ]),
  );
  return { db, P, ids };
}

// ───────────────────────────────────────────────────────────────────────────── Projects

function seedProjects(ctx: MockCtx, ws: Id, now: number, parentId: Id | null, crm: ReturnType<typeof seedCrm>) {
  const status = opts([
    ['Backlog', 'gray', 'todo'],
    ['Planned', 'yellow', 'todo'],
    ['In progress', 'blue', 'in_progress'],
    ['In review', 'purple', 'in_progress'],
    ['Done', 'green', 'complete'],
  ]);
  const priority = opts([
    ['Urgent', 'red'],
    ['High', 'orange'],
    ['Medium', 'yellow'],
    ['Low', 'gray'],
  ]);
  const tags = opts([
    ['Design', 'pink'],
    ['Engineering', 'blue'],
    ['Research', 'purple'],
    ['Marketing', 'orange'],
    ['Ops', 'brown'],
    ['Customer', 'green'],
  ]);
  const { db } = createDatabase(ctx, {
    workspaceId: ws,
    parentId,
    title: 'Project tracker',
    icon: emoji('🚀'),
    description: 'Everything the studio is shipping this quarter.',
    createdAt: now - 60 * DAY,
    properties: [
      { name: 'Project', type: 'title' },
      { name: 'Status', type: 'status', config: { options: status } },
      { name: 'Priority', type: 'select', config: { options: priority } },
      { name: 'Owner', type: 'select', config: { options: opts(PEOPLE.map((p, i) => [p, ['blue', 'purple', 'green', 'orange', 'pink'][i]] as [string, string])) } },
      { name: 'Tags', type: 'multi_select', config: { options: tags } },
      { name: 'Timeline', type: 'date' },
      { name: 'Progress', type: 'progress', config: { display: 'bar' } },
      { name: 'Effort', type: 'number', config: { format: 'number', decimals: 0 } },
      { name: 'Budget', type: 'money', config: { currency: 'USD', decimals: 0 } },
      { name: 'Client', type: 'relation', config: { targetDatabaseId: crm.db.id, twoWay: true, limit: 'one' } },
      { name: 'Days left', type: 'formula', config: { expression: 'if(prop("Status") == "Done", "Shipped", if(empty(prop("Timeline")), "", let(d, dateBetween(dateEnd(prop("Timeline")), today(), "days"), if(d < 0, format(abs(d)) + "d overdue", format(d) + "d left"))))' } },
      { name: 'Done', type: 'checkbox' },
      { name: 'ID', type: 'unique_id', config: { prefix: 'PRJ' } },
      { name: 'Repeats', type: 'recurrence' },
      { name: 'Created', type: 'created_time', config: { format: 'relative' } },
    ],
    views: [
      { name: 'Board', layout: 'board' },
      { name: 'All projects', layout: 'table' },
      { name: 'Timeline', layout: 'calendar' },
      { name: 'Effort by status', layout: 'chart' },
      { name: 'My list', layout: 'list' },
    ],
  });
  const P = schemaIds(ctx, db.id);
  const rows: [string, string, string, string, string[], number, number, number, number, string, string | null, string][] = [
    ['Website relaunch', 'In progress', 'Urgent', 'Maya Chen', ['Design', 'Engineering'], -18, 9, 0.62, 13, '24000', 'Juniper Retail Group', '🌐'],
    ['Onboarding checklist v2', 'In review', 'High', 'Priya Natarajan', ['Design', 'Customer'], -10, 2, 0.9, 5, '6000', 'Cobalt Systems', '✅'],
    ['Pricing page experiment', 'Planned', 'Medium', 'Amara Okafor', ['Marketing', 'Research'], 4, 18, 0, 3, '3500', null, '💸'],
    ['SOC 2 Type II audit', 'In progress', 'Urgent', 'Leo Fischer', ['Ops'], -30, 21, 0.45, 21, '38000', null, '🛡️'],
    ['Mobile app beta', 'Backlog', 'High', 'Jonah Reyes', ['Engineering'], 20, 60, 0, 34, '52000', null, '📱'],
    ['Customer interviews · Q4', 'Done', 'Medium', 'Priya Natarajan', ['Research', 'Customer'], -40, -12, 1, 8, '2000', 'Northwind Analytics', '🎙️'],
    ['Data warehouse migration', 'In progress', 'High', 'Jonah Reyes', ['Engineering', 'Ops'], -25, -2, 0.78, 21, '18000', 'Ledgerline', '🗄️'],
    ['Brand refresh', 'Planned', 'Low', 'Maya Chen', ['Design', 'Marketing'], 12, 45, 0, 13, '15000', null, '🎨'],
    ['Helios pilot rollout', 'In review', 'Urgent', 'Amara Okafor', ['Customer'], -14, 3, 0.85, 8, '9000', 'Helios Health', '🏥'],
    ['Support macros cleanup', 'Done', 'Low', 'Leo Fischer', ['Ops', 'Customer'], -20, -15, 1, 2, '0', null, '🧹'],
    ['Quarterly business review deck', 'Backlog', 'Medium', 'Maya Chen', ['Marketing'], 25, 28, 0, 3, '0', 'Cobalt Systems', '📊'],
    ['Billing service refactor', 'In progress', 'Medium', 'Jonah Reyes', ['Engineering'], -6, 14, 0.3, 13, '12000', 'Orbit Payments', '🧾'],
    ['Partner portal discovery', 'Planned', 'Medium', 'Priya Natarajan', ['Research'], 6, 20, 0, 5, '4000', 'Vantage Logistics', '🧭'],
    ['Accessibility audit', 'Done', 'High', 'Amara Okafor', ['Design', 'Engineering'], -35, -21, 1, 8, '7000', null, '♿'],
  ];
  const ids: Record<string, Id> = {};
  rows.forEach(([name, st, pr, owner, tg, s, e, prog, effort, budget, client, icon], i) => {
    const values: Record<Id, CellValue> = {
      [P.Project]: V.text(name),
      [P.Status]: V.status(st),
      [P.Priority]: V.sel(pr),
      [P.Owner]: V.sel(owner),
      [P.Tags]: V.multi(...tg),
      [P.Timeline]: V.date(dayOf(ctx, s), dayOf(ctx, e)),
      [P.Progress]: V.progress(prog),
      [P.Effort]: V.num(effort),
      [P.Budget]: V.money(budget),
      [P.Done]: V.check(st === 'Done'),
    };
    if (client && crm.ids[client]) values[P.Client] = V.rel([crm.ids[client]]);
    if (name === 'Quarterly business review deck') values[P.Repeats] = { t: 'recurrence', v: { rrule: 'FREQ=MONTHLY;INTERVAL=3', dtstart: dayOf(ctx, 25), mode: 'schedule' } };
    if (name === 'Support macros cleanup') values[P.Repeats] = { t: 'recurrence', v: { rrule: 'FREQ=WEEKLY;BYDAY=FR', dtstart: dayOf(ctx, -20), mode: 'completion' } };
    const r = createRow(ctx, db.id, { values, icon: emoji(icon), createdAt: now - (55 - i * 3) * DAY, updatedAt: now - (i % 5) * DAY - 3600_000 * i, silent: true });
    ids[name] = r.id;
  });
  ctx.docs.save(
    ids['Website relaunch'],
    'row',
    makeDoc([
      b.callout('Launch target: two weeks from Friday. Content freeze on Monday.', { icon: emoji('🎯'), tone: 'orange' }),
      b.h2('Goals'),
      b.numbered('Cut time-to-first-value on the homepage in half'),
      b.numbered('Ship the new pricing page with annual toggle'),
      b.numbered('Hit 95+ Lighthouse on mobile'),
      b.h2('Milestones'),
      b.todo('Wireframes signed off', true),
      b.todo('Design system tokens in Figma', true),
      b.todo('Build marketing pages', false),
      b.todo('Content migration', false),
      b.todo('QA + accessibility pass', false),
      b.quote('Make the first screen answer “what is this and why should I care” in five seconds.'),
    ]),
  );
  // Row templates (§8.6)
  const tpl = [
    { id: 'tpl_feature', name: 'Feature project', icon: emoji('✨'), values: { [P.Status]: V.status('Planned'), [P.Priority]: V.sel('Medium'), [P.Tags]: V.multi('Engineering'), [P.Timeline]: '@today+14d', [P.Project]: 'New feature' } as Record<Id, CellValue | string>, doc: makeDoc([b.h2('Problem'), b.p(''), b.h2('Proposal'), b.p(''), b.h2('Success metrics'), b.bullet('')]) },
    { id: 'tpl_research', name: 'Research study', icon: emoji('🔬'), values: { [P.Status]: V.status('Backlog'), [P.Tags]: V.multi('Research'), [P.Timeline]: '@today+7d' } as Record<Id, CellValue | string>, doc: makeDoc([b.h2('Questions'), b.bullet(''), b.h2('Participants'), b.p(''), b.h2('Findings'), b.p('')]) },
  ];
  ctx.db.table<{ id: Id; templates: unknown[]; defaultTemplateId?: Id }>('db_databases').update(db.id, (d) => {
    d.templates = tpl;
  });
  return { db, P, ids };
}

// ───────────────────────────────────────────────────────────────────────────── Reading list

function seedReading(ctx: MockCtx, ws: Id, now: number, rng: Rng) {
  const status = opts([
    ['Want to read', 'gray'],
    ['Reading', 'blue'],
    ['Finished', 'green'],
    ['Abandoned', 'red'],
  ]);
  const genre = opts([
    ['Fiction', 'purple'],
    ['Non-fiction', 'blue'],
    ['Design', 'pink'],
    ['Business', 'orange'],
    ['Science', 'green'],
    ['Biography', 'brown'],
    ['Philosophy', 'yellow'],
    ['Money', 'gray'],
  ]);
  const { db } = createDatabase(ctx, {
    workspaceId: ws,
    parentId: null,
    title: 'Reading list',
    icon: emoji('📖'),
    description: 'Books I want to read, am reading, and loved.',
    createdAt: now - 120 * DAY,
    properties: [
      { name: 'Title', type: 'title' },
      { name: 'Author', type: 'text' },
      { name: 'Cover', type: 'files' },
      { name: 'Status', type: 'select', config: { options: status } },
      { name: 'Genre', type: 'multi_select', config: { options: genre } },
      { name: 'Rating', type: 'rating', config: { max: 5, icon: 'star' } },
      { name: 'Pages', type: 'number', config: { format: 'comma', decimals: 0 } },
      { name: 'Read', type: 'progress', config: { display: 'ring' } },
      { name: 'Finished', type: 'date' },
      { name: 'Link', type: 'url' },
      { name: 'Pages left', type: 'formula', config: { expression: 'round(prop("Pages") * (1 - prop("Read")))' } },
    ],
    views: [
      { name: 'Shelf', layout: 'gallery' },
      { name: 'By status', layout: 'board' },
      { name: 'All books', layout: 'table' },
    ],
  });
  const P = schemaIds(ctx, db.id);
  const books: [string, string, string, string[], number, number, number, number | null][] = [
    ['The Design of Everyday Things', 'Don Norman', 'Finished', ['Design', 'Non-fiction'], 5, 368, 1, -12],
    ['Thinking in Systems', 'Donella Meadows', 'Reading', ['Science', 'Non-fiction'], 0, 240, 0.55, null],
    ['The Left Hand of Darkness', 'Ursula K. Le Guin', 'Finished', ['Fiction'], 5, 304, 1, -40],
    ['The Psychology of Money', 'Morgan Housel', 'Finished', ['Money', 'Business'], 4, 256, 1, -75],
    ['Shape Up', 'Ryan Singer', 'Reading', ['Business', 'Design'], 0, 178, 0.3, null],
    ['Piranesi', 'Susanna Clarke', 'Want to read', ['Fiction'], 0, 272, 0, null],
    ['The Mom Test', 'Rob Fitzpatrick', 'Finished', ['Business'], 4, 136, 1, -20],
    ['Meditations', 'Marcus Aurelius', 'Reading', ['Philosophy'], 0, 254, 0.8, null],
    ['Grid Systems in Graphic Design', 'Josef Müller-Brockmann', 'Want to read', ['Design'], 0, 176, 0, null],
    ['The Overstory', 'Richard Powers', 'Abandoned', ['Fiction'], 2, 502, 0.35, null],
    ['Range', 'David Epstein', 'Finished', ['Non-fiction', 'Science'], 4, 352, 1, -110],
    ['Shoe Dog', 'Phil Knight', 'Finished', ['Biography', 'Business'], 5, 400, 1, -95],
    ['Klara and the Sun', 'Kazuo Ishiguro', 'Want to read', ['Fiction'], 0, 303, 0, null],
    ['The Intelligent Investor', 'Benjamin Graham', 'Reading', ['Money'], 0, 640, 0.18, null],
    ['Working in Public', 'Nadia Eghbal', 'Want to read', ['Non-fiction'], 0, 288, 0, null],
    ['A Pattern Language', 'Christopher Alexander', 'Want to read', ['Design', 'Philosophy'], 0, 1171, 0, null],
  ];
  books.forEach(([title, author, st, g, rating, pages, read, fin], i) => {
    const cover = svgAsset(ctx, ws, `${title}.svg`, bookCover(title, author, i, rng), 400, 600);
    const values: Record<Id, CellValue> = {
      [P.Title]: V.text(title),
      [P.Author]: V.text(author),
      [P.Cover]: V.files([{ assetId: cover, name: `${title}.svg` }]),
      [P.Status]: V.sel(st),
      [P.Genre]: V.multi(...g),
      [P.Pages]: V.num(pages),
      [P.Read]: V.progress(read),
      [P.Link]: V.url(`https://openlibrary.org/search?q=${encodeURIComponent(title)}`),
    };
    if (rating) values[P.Rating] = V.rating(rating);
    if (fin !== null) values[P.Finished] = V.date(dayOf(ctx, fin));
    createRow(ctx, db.id, { values, createdAt: now - (118 - i * 6) * DAY, updatedAt: now - (i % 7) * DAY, silent: true });
  });
  return { db, P };
}

// ───────────────────────────────────────────────────────────────────────────── Content calendar

function seedContent(ctx: MockCtx, ws: Id, now: number, rng: Rng) {
  const channel = opts([
    ['Blog', 'blue'],
    ['Newsletter', 'purple'],
    ['YouTube', 'red'],
    ['LinkedIn', 'green'],
    ['Podcast', 'orange'],
  ]);
  const status = opts([
    ['Idea', 'gray', 'todo'],
    ['Drafting', 'yellow', 'in_progress'],
    ['Editing', 'orange', 'in_progress'],
    ['Scheduled', 'blue', 'in_progress'],
    ['Published', 'green', 'complete'],
  ]);
  const { db } = createDatabase(ctx, {
    workspaceId: ws,
    parentId: null,
    title: 'Content calendar',
    icon: emoji('🗓️'),
    description: 'What goes out, where, and when.',
    createdAt: now - 70 * DAY,
    properties: [
      { name: 'Title', type: 'title' },
      { name: 'Publish date', type: 'date' },
      { name: 'Channel', type: 'select', config: { options: channel } },
      { name: 'Status', type: 'status', config: { options: status } },
      { name: 'Author', type: 'select', config: { options: opts(PEOPLE.map((p, i) => [p, ['blue', 'purple', 'green', 'orange', 'pink'][i]] as [string, string])) } },
      { name: 'Words', type: 'number', config: { format: 'comma', decimals: 0 } },
      { name: 'Views', type: 'number', config: { format: 'comma', decimals: 0 } },
      { name: 'Link', type: 'url' },
      { name: 'Reading time', type: 'formula', config: { expression: 'if(empty(prop("Words")), "", format(ceil(prop("Words") / 220)) + " min read")' } },
    ],
    views: [
      { name: 'Calendar', layout: 'calendar' },
      { name: 'Pipeline', layout: 'board' },
      { name: 'Everything', layout: 'table' },
      { name: 'Mix by channel', layout: 'chart' },
    ],
  });
  const P = schemaIds(ctx, db.id);
  const titles: [string, string][] = [
    ['How we plan a quarter in one afternoon', 'Blog'],
    ['Five calm habits for busy founders', 'Newsletter'],
    ['Inside our design review ritual', 'YouTube'],
    ['What we learned from 40 customer calls', 'LinkedIn'],
    ['The case for boring technology', 'Blog'],
    ['Episode 12 · Pricing with conviction', 'Podcast'],
    ['Monthly product update', 'Newsletter'],
    ['A tour of our home office setups', 'YouTube'],
    ['Hiring our first designer', 'LinkedIn'],
    ['Local-first software, explained', 'Blog'],
    ['Episode 13 · Small teams, big leverage', 'Podcast'],
    ['Year in review: what shipped', 'Blog'],
    ['Weekly digest #46', 'Newsletter'],
    ['Weekly digest #47', 'Newsletter'],
    ['Weekly digest #48', 'Newsletter'],
    ['Weekly digest #49', 'Newsletter'],
    ['Behind the scenes: brand refresh', 'YouTube'],
    ['Keyboard shortcuts that save an hour a week', 'Blog'],
    ['Why we write everything down', 'LinkedIn'],
    ['Episode 14 · Saying no to features', 'Podcast'],
    ['Designing for focus', 'Blog'],
    ['Customer story: Juniper Retail', 'Blog'],
    ['Office hours livestream', 'YouTube'],
    ['Holiday reading list', 'Newsletter'],
    ['Q1 roadmap preview', 'LinkedIn'],
    ['Episode 15 · Calm growth', 'Podcast'],
  ];
  const offsets = [-26, -23, -19, -16, -13, -11, -9, -6, -5, -3, -2, 0, -20, -13, -6, 1, 3, 4, 6, 8, 10, 12, 15, 18, 22, 27];
  titles.forEach(([title, ch], i) => {
    const off = offsets[i] ?? i;
    const st = off < -1 ? 'Published' : off <= 3 ? (i % 2 ? 'Scheduled' : 'Editing') : off < 12 ? 'Drafting' : 'Idea';
    const words = ch === 'YouTube' || ch === 'Podcast' ? null : ch === 'LinkedIn' ? rng.int(180, 420) : rng.int(900, 2600);
    const values: Record<Id, CellValue> = {
      [P.Title]: V.text(title),
      [P['Publish date']]: V.date(dayOf(ctx, off)),
      [P.Channel]: V.sel(ch),
      [P.Status]: V.status(st),
      [P.Author]: V.sel(PEOPLE[i % PEOPLE.length]),
    };
    if (words) values[P.Words] = V.num(words);
    if (st === 'Published') {
      values[P.Views] = V.num(Math.round((ch === 'YouTube' ? 9000 : ch === 'Blog' ? 4200 : 1800) * (0.4 + rng.next() * 1.4)));
      values[P.Link] = V.url(`https://studio.example.com/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '')}`);
    }
    createRow(ctx, db.id, { values, createdAt: now - (68 - i * 2) * DAY, updatedAt: now - Math.max(0, -off) * DAY, silent: true });
  });
  return { db, P };
}

// ───────────────────────────────────────────────────────────────────────────── helpers

function schemaIds(ctx: MockCtx, dbId: Id): Record<string, Id> {
  const out: Record<string, Id> = {};
  for (const p of ctx.db.table<{ id: Id; name: string; databaseId: Id; deletedAt?: number }>('db_properties').values()) {
    if (p.databaseId === dbId && !p.deletedAt) out[p.name] = p.id;
  }
  return out;
}

function viewIds(ctx: MockCtx, dbId: Id): Record<string, Id> {
  const out: Record<string, Id> = {};
  for (const v of ctx.db.table<{ id: Id; name: string; databaseId: Id }>('db_views').values()) if (v.databaseId === dbId) out[v.name] = v.id;
  return out;
}

function patchView(ctx: MockCtx, id: Id, patch: Record<string, unknown>): void {
  ctx.db.table<{ id: Id } & Record<string, unknown>>('db_views').update(id, (v) => Object.assign(v, patch));
}

// ───────────────────────────────────────────────────────────────────────────── perf

function seedPerf(ctx: MockCtx, ws: Id, now: number): void {
  const rng = createRng('emp:perf-db');
  const status = opts([
    ['Open', 'gray', 'todo'],
    ['Active', 'blue', 'in_progress'],
    ['Blocked', 'red', 'in_progress'],
    ['Closed', 'green', 'complete'],
  ]);
  const region = opts([
    ['North America', 'blue'],
    ['Europe', 'green'],
    ['APAC', 'orange'],
    ['LATAM', 'purple'],
    ['Africa', 'brown'],
  ]);
  const tags = opts(['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'].map((n, i) => [n, ['blue', 'pink', 'green', 'orange', 'purple', 'yellow'][i]] as [string, string]));
  const { db } = createDatabase(ctx, {
    workspaceId: ws,
    parentId: null,
    title: 'Orders (10k rows)',
    icon: emoji('📦'),
    createdAt: now - 400 * DAY,
    properties: [
      { name: 'Order', type: 'title' },
      { name: 'Status', type: 'status', config: { options: status } },
      { name: 'Region', type: 'select', config: { options: region } },
      { name: 'Tags', type: 'multi_select', config: { options: tags } },
      { name: 'Amount', type: 'money', config: { currency: 'USD', decimals: 2 } },
      { name: 'Quantity', type: 'number', config: { format: 'comma', decimals: 0 } },
      { name: 'Ordered', type: 'date' },
      { name: 'Paid', type: 'checkbox' },
      { name: 'Customer', type: 'text' },
      { name: 'Email', type: 'email' },
      { name: 'Score', type: 'rating', config: { max: 5 } },
      { name: 'Fulfilment', type: 'progress' },
      { name: 'Unit price', type: 'formula', config: { expression: 'if(prop("Quantity") > 0, prop("Amount") / prop("Quantity"), 0)' } },
      { name: 'SKU', type: 'unique_id', config: { prefix: 'ORD' } },
    ],
    views: [{ name: 'All orders', layout: 'table' }, { name: 'By status', layout: 'board' }],
  });
  const P = schemaIds(ctx, db.id);
  const first = ['Ava', 'Ben', 'Chloe', 'Dev', 'Ella', 'Finn', 'Gia', 'Hugo', 'Isla', 'Jude', 'Kai', 'Lena', 'Milo', 'Nora', 'Omar', 'Pia'];
  const last = ['Stone', 'Rivera', 'Kowalski', 'Nguyen', 'Haddad', 'Larsen', 'Moreau', 'Silva', 'Tanaka', 'Becker', 'Okoye', 'Rossi'];
  for (let i = 0; i < 10_000; i++) {
    const name = `${rng.pick(first)} ${rng.pick(last)}`;
    const qty = rng.int(1, 40);
    const values: Record<Id, CellValue> = {
      [P.Order]: V.text(`Order #${String(100000 + i)}`),
      [P.Status]: V.status(rng.pick(status).name),
      [P.Region]: V.sel(rng.pick(region).name),
      [P.Tags]: { t: 'multi', v: rng.shuffle(tags.map((x) => x.id)).slice(0, rng.int(0, 3)) },
      [P.Amount]: V.money((qty * rng.float(4, 220)).toFixed(2)),
      [P.Quantity]: V.num(qty),
      [P.Ordered]: V.date(dayOf(ctx, -rng.int(0, 400))),
      [P.Paid]: V.check(rng.chance(0.7)),
      [P.Customer]: V.text(name),
      [P.Email]: V.email(`${name.toLowerCase().replace(' ', '.')}@example.com`),
      [P.Score]: V.rating(rng.int(1, 5)),
      [P.Fulfilment]: V.progress(Math.round(rng.next() * 20) / 20),
    };
    createRow(ctx, db.id, { values, createdAt: now - (10_000 - i) * 3_600_000, silent: true });
  }
  refreshResultTypes(ctx, db.id);
  const V2 = viewIds(ctx, db.id);
  patchView(ctx, V2['All orders'], { footerAggs: { [P.Amount]: 'sum', [P.Quantity]: 'avg', [P.Paid]: 'pct_checked', [P.Order]: 'count' }, propWidths: { [P.Order]: 200 } });
}

// ───────────────────────────────────────────────────────────────────────────── seed

export function seed(ctx: MockCtx): void {
  const ws = ctx.db.table<{ id: string }>('workspaces').all()[0]?.id;
  if (!ws) return;
  const now = ctx.clock.now();
  if (ctx.seedKind === 'perf') {
    seedPerf(ctx, ws, now);
    return;
  }
  if (ctx.seedKind !== 'demo') return;
  const rng = createRng('emp:databases');

  const crm = seedCrm(ctx, ws, now);
  const projectsParent = ctx.seedRefs.get('core.page.projects') ?? null;
  const projects = seedProjects(ctx, ws, now, projectsParent && ctx.pages.get(projectsParent) ? projectsParent : null, crm);
  const reading = seedReading(ctx, ws, now, rng);
  const content = seedContent(ctx, ws, now, rng);

  // CRM: rollup of linked projects + view setup (the Projects relation created a dual "Client CRM" ← "Project tracker").
  const C = schemaIds(ctx, crm.db.id);
  const dualId = C['Project tracker'];
  if (dualId) {
    ctx.db.table<{ id: Id; name: string }>('db_properties').update(dualId, (p) => void (p.name = 'Projects'));
    createPropertySafe(ctx, crm.db.id, { name: 'Active projects', type: 'rollup', config: { relationPropId: dualId, targetPropId: projects.P.Status, fn: 'count_values' } });
    createPropertySafe(ctx, crm.db.id, { name: 'Project budget', type: 'rollup', config: { relationPropId: dualId, targetPropId: projects.P.Budget, fn: 'sum' } });
  }
  const C2 = schemaIds(ctx, crm.db.id);
  const cv = viewIds(ctx, crm.db.id);
  patchView(ctx, cv.Pipeline, {
    visibleProps: [C2.Company, C2.Stage, C2['Deal value'], C2.Probability, C2.Weighted, C2.Owner, C2.Industry, C2['Last contacted'], C2['Next step'], C2.Projects, C2['Project budget'], C2.Account, C2.Contact, C2.Email, C2.Website, C2.Ticker].filter(Boolean),
    footerAggs: { [C2.Company]: 'count', [C2['Deal value']]: 'sum', [C2.Weighted]: 'sum', [C2.Probability]: 'avg' },
    propWidths: { [C2.Company]: 220, [C2['Next step']]: 260, [C2.Stage]: 130 },
    sorts: [{ prop: C2['Deal value'], dir: 'desc' }],
  });
  patchView(ctx, cv['By stage'], { visibleProps: [C2['Deal value'], C2.Owner, C2['Next step']], card: { preview: 'none', size: 'm', fit: false }, filter: { prop: C2.Stage, op: 'neq', value: 'o_lost' } });
  patchView(ctx, cv.Forecast, { chart: { type: 'bar', x: { prop: C2.Stage }, y: [{ agg: 'sum', prop: C2['Deal value'] }], labels: true, omitZero: true }, filter: { prop: C2.Stage, op: 'neq', value: 'o_lost' } });

  // Projects views
  const pv = viewIds(ctx, projects.db.id);
  const PP = projects.P;
  patchView(ctx, pv.Board, { visibleProps: [PP.Priority, PP.Owner, PP.Tags, PP.Timeline, PP.Progress, PP['Days left']], groupBy: { prop: PP.Status }, card: { preview: 'none', size: 'm', fit: false } });
  patchView(ctx, pv['All projects'], {
    visibleProps: [PP.Project, PP.Status, PP.Priority, PP.Owner, PP.Tags, PP.Timeline, PP['Days left'], PP.Progress, PP.Effort, PP.Budget, PP.Client, PP.ID, PP.Done, PP.Repeats, PP.Created],
    footerAggs: { [PP.Project]: 'count', [PP.Effort]: 'sum', [PP.Budget]: 'sum', [PP.Progress]: 'avg', [PP.Done]: 'pct_checked' },
    propWidths: { [PP.Project]: 240, [PP.Tags]: 190, [PP.Timeline]: 200 },
    sorts: [{ prop: PP.Status, dir: 'asc' }, { prop: PP.Priority, dir: 'asc' }],
  });
  patchView(ctx, pv.Timeline, { calendar: { dateProp: PP.Timeline, showWeekends: true }, visibleProps: [PP.Status, PP.Owner] });
  patchView(ctx, pv['Effort by status'], { chart: { type: 'bar', x: { prop: PP.Owner }, y: [{ agg: 'sum', prop: PP.Effort }], series: { prop: PP.Status }, stacked: true } });
  patchView(ctx, pv['My list'], { visibleProps: [PP.Status, PP.Owner, PP.Timeline, PP.Progress], groupBy: { prop: PP.Priority }, filter: { prop: PP.Owner, op: 'any_of', value: ['o_maya_chen', 'o_jonah_reyes'] } });

  // Reading views
  const rv = viewIds(ctx, reading.db.id);
  const RP = reading.P;
  patchView(ctx, rv.Shelf, { card: { preview: RP.Cover, size: 'm', fit: true }, visibleProps: [RP.Author, RP.Rating, RP.Status], sorts: [{ prop: RP.Status, dir: 'asc' }] });
  patchView(ctx, rv['By status'], { card: { preview: RP.Cover, size: 's', fit: true }, visibleProps: [RP.Author, RP.Read], groupBy: { prop: RP.Status } });
  patchView(ctx, rv['All books'], {
    visibleProps: [RP.Title, RP.Author, RP.Status, RP.Genre, RP.Rating, RP.Pages, RP.Read, RP['Pages left'], RP.Finished, RP.Link, RP.Cover],
    footerAggs: { [RP.Title]: 'count', [RP.Pages]: 'sum', [RP.Rating]: 'avg' },
    propWidths: { [RP.Title]: 260 },
  });

  // Content views
  const ccv = viewIds(ctx, content.db.id);
  const CP = content.P;
  patchView(ctx, ccv.Calendar, { calendar: { dateProp: CP['Publish date'], showWeekends: true }, visibleProps: [CP.Channel] });
  patchView(ctx, ccv.Pipeline, { visibleProps: [CP.Channel, CP['Publish date'], CP.Author, CP['Reading time']], groupBy: { prop: CP.Status } });
  patchView(ctx, ccv.Everything, {
    visibleProps: [CP.Title, CP['Publish date'], CP.Channel, CP.Status, CP.Author, CP.Words, CP['Reading time'], CP.Views, CP.Link],
    footerAggs: { [CP.Title]: 'count', [CP.Words]: 'sum', [CP.Views]: 'sum' },
    propWidths: { [CP.Title]: 300 },
    sorts: [{ prop: CP['Publish date'], dir: 'desc' }],
    groupBy: { prop: CP.Channel },
  });
  patchView(ctx, ccv['Mix by channel'], { chart: { type: 'donut', x: { prop: CP.Channel }, y: [{ agg: 'count' }] } });

  // Linked views on core pages
  if (projectsParent && ctx.pages.get(projectsParent)) {
    appendBlocks(ctx, projectsParent, [b.h2('Tracker'), b.databaseView(projects.db.id, pv.Board, { linked: true })]);
  }
  const notes = ctx.pages.table().find((p) => p.title === 'Reading notes' && !p.deletedAt);
  if (notes) appendBlocks(ctx, notes.id, [b.h2('The shelf'), b.databaseView(reading.db.id, rv.Shelf, { linked: true })]);

  // An inline database inside "Writing in EMP" → Live blocks
  const writing = ctx.seedRefs.get('core.page.blocks');
  if (writing && ctx.pages.get(writing)) {
    const inline = createDatabase(ctx, {
      workspaceId: ws,
      parentId: writing,
      title: 'Weekend trip packing',
      inline: true,
      properties: [
        { name: 'Item', type: 'title' },
        { name: 'Packed', type: 'checkbox' },
        { name: 'Bag', type: 'select', config: { options: opts([['Backpack', 'blue'], ['Carry-on', 'purple'], ['Tote', 'orange']]) } },
        { name: 'Qty', type: 'number', config: { format: 'number', decimals: 0 } },
      ],
      views: [{ name: 'Checklist', layout: 'table' }, { name: 'By bag', layout: 'board' }],
    });
    const I = schemaIds(ctx, inline.db.id);
    const items: [string, boolean, string, number][] = [
      ['Passport', true, 'Backpack', 1],
      ['Rain jacket', true, 'Carry-on', 1],
      ['Chargers & cables', false, 'Backpack', 3],
      ['Walking shoes', false, 'Carry-on', 1],
      ['Book for the train', true, 'Tote', 1],
      ['Snacks', false, 'Tote', 4],
    ];
    for (const [item, packed, bag, qty] of items) createRow(ctx, inline.db.id, { values: { [I.Item]: V.text(item), [I.Packed]: V.check(packed), [I.Bag]: V.sel(bag), [I.Qty]: V.num(qty) }, silent: true });
    const iv = viewIds(ctx, inline.db.id);
    patchView(ctx, iv.Checklist, { footerAggs: { [I.Packed]: 'pct_checked', [I.Qty]: 'sum' }, propWidths: { [I.Item]: 220 } });
    patchView(ctx, iv['By bag'], { groupBy: { prop: I.Bag }, visibleProps: [I.Packed, I.Qty] });
    const blocks: TipTapNode[] = [b.h3('Inline database'), b.p('Databases can live right inside a page. Try switching to the board, or add a row.'), b.databaseView(inline.db.id, iv.Checklist)];
    appendBlocks(ctx, writing, blocks);
  }

  for (const id of [crm.db.id, projects.db.id, reading.db.id, content.db.id]) refreshResultTypes(ctx, id);
  ctx.seedRefs.set('db.crm', crm.db.id);
  ctx.seedRefs.set('db.projects', projects.db.id);
  ctx.seedRefs.set('db.reading', reading.db.id);
  ctx.seedRefs.set('db.content', content.db.id);
}

function createPropertySafe(ctx: MockCtx, dbId: Id, np: NewProp): void {
  try {
    createProperty(ctx, dbId, np, undefined, { silent: true });
  } catch (err) {
    console.error('[emp mock] databases seed: property failed', err);
  }
}
