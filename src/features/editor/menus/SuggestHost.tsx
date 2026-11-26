/** Renders the active suggestion menu (slash, mention, page link) for one editor. The app offers no emoji inserter. */
import type { Editor } from '@tiptap/core';
import { useSyncExternalStore } from 'react';
import { getSuggest, subscribeSuggest } from '../extensions/suggest';
import { MentionMenu } from './MentionMenu';
import { SlashMenu } from './SlashMenu';

export function SuggestHost({ editor }: { editor: Editor }) {
  const view = editor.view;
  const state = useSyncExternalStore(
    (fn) => subscribeSuggest(view, fn),
    () => getSuggest(view.state),
  );
  if (!state.active || !editor.isEditable) return null;
  const key = `${state.kind}:${state.from}`;
  if (state.kind === 'slash') return <SlashMenu key={key} editor={editor} state={state} />;
  if (state.kind === 'mention' || state.kind === 'pagelink') return <MentionMenu key={key} editor={editor} state={state} />;
  return null;
}
