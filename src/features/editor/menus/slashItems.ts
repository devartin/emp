/**
 * Slash menu catalogue (§7.5): groups Basic, Media, Database, EMP, Advanced, Inline, Actions. Each item has aliases
 * and keywords for fuzzy matching; recently used items float to the top (persisted in kv `ui.editor`).
 */
import type { Editor } from '@tiptap/core';
import {
  BarChart3,
  Calendar,
  CalendarDays,
  ChevronRight,
  Code2,
  Columns2,
  Columns3,
  Columns4,
  Copy,
  Database,
  FileText,
  Gauge,
  GalleryVerticalEnd,
  Grid3x3,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  KanbanSquare,
  Lightbulb,
  Link2,
  List,
  ListOrdered,
  ListTree,
  Minus,
  MoveRight,
  Paintbrush,
  Paperclip,
  Quote,
  Rows3,
  Sheet,
  Sigma,
  Smile,
  Sparkles,
  SquareCheck,
  SquareFunction,
  Table2,
  Trash2,
  TrendingUp,
  Type,
  AtSign,
  Repeat2,
  Baseline,
  type LucideIcon,
} from 'lucide-react';
import { api } from '@/backend';
import { navigate } from '@/app/router';
import { BLOCK_COLOR_NAMES, COLOR_LABEL, TURN_INTO } from '../lib/blockTypes';
import {
  applyTextType,
  createSubPage,
  insertAtom,
  insertColumns,
  insertDatabase,
  insertDateMention,
  insertSpreadsheet,
  insertTable,
} from '../lib/editorCommands';
import { currentBlock, deleteBlocks, duplicateBlocks } from '../lib/blocks';
import { applyColor } from '../lib/lastColor';
import { isoDay } from '@/lib/dates';
import { suggestKey } from '../extensions/suggest';
import { openOverlay } from './overlay';

export type SlashGroup = 'Basic' | 'Media' | 'Database' | 'EMP' | 'Advanced' | 'Inline' | 'Actions';
export const SLASH_GROUPS: SlashGroup[] = ['Basic', 'Media', 'Database', 'EMP', 'Advanced', 'Inline', 'Actions'];

export interface SlashItem {
  id: string;
  title: string;
  description: string;
  group: SlashGroup;
  icon: LucideIcon;
  aliases?: string[];
  keywords?: string[];
  /** Colour swatch for colour items. */
  swatch?: { kind: 'text' | 'bg'; color: string | null };
  /** Opens a second-level list instead of running. */
  submenu?: 'turnInto' | 'color' | 'linkedDb' | 'moveTo';
  shortcut?: string;
  run?: (editor: Editor) => void | Promise<void>;
  /** Hidden unless the query matches (long tails such as colours). */
  searchOnly?: boolean;
}

const tt = (key: string) => TURN_INTO.find((t) => t.key === key)!;

function openInlineTrigger(editor: Editor, text: string, kind: 'mention' | 'pagelink') {
  const { from } = editor.state.selection;
  const tr = editor.state.tr.insertText(text, from).setMeta(suggestKey, { open: { kind, from, triggerLen: text.length } });
  editor.view.dispatch(tr);
  editor.view.focus();
}

function caretRect(editor: Editor) {
  const c = editor.view.coordsAtPos(editor.state.selection.from);
  return { x: c.left, y: c.top, width: 1, height: c.bottom - c.top };
}

