/**
 * CSV parsing/serialising and column type inference for imports (§8, §9.16 import hardening: bounded sizes,
 * no formula evaluation, CSV-injection-safe export).
 */
import type { PropType } from '@/backend/types';

export const IMPORT_MAX_ROWS = 100_000;
export const IMPORT_MAX_COLS = 200;
export const IMPORT_MAX_BYTES = 50 * 1024 * 1024;

export function detectDelimiter(sample: string): string {
  const line = sample.split(/\r?\n/).slice(0, 5).join('\n');
  const cands = [',', ';', '\t', '|'];
  let best = ',';
  let bestN = -1;
  for (const c of cands) {
    let n = 0;
    let q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (!q && ch === c) n++;
    }
    if (n > bestN) {
      best = c;
      bestN = n;
    }
  }
  return best;
}

/** RFC 4180-ish parser (quoted fields, doubled quotes, CRLF). */
export function parseCsv(text: string, delimiter = detectDelimiter(text), maxRows = IMPORT_MAX_ROWS): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') q = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row.slice(0, IMPORT_MAX_COLS));
      row = [];
      if (rows.length > maxRows) break;
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row.slice(0, IMPORT_MAX_COLS));
  }
  return rows;
}

const MONEY_RE = /^[-−(]?\s?[$€£¥₹]\s?-?[\d,]+(\.\d+)?\)?$|^-?[\d,]+(\.\d+)?\s?(USD|EUR|GBP|JPY|CHF|CAD|AUD)$/i;
const NUM_RE = /^[-−]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?%?$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const US_DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
const BOOL_RE = /^(true|false|yes|no|y|n|checked|unchecked|✓|x)$/i;
const URL_RE = /^https?:\/\/\S+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function inferType(values: string[], isFirst: boolean): PropType {
  if (isFirst) return 'title';
  const vs = values.map((v) => v.trim()).filter(Boolean);
  if (!vs.length) return 'text';
  const all = (re: RegExp) => vs.every((v) => re.test(v));
  if (all(BOOL_RE) && new Set(vs.map((v) => v.toLowerCase())).size <= 2) return 'checkbox';
  if (all(MONEY_RE)) return 'money';
  if (all(NUM_RE)) return 'number';
  if (all(ISO_DATE_RE) || all(US_DATE_RE)) return 'date';
  if (all(URL_RE)) return 'url';
  if (all(EMAIL_RE)) return 'email';
  const distinct = new Set(vs);
  if (vs.some((v) => v.includes(',')) && vs.every((v) => v.length < 80)) {
    const parts = new Set(vs.flatMap((v) => v.split(',').map((x) => x.trim()).filter(Boolean)));
    if (parts.size <= 40 && parts.size < vs.length) return 'multi_select';
  }
  if (distinct.size <= Math.max(2, Math.min(30, vs.length * 0.5)) && vs.every((v) => v.length < 40) && vs.length >= 3) return 'select';
  return 'text';
}

export function parseNumber(s: string): number | null {
  const t = s.trim().replace(/[−]/g, '-').replace(/,/g, '');
  if (!t) return null;
  const pct = t.endsWith('%');
  const n = Number(pct ? t.slice(0, -1) : t);
  if (!Number.isFinite(n)) return null;
  return pct ? n / 100 : n;
}

export function parseMoney(s: string): string | null {
  let t = s.trim();
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) {
    neg = true;
    t = t.slice(1, -1);
  }
  t = t.replace(/[−]/g, '-').replace(/[$€£¥₹,\s]|USD|EUR|GBP|JPY|CHF|CAD|AUD/gi, '');
  if (t.startsWith('-')) {
    neg = !neg;
    t = t.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  return (neg ? '-' : '') + t;
}

export function parseDateInput(s: string): { start: string; time: boolean } | null {
  const t = s.trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return { start: t, time: false };
  if (ISO_DATE_RE.test(t)) {
    const d = new Date(t.replace(' ', 'T'));
    return Number.isFinite(d.getTime()) ? { start: d.toISOString(), time: true } : null;
  }
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(t);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return { start: `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`, time: false };
  }
  const d = new Date(t);
  if (Number.isFinite(d.getTime())) {
    return { start: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, time: false };
  }
  return null;
}

export function parseBool(s: string): boolean {
  return /^(true|yes|y|checked|✓|x|1)$/i.test(s.trim());
}

/** Quote a field; neutralise leading = + - @ (CSV injection, §9.16). */
export function csvField(v: string): string {
  let s = v;
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function toCsv(rows: string[][]): string {
  return '﻿' + rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';
}
