/**
 * HTML for the clipboard (§7.7, §9.15). Copy writes semantic HTML (so Docs/Word/Mail keep lists and headings) plus the
 * block JSON in a `data-emp` attribute (WebKitGTK fallback). Pasted HTML is normalised (Google Docs / Word quirks,
 * nested lists, to-dos, table cells), sanitised with the §9.15 DOMPurify profile, and only then parsed by the schema.
 */
import DOMPurify from 'dompurify';
import type { TipTapNode } from '@/backend/types';
import { internalHref } from './links';
import { pageInfo } from './pageInfo';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

type Mark = { type: string; attrs?: Record<string, unknown> };

function inlineHtml(nodes: TipTapNode[] | undefined): string {
  let out = '';
  for (const n of nodes ?? []) {
    if (n.type === 'text') {
      let t = esc(n.text ?? '');
      for (const m of (n.marks ?? []) as Mark[]) {
        switch (m.type) {
          case 'bold':
            t = `<strong>${t}</strong>`;
            break;
          case 'italic':
            t = `<em>${t}</em>`;
            break;
          case 'underline':
            t = `<u>${t}</u>`;
            break;
          case 'strike':
            t = `<s>${t}</s>`;
            break;
          case 'code':
            t = `<code>${t}</code>`;
            break;
          case 'link':
            t = `<a href="${esc(String(m.attrs?.href ?? ''))}">${t}</a>`;
            break;
          case 'textColor':
            t = `<span data-text-color data-color="${esc(String(m.attrs?.color ?? ''))}">${t}</span>`;
            break;
          case 'highlight':
            t = `<mark data-bg="${esc(String(m.attrs?.color ?? 'yellow'))}">${t}</mark>`;
            break;
          default:
            break;
        }
      }
      out += t;
    } else if (n.type === 'hardBreak') out += '<br>';
    else if (n.type === 'emoji') out += esc(String(n.attrs?.native ?? ''));
    else if (n.type === 'mathInline') out += `<span data-math-inline data-latex="${esc(String(n.attrs?.latex ?? ''))}">${esc(String(n.attrs?.latex ?? ''))}</span>`;
    else if (n.type === 'mention') {
      if (n.attrs?.kind === 'date') {
        const d = n.attrs.date as { start?: string } | null;
        out += `<span data-mention data-kind="date" data-date="${esc(JSON.stringify(d ?? null))}">${esc(d?.start ?? '')}</span>`;
      } else {
        const id = String(n.attrs?.pageId ?? '');
        out += `<a href="${esc(internalHref(id))}">${esc(pageInfo(id)?.title || 'Untitled')}</a>`;
      }
    }
  }
  return out;
}