const BASE: SlashItem[] = [
  { id: 'text', title: 'Text', description: 'Just start writing with plain text.', group: 'Basic', icon: Type, aliases: ['paragraph', 'plain'], run: (e) => applyTextType(e, tt('paragraph')), shortcut: 'mod+alt+0' },
  { id: 'h1', title: 'Heading 1', description: 'Big section heading.', group: 'Basic', icon: Heading1, aliases: ['h1', 'title', '#'], run: (e) => applyTextType(e, tt('h1')), shortcut: 'mod+alt+1' },
  { id: 'h2', title: 'Heading 2', description: 'Medium section heading.', group: 'Basic', icon: Heading2, aliases: ['h2', 'subtitle', '##'], run: (e) => applyTextType(e, tt('h2')), shortcut: 'mod+alt+2' },
  { id: 'h3', title: 'Heading 3', description: 'Small section heading.', group: 'Basic', icon: Heading3, aliases: ['h3', '###'], run: (e) => applyTextType(e, tt('h3')), shortcut: 'mod+alt+3' },
  { id: 'th1', title: 'Toggle heading 1', description: 'Big heading that folds its section.', group: 'Basic', icon: Heading1, aliases: ['toggle h1', 'collapsible'], run: (e) => applyTextType(e, tt('th1')) },
  { id: 'th2', title: 'Toggle heading 2', description: 'Medium heading that folds its section.', group: 'Basic', icon: Heading2, aliases: ['toggle h2', 'collapsible'], run: (e) => applyTextType(e, tt('th2')) },
  { id: 'th3', title: 'Toggle heading 3', description: 'Small heading that folds its section.', group: 'Basic', icon: Heading3, aliases: ['toggle h3', 'collapsible'], run: (e) => applyTextType(e, tt('th3')) },
  { id: 'todo', title: 'To-do list', description: 'Track tasks with a checkbox.', group: 'Basic', icon: SquareCheck, aliases: ['todo', 'task', 'checkbox', 'check', '[]'], run: (e) => applyTextType(e, tt('todo')), shortcut: 'mod+alt+4' },
  { id: 'bullet', title: 'Bulleted list', description: 'A simple bulleted list.', group: 'Basic', icon: List, aliases: ['ul', 'bullet', 'unordered', '-'], run: (e) => applyTextType(e, tt('bullet')), shortcut: 'mod+alt+5' },
  { id: 'numbered', title: 'Numbered list', description: 'A list with numbering.', group: 'Basic', icon: ListOrdered, aliases: ['ol', 'ordered', '1.'], run: (e) => applyTextType(e, tt('numbered')), shortcut: 'mod+alt+6' },
  { id: 'toggle', title: 'Toggle list', description: 'Hide details inside a toggle.', group: 'Basic', icon: ChevronRight, aliases: ['toggle', 'collapse', 'details', '>'], run: (e) => applyTextType(e, tt('toggle')), shortcut: 'mod+alt+7' },
  { id: 'quote', title: 'Quote', description: 'Capture a quote.', group: 'Basic', icon: Quote, aliases: ['blockquote', 'citation'], run: (e) => applyTextType(e, tt('quote')) },
  { id: 'callout', title: 'Callout', description: 'Make writing stand out.', group: 'Basic', icon: Lightbulb, aliases: ['note', 'tip', 'warning', 'info', 'aside'], run: (e) => applyTextType(e, tt('callout')) },
  { id: 'divider', title: 'Divider', description: 'Visually divide blocks.', group: 'Basic', icon: Minus, aliases: ['hr', 'separator', 'line', '---'], run: (e) => void insertAtom(e, 'divider', null, 'after') },
  { id: 'page', title: 'Page', description: 'Embed a sub-page inside this page.', group: 'Basic', icon: FileText, aliases: ['subpage', 'new page', 'doc'], run: (e) => void createSubPage(e), shortcut: 'mod+alt+9' },
  { id: 'linkpage', title: 'Link to page', description: 'Link to an existing page.', group: 'Basic', icon: Link2, aliases: ['link', 'reference', '[['], run: (e) => openInlineTrigger(e, '[[', 'pagelink') },

  { id: 'image', title: 'Image', description: 'Upload or embed with a link.', group: 'Media', icon: ImageIcon, aliases: ['picture', 'photo', 'img', 'screenshot'], run: (e) => void insertAtom(e, 'image', { assetId: null, width: null, align: 'center', caption: '', pendingUrl: null }) },
  { id: 'file', title: 'File', description: 'Upload any file.', group: 'Media', icon: Paperclip, aliases: ['attachment', 'pdf', 'upload'], run: (e) => void insertAtom(e, 'file', { assetId: null }) },

  { id: 'db-table', title: 'Table view', description: 'Inline database shown as a table.', group: 'Database', icon: Table2, aliases: ['database', 'db', 'inline database'], run: (e) => insertDatabase(e, 'table') },
  { id: 'db-board', title: 'Board view', description: 'Inline database shown as a kanban board.', group: 'Database', icon: KanbanSquare, aliases: ['kanban', 'database'], run: (e) => insertDatabase(e, 'board') },
  { id: 'db-list', title: 'List view', description: 'Inline database shown as a list.', group: 'Database', icon: Rows3, aliases: ['database'], run: (e) => insertDatabase(e, 'list') },
  { id: 'db-calendar', title: 'Calendar view', description: 'Inline database on a month calendar.', group: 'Database', icon: CalendarDays, aliases: ['database', 'schedule'], run: (e) => insertDatabase(e, 'calendar') },
  { id: 'db-gallery', title: 'Gallery view', description: 'Inline database shown as cards.', group: 'Database', icon: GalleryVerticalEnd, aliases: ['cards', 'database'], run: (e) => insertDatabase(e, 'gallery') },
  { id: 'db-chart', title: 'Chart view', description: 'Inline database shown as a chart.', group: 'Database', icon: BarChart3, aliases: ['graph', 'database'], run: (e) => insertDatabase(e, 'chart') },
  { id: 'db-linked', title: 'Linked view of database', description: 'Show an existing database here.', group: 'Database', icon: Repeat2, aliases: ['linked', 'linked view', 'existing database'], submenu: 'linkedDb' },
  { id: 'db-page', title: 'Database full page', description: 'A new database on its own page.', group: 'Database', icon: Database, aliases: ['database page', 'full page'], run: (e) => insertDatabase(e, 'table', { fullPage: true }) },

  { id: 'sheet', title: 'Spreadsheet', description: 'A live spreadsheet with formulas.', group: 'EMP', icon: Sheet, aliases: ['excel', 'grid', 'formula', 'workbook'], run: (e) => insertSpreadsheet(e) },
  { id: 'chart', title: 'Chart', description: 'Chart a database, sheet or life-app metric.', group: 'EMP', icon: TrendingUp, aliases: ['graph', 'plot', 'visualise'], run: (e) => void insertAtom(e, 'chart', { source: null, spec: null }) },
  { id: 'kpi', title: 'KPI', description: 'One number that matters, live.', group: 'EMP', icon: Gauge, aliases: ['metric', 'number', 'stat', 'tile'], run: (e) => void insertAtom(e, 'kpi', { source: null, agg: 'sum', label: '', format: 'number' }) },
  { id: 'watchlist', title: 'Watchlist', description: 'Live quotes for symbols you follow.', group: 'EMP', icon: TrendingUp, aliases: ['stocks', 'quotes', 'tickers', 'market'], run: (e) => void insertAtom(e, 'watchlist', { watchlistId: null }) },
  { id: 'lifeapp', title: 'Life app…', description: 'Set up Money HQ, Habits, Life OS and more.', group: 'EMP', icon: Sparkles, aliases: ['app', 'template', 'money', 'habits'], run: () => navigate({ t: 'lifeapps' }) },

  { id: 'table', title: 'Table', description: 'A simple table with rows and columns.', group: 'Advanced', icon: Grid3x3, aliases: ['simple table', 'grid'], run: (e) => insertTable(e) },
  { id: 'col2', title: '2 columns', description: 'Two side-by-side columns.', group: 'Advanced', icon: Columns2, aliases: ['columns', 'layout', 'side by side'], run: (e) => insertColumns(e, 2) },
  { id: 'col3', title: '3 columns', description: 'Three side-by-side columns.', group: 'Advanced', icon: Columns3, aliases: ['columns', 'layout'], run: (e) => insertColumns(e, 3) },
  { id: 'col4', title: '4 columns', description: 'Four side-by-side columns.', group: 'Advanced', icon: Columns4, aliases: ['columns', 'layout'], run: (e) => insertColumns(e, 4) },
  { id: 'col5', title: '5 columns', description: 'Five side-by-side columns.', group: 'Advanced', icon: Columns4, aliases: ['columns', 'layout'], run: (e) => insertColumns(e, 5) },
  { id: 'code', title: 'Code', description: 'Capture a code snippet.', group: 'Advanced', icon: Code2, aliases: ['snippet', 'pre', '```'], run: (e) => applyTextType(e, tt('code')), shortcut: 'mod+alt+8' },
  { id: 'equation', title: 'Block equation', description: 'Display a TeX equation.', group: 'Advanced', icon: Sigma, aliases: ['math', 'latex', 'tex', 'formula', 'katex'], run: (e) => void insertAtom(e, 'mathBlock', { latex: '' }) },
  { id: 'toc', title: 'Table of contents', description: 'Outline of this page’s headings.', group: 'Advanced', icon: ListTree, aliases: ['toc', 'outline', 'contents'], run: (e) => void insertAtom(e, 'toc', null, 'after') },

  { id: 'mention', title: 'Mention a page', description: 'Link to a page inline.', group: 'Inline', icon: AtSign, aliases: ['@', 'mention', 'link'], run: (e) => openInlineTrigger(e, '@', 'mention') },
  {
    id: 'date',
    title: 'Date or reminder',
    description: 'Insert today’s date, then pick another.',
    group: 'Inline',
    icon: Calendar,
    aliases: ['today', 'now', 'time', 'reminder'],
    run: (e) => {
      insertDateMention(e, { start: isoDay(), time: false });
      const pos = e.state.selection.from - 2;
      requestAnimationFrame(() => {
        const dom = e.view.nodeDOM(pos) as HTMLElement | null;
        const r = dom?.getBoundingClientRect();
        if (r) openOverlay({ kind: 'date', editorId: e.instanceId, pos, rect: { x: r.left, y: r.top, width: r.width, height: r.height }, data: { date: { start: isoDay(), time: false } } });
      });
    },
  },
  {
    id: 'emoji',
    title: 'Emoji',
    description: 'Search for an emoji to insert.',
    group: 'Inline',
    icon: Smile,
    aliases: ['emoticon', 'smiley', ':'],
    run: (e) => openOverlay({ kind: 'calloutIcon', editorId: e.instanceId, pos: -1, rect: caretRect(e), data: { insert: true } }),
  },
  {
    id: 'inline-eq',
    title: 'Inline equation',
    description: 'Maths inside a sentence.',
    group: 'Inline',
    icon: SquareFunction,
    aliases: ['inline math', 'latex', '$'],
    run: (e) => {
      const pos = e.state.selection.from;
      e.chain().focus().insertContent({ type: 'mathInline', attrs: { latex: '' } }).run();
      requestAnimationFrame(() => {
        const dom = e.view.nodeDOM(pos) as HTMLElement | null;
        const r = dom?.getBoundingClientRect();
        if (r) openOverlay({ kind: 'mathInline', editorId: e.instanceId, pos, rect: { x: r.left, y: r.top, width: r.width, height: r.height }, data: { latex: '' } });
      });
    },
  },

  { id: 'turninto', title: 'Turn into…', description: 'Change this block’s type.', group: 'Actions', icon: Repeat2, aliases: ['convert', 'change type'], submenu: 'turnInto' },
  { id: 'color', title: 'Color…', description: 'Text or background colour.', group: 'Actions', icon: Paintbrush, aliases: ['colour', 'highlight', 'background'], submenu: 'color' },
  {
    id: 'duplicate',
    title: 'Duplicate',
    description: 'Copy this block below.',
    group: 'Actions',
    icon: Copy,
    shortcut: 'mod+d',
    run: (e) => void duplicateBlocks(e.state, (tr) => e.view.dispatch(tr)),
  },
  {
    id: 'delete',
    title: 'Delete',
    description: 'Remove this block.',
    group: 'Actions',
    icon: Trash2,
    aliases: ['remove'],
    run: (e) => {
      const b = currentBlock(e.state);
      if (b) deleteBlocks(e.state, (tr) => e.view.dispatch(tr), [b]);
    },
  },
  { id: 'moveto', title: 'Move to…', description: 'Send this block to another page.', group: 'Actions', icon: MoveRight, aliases: ['move', 'send'], submenu: 'moveTo' },
];

