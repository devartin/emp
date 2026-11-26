/**
 * export_pages / export_everything (§11.3, §17.5, §9.21 "Export") for the browser preview.
 *
 * - Markdown: each page becomes `<Title>.md` with front matter; duplicates get ` (2)`; mentions become relative
 *   links; EMP-only blocks export as fenced `emp-block` JSON so a re-import is lossless; databases export as CSV plus
 *   a folder of row `.md` files. A grant named `*.zip` receives the folder layout (with `assets/`); otherwise the
 *   page and its sub-pages are written as one Markdown document.
 * - JSON: a lossless `{ format: 'emp-pages', pages: [{ meta, doc }] }` file.
 * - PDF is printed by the frontend (`UNSUPPORTED` here, as in v1).
 * - Export everything: a zip with pages/**, databases/*.csv + *.schema.json, sheets/*.xlsx, attachments/,
 *   calendar/*.ics, emp-full.json (lossless, no secrets) and manifest.json with SHA-256 sums.
 * Exports from an encrypted vault leave the vault unencrypted, so they require re-auth.
 */
import { BackendError } from '../../errors';
import type { Id, PageMeta, TipTapDoc, TipTapNode } from '../../types';
import type { GrantsService, MockCallCtx, MockCtx, MockHandlers, PageRecord } from '../ctx';
import { inlineText } from '../lib/doc';
import { dumpDb, sha256Hex } from './backup';
import { eventsBetween } from './calendar';
import { handlers as dbHandlers, type DbApi } from './db';
import { handlers as sheetHandlers } from './sheet';
import { writeIcs } from '@/features/calendar/engine/ics';
import { zipStore } from '@/features/sheets/engine/xlsx';

const enc = new TextEncoder();

// ───────────────────────────────────────────────────────────────────────────── markdown serializer

export interface MdOut {
  /** Relative link for a page mention, from the current file. */
  pageHref?: (pageId: Id) => string | null;
  pageTitle?: (pageId: Id) => string;
  /** Relative path for an asset (and records it for packaging). */
  assetHref?: (assetId: Id) => string | null;
}

const escapeMd = (s: string) => s.replace(/([\\`*_[\]#|<>])/g, '\\$1');

function inlineMd(nodes: TipTapNode[] | undefined, out: MdOut): string {
  if (!nodes) return '';
  let s = '';
  for (const n of nodes) {
    if (n.type === 'text') {
      let t = escapeMd(n.text ?? '');
      const marks = n.marks ?? [];
      const has = (k: string) => marks.some((m) => m.type === k);
      if (has('code')) t = `\`${n.text ?? ''}\``;
      if (has('bold')) t = `**${t}**`;
      if (has('italic')) t = `*${t}*`;
      if (has('strike')) t = `~~${t}~~`;
      if (has('highlight')) t = `==${t}==`;
      const link = marks.find((m) => m.type === 'link');
      if (link) t = `[${t}](${String((link.attrs as { href?: string } | undefined)?.href ?? '')})`;
      s += t;
    } else if (n.type === 'hardBreak') s += '  \n';
    else if (n.type === 'mathInline') s += `$${String((n.attrs as { latex?: string } | undefined)?.latex ?? '')}$`;
    else if (n.type === 'emoji') s += String((n.attrs as { native?: string } | undefined)?.native ?? '');
    else if (n.type === 'mention') {
      const a = (n.attrs ?? {}) as { kind?: string; pageId?: string; label?: string; date?: { start?: string; end?: string } };
      if (a.kind === 'page' && a.pageId) {
        const title = a.label || out.pageTitle?.(a.pageId) || 'Untitled';
        const href = out.pageHref?.(a.pageId);
        s += href ? `[${escapeMd(title)}](${encodeURI(href)})` : `[[${title}]]`;
      } else if (a.kind === 'date' && a.date?.start) s += a.date.end ? `${a.date.start} → ${a.date.end}` : a.date.start;
      else s += inlineText(n);
    } else s += inlineText(n);
  }
  return s;
}

function fence(node: TipTapNode): string {
  return '```emp-block\n' + JSON.stringify(node) + '\n```';
}

