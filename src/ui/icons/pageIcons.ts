/**
 * The curated page-icon set: one monochrome Lucide family, ~120 glyphs in 8 groups.
 * Names are lucide-react kebab-case icon names (validated by pageIcons.test.ts).
 * Keywords feed the IconPicker search; the icon name itself is always searchable too.
 */
export interface PageIconEntry {
  name: string;
  keywords: string;
}

export interface PageIconGroup {
  id: string;
  label: string;
  icons: PageIconEntry[];
}

const g = (id: string, label: string, list: Array<[string, string]>): PageIconGroup => ({
  id,
  label,
  icons: list.map(([name, keywords]) => ({ name, keywords })),
});

export const PAGE_ICON_GROUPS: PageIconGroup[] = [
  g('documents', 'Documents', [
    ['file-text', 'page doc document note text'],
    ['notebook', 'journal diary notes log'],
    ['notebook-pen', 'write journal draft'],
    ['book-open', 'read guide manual handbook getting started'],
    ['book', 'book reference'],
    ['sticky-note', 'memo quick note'],
    ['scroll-text', 'policy contract terms'],
    ['clipboard-list', 'checklist list agenda'],
    ['list-todo', 'tasks todo checklist'],
    ['list-ordered', 'steps numbered list order sequence'],
    ['files', 'pages collection'],
    ['folder', 'folder directory'],
    ['folder-open', 'folder open'],
    ['archive', 'archive storage old'],
    ['inbox', 'inbox capture'],
    ['bookmark', 'saved reading'],
    ['quote', 'quote citation'],
  ]),
  g('work', 'Work', [
    ['briefcase', 'work job business career'],
    ['target', 'goal objective okr aim'],
    ['rocket', 'launch project ship startup'],
    ['flag', 'milestone flag finish'],
    ['kanban', 'board project tracker'],
    ['calendar', 'calendar schedule date'],
    ['calendar-check', 'deadline due'],
    ['calendar-clock', 'schedule appointment reminder due soon'],
    ['clock', 'time hours'],
    ['users', 'team people group'],
    ['handshake', 'meeting deal partner client'],
    ['presentation', 'slides talk deck'],
    ['lightbulb', 'idea brainstorm'],
    ['compass', 'direction plan strategy'],
    ['chart-line', 'metrics growth chart'],
    ['layers', 'stack layers system'],
    ['database', 'database table data'],
  ]),
  g('money', 'Money', [
    ['wallet', 'wallet money cash spending'],
    ['piggy-bank', 'savings save fund'],
    ['banknote', 'cash money bill'],
    ['coins', 'coins change money'],
    ['credit-card', 'card credit debt'],
    ['landmark', 'bank institution tax government'],
    ['receipt', 'receipt bill expense invoice'],
    ['calculator', 'calculator budget maths'],
    ['scale', 'balance law fair net worth'],
    ['trending-up', 'invest portfolio stocks growth'],
    ['chart-pie', 'allocation budget split'],
    ['chart-area', 'net worth trend balance chart'],
    ['hand-coins', 'pay give spend'],
    ['shopping-cart', 'shopping groceries buy'],
    ['tag', 'price label category'],
    ['gift', 'gift present birthday'],
  ]),
  g('home', 'Home & life', [
    ['house', 'home house family'],
    ['sun', 'day morning today'],
    ['moon', 'night evening sleep'],
    ['heart', 'love favourite relationship'],
    ['baby', 'baby child kids'],
    ['dog', 'dog pet'],
    ['cat', 'cat pet'],
    ['utensils', 'food meals recipes'],
    ['cooking-pot', 'cooking recipe kitchen'],
    ['coffee', 'coffee cafe break'],
    ['sprout', 'garden plant grow habit'],
    ['leaf', 'nature plant'],
    ['wrench', 'repair maintenance fix'],
    ['key-round', 'key access rent'],
    ['brush-cleaning', 'chores cleaning'],
  ]),
  g('travel', 'Travel', [
    ['plane', 'travel flight trip holiday'],
    ['luggage', 'trip packing luggage'],
    ['map', 'map route itinerary'],
    ['map-pin', 'place location'],
    ['globe', 'world international'],
    ['car', 'car drive road trip'],
    ['train-front', 'train rail'],
    ['bus', 'bus transit'],
    ['bike', 'bike cycling'],
    ['mountain', 'hiking outdoors'],
    ['tent', 'camping'],
    ['tree-palm', 'beach holiday'],
    ['hotel', 'hotel stay'],
    ['ticket', 'ticket event'],
  ]),
  g('health', 'Health', [
    ['heart-pulse', 'health heart fitness'],
    ['activity', 'activity exercise'],
    ['dumbbell', 'gym workout strength'],
    ['footprints', 'walk steps run'],
    ['person-standing', 'exercise posture stretch'],
    ['bed', 'sleep rest'],
    ['droplet', 'water hydrate'],
    ['apple', 'nutrition diet fruit'],
    ['pill', 'medication medicine'],
    ['stethoscope', 'doctor medical'],
    ['brain', 'mind mental focus'],
    ['smile', 'mood happy'],
    ['flame', 'streak calories energy'],
    ['timer', 'timer interval'],
  ]),
  g('learning', 'Learning', [
    ['graduation-cap', 'school study course university'],
    ['library', 'library reading list books'],
    ['languages', 'language learn translate'],
    ['pen-line', 'writing essay'],
    ['microscope', 'science research'],
    ['flask-conical', 'experiment lab'],
    ['atom', 'physics science'],
    ['code', 'code programming developer'],
    ['terminal', 'terminal command shell'],
    ['music', 'music practice song'],
    ['palette', 'art design colour'],
    ['camera', 'photo photography'],
    ['puzzle', 'puzzle problem'],
    ['message-circle', 'conversation chat'],
  ]),
  g('objects', 'Objects', [
    ['star', 'star favourite important'],
    ['bell', 'reminder notification'],
    ['lock', 'private secure vault'],
    ['shield', 'protect insurance safety'],
    ['life-buoy', 'emergency help support'],
    ['package', 'package box delivery'],
    ['laptop', 'computer laptop'],
    ['smartphone', 'phone mobile'],
    ['headphones', 'audio podcast'],
    ['mic', 'voice record interview'],
    ['tv', 'tv watch shows'],
    ['gamepad-2', 'games play'],
    ['trophy', 'win award achievement'],
    ['gem', 'gem precious'],
    ['zap', 'quick energy power'],
    ['settings', 'settings config'],
    ['sliders-horizontal', 'controls options adjust preferences'],
  ]),
];

/** Flat list of every curated icon name. */
export const PAGE_ICON_NAMES: string[] = PAGE_ICON_GROUPS.flatMap((grp) =>
  grp.icons.map((i) => i.name),
);

/** Case-insensitive search across names, keywords and group labels. Empty query → all. */
export function searchPageIcons(query: string): PageIconGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return PAGE_ICON_GROUPS;
  const terms = q.split(/\s+/);
  return PAGE_ICON_GROUPS.map((grp) => ({
    ...grp,
    icons: grp.icons.filter((i) => {
      const hay = `${i.name.replace(/-/g, ' ')} ${i.keywords} ${grp.label.toLowerCase()}`;
      return terms.every((t) => hay.includes(t));
    }),
  })).filter((grp) => grp.icons.length > 0);
}
