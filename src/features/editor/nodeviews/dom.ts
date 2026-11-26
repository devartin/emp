/**
 * Plain-DOM node views for hot blocks (§7.1: hot blocks never use React node views). Each view only touches the DOM
 * it owns and reports interactions as transactions, so typing stays on ProseMirror's fast path.
 */
import type { Editor, NodeViewRenderer, NodeViewRendererProps } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { api } from '@/backend';
import type { DateValue, Icon } from '@/backend/types';
import { navigate } from '@/app/router';
import { formatBytes } from '@/lib/format';
import { formatDateValue } from '@/lib/dates';
import { glyphSvg } from '@/ui/icons/domGlyph';
import { glyphName } from '@/ui/icons/Icon';
import { isToggleLike } from '../lib/blockTypes';
import { allBlocks, infoAt, makeContainer } from '../lib/blocks';
import { cachedAsset, loadAsset, pickFiles, uploadBlob } from '../lib/assets';
import { editorContext, prefersReducedMotion } from '../lib/context';
import { domIcon, el } from '../lib/domIcons';
import { pageInfo, subscribePageInfo } from '../lib/pageInfo';
import { openOverlay, rectOf } from '../menus/overlay';
import { renderKatex } from '../lib/katex';
import { languageLabel } from '../lib/languages';

type GetPos = () => number | undefined;

function posOf(getPos: GetPos | boolean): number | null {
  if (typeof getPos !== 'function') return null;
  const p = getPos();
  return typeof p === 'number' ? p : null;
}

function editable(editor: Editor): boolean {
  return editor.isEditable && !editorContext(editor).readOnly;
}

// ───────────────────────────────────────────────────────────────────────────── blockContainer

function syncContainer(dom: HTMLElement, node: PMNode) {
  const c = node.firstChild;
  const set = (k: string, v: string | null | undefined) => {
    if (v == null) dom.removeAttribute(k);
    else if (dom.getAttribute(k) !== v) dom.setAttribute(k, v);
  };
  set('data-id', node.attrs.id ? String(node.attrs.id) : null);
  set('data-type', c ? c.type.name : null);
  set('data-level', c?.type.name === 'heading' ? String(c.attrs.level) : null);
  set('data-color', node.attrs.color ?? null);
  set('data-bg', node.attrs.bg ?? null);
  set('dir', node.attrs.dir && node.attrs.dir !== 'auto' ? node.attrs.dir : 'auto');
  const toggle = isToggleLike(c ?? null);
  set('data-toggle', toggle ? '' : null);
  set('data-collapsed', toggle && c?.attrs.collapsed ? '' : null);
  set('data-children', node.childCount > 1 ? '' : null);
  set('data-empty-toggle', toggle && !c?.attrs.collapsed && node.childCount < 2 ? '' : null);
  set('data-checked', c?.type.name === 'todoItem' && c.attrs.checked ? '' : null);
  set('data-tone', c?.type.name === 'callout' ? String(c.attrs.color ?? 'gray') : null);
}

export const containerView: NodeViewRenderer = ({ node }) => {
  const dom = el('div', 'emp-block');
  dom.setAttribute('data-node-type', 'blockContainer');
  let current = node;
  syncContainer(dom, node);
  return {
    dom,
    contentDOM: dom,
    update(next) {
      if (next.type !== current.type) return false;
      current = next;
      syncContainer(dom, next);
      return true;
    },
    ignoreMutation(m) {
      return m.type === 'attributes' && m.target === dom;
    },
  };
};

// ───────────────────────────────────────────────────────────────────────────── toggles

/** Expand/collapse: instant (a frequent action, motion class C0). Only the chevron turns (160ms, editor.css). */
export function setToggleCollapsed(view: EditorView, contentPos: number, collapsed: boolean): void {
  const content = view.state.doc.nodeAt(contentPos);
  if (!content || !isToggleLike(content)) return;
  view.dispatch(view.state.tr.setNodeMarkup(contentPos, undefined, { ...content.attrs, collapsed }).setMeta('addToHistory', true));
}

function chevronButton(): HTMLButtonElement {
  const b = el('button', 'emp-chevron', { type: 'button', contenteditable: 'false', tabindex: '-1', 'aria-label': 'Toggle' });
  b.appendChild(domIcon('chevronRight', 16, 2));
  return b;
}

function wireChevron(btn: HTMLButtonElement, view: EditorView, getPos: GetPos | boolean, readNode: () => PMNode) {
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const pos = posOf(getPos);
    if (pos == null) return;
    setToggleCollapsed(view, pos, !readNode().attrs.collapsed);
  });
}

