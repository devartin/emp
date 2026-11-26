/** Per-editor context (owner page/row, workspace) that node views and menus read via `editor.storage.empContext`. */
import { Extension, type Editor } from '@tiptap/core';
import type { Id } from '@/backend/types';

export interface EmpEditorContext {
  ownerId: Id;
  ownerKind: 'page' | 'row';
  workspaceId: Id;
  /** Parent for new sub-pages ("Page", "Turn into page"); null for rows. */
  parentPageId: Id | null;
  readOnly: boolean;
  hooks: EditorHooks;
}

/** Callbacks the host (PageView, RowPage, previews) provides; all optional. */
export interface EditorHooks {
  /** ⌘F / ⌘⌥F inside the editor. */
  find?(replace: boolean): void;
  /** "Turn into page" (⌘⌥9, block menu) for these block ids. */
  turnIntoPage?(blockIds: string[]): void;
  /** Copy link to block. */
  blockLink?(blockId: string): string | null;
}

export const EditorContextExt = Extension.create<Record<string, never>, EmpEditorContext>({
  name: 'empContext',
  addStorage() {
    return { ownerId: '', ownerKind: 'page', workspaceId: '', parentPageId: null, readOnly: false, hooks: {} };
  },
});

export function editorContext(editor: Editor): EmpEditorContext {
  const s = (editor.storage as unknown as Record<string, EmpEditorContext | undefined>).empContext;
  return s ?? { ownerId: '', ownerKind: 'page', workspaceId: '', parentPageId: null, readOnly: false, hooks: {} };
}

export function setEditorContext(editor: Editor, patch: Partial<EmpEditorContext>): void {
  Object.assign(editorContext(editor), patch);
}

export function prefersReducedMotion(): boolean {
  return typeof document !== 'undefined' && document.documentElement.getAttribute('data-motion') === 'reduced';
}