function groupHtml(blocks: TipTapNode[] | undefined): string {
  let out = '';
  let list: 'ul' | 'ol' | 'todo' | null = null;
  const close = () => {
    if (list) out += list === 'ol' ? '</ol>' : '</ul>';
    list = null;
  };
  for (const c of blocks ?? []) {
    const [content, group] = c.content ?? [];
    if (!content) continue;
    const kids = group ? groupHtml(group.content) : '';
    const a = content.attrs ?? {};
    const want = content.type === 'bulletItem' ? 'ul' : content.type === 'numberedItem' ? 'ol' : content.type === 'todoItem' ? 'todo' : null;
    if (want !== list) {
      close();
      if (want) out += want === 'ol' ? '<ol>' : want === 'todo' ? '<ul data-type="taskList">' : '<ul>';
      list = want;
    }
    const text = inlineHtml(content.content);
    switch (content.type) {
      case 'bulletItem':
      case 'numberedItem':
        out += `<li>${text}${kids}</li>`;
        break;
      case 'todoItem':
        out += `<li data-checked="${a.checked ? 'true' : 'false'}">${a.checked ? '☑' : '☐'} ${text}${kids}</li>`;
        break;
      case 'paragraph':
        out += `<p>${text}</p>${kids}`;
        break;
      case 'heading':
        out += `<h${Number(a.level) || 1}>${text}</h${Number(a.level) || 1}>${kids}`;
        break;
      case 'toggle':
        out += `<details open><summary>${text}</summary>${kids}</details>`;
        break;
      case 'quote':
        out += `<blockquote>${text}${kids}</blockquote>`;
        break;
      case 'callout':
        out += `<aside>${(a.icon as { t?: string; v?: string } | undefined)?.t === 'emoji' ? esc(String((a.icon as { v: string }).v)) + ' ' : ''}${text}${kids}</aside>`;
        break;
      case 'codeBlock':
        out += `<pre><code class="language-${esc(String(a.language ?? 'plain'))}">${esc((content.content ?? []).map((t) => t.text ?? '').join(''))}</code></pre>`;
        break;
      case 'divider':
        out += '<hr>';
        break;
      case 'mathBlock':
        out += `<p>$$${esc(String(a.latex ?? ''))}$$</p>`;
        break;
      case 'table': {
        const rows = content.content ?? [];
        out += '<table><tbody>';
        rows.forEach((r, ri) => {
          out += '<tr>';
          for (const cell of r.content ?? []) {
            const tag = ri === 0 && a.headerRow ? 'th' : 'td';
            out += `<${tag}>${inlineHtml(cell.content)}</${tag}>`;
          }
          out += '</tr>';
        });
        out += '</tbody></table>';
        break;
      }
      case 'columnList':
        for (const col of content.content ?? []) out += groupHtml(col.content?.[0]?.content);
        break;
      case 'pageRef':
      case 'pageLink': {
        const id = String(a.pageId ?? '');
        out += `<p><a href="${esc(internalHref(id))}">${esc(pageInfo(id)?.title || 'Untitled')}</a></p>`;
        break;
      }
      default:
        break;
    }
  }
  close();
  return out;
}

export function blocksToHtml(blocks: TipTapNode[], payload?: unknown): string {
  const body = groupHtml(blocks);
  if (payload === undefined) return body;
  return `<div data-emp="${esc(JSON.stringify(payload))}">${body}</div>`;
}

/** Extract the `data-emp` payload from pasted HTML (WebKitGTK drops custom clipboard types). */
export function extractEmpPayload(html: string): unknown | null {
  if (!html.includes('data-emp=')) return null;
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const raw = doc.querySelector('[data-emp]')?.getAttribute('data-emp');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────── paste normalisation

export const PURIFY_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'iframe', 'object', 'embed', 'form', 'input', 'svg', 'math', 'template', 'base', 'link', 'meta'],
  FORBID_ATTR: ['style', 'srcset', 'formaction', 'xlink:href'],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|emp:\/\/page\/)/i,
};

function unwrap(el: Element): void {
  el.replaceWith(...Array.from(el.childNodes));
}

function wrapStyled(el: HTMLElement): void {
  const s = el.getAttribute('style') ?? '';
  const weight = /font-weight\s*:\s*(bold|[6-9]00)/i.test(s);
  const italic = /font-style\s*:\s*italic/i.test(s);
  const underline = /text-decoration[^;]*underline/i.test(s);
  const strike = /text-decoration[^;]*line-through/i.test(s);
  const mono = /font-family[^;]*(mono|courier|consolas)/i.test(s);
  let inner: Node[] = Array.from(el.childNodes);
  const wrap = (tag: string) => {
    const w = el.ownerDocument.createElement(tag);
    w.append(...inner);
    inner = [w];
  };
  if (mono) wrap('code');
  if (strike) wrap('s');
  if (underline) wrap('u');
  if (italic) wrap('em');
  if (weight) wrap('strong');
  if (inner[0] !== el.firstChild || inner.length !== el.childNodes.length) el.replaceChildren(...inner);
}

