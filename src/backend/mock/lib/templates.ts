/** Built-in page templates (template_list / template_apply) and the daily-note template. */
import type { Icon, PageKind, TipTapDoc } from '../../types';
import { b, makeDoc, t } from './doc';

export interface BuiltinTemplate {
  id: string;
  title: string;
  icon: Icon;
  category: string;
  kind: PageKind;
  /** Fresh doc on each call (new block ids). */
  doc(): TipTapDoc;
}

const lucide = (v: string): Icon => ({ t: 'lucide', v });

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    id: 'builtin:meeting-notes',
    title: 'Meeting notes',
    icon: lucide('notebook-pen'),
    category: 'Work',
    kind: 'doc',
    doc: () =>
      makeDoc([
        b.callout(['Date, attendees and the one question this meeting must answer.'], { icon: lucide('target'), tone: 'blue' }),
        b.h2('Agenda'),
        b.numbered(''),
        b.h2('Notes'),
        b.bullet(''),
        b.h2('Decisions'),
        b.bullet(''),
        b.h2('Action items'),
        b.todo(''),
      ]),
  },
  {
    id: 'builtin:weekly-review',
    title: 'Weekly review',
    icon: lucide('repeat'),
    category: 'Personal',
    kind: 'doc',
    doc: () =>
      makeDoc([
        b.p([t.italic('Twenty quiet minutes, once a week. Clear the decks, then choose what matters next.')]),
        b.h2('Get clear'),
        b.todo('Empty inboxes and capture loose notes'),
        b.todo('Review last week’s calendar'),
        b.todo('Review the next two weeks'),
        b.h2('Reflect'),
        b.toggle('What went well?', { collapsed: false, children: [b.p('')] }),
        b.toggle('What was hard, and why?', { collapsed: false, children: [b.p('')] }),
        b.h2('Next week’s three priorities'),
        b.numbered(''),
        b.numbered(''),
        b.numbered(''),
      ]),
  },
  {
    id: 'builtin:project-brief',
    title: 'Project brief',
    icon: lucide('target'),
    category: 'Work',
    kind: 'doc',
    doc: () =>
      makeDoc([
        b.callout([t.bold('One sentence: '), 'what are we doing, for whom, and why now?'], { icon: lucide('lightbulb'), tone: 'yellow' }),
        b.h2('Problem'),
        b.p(''),
        b.h2('Goals'),
        b.bullet(''),
        b.h2('Non-goals'),
        b.bullet(''),
        b.h2('Milestones'),
        b.table([
          ['Milestone', 'Owner', 'Target date'],
          ['', '', ''],
          ['', '', ''],
        ]),
        b.h2('Risks and open questions'),
        b.toggle('Risk', { collapsed: false, children: [b.p('Likelihood, impact, mitigation.')] }),
      ]),
  },
  {
    id: 'builtin:daily-journal',
    title: 'Daily journal',
    icon: lucide('sun'),
    category: 'Journal',
    kind: 'doc',
    doc: () => dailyNoteDoc(),
  },
  {
    id: 'builtin:reading-notes',
    title: 'Reading notes',
    icon: lucide('library'),
    category: 'Learning',
    kind: 'doc',
    doc: () =>
      makeDoc([
        b.table(
          [
            ['Author', ''],
            ['Started', ''],
            ['Rating', '☆☆☆☆☆'],
          ],
          { headerRow: false, headerCol: true },
        ),
        b.h2('The big idea'),
        b.p(''),
        b.h2('Highlights'),
        b.quote(''),
        b.h2('What I’ll do differently'),
        b.todo(''),
      ]),
  },
  {
    id: 'builtin:trip-planner',
    title: 'Trip planner',
    icon: lucide('plane'),
    category: 'Personal',
    kind: 'doc',
    doc: () =>
      makeDoc([
        b.h2('Itinerary'),
        b.table([
          ['Day', 'Plan', 'Booked'],
          ['1', '', ''],
          ['2', '', ''],
        ]),
        b.h2('Bookings'),
        b.toggle('Flights', { collapsed: false, children: [b.p('')] }),
        b.toggle('Stay', { collapsed: false, children: [b.p('')] }),
        b.h2('Packing'),
        b.todo('Passport'),
        b.todo('Chargers and adapters'),
        b.todo('Travel insurance details'),
      ]),
  },
  {
    id: 'builtin:decision-log',
    title: 'Decision log',
    icon: lucide('scale'),
    category: 'Work',
    kind: 'doc',
    doc: () =>
      makeDoc([
        b.callout('Write the decision down before you make it. Future you will want the context.', {
          icon: lucide('compass'),
          tone: 'gray',
        }),
        b.h2('Context'),
        b.p(''),
        b.h2('Options'),
        b.toggle('Option A', { collapsed: false, children: [b.bullet('Pros'), b.bullet('Cons')] }),
        b.toggle('Option B', { collapsed: false, children: [b.bullet('Pros'), b.bullet('Cons')] }),
        b.h2('Decision'),
        b.p(''),
        b.h2('Revisit if…'),
        b.bullet(''),
      ]),
  },
  {
    id: 'builtin:one-on-one',
    title: '1:1 notes',
    icon: lucide('handshake'),
    category: 'Work',
    kind: 'doc',
    doc: () =>
      makeDoc([
        b.h2('Their topics'),
        b.bullet(''),
        b.h2('My topics'),
        b.bullet(''),
        b.h2('Feedback'),
        b.p(''),
        b.h2('Follow-ups'),
        b.todo(''),
      ]),
  },
];

export function findBuiltin(id: string): BuiltinTemplate | undefined {
  return BUILTIN_TEMPLATES.find((tpl) => tpl.id === id);
}

export function dailyNoteDoc(): TipTapDoc {
  return makeDoc([
    b.h3('Focus'),
    b.todo(''),
    b.todo(''),
    b.todo(''),
    b.h3('Notes'),
    b.p(''),
    b.h3('End of day'),
    b.toggle('What went well?', { collapsed: false, children: [b.p('')] }),
  ]);
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'Thursday, Nov 26, 2026' */
export function dailyTitle(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `${WEEKDAYS[dt.getDay()]}, ${MONTHS[m - 1]} ${d}, ${y}`;
}

export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}
