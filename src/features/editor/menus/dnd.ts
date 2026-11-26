/**
 * Block drag and drop (§7.6, §4.2): pointer-driven, a 0.6-opacity clone follows the pointer (lift: scale 1.02, elev-4),
 * a 2px accent drop line with a 6px cap shows the target, the ghost's horizontal offset picks the nesting depth
 * (24px per level), hovering a collapsed toggle for 500ms expands it, the view auto-scrolls within 48px of an edge
 * (≤ 12px/frame), and dropping to the right edge of a top-level block makes columns. The drop is one undo step and
 * the moved block FLIPs into place.
 */
import type { Editor } from '@tiptap/core';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { css } from '@/ui/motion/tokens';
import { allowsChildren, isToggleLike } from '../lib/blockTypes';
import { allBlocks, deleteContainer, infoAt, parentOf, type BlockInfo } from '../lib/blocks';
import { prefersReducedMotion } from '../lib/context';
import { blockSelectionKey, KEEP_BLOCK_SEL } from '../extensions/blockSelection';

const INDENT = 24;
const EDGE = 48;
const MAX_SCROLL = 12;

type FlowBlock = BlockInfo & { depth: number; inColumn: boolean };

type Target =
  | { kind: 'gap'; pos: number; asFirstChildOf: FlowBlock | null; depth: number; line: { x: number; y: number; w: number } }
  | { kind: 'columns'; block: FlowBlock; line: { x: number; y: number; h: number } };

function scrollParent(el: HTMLElement): HTMLElement | Window {
  let cur: HTMLElement | null = el.parentElement;
  while (cur) {
    const s = getComputedStyle(cur);
    if (/(auto|scroll)/.test(s.overflowY) && cur.scrollHeight > cur.clientHeight) return cur;
    cur = cur.parentElement;
  }
  return window;
}

function rowEl(blockEl: HTMLElement): HTMLElement {
  return (blockEl.firstElementChild as HTMLElement | null) ?? blockEl;
}

export class BlockDrag {
  private ghost: HTMLElement;
  private line: HTMLElement;
  private target: Target | null = null;
  private raf = 0;
  private scroller: HTMLElement | Window;
  private pointer = { x: 0, y: 0 };
  private hoverToggle: { id: string; since: number } | null = null;
  private sourceEls: HTMLElement[];
  private offset: { x: number; y: number };
  private done = false;

  constructor(
    private editor: Editor,
    private blocks: BlockInfo[],
    start: { x: number; y: number },
    private onEnd: () => void,
  ) {
    const view = editor.view;
    this.sourceEls = blocks.map((b) => view.nodeDOM(b.pos) as HTMLElement | null).filter((e): e is HTMLElement => !!e);
    const first = this.sourceEls[0];
    const r = first.getBoundingClientRect();
    this.offset = { x: start.x - r.left, y: start.y - r.top };
    this.ghost = document.createElement('div');
    this.ghost.className = 'emp-drag-ghost emp-prose';
    this.ghost.style.width = `${r.width}px`;
    const clone = first.cloneNode(true) as HTMLElement;
    clone.classList.remove('emp-block-selected');
    clone.removeAttribute('contenteditable');
    clone.querySelectorAll('[contenteditable]').forEach((n) => n.removeAttribute('contenteditable'));
    this.ghost.appendChild(clone);
    if (blocks.length > 1) {
      const badge = document.createElement('span');
      badge.className = 'emp-drag-count';
      badge.textContent = String(blocks.length);
      this.ghost.appendChild(badge);
    }
    for (const attr of ['data-font', 'data-small-text']) {
      const v = view.dom.getAttribute(attr);
      if (v != null) this.ghost.setAttribute(attr, v);
    }
    document.body.appendChild(this.ghost);
    this.line = document.createElement('div');
    this.line.className = 'emp-drop-indicator';
    this.line.style.opacity = '0';
    document.body.appendChild(this.line);
    this.sourceEls.forEach((e) => e.classList.add('is-drag-source'));
    document.documentElement.classList.add('emp-dragging');
    this.scroller = scrollParent(view.dom);
    this.pointer = start;
    this.positionGhost();
    requestAnimationFrame(() => this.ghost.classList.add('is-lifted'));
    window.addEventListener('pointermove', this.onMove, true);
    window.addEventListener('pointerup', this.onUp, true);
    window.addEventListener('keydown', this.onKey, true);
    this.raf = requestAnimationFrame(this.tick);
  }

  private positionGhost() {
    this.ghost.style.transform = `translate3d(${this.pointer.x - this.offset.x}px, ${this.pointer.y - this.offset.y}px, 0)`;
  }

  private onMove = (e: PointerEvent) => {
    this.pointer = { x: e.clientX, y: e.clientY };
    this.positionGhost();
    this.compute();
  };

