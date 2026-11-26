/** Mock-only: Life OS generator (§16.6) — Today dashboard, Tasks / Projects / Areas / Daily notes databases, views. */
import type { Id } from '@/backend/types';
import { createReminder } from '@/backend/mock/commands/reminder';
import { LIFE_AREAS } from '../engine/manifests';
import { md } from './content';
import { c, DAY, F, isoDay, lucide, multi, P, prng, sel, type DbHandle, type Env } from './env';

export const TASK_STATUSES = [
  { name: 'Inbox', color: 'gray', group: 'todo' as const },
  { name: 'Next', color: 'blue', group: 'todo' as const },
  { name: 'Scheduled', color: 'purple', group: 'in_progress' as const },
  { name: 'Waiting', color: 'orange', group: 'in_progress' as const },
  { name: 'Someday', color: 'brown', group: 'todo' as const },
  { name: 'Done', color: 'green', group: 'complete' as const },
];
const PRIORITIES = [
  { name: 'P1', color: 'red' },
  { name: 'P2', color: 'orange' },
  { name: 'P3', color: 'blue' },
  { name: 'P4', color: 'gray' },
];
const QUADRANTS = [
  { name: 'Do now', color: 'red' },
  { name: 'Schedule', color: 'blue' },
  { name: 'Delegate', color: 'orange' },
  { name: 'Drop', color: 'gray' },
];
const AREA_ICON: Record<string, string> = { Work: 'briefcase', Health: 'heart-pulse', Money: 'piggy-bank', Home: 'house', Relationships: 'heart', Learning: 'library', Fun: 'party-popper', 'Side project': 'wrench', Family: 'users', Community: 'handshake' };
const AREA_STANDARD: Record<string, string> = {
  Work: 'Clear priorities each week; no surprises for my team.',
  Health: 'Move daily, sleep 7+ hours, check-ups on time.',
  Money: 'Bills on autopay, budget reviewed weekly.',
  Home: 'Tidy, safe, and maintained before things break.',
  Relationships: 'Make time for the people who matter.',
  Learning: 'Always reading something; one course a quarter.',
  Fun: 'Something to look forward to every month.',
  'Side project': 'Ship small, ship often.',
  Family: 'Present at dinner; weekends protected.',
  Community: 'Show up for neighbours and causes I care about.',
};