/** Pre-sanitisation pass on raw HTML: keep meaning that lives in styles/inputs, drop vendor wrappers. */
function prepare(doc: Document): void {
  // Google Docs wraps everything in <b style="font-weight:normal" id="docs-internal-guid-…">.
  doc.querySelectorAll('b[id^="docs-internal-guid"]').forEach(unwrap);
  // Word: <o:p> and conditional comments.
  doc.querySelectorAll('o\\:p').forEach((e) => e.remove());
  doc.querySelectorAll('span[style], font[style]').forEach((e) => wrapStyled(e as HTMLElement));
  // To-dos: checkbox inputs (GitHub, Notion, TipTap) and aria-checked markers.
  doc.querySelectorAll('li').forEach((li) => {
    const box = li.querySelector(':scope > input[type="checkbox"], :scope > label > input[type="checkbox"], :scope > p > input[type="checkbox"]');
    if (box) {
      li.setAttribute('data-todo', (box as HTMLInputElement).hasAttribute('checked') ? 'true' : 'false');
      box.remove();
    } else if (li.hasAttribute('data-checked')) {
      li.setAttribute('data-todo', li.getAttribute('data-checked') === 'true' ? 'true' : 'false');
    }
  });
  // Notion's to-do lists.
  doc.querySelectorAll('ul.to-do-list > li').forEach((li) => {
    const checked = !!li.querySelector('.checkbox-on');
    li.querySelectorAll('.checkbox').forEach((c) => c.remove());
    li.setAttribute('data-todo', checked ? 'true' : 'false');
  });
}

function blockChildrenToInline(el: Element): void {
  const doc = el.ownerDocument;
  const blocks = Array.from(el.children).filter((c) => /^(P|DIV|H[1-6])$/.test(c.tagName));
  blocks.forEach((b, i) => {
    if (i > 0) b.before(doc.createElement('br'));
    unwrap(b);
  });
}

function convertList(list: Element): Element[] {
  const doc = list.ownerDocument;
  const ordered = list.tagName === 'OL';
  const out: Element[] = [];
  for (const li of Array.from(list.children)) {
    if (li.tagName !== 'LI') continue;
    const todo = li.getAttribute('data-todo');
    const type = todo != null ? 'todoItem' : ordered ? 'numberedItem' : 'bulletItem';
    const container = doc.createElement('div');
    container.setAttribute('data-node-type', 'blockContainer');
    const content = doc.createElement('div');
    content.setAttribute('data-content-type', type);
    if (todo === 'true') content.setAttribute('data-checked', 'true');
    const nested: Element[] = [];
    for (const child of Array.from(li.childNodes)) {
      if (child instanceof Element && (child.tagName === 'UL' || child.tagName === 'OL')) nested.push(child);
      else content.appendChild(child);
    }
    blockChildrenToInline(content);
    container.appendChild(content);
    if (nested.length) {
      const group = doc.createElement('div');
      group.setAttribute('data-node-type', 'blockGroup');
      for (const n of nested) group.append(...convertList(n));
      container.appendChild(group);
    }
    out.push(container);
  }
  list.replaceWith(...out);
  return out;
}

function normalise(root: DocumentFragment | HTMLElement): void {
  // Lists, deepest first so nested conversions see plain <li> children.
  const lists = Array.from(root.querySelectorAll('ul, ol')).filter((l) => !l.parentElement?.closest('ul, ol'));
  lists.forEach((l) => convertList(l));
  root.querySelectorAll('td, th').forEach(blockChildrenToInline);
  root.querySelectorAll('details').forEach((d) => {
    const doc = d.ownerDocument;
    const summary = d.querySelector(':scope > summary');
    const container = doc.createElement('div');
    container.setAttribute('data-node-type', 'blockContainer');
    const content = doc.createElement('div');
    content.setAttribute('data-content-type', 'toggle');
    if (summary) content.append(...Array.from(summary.childNodes));
    summary?.remove();
    container.appendChild(content);
    if (d.childNodes.length) {
      const group = doc.createElement('div');
      group.setAttribute('data-node-type', 'blockGroup');
      group.append(...Array.from(d.childNodes));
      container.appendChild(group);
    }
    d.replaceWith(container);
  });
  // Headings deeper than h3 become h3 (the schema maps them, but keep the DOM tidy).
  root.querySelectorAll('h4, h5, h6').forEach((h) => {
    const n = h.ownerDocument.createElement('h3');
    n.append(...Array.from(h.childNodes));
    h.replaceWith(n);
  });
}

/** Raw clipboard HTML → sanitised, schema-friendly HTML. */
export function normalisePastedHtml(html: string): string {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return '';
  }
  prepare(doc);
  const clean = DOMPurify.sanitize(doc.body, { ...PURIFY_CONFIG, RETURN_DOM_FRAGMENT: true }) as unknown as DocumentFragment;
  normalise(clean);
  const holder = document.createElement('div');
  holder.appendChild(clean);
  return holder.innerHTML;
}
