/** The editor's extension bundle: schema + behaviour, in priority order. */
import type { AnyExtension } from '@tiptap/core';
import { Dropcursor, UndoRedo } from '@tiptap/extensions';
import { schemaExtensions } from '../schema';
import { EditorContextExt } from '../lib/context';
import { BlockIds } from './blockId';
import { BlockKeymap } from './keymap';
import { BlockSelection } from './blockSelection';
import { Clipboard } from './clipboard';
import { CodeHighlight } from './codeHighlight';
import { FindReplace } from './findReplace';
import { MarkdownShortcuts } from './inputRules';
import { Placeholders } from './placeholder';
import { Suggest } from './suggest';
import { BlockMorph } from './morph';

export function editorExtensions(opts: { readOnly?: boolean } = {}): AnyExtension[] {
  const base: AnyExtension[] = [...schemaExtensions(), EditorContextExt, BlockIds, CodeHighlight, FindReplace];
  if (opts.readOnly) return base;
  return [
    ...base,
    UndoRedo.configure({ depth: 500, newGroupDelay: 500 }),
    Dropcursor.configure({ color: 'var(--accent-solid)', width: 2, class: 'emp-dropcursor' }),
    Suggest,
    BlockSelection,
    Clipboard,
    BlockKeymap,
    MarkdownShortcuts,
    Placeholders,
    BlockMorph,
  ];
}