/** Blocks of one blockGroup → Markdown lines. */
function groupMd(group: TipTapNode | undefined, out: MdOut, indent = ''): string[] {
  const lines: string[] = [];
  let n = 0;
  for (const c of group?.content ?? []) {
    if (c.type !== 'blockContainer') continue;
    const content = c.content?.[0];
    const children = c.content?.[1]?.type === 'blockGroup' ? c.content[1] : undefined;
    if (!content) continue;
    const attrs = (content.attrs ?? {}) as Record<string, unknown>;
    const text = () => inlineMd(content.content, out);
    const kids = (pad = '  ') => (children ? groupMd(children, out, indent + pad) : []);
    const para = (s: string) => {
      if (lines.length && lines[lines.length - 1] !== '' && !indent) lines.push('');
      lines.push(...s.split('\n').map((l) => indent + l));
    };
    n = content.type === 'numberedItem' ? n + 1 : 0;
    switch (content.type) {
      case 'paragraph':
        para(text());
        lines.push(...kids());
        break;
      case 'heading': {
        const level = Math.min(3, Math.max(1, Number(attrs.level ?? 1)));
        if (attrs.toggle || children) {
          para(fence(c));
          break;
        }
        para(`${'#'.repeat(level)} ${text()}`);
        break;
      }
      case 'bulletItem':
        lines.push(`${indent}- ${text()}`, ...kids());
        break;
      case 'numberedItem':
        lines.push(`${indent}${n}. ${text()}`, ...kids('   '));
        break;
      case 'todoItem':
        lines.push(`${indent}- [${attrs.checked ? 'x' : ' '}] ${text()}`, ...kids());
        break;
      case 'quote':
        para(text().split('\n').map((l) => `> ${l}`).join('\n'));
        break;
      case 'codeBlock': {
        const lang = String(attrs.language ?? '');
        para('```' + (lang === 'plain' ? '' : lang) + '\n' + inlineText(content) + '\n```');
        break;
      }
      case 'divider':
        para('---');
        break;
      case 'mathBlock':
        para(`$$\n${String(attrs.latex ?? '')}\n$$`);
        break;
      case 'image': {
        const href = out.assetHref?.(String(attrs.assetId ?? ''));
        para(href ? `![${escapeMd(String(attrs.caption ?? ''))}](${encodeURI(href)})` : fence(c));
        break;
      }
      case 'file': {
        const href = out.assetHref?.(String(attrs.assetId ?? ''));
        para(href ? `[${escapeMd(href.split('/').pop() ?? 'file')}](${encodeURI(href)})` : fence(c));
        break;
      }
      case 'pageLink':
      case 'pageRef': {
        const id = String(attrs.pageId ?? '');
        const href = out.pageHref?.(id);
        const title = out.pageTitle?.(id) ?? 'Untitled';
        para(href ? `[${escapeMd(title)}](${encodeURI(href)})` : `[[${title}]]`);
        break;
      }
      case 'table': {
        const rows = (content.content ?? []).map((r) => (r.content ?? []).map((cell) => inlineMd(cell.content, out).replace(/\|/g, '\\|').replace(/\n/g, ' ')));
        if (!rows.length) break;
        const width = Math.max(...rows.map((r) => r.length));
        const fill = (r: string[]) => `| ${Array.from({ length: width }, (_, k) => r[k] ?? '').join(' | ')} |`;
        para([fill(rows[0]), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1).map(fill)].join('\n'));
        break;
      }
      default:
        // callout, toggle, columns, database views, toc … : lossless fence
        para(fence(c));
    }
  }
  return lines;
}