  private onUp = () => {
    this.finish(true);
  };

  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.finish(false);
    }
  };

  private tick = () => {
    if (this.done) return;
    // Auto-scroll near the edges.
    const rect = this.scroller instanceof Window ? { top: 0, bottom: window.innerHeight } : this.scroller.getBoundingClientRect();
    const y = this.pointer.y;
    let dy = 0;
    if (y < rect.top + EDGE) dy = -Math.ceil(MAX_SCROLL * Math.min(1, (rect.top + EDGE - y) / EDGE));
    else if (y > rect.bottom - EDGE) dy = Math.ceil(MAX_SCROLL * Math.min(1, (y - (rect.bottom - EDGE)) / EDGE));
    if (dy) {
      if (this.scroller instanceof Window) window.scrollBy(0, dy);
      else this.scroller.scrollTop += dy;
      this.compute();
    }
    // Hovering a collapsed toggle for 500ms expands it.
    if (this.hoverToggle && performance.now() - this.hoverToggle.since > 500) {
      const id = this.hoverToggle.id;
      this.hoverToggle = null;
      const b = allBlocks(this.editor.state.doc).find((x) => x.id === id);
      if (b && isToggleLike(b.content) && b.content.attrs.collapsed) {
        this.editor.view.dispatch(this.editor.state.tr.setNodeMarkup(b.contentPos, undefined, { ...b.content.attrs, collapsed: false }));
        requestAnimationFrame(() => this.compute());
      }
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private flow(): FlowBlock[] {
    const doc = this.editor.state.doc;
    const out: FlowBlock[] = [];
    const dragged = this.blocks;
    for (const b of allBlocks(doc, { visibleOnly: true })) {
      if (dragged.some((d) => b.pos >= d.pos && b.end <= d.end)) continue;
      out.push(b);
    }
    return out;
  }

  private compute() {
    const view = this.editor.view;
    const { x, y } = this.pointer;
    const ghostLeft = x - this.offset.x;
    const all = this.flow();
    const rows = all
      .map((b) => {
        const el = view.nodeDOM(b.pos) as HTMLElement | null;
        if (!el) return null;
        return { b, el, row: rowEl(el).getBoundingClientRect(), box: el.getBoundingClientRect() };
      })
      .filter((r): r is NonNullable<typeof r> => !!r && r.row.height > 0);
    // Which flow: a column under the pointer, else the main flow.
    const colEl = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('.emp-column');
    let flowRows = rows.filter((r) => !r.b.inColumn);
    let base: DOMRect | null = view.dom.getBoundingClientRect();
    if (colEl && view.dom.contains(colEl)) {
      flowRows = rows.filter((r) => colEl.contains(r.el));
      base = colEl.getBoundingClientRect();
    }
    if (!flowRows.length || !base) {
      this.setTarget(null);
      return;
    }
    const baseLeft = (flowRows.find((r) => r.b.depth === 0) ?? flowRows[0]).box.left;
    // Columns: pointer near the right edge of a top-level block.
    if (!colEl) {
      const over = flowRows.find((r) => r.b.depth === 0 && y >= r.row.top && y <= r.row.bottom);
      if (over && x > over.box.right - 40 && x < over.box.right + 60 && over.b.content.type.name !== 'columnList' && !this.blocks.some((d) => d.content.type.name === 'columnList')) {
        this.setTarget({ kind: 'columns', block: over.b, line: { x: over.box.right + 4, y: over.box.top, h: over.box.height } });
        return;
      }
    }
    let i = flowRows.findIndex((r) => y < r.row.top + r.row.height / 2);
    if (i < 0) i = flowRows.length;
    const prev = i > 0 ? flowRows[i - 1] : null;
    const next = i < flowRows.length ? flowRows[i] : null;
    // Collapsed toggle hover tracking.
    const hovered = flowRows.find((r) => y >= r.row.top && y <= r.row.bottom);
    if (hovered && isToggleLike(hovered.b.content) && hovered.b.content.attrs.collapsed) {
      if (this.hoverToggle?.id !== hovered.b.id) this.hoverToggle = { id: hovered.b.id, since: performance.now() };
    } else this.hoverToggle = null;
    const prevCanNest = !!prev && allowsChildren(prev.b.content) && !(isToggleLike(prev.b.content) && prev.b.content.attrs.collapsed);
    const max = prev ? prev.b.depth + (prevCanNest ? 1 : 0) : 0;
    const min = next ? Math.min(next.b.depth, max) : 0;
    const desired = Math.round((ghostLeft - baseLeft) / INDENT);
    const depth = Math.max(min, Math.min(max, desired));
    const lineY = next && prev ? Math.round((Math.min(prev.box.bottom, next.row.top) + next.row.top) / 2) - 1 : next ? next.row.top - 3 : prev ? prev.box.bottom + 1 : base.top;
    const lineX = baseLeft + depth * INDENT;
    const right = (prev ?? next)!.box.right;
    const line = { x: lineX, y: lineY, w: Math.max(40, right - lineX) };
    if (!prev) {
      this.setTarget({ kind: 'gap', pos: next!.b.pos, asFirstChildOf: null, depth, line });
      return;
    }
    if (depth === prev.b.depth + 1) {
      this.setTarget({ kind: 'gap', pos: prev.b.group ? prev.b.contentEnd + 1 : prev.b.contentEnd, asFirstChildOf: prev.b, depth, line });
      return;
    }
    // Insert after prev's ancestor at `depth`.
    const doc = this.editor.state.doc;
    let anc: BlockInfo = prev.b;
    let d = prev.b.depth;
    while (d > depth) {
      const p = parentOf(doc, anc);
      if (!p) break;
      anc = p;
      d--;
    }
    this.setTarget({ kind: 'gap', pos: anc.end, asFirstChildOf: null, depth, line });
  }

  private setTarget(t: Target | null) {
    this.target = t;
    const l = this.line;
    if (!t) {
      l.style.opacity = '0';
      return;
    }
    l.style.opacity = '1';
    if (t.kind === 'gap') {
      l.classList.remove('is-vertical');
      l.style.transform = `translate3d(${t.line.x}px, ${t.line.y}px, 0)`;
      l.style.width = `${t.line.w}px`;
      l.style.height = '2px';
    } else {
      l.classList.add('is-vertical');
      l.style.transform = `translate3d(${t.line.x}px, ${t.line.y}px, 0)`;
      l.style.width = '2px';
      l.style.height = `${t.line.h}px`;
    }
  }

  private finish(drop: boolean) {
    if (this.done) return;
    this.done = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('pointermove', this.onMove, true);
    window.removeEventListener('pointerup', this.onUp, true);
    window.removeEventListener('keydown', this.onKey, true);
    const ghostRect = this.ghost.getBoundingClientRect();
    this.ghost.remove();
    this.line.remove();
    this.sourceEls.forEach((e) => e.classList.remove('is-drag-source'));
    document.documentElement.classList.remove('emp-dragging');
    if (drop && this.target) this.apply(this.target, ghostRect);
    this.onEnd();
  }

  private apply(t: Target, ghostRect: DOMRect) {
    const { state } = this.editor;
    const { schema } = state;
    const doc = state.doc;
    const blocks = this.blocks.map((b) => infoAt(doc, b.pos)).filter((b): b is BlockInfo => !!b);
    if (!blocks.length) return;
    const nodes: PMNode[] = blocks.map((b) => b.node);
    const tr = state.tr;
    if (t.kind === 'columns') {
      const target = infoAt(doc, t.block.pos);
      if (!target || blocks.some((b) => b.pos >= target.pos && b.end <= target.end)) return;
      const col = (kids: PMNode[]) => schema.nodes.column.create(null, schema.nodes.blockGroup.create(null, kids));
      const list = schema.nodes.columnList.create({ widths: [0.5, 0.5] }, [col([target.node]), col(nodes)]);
      const container = schema.nodes.blockContainer.create(null, list);
      tr.replaceWith(target.pos, target.end, container);
    } else {
      if (blocks.some((b) => t.pos > b.pos && t.pos < b.end)) return;
      if (t.asFirstChildOf && !t.asFirstChildOf.group) tr.insert(t.pos, schema.nodes.blockGroup.create(null, nodes));
      else tr.insert(t.pos, Fragment.from(nodes));
    }
    for (const b of [...blocks].sort((a, z) => z.pos - a.pos)) {
      const from = tr.mapping.map(b.pos, 1);
      const node = tr.doc.nodeAt(from);
      if (node && node.attrs.id === b.id) deleteContainer(tr, from);
    }
    tr.setMeta(blockSelectionKey, { set: { ids: blocks.map((b) => b.id) } }).setMeta(KEEP_BLOCK_SEL, true);
    this.editor.view.dispatch(tr.scrollIntoView());
    if (prefersReducedMotion()) return;
    requestAnimationFrame(() => {
      const el = this.editor.view.dom.querySelector<HTMLElement>(`.emp-block[data-id="${CSS.escape(blocks[0].id)}"]`);
      if (!el) return;
      const r = el.getBoundingClientRect();
      const dx = ghostRect.left - r.left;
      const dy = ghostRect.top - r.top;
      if (Math.abs(dx) + Math.abs(dy) < 2) return;
      el.animate([{ transform: `translate(${dx}px, ${dy}px) scale(1.02)`, opacity: 0.8 }, { transform: 'none', opacity: 1 }], { duration: 240, easing: css.easeOutExpo });
    });
  }
}
