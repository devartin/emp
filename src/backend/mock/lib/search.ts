/**
 * In-memory search (§11.3 search_query): titles + document text, AND semantics over tokens, prefix matching,
 * recency boost, ±60-character snippets with highlight ranges, and the `in:` `type:` `db:` `edited:` operators.
 * Other namespaces contribute candidates (rows, assets …) through `ctx.search.register`.
 */
import type { Id, SearchFilters, SearchHit, SearchHitKind } from '../../types';
import type { MockCtx, PageRecord, SearchCandidate, SearchProvider, SearchService } from '../ctx';
import { walkBlocks } from './doc';

const KINDS: SearchHitKind[] = ['page', 'row', 'database', 'sheet', 'block', 'asset'];
const DAY = 86_400_000;

export function fold(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function tokenize(s: string): string[] {
  return fold(s)
    .split(/[^\p{L}\p{N}$]+/u)
    .filter((w) => w.length > 0);
}

export interface ParsedQuery {
  terms: string[];
  raw: string;
  filters: SearchFilters;
  inTitle?: string;
  dbTitle?: string;
}

/** Splits `in:` `type:` `db:` `edited:` operators out of the query text. */
export function parseQuery(q: string, base: SearchFilters = {}, now = Date.now()): ParsedQuery {
  const filters: SearchFilters = { ...base };
  let inTitle: string | undefined;
  let dbTitle: string | undefined;
  const rest: string[] = [];
  const re = /(\w+):(?:"([^"]*)"|(\S+))|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    if (m[4] !== undefined) {
      rest.push(m[4]);
      continue;
    }
    const op = m[1].toLowerCase();
    const val = m[2] ?? m[3] ?? '';
    if (op === 'in') {
      if (/^[0-9a-f]{8}-/i.test(val)) filters.in = val;
      else inTitle = val;
    } else if (op === 'type') {
      const types = val
        .split(',')
        .map((v) => v.toLowerCase().replace(/s$/, ''))
        .map((v) => (v === 'doc' ? 'page' : v === 'db' ? 'database' : v)) as SearchHitKind[];
      filters.type = types.filter((tp) => KINDS.includes(tp));
    } else if (op === 'db') {
      if (/^[0-9a-f]{8}-/i.test(val)) filters.db = val;
      else dbTitle = val;
    } else if (op === 'edited') {
      const v = val.toLowerCase();
      const startOfToday = new Date(now);
      startOfToday.setHours(0, 0, 0, 0);
      const t0 = startOfToday.getTime();
      const rel = /^(\d+)([dwmy])$/.exec(v);
      if (v === 'today') filters.edited = { from: t0 };
      else if (v === 'yesterday') filters.edited = { from: t0 - DAY, to: t0 };
      else if (v === 'week') filters.edited = { from: now - 7 * DAY };
      else if (v === 'month') filters.edited = { from: now - 30 * DAY };
      else if (rel) {
        const n = Number(rel[1]);
        const unit = { d: DAY, w: 7 * DAY, m: 30 * DAY, y: 365 * DAY }[rel[2] as 'd' | 'w' | 'm' | 'y'];
        filters.edited = { from: now - n * unit };
      } else {
        const range = /^(\d{4}-\d{2}-\d{2})(?:\.\.(\d{4}-\d{2}-\d{2}))?$/.exec(v);
        if (range) {
          const from = new Date(`${range[1]}T00:00:00`).getTime();
          const to = range[2] ? new Date(`${range[2]}T23:59:59`).getTime() : from + DAY;
          filters.edited = { from, to };
        } else rest.push(m[0]);
      }
    } else rest.push(m[0]);
  }
  const raw = rest.join(' ');
  return { terms: tokenize(raw), raw, filters, inTitle, dbTitle };
}

export interface Snippet {
  text: string;
  ranges: [number, number][];
}

