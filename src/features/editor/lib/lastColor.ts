/** "Apply last colour" (⌘⌥H, §8.7): remembers the last text/background colour picked from any colour menu. */
import type { Editor } from '@tiptap/core';
import { currentBlock, setBlockColor } from './blocks';
import { selectedBlocks } from '../extensions/blockSelection';

export interface LastColor {
  kind: 'text' | 'bg';
  color: string | null;
}

let last: LastColor | null = null;

export function rememberColor(c: LastColor): void {
  last = c;
}

export function getLastColor(): LastColor | null {
  return last;
}

/** Apply a colour to the text selection (marks) or, with a collapsed caret / block selection, to blocks. */
export function applyColor(editor: Editor, c: LastColor, opts: { blocks?: boolean } = {}): void {
  rememberColor(c);
  const { state } = editor;
  const blocks = selectedBlocks(state);
  if (opts.blocks || blocks.length || state.selection.empty) {
    const list = blocks.length ? blocks : [currentBlock(state)].filter((b): b is NonNullable<typeof b> => !!b);
    setBlockColor(state, (tr) => editor.view.dispatch(tr), list, c.kind === 'text' ? 'color' : 'bg', c.color);
    return;
  }
  const chain = editor.chain().focus();
  if (c.kind === 'text') {
    if (c.color) chain.setMark('textColor', { color: c.color });
    else chain.unsetMark('textColor');
  } else if (c.color) chain.setMark('highlight', { color: c.color });
  else chain.unsetMark('highlight');
  chain.run();
}

export function applyLastColor(editor: Editor): boolean {
  if (!last) return false;
  applyColor(editor, last);
  return true;
}
