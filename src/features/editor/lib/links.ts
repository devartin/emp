/** Link rules (§9.15): only https:, http:, mailto: and internal emp://page/<id>[#blockId]. */
import type { Id } from '@/backend/types';

const INTERNAL = /^emp:\/\/page\/([A-Za-z0-9_-]+)(?:#([A-Za-z0-9_-]+))?$/;

export function isAllowedHref(href: string | null | undefined): boolean {
  if (!href) return false;
  const h = href.trim();
  if (h.length > 4096) return false;
  if (INTERNAL.test(h)) return true;
  if (/^mailto:[^\s]+$/i.test(h)) return true;
  if (!/^https?:\/\//i.test(h)) return false;
  try {
    const u = new URL(h);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !!u.hostname;
  } catch {
    return false;
  }
}

export function parseInternalHref(href: string | null | undefined): { pageId: Id; blockId?: string } | null {
  const m = href ? INTERNAL.exec(href.trim()) : null;
  if (!m) return null;
  return m[2] ? { pageId: m[1], blockId: m[2] } : { pageId: m[1] };
}

export function internalHref(pageId: Id, blockId?: string): string {
  return `emp://page/${pageId}${blockId ? `#${blockId}` : ''}`;
}

/** Normalise user-typed links ("example.com" → "https://example.com"); null when not allowed. */
export function normaliseHref(input: string): string | null {
  const v = input.trim();
  if (!v) return null;
  if (isAllowedHref(v)) return v;
  if (/^[\w.-]+@[\w.-]+\.\w+$/.test(v)) return `mailto:${v}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(v)) {
    const withProto = `https://${v}`;
    return isAllowedHref(withProto) ? withProto : null;
  }
  return null;
}
