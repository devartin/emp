/**
 * Block handle (§5.11, §7.6): an 18×24 grip and a 20×24 `+`, 24px left of the hovered block, aligned to its first
 * line, fading in after a 60ms hover rest. `+` inserts a block below (⌥-click: above) and opens the slash menu;
 * clicking ⋮⋮ selects the block and opens the block menu; dragging it moves the block (dnd.ts).
 */
import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { GripVertical, Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Tooltip } from '@/ui/Tooltip';
import { isMac } from '@/lib/platform';
import { blockLabel } from '../lib/blockTypes';
import { findBlockById, makeContainer, topLevelOnly, type BlockInfo } from '../lib/blocks';
import { selectedBlockIds, selectedBlocks, setBlockSelection } from '../extensions/blockSelection';
import { suggestKey } from '../extensions/suggest';
import { BlockDrag } from './dnd';
import { BlockMenu } from './BlockMenu';
import { useOverlay } from './overlay';

interface Hover {
  id: string;
  top: number;
  left: number;
  label: string;
}

const LINE_ANCHOR = ['.emp-h-text', '.emp-todo-text', '.emp-toggle-text', '.emp-callout-text'];

function lineBox(blockEl: HTMLElement): { top: number; height: number } {
  const content = (blockEl.firstElementChild as HTMLElement | null) ?? blockEl;
  let anchor: HTMLElement = content;
  for (const sel of LINE_ANCHOR) {
    const a = content.matches(sel) ? content : content.querySelector<HTMLElement>(`:scope > ${sel}, :scope > * > ${sel}`);
    if (a) {
      anchor = a;
      break;
    }
  }
  const r = anchor.getBoundingClientRect();
  const lh = parseFloat(getComputedStyle(anchor).lineHeight);
  const type = blockEl.getAttribute('data-type');
  if (type === 'codeBlock') return { top: r.top + 4, height: 24 };
  if (!Number.isFinite(lh) || lh <= 0 || !/^(paragraph|heading|bulletItem|numberedItem|todoItem|toggle|quote|callout)$/.test(type ?? '')) return { top: r.top + 2, height: 24 };
  return { top: r.top, height: Math.min(lh, r.height || lh) };
}