/** Clicking the "Empty toggle" hint creates a first child. */
function wireEmptyHint(dom: HTMLElement, editor: Editor, getPos: GetPos | boolean) {
  dom.addEventListener('mousedown', (e) => {
    if (e.target !== dom || !editable(editor)) return;
    const row = dom.firstElementChild as HTMLElement | null;
    if (!row || e.clientY < row.getBoundingClientRect().bottom) return;
    const pos = posOf(getPos);
    if (pos == null) return;
    const container = infoAt(editor.state.doc, pos - 1);
    if (!container || container.group) return;
    e.preventDefault();
    const { schema } = editor.state;
    const tr = editor.state.tr.insert(container.contentEnd, schema.nodes.blockGroup.create(null, makeContainer(schema, schema.nodes.paragraph.create())));
    editor.view.dispatch(tr);
    editor.commands.setTextSelection(container.contentEnd + 3);
    editor.view.focus();
  });
}

export const toggleView: NodeViewRenderer = ({ node, view, getPos, editor }) => {
  const dom = el('div', 'emp-toggle');
  dom.setAttribute('data-content-type', 'toggle');
  const row = el('div', 'emp-toggle-row');
  const btn = chevronButton();
  const text = el('div', 'emp-toggle-text');
  row.append(btn, text);
  dom.append(row);
  let current = node;
  wireChevron(btn, view, getPos, () => current);
  wireEmptyHint(dom, editor, getPos);
  const sync = () => btn.setAttribute('aria-expanded', current.attrs.collapsed ? 'false' : 'true');
  sync();
  return {
    dom,
    contentDOM: text,
    update(next) {
      if (next.type !== current.type) return false;
      current = next;
      sync();
      return true;
    },
    stopEvent: (e) => e.target instanceof Node && btn.contains(e.target),
    ignoreMutation: (m) => m.type === 'attributes' || (m.target instanceof Node && btn.contains(m.target)),
  };
};

export const headingView: NodeViewRenderer = ({ node, view, getPos, editor }) => {
  const level = Math.min(3, Math.max(1, Number(node.attrs.level) || 1));
  const dom = el(`h${level}` as 'h1', 'emp-h');
  dom.setAttribute('data-content-type', 'heading');
  dom.setAttribute('data-level', String(level));
  const text = el('span', 'emp-h-text');
  let btn: HTMLButtonElement | null = null;
  let current = node;
  const sync = () => {
    if (current.attrs.toggle && !btn) {
      btn = chevronButton();
      wireChevron(btn, view, getPos, () => current);
      dom.insertBefore(btn, text);
    } else if (!current.attrs.toggle && btn) {
      btn.remove();
      btn = null;
    }
    dom.toggleAttribute('data-toggle', !!current.attrs.toggle);
    btn?.setAttribute('aria-expanded', current.attrs.collapsed ? 'false' : 'true');
  };
  dom.appendChild(text);
  sync();
  wireEmptyHint(dom, editor, getPos);
  return {
    dom,
    contentDOM: text,
    update(next) {
      if (next.type !== current.type || next.attrs.level !== current.attrs.level) return false;
      current = next;
      sync();
      return true;
    },
    stopEvent: (e) => !!btn && e.target instanceof Node && btn.contains(e.target),
    ignoreMutation: (m) => m.type === 'attributes' || (!!btn && m.target instanceof Node && btn.contains(m.target)),
  };
};

// ───────────────────────────────────────────────────────────────────────────── to-do

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The kit checkbox's inner structure (lit cap + drawn tick), built in plain DOM for the hot to-do node view. */
function checkFace(box: HTMLElement) {
  const cap = el('span', 'emp-check-cap');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M5 12.5l4.5 4.5L19 7.5');
  path.setAttribute('pathLength', '1');
  path.setAttribute('class', 'emp-check-tick');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '3.2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  const ind = el('span', 'emp-check-ind');
  ind.appendChild(svg);
  box.append(cap, ind);
}

/**
 * To-do: the box is the kit checkbox (ink fill and a 120ms tick when done); the text strikes through and fades to
 * tertiary in 150ms (C1 feedback, editor.css).
 */
export const todoView: NodeViewRenderer = ({ node, getPos, editor }) => {
  const dom = el('div', 'emp-todo');
  dom.setAttribute('data-content-type', 'todoItem');
  const box = el('button', 'emp-check', { type: 'button', contenteditable: 'false', role: 'checkbox', tabindex: '-1' });
  checkFace(box);
  const text = el('div', 'emp-todo-text');
  const inline = el('span', 'emp-todo-inline');
  text.appendChild(inline);
  dom.append(box, text);
  let current = node;
  const sync = () => {
    const on = !!current.attrs.checked;
    dom.setAttribute('data-checked', on ? 'true' : 'false');
    box.setAttribute('aria-checked', on ? 'true' : 'false');
    box.setAttribute('data-state', on ? 'checked' : 'unchecked');
  };
  sync();
  box.addEventListener('mousedown', (e) => e.preventDefault());
  box.addEventListener('click', (e) => {
    e.preventDefault();
    const pos = posOf(getPos);
    if (pos == null || !editable(editor)) return;
    const checked = !current.attrs.checked;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, checked }));
  });
  return {
    dom,
    contentDOM: inline,
    update(next) {
      if (next.type !== current.type) return false;
      current = next;
      sync();
      return true;
    },
    stopEvent: (e) => e.target instanceof Node && box.contains(e.target),
    ignoreMutation: (m) => m.type === 'attributes' || (m.target instanceof Node && box.contains(m.target)),
  };
};