export function docToMarkdown(doc: TipTapDoc | null | undefined, out: MdOut = {}): string {
  const lines: string[] = [];
  for (const g of doc?.content ?? []) if (g.type === 'blockGroup') lines.push(...groupMd(g, out));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function frontMatter(p: PageRecord | PageMeta): string {
  const yaml = (s: string) => (/[:#\-"'{}[\]|>&*!%@`]/.test(s) || !s ? JSON.stringify(s) : s);
  const lines = ['---', `title: ${yaml(p.title || 'Untitled')}`];
  if (p.icon?.t === 'emoji') lines.push(`icon: ${yaml(p.icon.v)}`);
  lines.push(`created: ${new Date(p.createdAt).toISOString()}`, `updated: ${new Date(p.updatedAt).toISOString()}`, `emp_id: ${p.id}`, '---', '');
  return lines.join('\n');
}

// ───────────────────────────────────────────────────────────────────────────── packaging

const safeName = (s: string) => (s || 'Untitled').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled';

class Pack {
  files = new Map<string, Uint8Array>();
  private used = new Set<string>();
  unique(dir: string, base: string, extName: string): string {
    let name = `${dir}${base}${extName}`;
    for (let k = 2; this.used.has(name.toLowerCase()); k++) name = `${dir}${base} (${k})${extName}`;
    this.used.add(name.toLowerCase());
    return name;
  }
  add(path: string, data: string | Uint8Array): void {
    this.files.set(path, typeof data === 'string' ? enc.encode(data) : data);
  }
}

function relative(from: string, to: string): string {
  const a = from.split('/').slice(0, -1);
  const b2 = to.split('/');
  let i = 0;
  while (i < a.length && i < b2.length - 1 && a[i] === b2[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b2.slice(i)].join('/') || to;
}

/** Captures what another handler writes to its grant (reuse db_export / sheet_export inside a zip). */
async function capture(ctx: MockCallCtx, run: (c: MockCallCtx, grantId: Id) => unknown): Promise<Uint8Array | null> {
  let text: string | null = null;
  let blob: Blob | null = null;
  const grants: GrantsService = {
    ...ctx.grants,
    write: (_id, d) => {
      if (typeof d === 'string') text = d;
      else blob = d;
      return typeof d === 'string' ? d.length : d.size;
    },
  };
  const c = Object.create(ctx) as MockCallCtx;
  Object.defineProperty(c, 'grants', { value: grants });
  Object.defineProperty(c, 'progress', { value: () => undefined });
  await run(c, 'grant:capture');
  if (text !== null) return enc.encode(text);
  if (blob) return new Uint8Array(await (blob as Blob).arrayBuffer());
  return null;
}

interface PageWriter {
  pathOf: Map<Id, string>;
  assets: Map<Id, string>;
}

function planPaths(ctx: MockCtx, pack: Pack, roots: PageRecord[], withChildren: boolean, prefix: string): { order: PageRecord[]; pathOf: Map<Id, string> } {
  const order: PageRecord[] = [];
  const pathOf = new Map<Id, string>();
  const visit = (p: PageRecord, dir: string) => {
    if (p.flags.template) return;
    const base = safeName(p.title);
    const file = pack.unique(dir, base, p.kind === 'database' ? '.csv' : p.kind === 'sheet' ? '.xlsx' : '.md');
    pathOf.set(p.id, file);
    order.push(p);
    if (!withChildren) return;
    const kids = ctx.pages.children(p.id);
    if (kids.length) {
      const folder = file.replace(/\.(md|csv|xlsx)$/, '') + '/';
      for (const k of kids) visit(k, folder);
    }
  };
  for (const r of roots) visit(r, prefix);
  return { order, pathOf };
}

async function writePages(ctx: MockCallCtx, pack: Pack, order: PageRecord[], w: PageWriter, opts: { includeAssets: boolean; assetDir: string; step?: (label: string) => void }): Promise<number> {
  const db = ctx.services.get<DbApi>('db.api');
  let files = 0;
  for (const p of order) {
    ctx.checkCancelled();
    const path = w.pathOf.get(p.id) as string;
    opts.step?.(`Writing “${p.title || 'Untitled'}”`);
    const out: MdOut = {
      pageTitle: (id) => ctx.pages.get(id)?.title || 'Untitled',
      pageHref: (id) => {
        const target = w.pathOf.get(id);
        return target ? relative(path, target) : null;
      },
      assetHref: (assetId) => {
        if (!opts.includeAssets) return null;
        const a = ctx.assets.get(assetId);
        if (!a) return null;
        let rel = w.assets.get(assetId);
        if (!rel) {
          rel = pack.unique(opts.assetDir, safeName(a.name.replace(/\.[^.]+$/, '')), /\.[^.]+$/.exec(a.name)?.[0] ?? '');
          w.assets.set(assetId, rel);
        }
        return relative(path, rel);
      },
    };
    if (p.kind === 'database' && db) {
      const csv = await capture(ctx, (c, g) => dbHandlers.db_export?.({ databaseId: p.id, format: 'csv', grantId: g }, c));
      if (csv) {
        pack.add(path, csv);
        files++;
      }
      // Row bodies → folder of .md files.
      const schema = db.schema(ctx, p.id);
      const titleProp = schema.database.primaryPropId;
      const folder = path.replace(/\.csv$/, '') + '/';
      for (const r of db.rows(ctx, p.id)) {
        const body = ctx.docs.get(r.id)?.doc;
        if (!body || !r.hasBody) continue;
        const v = r.values[titleProp];
        const title = v && v.t === 'text' ? v.v.map((x) => x.text).join('') : 'Untitled';
        const rowPath = pack.unique(folder, safeName(title), '.md');
        pack.add(rowPath, `---\ntitle: ${JSON.stringify(title || 'Untitled')}\nemp_id: ${r.id}\n---\n\n${docToMarkdown(body, out)}`);
        files++;
      }
    } else if (p.kind === 'sheet') {
      const xlsx = await capture(ctx, (c, g) => sheetHandlers.sheet_export?.({ workbookId: p.id, format: 'xlsx', grantId: g }, c));
      if (xlsx) {
        pack.add(path, xlsx);
        files++;
      }
    } else {
      pack.add(path, frontMatter(p) + docToMarkdown(ctx.docs.get(p.id)?.doc, out));
      files++;
    }
    await ctx.sleep(0, ctx.signal);
  }
  if (opts.includeAssets) {
    for (const [assetId, rel] of w.assets) {
      const blob = ctx.assets.blob(assetId);
      if (blob) {
        pack.add(rel, new Uint8Array(await blob.arrayBuffer()));
        files++;
      }
    }
  }
  return files;
}

function collect(ctx: MockCtx, ids: Id[], withChildren: boolean): PageRecord[] {
  const roots = ids.map((id) => ctx.pages.require(id));
  // Drop roots that are descendants of other roots (they are exported with them).
  if (!withChildren) return roots;
  const set = new Set(ids);
  return roots.filter((r) => !ctx.pages.ancestors(r.id).some((a) => set.has(a.id)));
}

function flatten(ctx: MockCtx, roots: PageRecord[], withChildren: boolean): PageRecord[] {
  const out: PageRecord[] = [];
  const visit = (p: PageRecord) => {
    out.push(p);
    if (withChildren) ctx.pages.children(p.id).forEach(visit);
  };
  roots.forEach(visit);
  return out;
}

// ───────────────────────────────────────────────────────────────────────────── handlers

export const handlers: MockHandlers = {
  export_pages: async (req, ctx) => {
    if (req.format === 'pdf') throw new BackendError('UNSUPPORTED', 'PDF export prints the page: open it and choose Export → PDF.');
    if (!req.pageIds.length) throw new BackendError('INVALID', 'Choose at least one page to export', { field: 'pageIds' });
    ctx.vault.requireReauth();
    const roots = collect(ctx, req.pageIds, req.includeChildren);
    const all = flatten(ctx, roots, req.includeChildren);
    ctx.progress(0, all.length + 1, 'Preparing');

    if (req.format === 'json') {
      const pages = all.map((p) => ({ meta: ctx.pages.toMeta(p), doc: ctx.docs.get(p.id)?.doc ?? null }));
      const body = JSON.stringify({ format: 'emp-pages', version: 1, exportedAt: new Date(ctx.clock.now()).toISOString(), pages }, null, 2);
      ctx.grants.write(req.grantId, body, 'application/json');
      ctx.progress(all.length + 1, all.length + 1, 'Done');
      if (ctx.vault.isEncrypted()) ctx.vault.securityLog('export_plain');
      return { files: 1 };
    }

    // Markdown. A zip grant gets the folder layout; otherwise one document with the sub-pages appended.
    const zipped = req.pageIds.length > 1 || all.some((p) => p.kind === 'database' || p.kind === 'sheet') ? true : null;
    const pack = new Pack();
    const { order, pathOf } = planPaths(ctx, pack, roots, req.includeChildren, '');
    let done = 0;
    const w: PageWriter = { pathOf, assets: new Map() };
    const step = (label: string) => ctx.progress(++done, order.length + 1, label);
    const nameHint = order.length > 1 || zipped;
    if (nameHint) {
      const files = await writePages(ctx, pack, order, w, { includeAssets: req.includeAssets, assetDir: 'assets/', step });
      const single = pack.files.size === 1 && order.length === 1;
      if (single) ctx.grants.write(req.grantId, new Blob([Array.from(pack.files.values())[0].slice()], { type: 'text/markdown' }), 'text/markdown');
      else if (writesZip(ctx, req.grantId)) ctx.grants.write(req.grantId, new Blob([zipStore(Array.from(pack.files, ([name, data]) => ({ name, data }))).slice()], { type: 'application/zip' }), 'application/zip');
      else {
        // Not a zip destination: one Markdown document, sub-pages appended as sections.
        const parts = order
          .filter((p) => p.kind !== 'database' && p.kind !== 'sheet')
          .map((p, k) => (k === 0 ? frontMatter(p) : `\n---\n\n# ${p.title || 'Untitled'}\n\n`) + docToMarkdown(ctx.docs.get(p.id)?.doc, { pageTitle: (id) => ctx.pages.get(id)?.title || 'Untitled' }));
        ctx.grants.write(req.grantId, parts.join(''), 'text/markdown');
        ctx.progress(order.length + 1, order.length + 1, 'Done');
        if (ctx.vault.isEncrypted()) ctx.vault.securityLog('export_plain');
        return { files: 1 };
      }
      ctx.progress(order.length + 1, order.length + 1, 'Done');
      if (ctx.vault.isEncrypted()) ctx.vault.securityLog('export_plain');
      return { files };
    }
    const p = order[0];
    step(`Writing “${p.title || 'Untitled'}”`);
    ctx.grants.write(req.grantId, frontMatter(p) + docToMarkdown(ctx.docs.get(p.id)?.doc, { pageTitle: (id) => ctx.pages.get(id)?.title || 'Untitled' }), 'text/markdown');
    ctx.progress(order.length + 1, order.length + 1, 'Done');
    if (ctx.vault.isEncrypted()) ctx.vault.securityLog('export_plain');
    return { files: 1 };
  },

  export_everything: async (req, ctx) => {
    const ws = ctx.workspaceId();
    const pages = ctx.pages.table().filter((p) => !p.deletedAt && !p.flags.template && p.workspaceId === ws);
    const total = 7;
    const pack = new Pack();
    ctx.progress(0, total, 'Collecting pages');
    await ctx.sleep(80, ctx.signal);

    // pages/** — documents (databases and sheets go to their own folders)
    const docRoots = ctx.pages.children(null, ws).filter((p) => !p.flags.template);
    const { order, pathOf } = planPaths(ctx, pack, docRoots, true, 'pages/');
    const w: PageWriter = { pathOf, assets: new Map() };
    const docsOnly = order.filter((p) => p.kind !== 'database' && p.kind !== 'sheet');
    ctx.progress(1, total, `Writing ${docsOnly.length} pages`);
    await writePages(ctx, pack, docsOnly, w, { includeAssets: true, assetDir: 'attachments/' });

    // databases/*.csv + *.schema.json
    const db = ctx.services.get<DbApi>('db.api');
    const dbs = pages.filter((p) => p.kind === 'database');
    ctx.progress(2, total, `Exporting ${dbs.length} databases`);
    for (const d of dbs) {
      ctx.checkCancelled();
      const base = pack.unique('databases/', safeName(d.title), '');
      const csv = await capture(ctx, (c, g) => dbHandlers.db_export?.({ databaseId: d.id, format: 'csv', grantId: g }, c));
      if (csv) pack.add(`${base}.csv`, csv);
      if (db) {
        const s = db.schema(ctx, d.id);
        pack.add(`${base}.schema.json`, JSON.stringify({ id: d.id, title: d.title, properties: s.properties, views: s.views }, null, 2));
      }
    }

    // sheets/*.xlsx
    const sheets = pages.filter((p) => p.kind === 'sheet');
    ctx.progress(3, total, `Exporting ${sheets.length} workbooks`);
    for (const s of sheets) {
      ctx.checkCancelled();
      const xlsx = await capture(ctx, (c, g) => sheetHandlers.sheet_export?.({ workbookId: s.id, format: 'xlsx', grantId: g }, c)).catch(() => null);
      if (xlsx) pack.add(pack.unique('sheets/', safeName(s.title), '.xlsx'), xlsx);
    }

    // attachments/ (everything, including assets not referenced from documents)
    ctx.progress(4, total, 'Copying attachments');
    for (const a of ctx.db.table<{ id: Id; name: string; workspaceId: Id }>('assets').all()) {
      if (w.assets.has(a.id)) continue;
      const blob = ctx.assets.blob(a.id);
      if (!blob) continue;
      pack.add(pack.unique('attachments/', safeName(a.name.replace(/\.[^.]+$/, '')), /\.[^.]+$/.exec(a.name)?.[0] ?? ''), new Uint8Array(await blob.arrayBuffer()));
    }

    // calendar/*.ics
    ctx.progress(5, total, 'Writing calendars');
    try {
      const now = new Date(ctx.clock.now());
      const from = new Date(now.getTime() - 180 * 86_400_000).toISOString().slice(0, 10);
      const to = new Date(now.getTime() + 180 * 86_400_000).toISOString().slice(0, 10);
      const events = eventsBetween(ctx, from, to);
      const byCal = new Map<string, typeof events>();
      for (const e of events) byCal.set(e.calendarId, [...(byCal.get(e.calendarId) ?? []), e]);
      for (const [cal, list] of byCal) {
        const name = cal.replace(/^(ics|db|google):/, '') || 'Calendar';
        pack.add(pack.unique('calendar/', safeName(name), '.ics'), writeIcs(list.map((e) => ({ uid: `${e.id}@emp.local`, kind: 'event' as const, title: e.title, start: e.start, end: e.end, allDay: e.allDay, location: e.location, description: e.description })), name, now));
      }
    } catch {
      /* no calendar data */
    }

    // emp-full.json — lossless, without secrets or key material
    ctx.progress(6, total, 'Writing the full data file');
    const dump = await dumpDb(ctx, { signal: ctx.signal });
    delete dump.asset_blobs;
    for (const name of Object.keys(dump)) if (/secret|security_log|imports/.test(name)) delete dump[name];
    if (dump._meta) dump._meta = (dump._meta as { id: string }[]).filter((m) => !/^(vault|backup\.|snapshots\.|google)/.test(m.id) && !/secret|token|password|key/i.test(m.id));
    pack.add('emp-full.json', JSON.stringify({ format: 'emp-full', version: 1, exportedAt: new Date(ctx.clock.now()).toISOString(), tables: dump }));

    // manifest.json with SHA-256 sums
    const entries: { path: string; bytes: number; sha256: string }[] = [];
    for (const [path, data] of pack.files) entries.push({ path, bytes: data.length, sha256: await sha256Hex(data) });
    pack.add('manifest.json', JSON.stringify({
      format: 'emp-export',
      version: 1,
      app: 'EMP 1.0.0',
      exportedAt: new Date(ctx.clock.now()).toISOString(),
      counts: { pages: docsOnly.length, databases: dbs.length, sheets: sheets.length, attachments: entries.filter((e) => e.path.startsWith('attachments/')).length },
      files: entries,
    }, null, 2));

    const zip = zipStore(Array.from(pack.files, ([name, data]) => ({ name, data })));
    const bytes = ctx.grants.write(req.grantId, new Blob([zip.slice()], { type: 'application/zip' }), 'application/zip');
    ctx.progress(total, total, 'Done');
    if (ctx.vault.isEncrypted()) ctx.vault.securityLog('export_plain');
    return { bytes };
  },
};

/** Zip destinations are grants whose name ends in .zip (the desktop save dialog picks the format). */
function writesZip(ctx: MockCtx, grantId: Id): boolean {
  return !!zipGrants.get(ctx.db)?.has(grantId);
}

const zipGrants = new WeakMap<object, Set<Id>>();

export function setup(ctx: MockCtx): void {
  const grants = ctx.grants as GrantsService;
  const save = grants.saveGrant.bind(grants);
  grants.saveGrant = (purpose, suggestedName) => {
    const g = save(purpose, suggestedName);
    if (/\.zip$/i.test(suggestedName)) {
      let set = zipGrants.get(ctx.db);
      if (!set) zipGrants.set(ctx.db, (set = new Set()));
      set.add(g.grantId);
    }
    return g;
  };
}
