/**
 * Block menu (§7.6): Delete, Duplicate (⌘D), Turn into ▸, Turn into page, Copy link to block, Copy as Markdown,
 * Move to…, Color ▸ — plus table and callout extras. Opened from the ⋮⋮ handle or ⌘/ with blocks selected.
 */
import type { Editor } from '@tiptap/core';
import { ArrowDownToLine, ArrowRightToLine, ClipboardCopy, Copy, FileText, Link, MoveRight, Paintbrush, PanelTop, PanelLeft, Repeat2, Smile, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { notify } from '@/stores/toasts';
import { Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger } from '@/ui/Menu';
import { TURN_INTO, blockLabel, currentTarget, isTextContent } from '../lib/blockTypes';
import { deleteBlocks, duplicateBlocks, findBlockById, turnInto, turnIntoNeedsConfirm, type BlockInfo } from '../lib/blocks';
import { editorContext } from '../lib/context';
import { copyAsMarkdown } from '../extensions/clipboard';
import { setBlockSelection } from '../extensions/blockSelection';
import { ColorMenu } from './ColorMenu';
import { openOverlay } from './overlay';
import { PagePicker } from './PagePicker';
import { moveBlocksToPage } from '../lib/editorCommands';
import type { RectLike } from './Floating';

export interface BlockMenuProps {
  editor: Editor;
  ids: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchor: RectLike;
}

function infos(editor: Editor, ids: string[]): BlockInfo[] {
  return ids.map((id) => findBlockById(editor.state.doc, id)).filter((b): b is BlockInfo => !!b);
}

export function BlockMenu({ editor, ids, open, onOpenChange, anchor }: BlockMenuProps) {
  const [moveOpen, setMoveOpen] = useState(false);
  const blocks = open ? infos(editor, ids) : [];
  const first = blocks[0];
  const readOnly = !editor.isEditable;
  const dispatch = (tr: Parameters<Editor['view']['dispatch']>[0]) => editor.view.dispatch(tr);
  const textish = blocks.every((b) => isTextContent(b.content) || b.content.type.name === 'codeBlock');
  const cur = first ? currentTarget(first.content) : undefined;
  const isTable = blocks.length === 1 && first?.content.type.name === 'table';
  const isCallout = blocks.length === 1 && first?.content.type.name === 'callout';
  const done = () => {
    onOpenChange(false);
    requestAnimationFrame(() => editor.view.focus());
  };
  const refresh = () => infos(editor, ids);

  return (
    <>
      <Menu open={open} onOpenChange={onOpenChange} modal={false}>
        <MenuTrigger asChild>
          <span aria-hidden style={{ position: 'fixed', left: anchor.x, top: anchor.y, width: anchor.width, height: anchor.height, pointerEvents: 'none' }} />
        </MenuTrigger>
        <MenuContent side="left" align="start" width={252} noReturnFocus>
          <MenuLabel>{blocks.length > 1 ? `${blocks.length} blocks` : first ? blockLabel(first.content) : 'Block'}</MenuLabel>
          {textish && !readOnly ? (
            <MenuSub>
              <MenuSubTrigger icon={Repeat2}>Turn into</MenuSubTrigger>
              <MenuSubContent>
                {TURN_INTO.map((t) => (
                  <MenuItem
                    key={t.key}
                    icon={t.icon}
                    shortcut={t.shortcut}
                    trailing={cur?.key === t.key && blocks.length === 1 ? <span className="emp-menu-check">✓</span> : undefined}
                    onSelect={() => {
                      if (t.type === '$page') editorContext(editor).hooks.turnIntoPage?.(ids);
                      else {
                        const list = refresh();
                        if (turnIntoNeedsConfirm(list, t) && !window.confirm('Converting to code flattens nested blocks into text lines. Continue?')) return;
                        turnInto(editor.state, dispatch, list, t);
                      }
                      done();
                    }}
                  >
                    {t.label}
                  </MenuItem>
                ))}
              </MenuSubContent>
            </MenuSub>
          ) : null}
          {!readOnly ? (
            <MenuSub>
              <MenuSubTrigger icon={Paintbrush}>Color</MenuSubTrigger>
              <MenuSubContent>
                <ColorMenu
                  editor={editor}
                  blocks
                  current={{ text: (first?.node.attrs.color as string | null) ?? null, bg: (first?.node.attrs.bg as string | null) ?? null }}
                  onDone={() => {
                    done();
                  }}
                />
              </MenuSubContent>
            </MenuSub>
          ) : null}
          {isCallout && !readOnly ? (
            <MenuItem
              icon={Smile}
              onSelect={() => {
                const el = editor.view.nodeDOM(first.contentPos) as HTMLElement | null;
                const r = el?.querySelector('.emp-callout-icon')?.getBoundingClientRect() ?? el?.getBoundingClientRect();
                if (r) openOverlay({ kind: 'calloutIcon', editorId: editor.instanceId, pos: first.contentPos, rect: { x: r.left, y: r.top, width: r.width, height: r.height } });
              }}
            >
              Change icon
            </MenuItem>
          ) : null}
          {isTable && !readOnly ? (
            <>
              <MenuSeparator />
              <MenuCheckboxItem
                icon={PanelTop}
                checked={!!first.content.attrs.headerRow}
                onCheckedChange={(v) => dispatch(editor.state.tr.setNodeMarkup(first.contentPos, undefined, { ...first.content.attrs, headerRow: v }))}
              >
                Header row
              </MenuCheckboxItem>
              <MenuCheckboxItem
                icon={PanelLeft}
                checked={!!first.content.attrs.headerCol}
                onCheckedChange={(v) => dispatch(editor.state.tr.setNodeMarkup(first.contentPos, undefined, { ...first.content.attrs, headerCol: v }))}
              >
                Header column
              </MenuCheckboxItem>
              <MenuItem icon={ArrowDownToLine} onSelect={() => tableOp(editor, first, 'deleteRow')}>
                Delete row
              </MenuItem>
              <MenuItem icon={ArrowRightToLine} onSelect={() => tableOp(editor, first, 'deleteCol')}>
                Delete column
              </MenuItem>
            </>
          ) : null}
          <MenuSeparator />
          {!readOnly ? (
            <MenuItem
              icon={Copy}
              shortcut="mod+d"
              onSelect={() => {
                const res = duplicateBlocks(editor.state, dispatch, refresh());
                if (res) setBlockSelection(editor.view, res.ids);
              }}
            >
              Duplicate
            </MenuItem>
          ) : null}
          {textish && !readOnly && editorContext(editor).hooks.turnIntoPage ? (
            <MenuItem icon={FileText} shortcut="mod+alt+9" onSelect={() => editorContext(editor).hooks.turnIntoPage?.(ids)}>
              Turn into page
            </MenuItem>
          ) : null}
          {blocks.length === 1 && editorContext(editor).hooks.blockLink ? (
            <MenuItem
              icon={Link}
              onSelect={() => {
                const href = editorContext(editor).hooks.blockLink?.(first.id);
                if (href) void navigator.clipboard.writeText(href).then(() => notify.success('Link to block copied'));
              }}
            >
              Copy link to block
            </MenuItem>
          ) : null}
          <MenuItem icon={ClipboardCopy} onSelect={() => void copyAsMarkdown(refresh().map((b) => b.node))}>
            Copy as Markdown
          </MenuItem>
          {!readOnly && editorContext(editor).ownerKind === 'page' ? (
            <MenuItem icon={MoveRight} onSelect={() => setMoveOpen(true)}>
              Move to…
            </MenuItem>
          ) : null}
          {!readOnly ? (
            <>
              <MenuSeparator />
              <MenuItem
                icon={Trash2}
                destructive
                shortcut="backspace"
                onSelect={() => {
                  deleteBlocks(editor.state, dispatch, refresh());
                  done();
                }}
              >
                Delete
              </MenuItem>
            </>
          ) : null}
        </MenuContent>
      </Menu>
      <PagePicker
        open={moveOpen}
        anchor={anchor}
        title="Move to"
        excludeId={editorContext(editor).ownerId}
        onClose={() => setMoveOpen(false)}
        onPick={(id) => {
          setMoveOpen(false);
          void moveBlocksToPage(editor, infos(editor, ids), id);
        }}
      />
    </>
  );
}

function tableOp(editor: Editor, info: BlockInfo, op: 'deleteRow' | 'deleteCol') {
  const { state } = editor;
  const table = info.content;
  const $f = state.selection.$from;
  let row = table.childCount - 1;
  let col = (table.firstChild?.childCount ?? 1) - 1;
  for (let d = $f.depth; d > 0; d--) {
    if ($f.node(d).type.name === 'tableCell' && $f.node(d - 2) === table) {
      row = $f.index(d - 2);
      col = $f.index(d - 1);
      break;
    }
  }
  const tr = state.tr;
  if (op === 'deleteRow') {
    if (table.childCount <= 1) return;
    let pos = info.contentPos + 1;
    for (let r = 0; r < row; r++) pos += table.child(r).nodeSize;
    tr.delete(pos, pos + table.child(row).nodeSize);
  } else {
    if ((table.firstChild?.childCount ?? 0) <= 1) return;
    let rowPos = info.contentPos + 1;
    const ranges: [number, number][] = [];
    table.forEach((r) => {
      let cellPos = rowPos + 1;
      r.forEach((cell, _o, ci) => {
        if (ci === col) ranges.push([cellPos, cellPos + cell.nodeSize]);
        cellPos += cell.nodeSize;
      });
      rowPos += r.nodeSize;
    });
    for (const [a, b] of ranges.reverse()) tr.delete(a, b);
    const widths = [...((table.attrs.colWidths as number[]) ?? [])];
    widths.splice(col, 1);
    tr.setNodeMarkup(info.contentPos, undefined, { ...table.attrs, colWidths: widths });
  }
  editor.view.dispatch(tr);
}