// ───────────────────────────────────────────────────────────────────────────── callout

/** Glyph SVGs already rendered once (cloned synchronously from the kit's cache afterwards). */
const glyphReady = new Set<string>();

/**
 * Fills `host` with the registry glyph `name`. The kit renders a glyph through React the first time, which cannot
 * happen while React is rendering (node views are built inside EditorContent's render), so a first-time glyph is
 * drawn in a microtask; later ones are cloned synchronously.
 */
function putGlyph(host: HTMLElement, name: string, size: number): void {
  const key = `${name}|${size}`;
  if (glyphReady.has(key)) {
    const svg = glyphSvg(name, 'inline', size);
    if (svg) host.replaceChildren(svg);
    return;
  }
  queueMicrotask(() => {
    const svg = glyphSvg(name, 'inline', size);
    if (!svg) return;
    glyphReady.add(key);
    host.replaceChildren(svg);
  });
}

/**
 * A page / callout icon as a DOM node: a Lucide glyph (`{t:'lucide'}`, or a legacy emoji mapped through the kit's
 * emoji map), an uploaded image, else the `fallback` glyph (none when null). Never renders an emoji.
 */
export function iconGlyph(icon: Icon | null | undefined, fallback: string | null = 'lightbulb', size = 16): HTMLElement {
  const span = el('span', 'emp-icon-glyph');
  if (icon?.t === 'asset') {
    const img = el('img', 'emp-icon-img', { alt: '', draggable: 'false' });
    const a = cachedAsset(icon.assetId);
    if (a) img.src = a.url;
    else void loadAsset(icon.assetId).then((x) => x && (img.src = x.url));
    span.appendChild(img);
    return span;
  }
  const name = glyphName(icon) ?? fallback;
  if (name) putGlyph(span, name, size);
  return span;
}

/** A page's own glyph in `host` when it has one (lucide or a mapped emoji); otherwise `fallback()` stays. */
function pageGlyphInto(host: HTMLElement, icon: Icon | null | undefined, size: number, fallback: () => HTMLElement | SVGElement): void {
  const name = glyphName(icon);
  host.replaceChildren(fallback());
  if (name) putGlyph(host, name, size);
}

export const calloutView: NodeViewRenderer = ({ node, getPos, editor }) => {
  const dom = el('div', 'emp-callout');
  dom.setAttribute('data-content-type', 'callout');
  const iconBtn = el('button', 'emp-callout-icon', { type: 'button', contenteditable: 'false', tabindex: '-1', 'aria-label': 'Change icon' });
  const text = el('div', 'emp-callout-text');
  dom.append(iconBtn, text);
  let current = node;
  const sync = () => {
    dom.setAttribute('data-tone', String(current.attrs.color ?? 'gray'));
    iconBtn.replaceChildren(iconGlyph(current.attrs.icon as Icon));
  };
  sync();
  iconBtn.addEventListener('mousedown', (e) => e.preventDefault());
  iconBtn.addEventListener('click', (e) => {
    e.preventDefault();
    const pos = posOf(getPos);
    if (pos == null || !editable(editor)) return;
    openOverlay({ kind: 'calloutIcon', editorId: editor.instanceId, pos, rect: rectOf(iconBtn) });
  });
  return {
    dom,
    contentDOM: text,
    update(next) {
      if (next.type !== current.type) return false;
      const changed = next.attrs.icon !== current.attrs.icon || next.attrs.color !== current.attrs.color;
      current = next;
      if (changed) sync();
      return true;
    },
    stopEvent: (e) => e.target instanceof Node && iconBtn.contains(e.target),
    ignoreMutation: (m) => m.type === 'attributes' || (m.target instanceof Node && iconBtn.contains(m.target)),
  };
};

// ───────────────────────────────────────────────────────────────────────────── code

