/**
 * Excel number-format codes (§14.4): sections `pos;neg;zero;text`, `0 # ? . , %` and `E+`, thousands scaling,
 * literal text, `[Red]` / `[Color n]`, conditions like `[>=1000]`, date/time tokens and `[h]` elapsed hours.
 * Display strings for the grid are produced here (the Rust engine owns this on desktop).
 */
import { round15, serialToDate, type Scalar, Err } from './values';

export interface Formatted {
  text: string;
  /** Section colour, e.g. 'red' from `[Red]`. */
  color?: string;
}

const COLORS = ['black', 'blue', 'cyan', 'green', 'magenta', 'red', 'white', 'yellow'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Built-in format ids (xlsx numFmtId) → codes. */
export const BUILTIN_FORMATS: Record<number, string> = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
  14: 'yyyy-mm-dd', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss',
  22: 'yyyy-mm-dd h:mm', 37: '#,##0;(#,##0)', 38: '#,##0;[Red](#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)',
  44: '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mm:ss.0', 48: '##0.0E+0', 49: '@',
};

function splitSections(code: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  let br = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '\\' && !q) {
      cur += ch + (code[i + 1] ?? '');
      i++;
      continue;
    }
    if (ch === '"') q = !q;
    else if (!q && ch === '[') br = true;
    else if (!q && ch === ']') br = false;
    if (ch === ';' && !q && !br) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

interface Section {
  body: string;
  color?: string;
  cond?: { op: string; v: number };
  elapsed?: boolean;
}

function parseSection(raw: string): Section {
  let body = '';
  let color: string | undefined;
  let cond: Section['cond'];
  let elapsed = false;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '[') {
      const end = raw.indexOf(']', i);
      if (end < 0) {
        body += raw.slice(i);
        break;
      }
      const inner = raw.slice(i + 1, end);
      const low = inner.toLowerCase();
      const cm = /^(<=|>=|<>|<|>|=)\s*(-?[\d.]+)$/.exec(inner);
      if (COLORS.includes(low)) color = low;
      else if (/^color\s*\d+$/i.test(inner)) color = `color${inner.replace(/\D/g, '')}`;
      else if (cm) cond = { op: cm[1], v: Number(cm[2]) };
      else if (/^(h+|m+|s+)$/i.test(inner)) {
        elapsed = true;
        body += `[${low}]`;
      }
      // Locale / currency tags like [$€-407] contribute their symbol.
      else if (inner.startsWith('$')) body += `"${inner.slice(1).split('-')[0]}"`;
      i = end + 1;
      continue;
    }
    body += ch;
    i++;
  }
  return { body, color, cond, elapsed };
}

const cache = new Map<string, Section[]>();
function sectionsOf(code: string): Section[] {
  let s = cache.get(code);
  if (!s) {
    s = splitSections(code).map(parseSection);
    if (cache.size > 500) cache.clear();
    cache.set(code, s);
  }
  return s;
}

/** Strip quoted literals and escapes so we can classify a section. */
function skeleton(body: string): string {
  return body.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/_./g, '').replace(/\*./g, '');
}