function colorItems(): SlashItem[] {
  const out: SlashItem[] = [];
  for (const c of [null, ...BLOCK_COLOR_NAMES]) {
    const name = c ? COLOR_LABEL[c] : 'Default';
    out.push({
      id: `color-${c ?? 'default'}`,
      title: c ? name : 'Default text',
      description: c ? `${name} text` : 'Remove text colour',
      group: 'Actions',
      icon: Baseline,
      swatch: { kind: 'text', color: c },
      keywords: c ? [c, `${c} text`] : ['default', 'clear colour'],
      searchOnly: true,
      run: (e) => applyColor(e, { kind: 'text', color: c }, { blocks: true }),
    });
    out.push({
      id: `bg-${c ?? 'default'}`,
      title: c ? `${name} background` : 'Default background',
      description: c ? `Highlight the block in ${name.toLowerCase()}` : 'Remove background',
      group: 'Actions',
      icon: Paintbrush,
      swatch: { kind: 'bg', color: c },
      keywords: c ? [`${c} background`, `${c} bg`, `${c} highlight`] : ['default background', 'no background'],
      searchOnly: true,
      run: (e) => applyColor(e, { kind: 'bg', color: c }, { blocks: true }),
    });
  }
  return out;
}

export const SLASH_ITEMS: SlashItem[] = [...BASE, ...colorItems()];

// ───────────────────────────────────────────────────────────────────────────── recents

let recent: string[] = [];
let recentLoaded = false;

export function slashRecent(): string[] {
  if (!recentLoaded) {
    recentLoaded = true;
    void api.kv
      .get({ ns: 'ui.editor', key: 'slashRecent' })
      .then((v) => {
        if (Array.isArray(v)) recent = v.filter((x): x is string => typeof x === 'string').slice(0, 5);
      })
      .catch(() => undefined);
  }
  return recent;
}

export function pushSlashRecent(id: string): void {
  if (id.startsWith('color-') || id.startsWith('bg-')) return;
  recent = [id, ...recent.filter((r) => r !== id)].slice(0, 5);
  void api.kv.set({ ns: 'ui.editor', key: 'slashRecent', value: recent }).catch(() => undefined);
}