export const codeBlockView: NodeViewRenderer = ({ node, getPos, editor }) => {
  const dom = el('div', 'emp-code');
  dom.setAttribute('data-content-type', 'codeBlock');
  const bar = el('div', 'emp-code-bar', { contenteditable: 'false' });
  const lang = el('button', 'emp-code-lang', { type: 'button', tabindex: '-1' });
  const langText = el('span');
  lang.append(langText, domIcon('chevronDown', 12, 2));
  const spacer = el('span', 'emp-code-spacer');
  const wrapBtn = el('button', 'emp-code-btn', { type: 'button', tabindex: '-1', 'aria-label': 'Wrap lines', title: 'Wrap lines' });
  wrapBtn.appendChild(domIcon('wrap', 14));
  const copy = el('button', 'emp-code-btn', { type: 'button', tabindex: '-1', 'aria-label': 'Copy code' });
  const copyLabel = el('span', 'emp-code-copy-label');
  copyLabel.textContent = 'Copy';
  // copy → check success morph: both glyphs live in one slot and swap by rotate/scale/opacity (data-done)
  const copySlot = el('span', 'emp-code-copy-icon');
  const copyA = domIcon('copy', 14);
  copyA.classList.add('is-copy');
  const copyB = domIcon('check', 14, 2.25);
  copyB.classList.add('is-check');
  copySlot.append(copyA, copyB);
  copy.append(copySlot, copyLabel);
  bar.append(lang, spacer, wrapBtn, copy);
  const pre = el('pre', 'emp-code-pre');
  const code = el('code');
  pre.appendChild(code);
  const caption = el('input', 'emp-code-caption', { placeholder: 'Add a caption', spellcheck: 'false', 'aria-label': 'Caption' });
  dom.append(bar, pre, caption);
  let current = node;
  const sync = () => {
    langText.textContent = languageLabel(String(current.attrs.language ?? 'plain'));
    dom.toggleAttribute('data-wrap', !!current.attrs.wrap);
    wrapBtn.toggleAttribute('data-active', !!current.attrs.wrap);
    if (document.activeElement !== caption) caption.value = String(current.attrs.caption ?? '');
    dom.toggleAttribute('data-has-caption', !!current.attrs.caption);
    caption.readOnly = !editable(editor);
  };
  sync();
  const setAttr = (patch: Record<string, unknown>) => {
    const pos = posOf(getPos);
    if (pos == null || !editable(editor)) return;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, ...patch }));
  };
  for (const b of [lang, wrapBtn, copy]) b.addEventListener('mousedown', (e) => e.preventDefault());
  lang.addEventListener('click', () => {
    const pos = posOf(getPos);
    if (pos == null || !editable(editor)) return;
    openOverlay({ kind: 'codeLang', editorId: editor.instanceId, pos, rect: rectOf(lang) });
  });
  wrapBtn.addEventListener('click', () => setAttr({ wrap: !current.attrs.wrap }));
  let copyTimer: ReturnType<typeof setTimeout> | null = null;
  copy.addEventListener('click', () => {
    void navigator.clipboard?.writeText(current.textContent).then(() => {
      copy.setAttribute('data-done', '');
      copyLabel.textContent = 'Copied';
      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copy.removeAttribute('data-done');
        copyLabel.textContent = 'Copy';
      }, 1400);
    });
  });
  caption.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      caption.blur();
      editor.view.focus();
    }
  });
  caption.addEventListener('blur', () => {
    if (caption.value !== String(current.attrs.caption ?? '')) setAttr({ caption: caption.value.slice(0, 500) });
  });
  return {
    dom,
    contentDOM: code,
    update(next) {
      if (next.type !== current.type) return false;
      const attrsChanged = next.attrs !== current.attrs;
      current = next;
      if (attrsChanged) sync();
      return true;
    },
    stopEvent: (e) => e.target instanceof Node && (bar.contains(e.target) || caption.contains(e.target)),
    ignoreMutation: (m) => m.type === 'attributes' || (m.target instanceof Node && (bar.contains(m.target) || caption.contains(m.target))),
    destroy() {
      if (copyTimer) clearTimeout(copyTimer);
    },
  };
};

// ───────────────────────────────────────────────────────────────────────────── page blocks

function pageBlockView(variant: 'ref' | 'link'): NodeViewRenderer {
  return ({ node, editor }) => {
    const dom = el('div', variant === 'ref' ? 'emp-pageref' : 'emp-pagelink', { contenteditable: 'false', role: 'link', tabindex: '-1' });
    dom.setAttribute('data-content-type', variant === 'ref' ? 'pageRef' : 'pageLink');
    const icon = el('span', 'emp-pageref-icon');
    const title = el('span', 'emp-pageref-title');
    dom.append(icon, title);
    if (variant === 'link') {
      const arrow = el('span', 'emp-pageref-arrow');
      arrow.appendChild(domIcon('arrowUpRight', 14, 2));
      dom.append(arrow);
    }
    let current = node;
    const render = () => {
      const meta = pageInfo(current.attrs.pageId as string | null);
      if (meta === undefined) {
        title.textContent = '';
        dom.setAttribute('data-loading', '');
        return;
      }
      dom.removeAttribute('data-loading');
      if (!meta) {
        icon.replaceChildren(domIcon('fileText', 18));
        title.textContent = 'Deleted page';
        dom.setAttribute('data-missing', '');
        return;
      }
      dom.removeAttribute('data-missing');
      pageGlyphInto(icon, meta.icon, 18, () => domIcon(meta.kind === 'database' ? 'listTree' : 'fileText', 18));
      title.textContent = meta.title || 'Untitled';
      dom.toggleAttribute('data-untitled', !meta.title);
    };
    render();
    const unsub = subscribePageInfo(render);
    dom.addEventListener('click', (e) => {
      const id = current.attrs.pageId as string | null;
      if (!id || dom.hasAttribute('data-missing')) return;
      e.preventDefault();
      navigate({ t: 'page', id });
    });
    dom.addEventListener('mousedown', (e) => {
      // Keep the click a navigation; ⇧/⌘ click selects the block instead.
      if (e.shiftKey || e.metaKey || e.ctrlKey) return;
      e.preventDefault();
    });
    void editor;
    return {
      dom,
      update(next) {
        if (next.type !== current.type) return false;
        const changed = next.attrs.pageId !== current.attrs.pageId;
        current = next;
        if (changed) render();
        return true;
      },
      selectNode: () => dom.classList.add('is-selected'),
      deselectNode: () => dom.classList.remove('is-selected'),
      ignoreMutation: () => true,
      stopEvent: (e) => e.type === 'click' || e.type === 'mousedown',
      destroy: unsub,
    };
  };
}