/** ±60 characters around the first match, with highlight ranges for every term inside the window. */
export function makeSnippet(text: string, terms: string[], radius = 60): Snippet | undefined {
  if (!text || !terms.length) return undefined;
  const folded = fold(text);
  let first = -1;
  for (const term of terms) {
    const i = folded.indexOf(term);
    if (i >= 0 && (first < 0 || i < first)) first = i;
  }
  if (first < 0) return undefined;
  let start = Math.max(0, first - radius);
  let end = Math.min(text.length, first + radius + terms[0].length);
  // Snap to word boundaries.
  if (start > 0) {
    const sp = text.indexOf(' ', start);
    if (sp >= 0 && sp < first) start = sp + 1;
  }
  if (end < text.length) {
    const sp = text.lastIndexOf(' ', end);
    if (sp > first) end = sp;
  }
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  const body = text.slice(start, end).replace(/\s+/g, ' ');
  const windowFolded = fold(body);
  const ranges: [number, number][] = [];
  for (const term of terms) {
    let from = 0;
    while (from < windowFolded.length) {
      const i = windowFolded.indexOf(term, from);
      if (i < 0) break;
      ranges.push([i + prefix.length, i + prefix.length + term.length]);
      from = i + term.length;
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return { text: prefix + body + suffix, ranges: merged };
}

function pageKind(p: PageRecord): SearchHitKind {
  return p.kind === 'database' ? 'database' : p.kind === 'sheet' ? 'sheet' : 'page';
}

export interface SearchEngine extends SearchService {
  query(q: string, filters: SearchFilters | undefined, limit: number): SearchHit[];
  docCount(): number;
}

export function createSearchEngine(ctx: MockCtx): SearchEngine {
  const providers = new Map<string, SearchProvider>();

  const pageCandidates = (): SearchCandidate[] => {
    const pages = ctx.db.table<PageRecord>('pages');
    const live = pages.filter((p) => !p.deletedAt && !p.flags.template);
    const byId = new Map(live.map((p) => [p.id, p]));
    const pathCache = new Map<Id, { titles: string[]; ids: Id[] }>();
    const pathOf = (p: PageRecord): { titles: string[]; ids: Id[] } => {
      const cached = pathCache.get(p.id);
      if (cached) return cached;
      const parent = p.parentId ? byId.get(p.parentId) : undefined;
      const res = parent
        ? (() => {
            const pp = pathOf(parent);
            return { titles: [...pp.titles, parent.title || 'Untitled'], ids: [...pp.ids, parent.id] };
          })()
        : { titles: [], ids: [] };
      pathCache.set(p.id, res);
      return res;
    };
    return live.map((p) => {
      const path = pathOf(p);
      const c: SearchCandidate = {
        id: p.id,
        kind: pageKind(p),
        title: p.title || 'Untitled',
        path: path.titles,
        updatedAt: p.updatedAt,
        ancestorIds: path.ids,
        text: p.kind === 'doc' || p.kind === 'dashboard' ? ctx.docs.text(p.id) : undefined,
      };
      if (p.icon) c.icon = p.icon;
      if (p.kind === 'database') c.databaseId = p.id;
      return c;
    });
  };

  const resolveTitle = (title: string): Id | undefined => {
    const f = fold(title);
    const pages = ctx.db.table<PageRecord>('pages').filter((p) => !p.deletedAt);
    return (pages.find((p) => fold(p.title) === f) ?? pages.find((p) => fold(p.title).startsWith(f)))?.id;
  };

  /** The block that best matches (most terms, then earliest). */
  const findBlock = (pageId: Id, terms: string[]): { id: string; text: string } | undefined => {
    const doc = ctx.docs.get(pageId)?.doc;
    let best: { id: string; text: string; n: number } | undefined;
    walkBlocks(doc, (v) => {
      const f = fold(v.text);
      const n = terms.filter((tm) => f.includes(tm)).length;
      if (n > 0 && (!best || n > best.n)) best = { id: v.id, text: v.text, n };
      if (best && best.n === terms.length) return false;
    });
    return best ? { id: best.id, text: best.text } : undefined;
  };

  return {
    register(name, provider) {
      providers.set(name, provider);
    },
    docCount() {
      return ctx.db.table<PageRecord>('pages').filter((p) => !p.deletedAt).length;
    },
    query(q, baseFilters, limit) {
      const now = ctx.clock.now();
      const parsed = parseQuery(q, baseFilters ?? {}, now);
      const filters = parsed.filters;
      if (parsed.inTitle) filters.in = resolveTitle(parsed.inTitle) ?? '__none__';
      if (parsed.dbTitle) filters.db = resolveTitle(parsed.dbTitle) ?? '__none__';

      let candidates = pageCandidates();
      for (const provider of providers.values()) {
        try {
          candidates = candidates.concat(provider(parsed.raw, filters));
        } catch (err) {
          console.error('[emp mock] search provider failed', err);
        }
      }

      const out: (SearchCandidate & { score: number; snippet?: Snippet; matchedBody: boolean })[] = [];
      const { terms } = parsed;
      const phrase = fold(parsed.raw.trim());
      for (const c of candidates) {
        if (filters.type?.length && !filters.type.includes(c.kind)) continue;
        if (filters.in && c.id !== filters.in && !c.ancestorIds?.includes(filters.in)) continue;
        if (filters.db && c.databaseId !== filters.db) continue;
        if (filters.edited?.from && c.updatedAt < filters.edited.from) continue;
        if (filters.edited?.to && c.updatedAt > filters.edited.to) continue;

        const recency = 1 + 0.3 * Math.exp(-(now - c.updatedAt) / (14 * DAY));
        if (!terms.length) {
          out.push({ ...c, score: recency, matchedBody: false });
          continue;
        }
        const title = fold(c.title);
        const titleWords = tokenize(c.title);
        const body = c.text ? fold(c.text) : '';
        let score = 0;
        let ok = true;
        let matchedBody = false;
        for (const term of terms) {
          if (titleWords.some((w) => w === term)) score += 4;
          else if (titleWords.some((w) => w.startsWith(term))) score += 3;
          else if (title.includes(term)) score += 1.5;
          else if (body.includes(term)) {
            score += 1;
            matchedBody = true;
          } else {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        if (title === phrase) score += 6;
        else if (title.startsWith(phrase)) score += 2.5;
        if (body && phrase.length > 2 && body.includes(phrase)) score += 1;
        // Shorter titles are more specific matches.
        score += 1 / (1 + titleWords.length);
        out.push({ ...c, score: score * recency, matchedBody });
      }

      out.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
      return out.slice(0, limit).map((c) => {
        const hit: SearchHit = {
          id: c.id,
          kind: c.kind,
          title: c.title,
          path: c.path,
          score: Math.round(c.score * 1000) / 1000,
          updatedAt: c.updatedAt,
        };
        if (c.icon) hit.icon = c.icon;
        if (c.blockId) hit.blockId = c.blockId;
        if (terms.length && c.text) {
          const block = c.kind === 'page' ? findBlock(c.id, terms) : undefined;
          const sn = makeSnippet(block?.text ?? c.text, terms);
          if (sn) hit.snippet = sn;
          if (block && c.matchedBody) hit.blockId = block.id;
        }
        return hit;
      });
    },
  };
}
