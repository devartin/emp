/**
 * The block editor (§7): a pooled TipTap instance (immediate render, no React re-render per transaction) with the
 * slash menu, bubble toolbar, block handle + drag, overlays and autosave. Used by PageView, the history preview and
 * database row pages (`features/databases/RowPage.tsx` may embed it with `ownerKind="row"`).
 *
 *   <Editor ownerId={page.id} ownerKind="page" workspaceId={…} doc={doc} docRev={rev} font="serif" />
 */
import { Editor as TEditor } from '@tiptap/core';
import { EditorContent } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Id, PageFont, Rev, TipTapDoc } from '@/backend/types';
import { cn } from '@/lib/cn';
import { useSettings } from '@/stores/settings';
import '@/styles/editor.css';
import { editorExtensions } from './extensions';
import { acquire, poolKey, release, retain, setPooledRev } from './editorPool';
import { emptyParagraphBlock, infoAt } from './lib/blocks';
import { editorContext, setEditorContext, type EditorHooks } from './lib/context';
import { normaliseDocJson } from './lib/normalize';
import { fixDocument } from './extensions/blockId';
import { BlockHandle } from './menus/BlockHandle';
import { BubbleToolbar } from './menus/BubbleToolbar';
import { OverlayHost } from './menus/OverlayHost';
import { SuggestHost } from './menus/SuggestHost';
import { REMOTE_META, saverFor, useDocSave, type ConflictInfo, type DocSaver, type SaverSnapshot } from './useDocSave';

const destroyTimers = new WeakMap<TEditor, ReturnType<typeof setTimeout>>();

export interface EditorProps {
  ownerId: Id;
  ownerKind: 'page' | 'row';
  workspaceId: Id;
  /** Parent for new sub-pages; defaults to the owner page (null for rows). */
  parentPageId?: Id | null;
  doc: TipTapDoc | null;
  docRev: Rev;
  readOnly?: boolean;
  font?: PageFont;
  smallText?: boolean;
  fullWidth?: boolean;
  /** Pool the instance (keeps undo history across navigation). Previews pass false. */
  pooled?: boolean;
  /** Enable autosave (default: not read-only). */
  autosave?: boolean;
  hooks?: EditorHooks;
  className?: string;
  /** Element that receives hover tracking for the block handle (the scroll pane); defaults to the editor's parent. */
  hoverRoot?: HTMLElement | null;
  onReady?: (editor: TEditor, saver: DocSaver | null) => void;
  onConflict?: (c: ConflictInfo) => void;
  onStatus?: (s: SaverSnapshot | null) => void;
  placeholder?: string;
}

function createEditor(props: EditorProps): TEditor {
  // Pooled editors keep every behaviour and toggle `editable`; unpooled previews get the lean read-only bundle.
  const lean = !!props.readOnly && props.pooled === false;
  const readOnly = !!props.readOnly;
  const doc = normaliseDocJson(props.doc);
  const vault = useSettings.getState().vault;
  const editor = new TEditor({
    extensions: editorExtensions({ readOnly: lean }),
    content: doc,
    editable: !readOnly,
    injectCSS: false,
    enableInputRules: true,
    enablePasteRules: false,
    enableContentCheck: true,
    onContentError: ({ disableCollaboration }) => disableCollaboration(),
    editorProps: {
      attributes: {
        class: 'emp-prose',
        spellcheck: vault?.spellcheck === false ? 'false' : 'true',
        'data-undo-scope': '',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': 'Page content',
      },
    },
  });
  // Make sure ids/invariants hold before the first save.
  const fix = fixDocument(editor.state.tr);
  if (fix) editor.view.dispatch(fix.setMeta('addToHistory', false).setMeta(REMOTE_META, true));
  return editor;
}