export const pageRefView = pageBlockView('ref');
export const pageLinkView = pageBlockView('link');

// ───────────────────────────────────────────────────────────────────────────── file

function extOf(name: string): string {
  const m = /\.([a-z0-9]{1,6})$/i.exec(name);
  return m ? m[1].toUpperCase() : 'FILE';
}

export const fileView: NodeViewRenderer = ({ node, editor, getPos }) => {
  const dom = el('div', 'emp-file', { contenteditable: 'false' });
  dom.setAttribute('data-content-type', 'file');
  let current = node;
  const render = () => {
    const id = current.attrs.assetId as string | null;
    dom.replaceChildren();
    if (!id) {
      const empty = el('button', 'emp-file-empty', { type: 'button' });
      empty.append(domIcon('paperclip', 18), Object.assign(el('span'), { textContent: 'Upload or drop a file' }));
      empty.addEventListener('click', async () => {
        const [f] = await pickFiles('*/*');
        const pos = posOf(getPos);
        if (!f || pos == null) return;
        empty.setAttribute('data-busy', '');
        try {
          const a = await uploadBlob(editorContext(editor).workspaceId, f, f.name);
          editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, assetId: a.id }));
        } catch (err) {
          empty.removeAttribute('data-busy');
          const { notify } = await import('@/stores/toasts');
          notify.fromError(err, "Couldn't upload that file");
        }
      });
      dom.appendChild(empty);
      return;
    }
    const a = cachedAsset(id);
    const badge = el('span', 'emp-file-badge');
    badge.textContent = a ? extOf(a.name) : '';
    const name = el('span', 'emp-file-name');
    name.textContent = a?.name ?? 'Loading…';
    const size = el('span', 'emp-file-size');
    size.textContent = a ? formatBytes(a.size) : '';
    const open = el('span', 'emp-file-open');
    open.appendChild(domIcon('arrowUpRight', 14, 2));
    dom.append(badge, name, size, open);
    if (!a) void loadAsset(id).then((x) => x && current.attrs.assetId === id && render());
  };
  render();
  dom.addEventListener('click', (e) => {
    const id = current.attrs.assetId as string | null;
    if (!id) return;
    e.preventDefault();
    void api.asset.openExternal({ id }).catch(async (err) => {
      const { notify } = await import('@/stores/toasts');
      notify.fromError(err, "Couldn't open that file");
    });
  });
  return {
    dom,
    update(next) {
      if (next.type !== current.type) return false;
      const changed = next.attrs.assetId !== current.attrs.assetId;
      current = next;
      if (changed) render();
      return true;
    },
    selectNode: () => dom.classList.add('is-selected'),
    deselectNode: () => dom.classList.remove('is-selected'),
    ignoreMutation: () => true,
    stopEvent: (e) => e.type === 'click',
  };
};

// ───────────────────────────────────────────────────────────────────────────── table of contents

export function flashBlockEl(target: HTMLElement | null): void {
  if (!target) return;
  target.classList.remove('emp-flash');
  void target.offsetWidth;
  target.classList.add('emp-flash');
  const done = () => target.classList.remove('emp-flash');
  target.addEventListener('animationend', done, { once: true });
  setTimeout(done, 1200);
}

export function scrollToBlock(view: EditorView, blockId: string, opts: { flash?: boolean } = {}): boolean {
  const target = view.dom.querySelector<HTMLElement>(`.emp-block[data-id="${CSS.escape(blockId)}"]`);
  if (!target) return false;
  target.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  if (opts.flash !== false) flashBlockEl(target);
  return true;
}

const headingCache = new WeakMap<PMNode, { id: string; level: number; text: string }[]>();
/** Headings outside columns, memoised per document (several TOC blocks share one walk). */
function headingsOf(doc: PMNode) {
  let h = headingCache.get(doc);
  if (!h) {
    h = allBlocks(doc)
      .filter((b) => b.content.type.name === 'heading' && !b.inColumn)
      .map((b) => ({ id: b.id, level: Number(b.content.attrs.level) || 1, text: b.content.textContent.trim() }));
    headingCache.set(doc, h);
  }
  return h;
}