export async function installLifeOs(env: Env): Promise<void> {
  const { ctx, answers } = env;
  const priority = String(answers.priority ?? 'p1p4');
  const areas = (Array.isArray(answers.areas) ? (answers.areas as string[]) : ['Work', 'Health', 'Home']).filter((a) => typeof a === 'string').slice(0, 20);

  await env.step('Setting up Areas');
  const areasDb = env.database('areas_db', {
    title: 'Areas',
    icon: lucide('compass'),
    props: [P.title('Name', 'area.name'), P.text('Standard', 'area.standard'), P.text('Icon')],
    firstView: { name: 'All areas', layout: 'gallery' },
  });
  const areaIds: Record<string, Id> = {};
  for (const a of areas) areaIds[a] = env.row(areasDb, { Name: c.text(a), Standard: c.text(AREA_STANDARD[a] ?? ''), Icon: c.text('') }, { icon: lucide(AREA_ICON[a] ?? 'compass'), sample: false });

  await env.step('Creating Projects');
  const projects = env.database('projects', {
    title: 'Projects',
    icon: lucide('target'),
    props: [
      P.title('Name', 'project.name'),
      P.rel('Area', areasDb.id, 'project.area', 'one'),
      P.select('Status', [{ name: 'Active', color: 'blue' }, { name: 'Planned', color: 'gray' }, { name: 'On hold', color: 'orange' }, { name: 'Done', color: 'green' }], 'project.status'),
      P.text('Outcome', 'project.outcome'),
      P.date('Deadline', 'project.deadline'),
      P.progress('Progress', 'project.progress'),
      P.text('Next action', 'project.next'),
      P.date('Review date', 'project.review'),
    ],
    firstView: { name: 'Active', layout: 'table' },
  });
  env.view(projects, 'Board', 'board', { groupBy: { prop: projects.props.Status.id } });

  await env.step('Creating Tasks with your views');
  const tasks = env.database('tasks', {
    title: 'Tasks',
    icon: lucide('circle-check'),
    description: 'Every task in one place. Views slice it into Inbox, Due, Upcoming and more.',
    props: [
      P.title('Title', 'task.title'),
      P.status('Status', TASK_STATUSES, 'task.status'),
      priority === 'eisenhower' ? P.select('Quadrant', QUADRANTS, 'task.priority') : P.select('Priority', PRIORITIES, 'task.priority'),
      P.date('Due', 'task.due'),
      P.date('Scheduled', 'task.scheduled'),
      P.num('Estimate (min)', 'task.estimate'),
      P.rel('Area', areasDb.id, 'task.area', 'one'),
      P.rel('Project', projects.id, 'task.project', 'one'),
      P.multi('Context', ['@home', '@computer', '@errands', '@calls'], 'task.context'),
      P.select('Energy', [{ name: 'High', color: 'red' }, { name: 'Medium', color: 'yellow' }, { name: 'Low', color: 'green' }], 'task.energy'),
      P.recurrence('Repeat', 'task.recurrence'),
      P.text('Waiting on', 'task.waiting'),
      P.select('Source', ['Manual', 'Quick add', 'Calendar', 'Recurring', 'Import'], 'task.source'),
      P.date('Completed at', 'task.completed'),
      P.check('Top 3', 'task.top3'),
    ],
    firstView: { name: 'Inbox', layout: 'list' },
  });
  const prioName = priority === 'eisenhower' ? 'Quadrant' : 'Priority';
  setViewFilter(env, tasks, 'Inbox', F.eq(tasks, 'Status', 'Inbox'), [F.sort(tasks, 'Due')]);
  env.view(tasks, 'Due', 'list', {
    filter: F.and(F.noneOf(tasks, 'Status', ['Done']), F.or(F.within(tasks, 'Due', 'today'), F.within(tasks, 'Scheduled', 'today'), F.before(tasks, 'Due', env.today))),
    sorts: [F.sort(tasks, 'Scheduled'), F.sort(tasks, prioName)],
    visibleProps: F.visible(tasks, ['Title', prioName, 'Due', 'Scheduled', 'Project']),
  });
  env.view(tasks, 'Upcoming', 'calendar', { calendar: { dateProp: tasks.props.Due.id, showWeekends: true } });
  env.view(tasks, 'Board', 'board', { groupBy: { prop: tasks.props.Status.id }, filter: F.noneOf(tasks, 'Status', ['Done']) });
  if (env.on('eisenhower')) env.view(tasks, 'Eisenhower', 'board', { groupBy: { prop: tasks.props.Quadrant?.id ?? tasks.props.Status.id }, filter: F.noneOf(tasks, 'Status', ['Done']) });
  env.view(tasks, 'Someday', 'list', { filter: F.eq(tasks, 'Status', 'Someday') });
  env.view(tasks, 'Waiting', 'table', { filter: F.eq(tasks, 'Status', 'Waiting'), visibleProps: F.visible(tasks, ['Title', 'Waiting on', 'Due', 'Project']) });
  env.view(tasks, 'Completed', 'table', { filter: F.eq(tasks, 'Status', 'Done'), sorts: [F.sort(tasks, 'Completed at', 'desc')], visibleProps: F.visible(tasks, ['Title', 'Completed at', 'Project', 'Area']) });
  env.view(tasks, 'All tasks', 'table', { visibleProps: F.visible(tasks, ['Title', 'Status', prioName, 'Due', 'Project', 'Area', 'Context']) });

  let resources: DbHandle | null = null;
  if (env.on('resources')) {
    await env.step('Adding Resources');
    resources = env.database('resources', {
      title: 'Resources',
      icon: lucide('library'),
      props: [P.title('Name'), P.rel('Area', areasDb.id, undefined, 'one'), P.select('Type', ['Article', 'Book', 'Course', 'Reference', 'Tool']), P.url('Link')],
      firstView: { name: 'All resources', layout: 'gallery' },
    });
  }

  await env.step('Creating Daily notes');
  const daily = env.database('daily', {
    title: 'Daily notes',
    icon: lucide('notebook'),
    props: [P.title('Day'), P.date('Date', 'daily.date'), P.text('Top 3', 'daily.top3'), P.text('Log', 'daily.log'), P.text('Gratitude', 'daily.gratitude'), P.check('Shutdown done', 'daily.shutdown')],
    firstView: { name: 'Recent', layout: 'table' },
  });

  let goals: DbHandle | null = null;
  if (env.on('goals')) {
    goals = env.database('goals', {
      title: 'Goals',
      icon: lucide('mountain'),
      props: [P.title('Goal', 'goal.name'), P.rel('Area', areasDb.id, undefined, 'one'), P.date('Target date', 'goal.date'), P.progress('Progress', 'goal.progress'), P.select('Status', [{ name: 'On track', color: 'green' }, { name: 'At risk', color: 'orange' }, { name: 'Achieved', color: 'blue' }])],
      firstView: { name: 'Goals', layout: 'gallery' },
    });
  }

  await env.step('Writing your weekly review');
  env.page('weekly', {
    title: 'Weekly review',
    icon: lucide('repeat'),
    blocks: md(`> [!tip] About 30 minutes, ideally ${ritualLabel(answers, 'weekly', 'Friday 4:00 PM')}. Tick items as you go.
## 1 · Get clear
- [ ] Empty your inbox to zero — every item becomes Next, Someday, Waiting or Done
- [ ] Clear your desk, downloads and notes
## 2 · Get current
- [ ] Look back over last week's calendar for loose ends
- [ ] Look ahead at the next two weeks
- [ ] Every active project has a next action
- [ ] Review the Waiting list — nudge anyone overdue
- [ ] Read this week's insights
## 3 · Get creative
- [ ] Skim Someday — promote anything that now matters
- [ ] Capture new ideas
## 4 · Choose next week's Top 3
1.
2.
3. `),
  });

  if (env.on('ritual_rem')) {
    await env.step('Scheduling your rituals');
    const root = env.inst.rootPageId;
    const base = startOfDayMs(env.now);
    const mk = (offsetDays: number, hhmm: string, text: string, everyDays: number) => {
      const [h, m] = hhmm.split(':').map(Number);
      let fire = base + offsetDays * DAY + (h * 60 + m) * 60_000;
      while (fire <= env.now) fire += everyDays * DAY;
      createReminder(ctx, { fireAt: fire, targetKind: 'page', targetId: root, text, instanceId: env.inst.id, everyMs: everyDays * DAY });
    };
    mk(0, ritualTime(answers, 'daily', '08:30'), 'Plan your day — pick today’s Top 3', 1);
    mk(0, ritualTime(answers, 'shutdown', '17:30'), 'Shutdown: capture loose ends and plan tomorrow', 1);
    mk(daysUntil(env.now, 5), ritualTime(answers, 'weekly', '16:00'), 'Weekly review', 7);
    mk(daysUntilMonthStart(env.now), ritualTime(answers, 'monthly', '09:00'), 'Monthly reset', 30);
  }

  if (env.sample) {
    await env.step('Adding example tasks');
    sampleLifeOs(env, { tasks, projects, areasDb, daily, goals, resources, areaIds, prioName });
  }
  for (const h of [areasDb, projects, tasks, daily, ...(resources ? [resources] : []), ...(goals ? [goals] : [])]) if (!ctx.seeding) env.db.emitChanged(ctx, h.id);
}

