/**
 * Block type catalogue (§7.1, §7.4): which content types carry inline text, which may take children, and the
 * turn-into targets with their ⌘⌥0–9 shortcuts.
 */
import type { Node as PMNode } from '@tiptap/pm/model';
import {
  ChevronRight,
  Code2,
  FileText,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Lightbulb,
  Quote,
  SquareCheck,
  Type,
  type LucideIcon,
} from 'lucide-react';

export const CONTAINER = 'blockContainer';
export const GROUP = 'blockGroup';

/** blockContent types with `inline*` content. */
export const TEXT_TYPES = new Set(['paragraph', 'heading', 'bulletItem', 'numberedItem', 'todoItem', 'toggle', 'quote', 'callout']);

/** blockContent types that may take a child blockGroup (heading only when `toggle: true`). */
const CHILD_TYPES = new Set(['paragraph', 'bulletItem', 'numberedItem', 'todoItem', 'toggle', 'quote', 'callout']);

/** Leaf atoms (selected as a node, never have children). */
export const ATOM_TYPES = new Set([
  'divider', 'mathBlock', 'pageRef', 'pageLink', 'image', 'file', 'toc', 'databaseView', 'chart', 'kpi', 'sheetEmbed', 'watchlist',
]);

export type ContentLike = Pick<PMNode, 'attrs'> & { type: { name: string } };

export function allowsChildren(content: ContentLike | null | undefined): boolean {
  if (!content) return false;
  if (content.type.name === 'heading') return !!content.attrs.toggle;
  return CHILD_TYPES.has(content.type.name);
}

export function isTextContent(content: ContentLike | null | undefined): boolean {
  return !!content && TEXT_TYPES.has(content.type.name);
}

/** Toggle-like blocks: collapsible, chevron, ⌘↵ expands. */
export function isToggleLike(content: ContentLike | null | undefined): boolean {
  if (!content) return false;
  return content.type.name === 'toggle' || (content.type.name === 'heading' && !!content.attrs.toggle);
}

export interface TurnIntoTarget {
  key: string;
  label: string;
  icon: LucideIcon;
  type: string;
  attrs?: Record<string, unknown>;
  shortcut?: string;
}

export const TURN_INTO: TurnIntoTarget[] = [
  { key: 'paragraph', label: 'Text', icon: Type, type: 'paragraph', shortcut: 'mod+alt+0' },
  { key: 'h1', label: 'Heading 1', icon: Heading1, type: 'heading', attrs: { level: 1, toggle: false }, shortcut: 'mod+alt+1' },
  { key: 'h2', label: 'Heading 2', icon: Heading2, type: 'heading', attrs: { level: 2, toggle: false }, shortcut: 'mod+alt+2' },
  { key: 'h3', label: 'Heading 3', icon: Heading3, type: 'heading', attrs: { level: 3, toggle: false }, shortcut: 'mod+alt+3' },
  { key: 'todo', label: 'To-do list', icon: SquareCheck, type: 'todoItem', shortcut: 'mod+alt+4' },
  { key: 'bullet', label: 'Bulleted list', icon: List, type: 'bulletItem', shortcut: 'mod+alt+5' },
  { key: 'numbered', label: 'Numbered list', icon: ListOrdered, type: 'numberedItem', shortcut: 'mod+alt+6' },
  { key: 'toggle', label: 'Toggle list', icon: ChevronRight, type: 'toggle', shortcut: 'mod+alt+7' },
  { key: 'th1', label: 'Toggle heading 1', icon: Heading1, type: 'heading', attrs: { level: 1, toggle: true } },
  { key: 'th2', label: 'Toggle heading 2', icon: Heading2, type: 'heading', attrs: { level: 2, toggle: true } },
  { key: 'th3', label: 'Toggle heading 3', icon: Heading3, type: 'heading', attrs: { level: 3, toggle: true } },
  { key: 'quote', label: 'Quote', icon: Quote, type: 'quote' },
  { key: 'callout', label: 'Callout', icon: Lightbulb, type: 'callout' },
  { key: 'code', label: 'Code', icon: Code2, type: 'codeBlock', shortcut: 'mod+alt+8' },
  { key: 'page', label: 'Page', icon: FileText, type: '$page', shortcut: 'mod+alt+9' },
];

export function targetMatches(content: ContentLike, t: TurnIntoTarget): boolean {
  if (content.type.name !== t.type) return false;
  if (t.type === 'heading') return content.attrs.level === t.attrs?.level && !!content.attrs.toggle === !!t.attrs?.toggle;
  return true;
}

export function currentTarget(content: ContentLike): TurnIntoTarget | undefined {
  return TURN_INTO.find((t) => targetMatches(content, t));
}

/** Human label for a block (handle tooltip, a11y). */
export function blockLabel(content: ContentLike): string {
  const t = currentTarget(content);
  if (t) return t.label;
  const names: Record<string, string> = {
    divider: 'Divider', mathBlock: 'Equation', pageRef: 'Page', pageLink: 'Link to page', image: 'Image', file: 'File', toc: 'Table of contents',
    databaseView: 'Database', chart: 'Chart', kpi: 'KPI', sheetEmbed: 'Spreadsheet', watchlist: 'Watchlist', table: 'Table', columnList: 'Columns',
  };
  return names[content.type.name] ?? 'Block';
}

export const BLOCK_COLOR_NAMES = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'] as const;
export const COLOR_LABEL: Record<string, string> = {
  default: 'Default', gray: 'Gray', brown: 'Brown', orange: 'Orange', yellow: 'Yellow', green: 'Green', blue: 'Blue', purple: 'Purple', pink: 'Pink', red: 'Red',
};