export function Editor(props: EditorProps) {
  const { ownerId, ownerKind, readOnly = false, pooled = true } = props;
  const key = poolKey(ownerKind, ownerId);
  const propsRef = useRef(props);
  propsRef.current = props;

  // Acquire (or create) the instance synchronously so the first paint already has the document.
  const [entry] = useState(() => {
    if (!pooled) return { editor: createEditor(props), rev: props.docRev, pooled: false };
    const e = acquire(key, () => createEditor(props), props.docRev);
    return { editor: e.editor, rev: e.rev, pooled: true };
  });
  const editor = entry.editor;

  useEffect(() => {
    if (entry.pooled) {
      retain(key);
      return () => release(key);
    }
    // Unpooled (previews): destroy after unmount, but survive StrictMode's mount → unmount → mount.
    const pending = destroyTimers.get(editor);
    if (pending) clearTimeout(pending);
    return () => {
      destroyTimers.set(
        editor,
        setTimeout(() => {
          destroyTimers.delete(editor);
          if (!editor.isDestroyed) editor.destroy();
        }, 0),
      );
    };
  }, [entry, key, editor]);

  // A pooled editor holding an older revision than the server: replace its content.
  useLayoutEffect(() => {
    if (!entry.pooled || entry.rev === props.docRev || !props.doc) return;
    if (props.docRev > entry.rev) {
      editor.chain().setMeta(REMOTE_META, true).setMeta('addToHistory', false).setContent(normaliseDocJson(props.doc), { emitUpdate: false }).run();
      setPooledRev(key, props.docRev);
      entry.rev = props.docRev;
    }
  }, [entry, editor, key, props.doc, props.docRev]);

  // Context for node views and menus.
  setEditorContext(editor, {
    ownerId,
    ownerKind,
    workspaceId: props.workspaceId,
    parentPageId: props.parentPageId !== undefined ? props.parentPageId : ownerKind === 'page' ? ownerId : null,
    readOnly,
    hooks: props.hooks ?? {},
  });

  useEffect(() => {
    if (editor.isEditable === !readOnly) return;
    editor.setEditable(!readOnly, false);
  }, [editor, readOnly]);

  const saver = useMemo(() => (props.autosave ?? !readOnly ? saverFor(editor, ownerId, ownerKind, entry.rev) : null), [editor, ownerId, ownerKind, readOnly, props.autosave, entry]);
  useEffect(() => {
    if (!saver) return;
    saver.onConflict = (c) => propsRef.current.onConflict?.(c);
    saver.onSaved = (rev) => {
      setPooledRev(key, rev);
      entry.rev = rev;
    };
    return () => {
      saver.onConflict = null;
      saver.onSaved = null;
    };
  }, [saver, key, entry]);
  const status = useDocSave(saver);
  useEffect(() => propsRef.current.onStatus?.(status), [status]);

  useEffect(() => {
    propsRef.current.onReady?.(editor, saver);
  }, [editor, saver]);

  // Page-level typography options live on the ProseMirror root.
  const spell = useSettings((s) => s.vault?.spellcheck !== false);
  useEffect(() => {
    const dom = editor.view.dom as HTMLElement;
    const set = (k: string, v: string | null) => (v == null ? dom.removeAttribute(k) : dom.setAttribute(k, v));
    set('data-font', props.font && props.font !== 'sans' ? props.font : null);
    set('data-small-text', props.smallText ? '' : null);
    set('data-full-width', props.fullWidth ? '' : null);
    set('spellcheck', spell ? 'true' : 'false');
    const many = editor.state.doc.firstChild ? editor.state.doc.firstChild.childCount > 300 : false;
    set('data-many-blocks', many ? '' : null);
  }, [editor, props.font, props.smallText, props.fullWidth, spell]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverRoot, setHoverRoot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setHoverRoot(props.hoverRoot ?? wrapRef.current), [props.hoverRoot]);

  // Clicking the empty area under the last block focuses (or adds) a trailing paragraph.
  const onTailDown = (e: React.MouseEvent) => {
    if (readOnly || e.target !== e.currentTarget) return;
    e.preventDefault();
    const root = editor.state.doc.firstChild;
    if (!root) return;
    const lastPos = root.content.size + 1 - (root.lastChild?.nodeSize ?? 0);
    const last = infoAt(editor.state.doc, lastPos);
    const tr = editor.state.tr;
    if (!last || last.content.type.name !== 'paragraph' || last.content.content.size > 0) {
      tr.insert(root.content.size + 1, emptyParagraphBlock(editor.schema));
      tr.setSelection(TextSelection.create(tr.doc, root.content.size + 3));
    } else {
      tr.setSelection(TextSelection.create(tr.doc, last.contentPos + 1));
    }
    editor.view.dispatch(tr.scrollIntoView());
    editor.view.focus();
  };

  return (
    <div ref={wrapRef} className={cn('emp-editor-root', readOnly && 'is-readonly', props.className)} data-owner={ownerId}>
      <EditorContent editor={editor} className="emp-editor-content" />
      {!readOnly ? <div className="emp-editor-tail" onMouseDown={onTailDown} aria-hidden /> : null}
      {!readOnly ? (
        <>
          <SuggestHost editor={editor} />
          <BubbleToolbar editor={editor} />
          <BlockHandle editor={editor} root={hoverRoot} />
          <OverlayHost editor={editor} />
        </>
      ) : null}
    </div>
  );
}

export function editorOwner(editor: TEditor): Id {
  return editorContext(editor).ownerId;
}

export default Editor;