function setViewFilter(env: Env, h: DbHandle, viewName: string, filter: ReturnType<typeof F.eq>, sorts: ReturnType<typeof F.sort>[]) {
  const id = h.views[viewName];
  if (!id) return;
  env.ctx.db.table<{ id: Id; filter?: unknown; sorts: unknown[] }>('db_views').update(id, (v) => {
    v.filter = filter;
    v.sorts = sorts;
  });
}

function ritualTime(answers: Record<string, unknown>, key: string, fallback: string): string {
  const r = answers.rituals as Record<string, { time?: string }> | undefined;
  const t = r?.[key]?.time;
  return typeof t === 'string' && /^\d{2}:\d{2}$/.test(t) ? t : fallback;
}
function ritualLabel(answers: Record<string, unknown>, key: string, fallback: string): string {
  const r = answers.rituals as Record<string, { rrule?: string; time?: string }> | undefined;
  const rr = r?.[key];
  if (!rr?.rrule) return fallback;
  const day = /BYDAY=([A-Z,]+)/.exec(rr.rrule)?.[1]?.split(',')[0];
  const names: Record<string, string> = { MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' };
  const [h, m] = (rr.time ?? '16:00').split(':').map(Number);
  const hh = ((h + 11) % 12) + 1;
  return `${day ? names[day] ?? 'Friday' : 'Friday'} ${hh}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
const startOfDayMs = (ms: number) => Math.floor(ms / DAY) * DAY;
function daysUntil(now: number, weekday: number): number {
  const d = new Date(now).getUTCDay();
  return (weekday - d + 7) % 7;
}
function daysUntilMonthStart(now: number): number {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return Math.round((next - startOfDayMs(now)) / DAY);
}

// ───────────────────────────────────────────────────────────────────────────── sample data

export function sampleLifeOs(
  env: Env,
  h: { tasks: DbHandle; projects: DbHandle; areasDb: DbHandle; daily: DbHandle; goals: DbHandle | null; resources: DbHandle | null; areaIds: Record<string, Id>; prioName: string },
) {
  const { tasks, projects, daily, areaIds, prioName } = h;
  const rnd = prng(606);
  const day = (n: number) => isoDay(env.now + n * DAY);
  const area = (name: string) => areaIds[name] ?? areaIds[Object.keys(areaIds)[0]] ?? null;
  const pr = (p: 1 | 2 | 3 | 4) => (prioName === 'Quadrant' ? sel(['Do now', 'Schedule', 'Delegate', 'Drop'][p - 1]) : sel(`P${p}`));

  const proj = (name: string, areaName: string, status: string, outcome: string, deadline: number | null, icon: string) =>
    env.row(projects, { Name: c.text(name), Area: c.rel([area(areaName)]), Status: sel(status), Outcome: c.text(outcome), Deadline: deadline === null ? null : c.date(day(deadline)), 'Review date': c.date(day(3)) }, { icon: lucide(icon) });
  const pWeb = proj('Website relaunch', 'Work', 'Active', 'New marketing site live with case studies', 18, 'rocket');
  const pKitchen = proj('Kitchen refresh', 'Home', 'Active', 'Painted cabinets, new lighting, under budget', 40, 'house');
  const pRun = proj('Run a half marathon', 'Health', 'Active', 'Finish the spring half under 2:05', 120, 'footprints');
  const pLang = proj('Conversational Portuguese', 'Learning', 'Active', 'Hold a 10-minute conversation in Lisbon', 95, 'languages');
  proj('Plan summer trip', 'Fun', 'Planned', 'Booked flights and lodging by March', 70, 'luggage');

  type T = { title: string; status: string; p?: 1 | 2 | 3 | 4; due?: number; sched?: [number, string, string]; est?: number; area?: string; project?: Id; ctxs?: string[]; energy?: string; waiting?: string; done?: number; top3?: boolean; source?: string; repeat?: string };
  const list: T[] = [
    // today
    { title: 'Finalize homepage copy with Maya', status: 'Scheduled', p: 1, due: 0, sched: [0, '09:30', '10:30'], est: 60, area: 'Work', project: pWeb, ctxs: ['@computer'], energy: 'High', top3: true },
    { title: 'Review case-study drafts', status: 'Scheduled', p: 2, sched: [0, '13:30', '14:15'], est: 45, area: 'Work', project: pWeb, ctxs: ['@computer'], energy: 'Medium', top3: true },
    { title: 'Easy 5k run', status: 'Scheduled', p: 2, sched: [0, '18:00', '18:40'], est: 40, area: 'Health', project: pRun, energy: 'Medium', top3: true, repeat: 'FREQ=WEEKLY;BYDAY=TU,TH,SA' },
    { title: 'Call the electrician about under-cabinet lights', status: 'Next', p: 2, due: 0, est: 15, area: 'Home', project: pKitchen, ctxs: ['@calls'], energy: 'Low' },
    { title: 'Pay the water bill', status: 'Next', p: 1, due: 0, est: 5, area: 'Money', ctxs: ['@computer'], energy: 'Low', repeat: 'FREQ=MONTHLY;BYMONTHDAY=26' },
    // overdue
    { title: 'Send invoice to Acme Bakery', status: 'Next', p: 1, due: -2, est: 15, area: 'Work', ctxs: ['@computer'], energy: 'Low' },
    { title: 'Book dentist check-up', status: 'Next', p: 3, due: -5, est: 10, area: 'Health', ctxs: ['@calls'], energy: 'Low' },
    // upcoming
    { title: 'Pick paint samples for cabinets', status: 'Next', p: 3, due: 2, est: 30, area: 'Home', project: pKitchen, ctxs: ['@errands'], energy: 'Low' },
    { title: 'Portuguese lesson — past tense', status: 'Scheduled', p: 3, sched: [1, '07:30', '08:00'], est: 30, area: 'Learning', project: pLang, energy: 'Medium', repeat: 'FREQ=WEEKLY;BYDAY=MO,WE,FR' },
    { title: 'Long run · 14 km', status: 'Scheduled', p: 2, sched: [3, '08:00', '09:30'], est: 90, area: 'Health', project: pRun, energy: 'High' },
    { title: 'Launch checklist walkthrough', status: 'Next', p: 1, due: 4, est: 60, area: 'Work', project: pWeb, ctxs: ['@computer'], energy: 'High' },
    { title: 'Renew passport', status: 'Next', p: 2, due: 9, est: 30, area: 'Fun', ctxs: ['@errands'], energy: 'Low' },
    { title: 'Quarterly 1:1 prep', status: 'Next', p: 3, due: 6, est: 30, area: 'Work', ctxs: ['@computer'] },
    // inbox
    { title: 'Look into a standing desk', status: 'Inbox', source: 'Quick add' },
    { title: 'Gift idea for Sam’s birthday', status: 'Inbox', source: 'Quick add', due: 12 },
    { title: 'Read “Shape Up” chapter 3', status: 'Inbox' },
    { title: 'Ask landlord about the balcony door', status: 'Inbox', source: 'Quick add' },
    { title: 'Compare phone plans', status: 'Inbox' },
    { title: 'Try the new climbing gym', status: 'Inbox' },
    // waiting
    { title: 'Designer mockups for pricing page', status: 'Waiting', waiting: 'Maya', due: 1, area: 'Work', project: pWeb },
    { title: 'Contractor quote for countertop', status: 'Waiting', waiting: 'Northside Stone', due: 5, area: 'Home', project: pKitchen },
    // someday
    { title: 'Learn to make fresh pasta', status: 'Someday', area: 'Fun' },
    { title: 'Write a short guide to home budgeting', status: 'Someday', area: 'Side project' },
    { title: 'Weekend trip to the coast', status: 'Someday', area: 'Fun' },
  ];
  // done in the last 10 days
  const doneTitles = ['Draft sitemap', 'Choose CMS', 'Order cabinet hardware', '8 km tempo run', 'Pay credit card', 'Portuguese lesson — greetings', 'Clean out garage shelf', 'Set up analytics', 'Call mom', 'Submit expense report', 'Interval run', 'Book flights to Lisbon'];
  doneTitles.forEach((title, i) => list.push({ title, status: 'Done', done: -Math.floor(i * 0.8) - (i % 3 === 0 ? 0 : 1), area: ['Work', 'Work', 'Home', 'Health', 'Money', 'Learning', 'Home', 'Work', 'Relationships', 'Work', 'Health', 'Fun'][i], project: [pWeb, pWeb, pKitchen, pRun, null, pLang, null, pWeb, null, null, pRun, null][i] ?? undefined, p: ((i % 4) + 1) as 1 | 2 | 3 | 4 }));

  for (const t of list) {
    const sched = t.sched ? c.date(`${day(t.sched[0])}T${t.sched[1]}:00`, `${day(t.sched[0])}T${t.sched[2]}:00`, true) : null;
    const completed = t.done !== undefined ? c.date(day(t.done)) : null;
    env.row(
      tasks,
      {
        Title: c.text(t.title),
        Status: sel(t.status),
        [prioName]: t.p ? pr(t.p) : null,
        Due: t.due !== undefined ? c.date(day(t.due)) : null,
        Scheduled: sched,
        'Estimate (min)': c.num(t.est),
        Area: t.area ? c.rel([area(t.area)]) : null,
        Project: t.project ? c.rel([t.project]) : null,
        Context: t.ctxs ? multi(t.ctxs) : null,
        Energy: t.energy ? sel(t.energy) : null,
        'Waiting on': c.text(t.waiting),
        Source: sel(t.source ?? 'Manual'),
        'Completed at': completed,
        'Top 3': t.top3 ? c.check(true) : null,
        Repeat: t.repeat ? c.recurrence(t.repeat, day(0)) : null,
      },
      { createdAt: env.now - Math.round((3 + rnd() * 20) * DAY) },
    );
  }

  // daily notes for the last 5 days
  const grat = ['Slow coffee on the balcony', 'A great run in the rain', 'Dinner with Sam', 'Finished the sitemap', 'Sunny walk at lunch'];
  for (let i = 0; i < 5; i++) {
    const d = env.now - i * DAY;
    const label = new Date(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
    env.row(daily, { Day: c.text(label), Date: c.date(isoDay(d)), 'Top 3': c.text(i === 0 ? 'Homepage copy · Case studies · Easy run' : 'Plan · Build · Move'), Gratitude: c.text(grat[i]), 'Shutdown done': c.check(i > 0) });
  }
  if (h.goals) {
    env.row(h.goals, { Goal: c.text('Run a sub-2:05 half marathon'), Area: c.rel([area('Health')]), 'Target date': c.date(day(120)), Progress: c.progress(0.35), Status: sel('On track') }, { icon: lucide('footprints') });
    env.row(h.goals, { Goal: c.text('Hold a conversation in Portuguese'), Area: c.rel([area('Learning')]), 'Target date': c.date(day(95)), Progress: c.progress(0.2), Status: sel('At risk') }, { icon: lucide('languages') });
  }
  if (h.resources) {
    env.row(h.resources, { Name: c.text('Shape Up — Basecamp'), Type: sel('Book'), Link: c.url('https://basecamp.com/shapeup'), Area: c.rel([area('Work')]) });
    env.row(h.resources, { Name: c.text('Half marathon 12-week plan'), Type: sel('Reference'), Area: c.rel([area('Health')]) });
  }
  void LIFE_AREAS;
}