export function isDateFormat(code: string | undefined): boolean {
  if (!code) return false;
  const sk = skeleton(sectionsOf(code)[0]?.body ?? '').toLowerCase();
  if (/[0#?]/.test(sk)) return false;
  return /[ydhs]|am\/pm|a\/p|\[h\]|m/.test(sk) && !/^general$/.test(sk) && sk !== '@';
}

function testCond(c: NonNullable<Section['cond']>, n: number): boolean {
  switch (c.op) {
    case '<': return n < c.v;
    case '>': return n > c.v;
    case '<=': return n <= c.v;
    case '>=': return n >= c.v;
    case '<>': return n !== c.v;
    default: return n === c.v;
  }
}

export function formatGeneral(n: number): string {
  if (!Number.isFinite(n)) return '#NUM!';
  const r = round15(n);
  if (Object.is(r, -0) || r === 0) return '0';
  const abs = Math.abs(r);
  if (Number.isInteger(r) && abs < 1e11) return String(r);
  if (abs >= 1e11 || abs < 1e-9) {
    const [m, e] = r.toExponential(5).split('e');
    const exp = Number(e);
    return `${m.replace(/\.?0+$/, '')}E${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  const intDigits = Math.max(1, Math.floor(Math.log10(abs)) + 1);
  const decimals = Math.max(0, 10 - intDigits);
  return String(Number.parseFloat(roundDec(r, decimals).toFixed(decimals)));
}

function roundDec(n: number, d: number): number {
  if (d > 15) return n;
  const s = `${Math.abs(n)}e${d}`;
  const r = Number(`${Math.round(Number(s))}e-${d}`);
  return n < 0 ? -r : r;
}

function groupThousands(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function literal(body: string): string {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '"') {
      const end = body.indexOf('"', i + 1);
      out += body.slice(i + 1, end < 0 ? body.length : end);
      i = end < 0 ? body.length : end;
    } else if (ch === '\\') {
      out += body[i + 1] ?? '';
      i++;
    } else if (ch === '_') {
      out += ' ';
      i++;
    } else if (ch === '*') {
      i++;
    } else out += ch;
  }
  return out;
}

/** Locate the number placeholder block outside quotes. */
function findBlock(body: string): { start: number; end: number } | null {
  let start = -1;
  let end = -1;
  let q = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '"') q = !q;
    if (q) continue;
    if (ch === '\\' || ch === '_' || ch === '*') {
      i++;
      continue;
    }
    if (ch === '0' || ch === '#' || ch === '?') {
      if (start < 0) start = i;
      end = i;
    } else if ((ch === '.' || ch === ',') && start >= 0) {
      // part of block if followed (eventually) by a placeholder
      const rest = body.slice(i + 1);
      if (/^[,.]*[0#?]/.test(rest)) end = i;
    } else if (ch === '.' && start < 0 && /^[0#?]/.test(body.slice(i + 1))) {
      start = i;
      end = i;
    } else if ((ch === 'E' || ch === 'e') && start >= 0 && /^[+-][0#]+/.test(body.slice(i + 1))) {
      const m = /^[+-][0#]+/.exec(body.slice(i + 1))!;
      end = i + m[0].length;
      i = end;
    }
  }
  return start < 0 ? null : { start, end: end + 1 };
}

function formatNumberSection(n: number, body: string): string {
  const pctCount = (skeleton(body).match(/%/g) ?? []).length;
  let v = n * 100 ** pctCount;
  const block = findBlock(body);
  if (!block) return literal(body).replace(/@/g, formatGeneral(n));
  let blockText = body.slice(block.start, block.end);
  let suffixRaw = body.slice(block.end);
  // Trailing commas scale by 1,000 each.
  const trailing = /^,+/.exec(suffixRaw);
  if (trailing) {
    v /= 1000 ** trailing[0].length;
    suffixRaw = suffixRaw.slice(trailing[0].length);
  }
  while (blockText.endsWith(',')) {
    v /= 1000;
    blockText = blockText.slice(0, -1);
  }
  const prefix = literal(body.slice(0, block.start));
  const suffix = literal(suffixRaw);
  const expM = /[eE]([+-])([0#]+)$/.exec(blockText);
  if (expM) {
    const mant = blockText.slice(0, expM.index);
    const dot = mant.indexOf('.');
    const decs = dot < 0 ? 0 : mant.length - dot - 1;
    if (v === 0) return `${prefix}${(0).toFixed(decs)}E${expM[1] === '+' ? '+' : ''}${'0'.repeat(expM[2].length)}${suffix}`;
    let exp = Math.floor(Math.log10(Math.abs(v)));
    let m = v / 10 ** exp;
    const mr = roundDec(m, decs);
    if (Math.abs(mr) >= 10) {
      exp += 1;
      m = v / 10 ** exp;
    }
    const es = String(Math.abs(exp)).padStart(expM[2].length, '0');
    return `${prefix}${roundDec(m, decs).toFixed(decs)}E${exp < 0 ? '-' : expM[1] === '+' ? '+' : ''}${es}${suffix}`;
  }
  const dot = blockText.indexOf('.');
  const intPat = dot < 0 ? blockText : blockText.slice(0, dot);
  const fracPat = dot < 0 ? '' : blockText.slice(dot + 1).replace(/,/g, '');
  const grouped = intPat.includes(',');
  const minInt = (intPat.match(/0/g) ?? []).length;
  const maxDec = (fracPat.match(/[0#?]/g) ?? []).length;
  const minDec = (fracPat.match(/0/g) ?? []).length + (fracPat.match(/\?/g) ?? []).length;
  const abs = Math.abs(v);
  const rounded = roundDec(abs, maxDec);
  let [ip, fp = ''] = rounded.toFixed(maxDec).split('.');
  // Trim optional (#) decimals.
  while (fp.length > minDec && fp.endsWith('0')) fp = fp.slice(0, -1);
  if (ip === '0' && minInt === 0) ip = '';
  if (ip.length < minInt) ip = ip.padStart(minInt, '0');
  if (grouped) ip = groupThousands(ip);
  let text = ip + (maxDec > 0 && (fp.length > 0 || dot >= 0) ? `.${fp}` : '');
  if (dot >= 0 && maxDec === 0) text = `${ip}.`;
  if (text === '' || text === '.') text = '0';
  return `${prefix}${text}${suffix}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatDateSection(serial: number, body: string, elapsed: boolean): string {
  const { y, m, d, ms } = serialToDate(serial);
  const totalSec = Math.round(ms / 1000);
  let hh = Math.floor(totalSec / 3600) % 24;
  const mi = Math.floor(totalSec / 60) % 60;
  const ss = totalSec % 60;
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const ampm = /am\/pm|a\/p/i.test(body);
  // Tokenize
  type Tk = { t: string; v: string };
  const toks: Tk[] = [];
  let i = 0;
  const lower = body.toLowerCase();
  while (i < body.length) {
    const ch = lower[i];
    if (body[i] === '"') {
      const end = body.indexOf('"', i + 1);
      toks.push({ t: 'lit', v: body.slice(i + 1, end < 0 ? undefined : end) });
      i = end < 0 ? body.length : end + 1;
      continue;
    }
    if (body[i] === '\\') {
      toks.push({ t: 'lit', v: body[i + 1] ?? '' });
      i += 2;
      continue;
    }
    if (lower.startsWith('am/pm', i)) {
      toks.push({ t: 'ampm', v: body.slice(i, i + 5) });
      i += 5;
      continue;
    }
    if (lower.startsWith('a/p', i)) {
      toks.push({ t: 'ap', v: body.slice(i, i + 3) });
      i += 3;
      continue;
    }
    if (lower.startsWith('[h]', i) || lower.startsWith('[hh]', i)) {
      const len = lower.startsWith('[hh]', i) ? 4 : 3;
      toks.push({ t: 'H', v: '' });
      i += len;
      continue;
    }
    if (lower.startsWith('[m]', i) || lower.startsWith('[mm]', i)) {
      const len = lower.startsWith('[mm]', i) ? 4 : 3;
      toks.push({ t: 'M', v: '' });
      i += len;
      continue;
    }
    if ('ydhms'.includes(ch)) {
      let j = i;
      while (j < body.length && lower[j] === ch) j++;
      toks.push({ t: ch, v: body.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '.' && lower[i + 1] === '0') {
      let j = i + 1;
      while (lower[j] === '0') j++;
      toks.push({ t: 'frac', v: body.slice(i + 1, j) });
      i = j;
      continue;
    }
    toks.push({ t: 'lit', v: body[i] === '_' ? ' ' : body[i] });
    i += body[i] === '_' || body[i] === '*' ? 2 : 1;
  }
  // m after h or before s → minutes.
  for (let k = 0; k < toks.length; k++) {
    if (toks[k].t !== 'm' || toks[k].v.length > 2) continue;
    let prev = k - 1;
    while (prev >= 0 && toks[prev].t === 'lit') prev--;
    let next = k + 1;
    while (next < toks.length && toks[next].t === 'lit') next++;
    if ((prev >= 0 && (toks[prev].t === 'h' || toks[prev].t === 'H')) || (next < toks.length && toks[next].t === 's')) toks[k].t = 'min';
  }
  if (ampm) {
    hh = hh % 12;
    if (hh === 0) hh = 12;
  }
  const pm = Math.floor(totalSec / 3600) % 24 >= 12;
  let out = '';
  for (const tk of toks) {
    const len = tk.v.length;
    switch (tk.t) {
      case 'y':
        out += len <= 2 ? pad2(y % 100) : String(y);
        break;
      case 'm':
        out += len === 1 ? String(m) : len === 2 ? pad2(m) : len === 3 ? MONTHS[m - 1].slice(0, 3) : len === 5 ? MONTHS[m - 1][0] : MONTHS[m - 1];
        break;
      case 'd':
        out += len === 1 ? String(d) : len === 2 ? pad2(d) : len === 3 ? DAYS[dow].slice(0, 3) : DAYS[dow];
        break;
      case 'h':
        out += len >= 2 ? pad2(hh) : String(hh);
        break;
      case 'H':
        out += String(Math.floor(serial * 24));
        break;
      case 'M':
        out += String(Math.floor(serial * 1440));
        break;
      case 'min':
        out += tk.v.length >= 2 ? pad2(mi) : String(mi);
        break;
      case 's':
        out += len >= 2 ? pad2(ss) : String(ss);
        break;
      case 'frac': {
        const f = (ms / 1000) % 1;
        out += `.${f.toFixed(tk.v.length).slice(2)}`;
        break;
      }
      case 'ampm':
        out += pm ? 'PM' : 'AM';
        break;
      case 'ap':
        out += pm ? 'P' : 'A';
        break;
      default:
        out += tk.v;
    }
  }
  void elapsed;
  return out;
}

/** Formats a number with an Excel format code. */
export function formatValue(n: number, code: string | undefined): Formatted {
  if (!code || /^general$/i.test(code.trim())) return { text: formatGeneral(n) };
  if (!Number.isFinite(n)) return { text: '#NUM!' };
  const secs = sectionsOf(code);
  let sec: Section;
  let v = n;
  const hasConds = secs.some((s) => s.cond);
  if (hasConds) {
    const picked = secs.find((s) => s.cond && testCond(s.cond, n)) ?? secs.find((s) => !s.cond && skeleton(s.body) !== '@') ?? secs[0];
    sec = picked;
    if (n < 0 && picked.cond && picked.cond.v <= 0 && /[<]/.test(picked.cond.op)) v = Math.abs(n);
  } else if (n < 0 && secs.length >= 2 && skeleton(secs[1].body).trim() !== '') {
    sec = secs[1];
    v = -n;
  } else if (n === 0 && secs.length >= 3) {
    sec = secs[2];
  } else sec = secs[0];
  const body = sec.body;
  if (isDateFormat(body) || sec.elapsed) {
    if (n < 0 && !sec.elapsed) return { text: '#'.repeat(8), color: sec.color };
    return { text: formatDateSection(v, body, !!sec.elapsed), color: sec.color };
  }
  const sk = skeleton(body);
  if (/^general$/i.test(sk.trim())) return { text: (n < 0 && v > 0 ? '-' : '') + formatGeneral(v), color: sec.color };
  if (!/[0#?]/.test(sk)) {
    // Pure literal section (e.g. "-" for zero).
    return { text: literal(body).replace(/general/i, formatGeneral(v)), color: sec.color };
  }
  let text = formatNumberSection(v, body);
  if (n < 0 && sec === secs[0]) {
    // No negative section: prefix a minus (keep it after leading literals like "$" → "-$12").
    const roundedZero = /^[^1-9]*$/.test(text);
    if (!roundedZero) text = `-${text}`;
  }
  return { text, color: sec.color };
}

/** Formats a cell value for display. */
export function formatScalar(v: Scalar, code: string | undefined): Formatted {
  if (v === null) return { text: '' };
  if (typeof v === 'number') return formatValue(v, code);
  if (typeof v === 'boolean') return { text: v ? 'TRUE' : 'FALSE' };
  if (v instanceof Err) return { text: v.code };
  if (code) {
    const secs = sectionsOf(code);
    const textSec = secs.length >= 4 ? secs[3] : secs.find((s) => skeleton(s.body).includes('@'));
    if (textSec) return { text: literal(textSec.body).replace(/@/g, v), color: textSec.color };
  }
  return { text: v };
}

/** Decimal places shown by a format (for the toolbar's increase / decrease decimals). */
export function decimalsOf(code: string | undefined, sample?: number): number {
  if (!code || /^general$/i.test(code)) {
    if (sample === undefined || Number.isInteger(sample)) return 0;
    const s = formatGeneral(sample);
    const dot = s.indexOf('.');
    return dot < 0 ? 0 : s.length - dot - 1;
  }
  const body = sectionsOf(code)[0]?.body ?? '';
  const block = findBlock(body);
  if (!block) return 0;
  const t = body.slice(block.start, block.end);
  const dot = t.indexOf('.');
  return dot < 0 ? 0 : (t.slice(dot + 1).match(/[0#?]/g) ?? []).length;
}

/** Returns `code` with `delta` more (or fewer) fixed decimals in every numeric section. */
export function adjustDecimals(code: string | undefined, delta: number, sample?: number): string {
  const base = !code || /^general$/i.test(code) ? (decimalsOf(code, sample) > 0 ? `0.${'0'.repeat(decimalsOf(code, sample))}` : '0') : code;
  const secs = splitSections(base);
  return secs
    .map((raw) => {
      const block = findBlock(raw);
      if (!block || isDateFormat(raw)) return raw;
      const t = raw.slice(block.start, block.end);
      const dot = t.indexOf('.');
      let intPart = dot < 0 ? t : t.slice(0, dot);
      const frac = dot < 0 ? '' : t.slice(dot + 1);
      const exp = /[eE][+-][0#]+$/.exec(frac);
      const fracDigits = exp ? frac.slice(0, exp.index) : frac;
      const n = Math.max(0, Math.min(15, fracDigits.length + delta));
      if (!intPart) intPart = '0';
      const next = `${intPart}${n ? `.${'0'.repeat(n)}` : ''}${exp ? exp[0] : ''}`;
      return raw.slice(0, block.start) + next + raw.slice(block.end);
    })
    .join(';');
}