export const tocView: NodeViewRenderer = ({ editor }) => {
  const dom = el('nav', 'emp-toc', { contenteditable: 'false', 'aria-label': 'Table of contents' });
  dom.setAttribute('data-content-type', 'toc');
  let last = '';
  let raf = 0;
  const render = () => {
    raf = 0;
    const heads = headingsOf(editor.state.doc);
    const key = JSON.stringify(heads);
    if (key === last) return;
    last = key;
    dom.replaceChildren();
    if (!heads.length) {
      const empty = el('div', 'emp-toc-empty');
      empty.textContent = 'Add headings to build a table of contents.';
      dom.appendChild(empty);
      return;
    }
    const min = Math.min(...heads.map((h) => h.level));
    for (const h of heads) {
      const a = el('a', 'emp-toc-item', { href: '#', 'data-level': String(h.level - min + 1) });
      a.textContent = h.text || 'Untitled heading';
      a.toggleAttribute('data-untitled', !h.text);
      a.addEventListener('click', (e) => {
        e.preventDefault();
        scrollToBlock(editor.view, h.id);
      });
      dom.appendChild(a);
    }
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!raf) raf = requestAnimationFrame(render);
    }, 150);
  };
  render();
  editor.on('update', schedule);
  return {
    dom,
    update: (next) => next.type.name === 'toc',
    selectNode: () => dom.classList.add('is-selected'),
    deselectNode: () => dom.classList.remove('is-selected'),
    ignoreMutation: () => true,
    stopEvent: (e) => e.type === 'click' || e.type === 'mousedown',
    destroy() {
      editor.off('update', schedule);
      if (raf) cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
    },
  };
};

// ───────────────────────────────────────────────────────────────────────────── table

export const tableView: NodeViewRenderer = ({ node, editor, getPos }) => {
  const dom = el('div', 'emp-table-wrap');
  dom.setAttribute('data-content-type', 'table');
  const scroller = el('div', 'emp-table-scroll');
  const table = el('table', 'emp-table');
  const colgroup = el('colgroup');
  const tbody = el('tbody');
  table.append(colgroup, tbody);
  scroller.appendChild(table);
  const addCol = el('button', 'emp-table-add emp-table-add-col', { type: 'button', contenteditable: 'false', tabindex: '-1', 'aria-label': 'Add column' });
  addCol.appendChild(domIcon('plus', 14, 2));
  const addRow = el('button', 'emp-table-add emp-table-add-row', { type: 'button', contenteditable: 'false', tabindex: '-1', 'aria-label': 'Add row' });
  addRow.appendChild(domIcon('plus', 14, 2));
  dom.append(scroller, addCol, addRow);
  let current = node;
  const sync = () => {
    table.toggleAttribute('data-header-row', !!current.attrs.headerRow);
    table.toggleAttribute('data-header-col', !!current.attrs.headerCol);
    const widths = (Array.isArray(current.attrs.colWidths) ? current.attrs.colWidths : []) as number[];
    const cols = current.firstChild?.childCount ?? 0;
    colgroup.replaceChildren();
    for (let i = 0; i < cols; i++) {
      const c = el('col');
      const w = widths[i];
      c.style.width = `${typeof w === 'number' && w > 40 ? w : 140}px`;
      colgroup.appendChild(c);
    }
    const ro = !editable(editor);
    addCol.hidden = ro;
    addRow.hidden = ro;
  };
  sync();
  const mutate = (fn: (pos: number) => void) => {
    const pos = posOf(getPos);
    if (pos == null || !editable(editor)) return;
    fn(pos);
  };
  for (const b of [addCol, addRow]) b.addEventListener('mousedown', (e) => e.preventDefault());
  addRow.addEventListener('click', () =>
    mutate((pos) => {
      const t = editor.state.doc.nodeAt(pos);
      if (!t) return;
      const { schema } = editor.state;
      const cols = t.firstChild?.childCount ?? 1;
      const row = schema.nodes.tableRow.create(null, Array.from({ length: cols }, () => schema.nodes.tableCell.create()));
      const at = pos + t.nodeSize - 1;
      editor.view.dispatch(editor.state.tr.insert(at, row));
      editor.commands.setTextSelection(at + 2);
      editor.view.focus();
    }),
  );
  addCol.addEventListener('click', () =>
    mutate((pos) => {
      const t = editor.state.doc.nodeAt(pos);
      if (!t) return;
      const { schema } = editor.state;
      const tr = editor.state.tr;
      let rowPos = pos + 1;
      t.forEach((row) => {
        const at = tr.mapping.map(rowPos + row.nodeSize - 1);
        tr.insert(at, schema.nodes.tableCell.create());
        rowPos += row.nodeSize;
      });
      const widths = [...((t.attrs.colWidths as number[]) ?? [])];
      while (widths.length < (t.firstChild?.childCount ?? 0)) widths.push(140);
      widths.push(140);
      tr.setNodeMarkup(pos, undefined, { ...t.attrs, colWidths: widths });
      editor.view.dispatch(tr);
      requestAnimationFrame(() => (scroller.scrollLeft = scroller.scrollWidth));
    }),
  );
  // Column resize: drag near a cell's right edge.
  let drag: { col: number; startX: number; startW: number; colEl: HTMLTableColElement } | null = null;
  table.addEventListener('mousemove', (e) => {
    if (drag || !editable(editor)) return;
    const cell = (e.target as HTMLElement).closest('td');
    if (!cell) return;
    const r = cell.getBoundingClientRect();
    table.toggleAttribute('data-resize', r.right - e.clientX < 6);
  });
  table.addEventListener('mouseleave', () => !drag && table.removeAttribute('data-resize'));
  table.addEventListener('mousedown', (e) => {
    if (!table.hasAttribute('data-resize')) return;
    const cell = (e.target as HTMLElement).closest('td');
    if (!cell) return;
    const col = (cell as HTMLTableCellElement).cellIndex;
    const colEl = colgroup.children[col] as HTMLTableColElement | undefined;
    if (!colEl) return;
    e.preventDefault();
    drag = { col, startX: e.clientX, startW: cell.getBoundingClientRect().width, colEl };
    const move = (ev: MouseEvent) => {
      if (!drag) return;
      drag.colEl.style.width = `${Math.max(60, Math.round(drag.startW + ev.clientX - drag.startX))}px`;
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      const d = drag;
      drag = null;
      table.removeAttribute('data-resize');
      if (!d) return;
      const w = Math.max(60, Math.round(d.startW + ev.clientX - d.startX));
      mutate((pos) => {
        const t = editor.state.doc.nodeAt(pos);
        if (!t) return;
        const widths = [...((t.attrs.colWidths as number[]) ?? [])];
        const cols = t.firstChild?.childCount ?? 0;
        while (widths.length < cols) widths.push(140);
        widths[d.col] = w;
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...t.attrs, colWidths: widths }));
      });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  return {
    dom,
    contentDOM: tbody,
    update(next) {
      if (next.type !== current.type) return false;
      current = next;
      sync();
      return true;
    },
    stopEvent: (e) => e.target instanceof Node && (addCol.contains(e.target) || addRow.contains(e.target)),
    ignoreMutation: (m) =>
      m.type === 'attributes' ||
      (m.target instanceof Node && (colgroup.contains(m.target) || addCol.contains(m.target) || addRow.contains(m.target))),
  };
};