export function BlockHandle({ editor, root }: { editor: Editor; root: HTMLElement | null }) {
  const [hover, setHover] = useState<Hover | null>(null);
  const [visible, setVisible] = useState(false);
  const [menu, setMenu] = useState<{ ids: string[]; anchor: { x: number; y: number; width: number; height: number } } | null>(null);
  const dragging = useRef<BlockDrag | null>(null);
  const raf = useRef(0);
  const last = useRef<{ x: number; y: number } | null>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const overlay = useOverlay((o) => (o.req?.editorId === editor.instanceId && o.req.kind === 'blockMenu' ? o.req : null));
  const closeOverlay = useOverlay((o) => o.close);

  const locate = useCallback(() => {
    raf.current = 0;
    const p = last.current;
    if (!p || dragging.current || menu) return;
    const view = editor.view;
    const pm = view.dom.getBoundingClientRect();
    if (p.y < pm.top - 4 || p.y > pm.bottom + 4 || p.x > pm.right + 40 || p.x < pm.left - 120) {
      setVisible(false);
      return;
    }
    const x = Math.max(p.x, pm.left + 4);
    const hit = document.elementsFromPoint(Math.min(x, pm.right - 4), p.y).find((el) => view.dom.contains(el));
    let blockEl = (hit as HTMLElement | undefined)?.closest<HTMLElement>('.emp-block') ?? null;
    if (!blockEl || !view.dom.contains(blockEl)) {
      // In the gutter between blocks: pick the nearest block by vertical distance.
      const blocks = Array.from(view.dom.querySelectorAll<HTMLElement>(':scope > .emp-group > .emp-block'));
      let best: HTMLElement | null = null;
      let bestD = Infinity;
      for (const b of blocks) {
        const r = b.getBoundingClientRect();
        const d = p.y < r.top ? r.top - p.y : p.y > r.bottom ? p.y - r.bottom : 0;
        if (d < bestD) {
          bestD = d;
          best = b;
        }
      }
      if (!best || bestD > 12) {
        setVisible(false);
        return;
      }
      blockEl = best;
    }
    // Prefer the innermost block whose own first line is under the pointer.
    const id = blockEl.getAttribute('data-id');
    if (!id) return;
    const line = lineBox(blockEl);
    const contentEl = (blockEl.firstElementChild as HTMLElement | null) ?? blockEl;
    const left = contentEl.getBoundingClientRect().left;
    const info = findBlockById(view.state.doc, id);
    setHover({ id, top: line.top + line.height / 2 - 12, left: left - 44 - 2, label: info ? blockLabel(info.content) : 'Block' });
    setVisible(true);
  }, [editor, menu]);

  useEffect(() => {
    const target = root ?? editor.view.dom.parentElement;
    if (!target) return;
    const move = (e: MouseEvent) => {
      last.current = { x: e.clientX, y: e.clientY };
      if (!raf.current) raf.current = requestAnimationFrame(locate);
    };
    const leave = (e: MouseEvent) => {
      if (handleRef.current && e.relatedTarget instanceof Node && handleRef.current.contains(e.relatedTarget)) return;
      setVisible(false);
    };
    const key = () => {
      if (!menu) setVisible(false);
    };
    const scroll = () => {
      if (!raf.current && last.current) raf.current = requestAnimationFrame(locate);
    };
    target.addEventListener('mousemove', move);
    target.addEventListener('mouseleave', leave);
    editor.view.dom.addEventListener('keydown', key);
    window.addEventListener('scroll', scroll, true);
    return () => {
      target.removeEventListener('mousemove', move);
      target.removeEventListener('mouseleave', leave);
      editor.view.dom.removeEventListener('keydown', key);
      window.removeEventListener('scroll', scroll, true);
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
  }, [editor, root, locate, menu]);

  // ⌘/ with blocks selected opens the same menu.
  useEffect(() => {
    if (!overlay) return;
    const ids = (overlay.data?.ids as string[] | undefined) ?? selectedBlockIds(editor.state);
    setMenu({ ids, anchor: overlay.rect });
    closeOverlay();
  }, [overlay, editor, closeOverlay]);

  const blocksFor = (id: string): BlockInfo[] => {
    const sel = selectedBlocks(editor.state);
    if (sel.some((b) => b.id === id)) return topLevelOnly(sel);
    const b = findBlockById(editor.state.doc, id);
    return b ? [b] : [];
  };

  const onGripDown = (e: React.PointerEvent) => {
    if (!hover || e.button !== 0) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY };
    const id = hover.id;
    const anchorEl = e.currentTarget as HTMLElement;
    let started = false;
    const move = (ev: PointerEvent) => {
      if (started || !editor.isEditable) return;
      if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) < 4) return;
      started = true;
      cleanup();
      const blocks = blocksFor(id);
      if (!blocks.length) return;
      setVisible(false);
      dragging.current = new BlockDrag(editor, blocks, { x: ev.clientX, y: ev.clientY }, () => {
        dragging.current = null;
      });
    };
    const up = () => {
      cleanup();
      if (started) return;
      // Click: select the block(s) and open the menu.
      const ids = blocksFor(id).map((b) => b.id);
      editor.view.focus();
      setBlockSelection(editor.view, ids);
      const r = anchorEl.getBoundingClientRect();
      setMenu({ ids, anchor: { x: r.left, y: r.top, width: r.width, height: r.height } });
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onPlus = (e: React.MouseEvent) => {
    if (!hover || !editor.isEditable) return;
    const info = findBlockById(editor.state.doc, hover.id);
    if (!info) return;
    const { schema } = editor.state;
    const above = e.altKey;
    const at = above ? info.pos : info.end;
    const tr = editor.state.tr.insert(at, makeContainer(schema, schema.nodes.paragraph.create(null, schema.text('/'))));
    tr.setSelection(TextSelection.create(tr.doc, at + 3));
    tr.setMeta(suggestKey, { open: { kind: 'slash', from: at + 2, triggerLen: 1 } });
    editor.view.dispatch(tr.scrollIntoView());
    editor.view.focus();
  };

  if (!editor.isEditable && !menu) return null;
  return (
    <>
      {hover ? (
        <div
          ref={handleRef}
          className="emp-block-handle"
          data-visible={visible && !menu ? '' : undefined}
          style={{ transform: `translate3d(${Math.round(hover.left)}px, ${Math.round(hover.top)}px, 0)` }}
          onMouseLeave={(e) => {
            const t = root ?? editor.view.dom.parentElement;
            if (t && e.relatedTarget instanceof Node && t.contains(e.relatedTarget)) return;
            setVisible(false);
          }}
        >
          <Tooltip content={<span className="emp-handle-tip"><b>Click</b> to add below<br /><b>{isMac ? '⌥' : 'Alt'}-click</b> to add above</span>} side="bottom">
            <button type="button" className="emp-handle-plus" aria-label="Add block" onMouseDown={(e) => e.preventDefault()} onClick={onPlus}>
              <Plus size={16} strokeWidth={1.75} />
            </button>
          </Tooltip>
          <Tooltip content={<span className="emp-handle-tip"><b>Drag</b> to move<br /><b>Click</b> to open menu</span>} side="bottom">
            <button type="button" className="emp-handle-grip" aria-label={`${hover.label} options`} onPointerDown={onGripDown}>
              <GripVertical size={16} strokeWidth={1.75} />
            </button>
          </Tooltip>
        </div>
      ) : null}
      {menu ? (
        <BlockMenu
          editor={editor}
          ids={menu.ids}
          anchor={menu.anchor}
          open
          onOpenChange={(o) => {
            if (!o) setMenu(null);
          }}
        />
      ) : null}
    </>
  );
}