// ───────────────────────────────────────────────────────────────────────────── columns

export const columnListView: NodeViewRenderer = ({ node, editor, getPos }) => {
  const dom = el('div', 'emp-columns');
  dom.setAttribute('data-content-type', 'columnList');
  let current = node;
  const applyWidths = () => {
    const widths = (current.attrs.widths as number[]) ?? [];
    const n = current.childCount;
    Array.from(dom.children).forEach((c, i) => {
      if (!(c instanceof HTMLElement) || !c.classList.contains('emp-column')) return;
      const w = widths[i] && widths.length === n ? widths[i] : 1 / n;
      c.style.flexGrow = String(Math.max(0.05, w));
    });
  };
  // Resize: drag the gap between columns.
  dom.addEventListener('mousedown', (e) => {
    if (e.target !== dom || !editable(editor)) return;
    const cols = Array.from(dom.children).filter((c): c is HTMLElement => c instanceof HTMLElement && c.classList.contains('emp-column'));
    const idx = cols.findIndex((c, i) => i < cols.length - 1 && e.clientX > c.getBoundingClientRect().right - 2 && e.clientX < cols[i + 1].getBoundingClientRect().left + 2);
    if (idx < 0) return;
    e.preventDefault();
    const total = dom.getBoundingClientRect().width;
    const startX = e.clientX;
    const widths = cols.map((c) => c.getBoundingClientRect().width / total);
    dom.setAttribute('data-resizing', '');
    const move = (ev: MouseEvent) => {
      const dx = (ev.clientX - startX) / total;
      const a = Math.max(0.1, widths[idx] + dx);
      const b = Math.max(0.1, widths[idx] + widths[idx + 1] - a);
      cols[idx].style.flexGrow = String(a);
      cols[idx + 1].style.flexGrow = String(b);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      dom.removeAttribute('data-resizing');
      const grow = cols.map((c) => Number(c.style.flexGrow) || 1);
      const sum = grow.reduce((s, v) => s + v, 0);
      const next = grow.map((g) => Math.round((g / sum) * 1000) / 1000);
      const pos = posOf(getPos);
      if (pos == null) return;
      editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, widths: next }));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  queueMicrotask(applyWidths);
  return {
    dom,
    contentDOM: dom,
    update(next) {
      if (next.type !== current.type) return false;
      current = next;
      applyWidths();
      return true;
    },
    ignoreMutation: (m) => m.type === 'attributes' && (m.target === dom || (m.target as HTMLElement).classList?.contains('emp-column')),
  };
};

// ───────────────────────────────────────────────────────────────────────────── inline: mention, emoji, maths

function mentionLabel(node: PMNode): { text: string; kind: 'page' | 'date' | 'missing' | 'loading'; icon?: Icon } {
  if (node.attrs.kind === 'date') {
    const d = node.attrs.date as DateValue | null;
    return { text: d?.start ? formatDateValue(d) : 'Date', kind: 'date' };
  }
  const meta = pageInfo(node.attrs.pageId as string | null);
  if (meta === undefined) return { text: '…', kind: 'loading' };
  if (!meta) return { text: 'Deleted page', kind: 'missing' };
  return { text: meta.title || 'Untitled', kind: 'page', icon: meta.icon ?? undefined };
}

export const mentionView: NodeViewRenderer = ({ node, editor, getPos }) => {
  const dom = el('span', 'emp-mention', { contenteditable: 'false', 'data-mention': '' });
  let current = node;
  const render = () => {
    const l = mentionLabel(current);
    dom.setAttribute('data-kind', l.kind);
    dom.replaceChildren();
    if (l.kind === 'date') {
      const dateAttr = current.attrs.date as DateValue | null;
      dom.append(domIcon(current.attrs.reminderId ? 'bell' : 'calendar', 14));
      const past = dateAttr?.start ? new Date(dateAttr.start).getTime() < Date.now() - 86_400_000 : false;
      dom.toggleAttribute('data-past', past);
    } else {
      // The page's own glyph (lucide, or a legacy emoji through the kit map), else the generic page icon.
      const g = el('span', 'emp-mention-glyph');
      pageGlyphInto(g, l.icon, 14, () => domIcon('fileText', 14));
      dom.append(g);
    }
    const t = el('span', 'emp-mention-text');
    t.textContent = l.text;
    dom.append(t);
  };
  render();
  const unsub = current.attrs.kind === 'page' ? subscribePageInfo(render) : () => undefined;
  dom.addEventListener('mousedown', (e) => {
    if (e.shiftKey) return;
    e.preventDefault();
  });
  dom.addEventListener('click', (e) => {
    e.preventDefault();
    if (current.attrs.kind === 'page') {
      const id = current.attrs.pageId as string | null;
      if (id && dom.getAttribute('data-kind') === 'page') navigate({ t: 'page', id });
      return;
    }
    const pos = posOf(getPos);
    if (pos == null || !editable(editor)) return;
    openOverlay({ kind: 'date', editorId: editor.instanceId, pos, rect: rectOf(dom), data: { date: current.attrs.date } });
  });
  return {
    dom,
    update(next) {
      if (next.type !== current.type || next.attrs.kind !== current.attrs.kind) return false;
      current = next;
      render();
      return true;
    },
    selectNode: () => dom.classList.add('is-selected'),
    deselectNode: () => dom.classList.remove('is-selected'),
    ignoreMutation: () => true,
    stopEvent: (e) => e.type === 'click',
    destroy: unsub,
  };
};

export const emojiView: NodeViewRenderer = ({ node }) => {
  const dom = el('span', 'emp-emoji', { 'data-emoji': '', contenteditable: 'false' });
  dom.textContent = String(node.attrs.native ?? '');
  if (node.attrs.shortcode) dom.title = `:${String(node.attrs.shortcode)}:`;
  return { dom, ignoreMutation: () => true, update: (next) => next.type.name === 'emoji' && next.attrs.native === node.attrs.native };
};

export const mathInlineView: NodeViewRenderer = ({ node, editor, getPos }: NodeViewRendererProps) => {
  const dom = el('span', 'emp-math-inline', { contenteditable: 'false', 'data-math-inline': '' });
  let current = node;
  const render = () => {
    const latex = String(current.attrs.latex ?? '');
    if (!latex.trim()) {
      dom.replaceChildren();
      dom.textContent = 'New equation';
      dom.setAttribute('data-empty', '');
      return;
    }
    dom.removeAttribute('data-empty');
    void renderKatex(latex, dom, false);
  };
  render();
  dom.addEventListener('mousedown', (e) => e.preventDefault());
  dom.addEventListener('click', (e) => {
    e.preventDefault();
    const pos = posOf(getPos);
    if (pos == null || !editable(editor)) return;
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
    openOverlay({ kind: 'mathInline', editorId: editor.instanceId, pos, rect: rectOf(dom), data: { latex: current.attrs.latex } });
  });
  return {
    dom,
    update(next) {
      if (next.type !== current.type) return false;
      const changed = next.attrs.latex !== current.attrs.latex;
      current = next;
      if (changed) render();
      return true;
    },
    selectNode: () => dom.classList.add('is-selected'),
    deselectNode: () => dom.classList.remove('is-selected'),
    ignoreMutation: () => true,
    stopEvent: (e) => e.type === 'click' || e.type === 'mousedown',
  };
};

