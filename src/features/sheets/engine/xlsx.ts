/**
 * Minimal xlsx IO for the browser mock (§14.5; the desktop app uses calamine / rust_xlsxwriter). Reads values,
 * formulas (shared formulas expanded), number formats, bold / italic, solid fills, column widths, row heights,
 * merges, freeze panes, hidden sheets and defined names. Writes the same back as a valid OOXML package (stored zip).
 */
import { cellKey, cellName, colIndex, parseRect, rectName } from './addr';
import { BUILTIN_FORMATS } from './numfmt';
import { shiftFormula } from './refs';

// ───────────────────────────────────────────────────────────────────────────── zip

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zipStore(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + name.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true);
    dv.setUint16(8, 0, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, 0x21, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, f.data.length, true);
    dv.setUint32(22, f.data.length, true);
    dv.setUint16(26, name.length, true);
    local.set(name, 30);
    chunks.push(local, f.data);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);
    offset += local.length + f.data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const total = offset + cdSize + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of [...chunks, ...central, end]) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as { DecompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array> }).DecompressionStream;
  if (!DS) throw new Error('This browser cannot read compressed xlsx files');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DS('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function unzip(bytes: Uint8Array, maxTotal = 200 * 1024 * 1024): Promise<Map<string, Uint8Array>> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = new Map<string, Uint8Array>();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt zip directory');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.includes('..') || name.startsWith('/')) continue;
    total += usize;
    if (total > maxTotal) throw new Error('The file expands to more than 200 MB');
    const lnlen = dv.getUint16(lho + 26, true);
    const lxlen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lnlen + lxlen;
    const raw = bytes.subarray(start, start + csize);
    if (method === 0) out.set(name, raw);
    else if (method === 8) out.set(name, await inflateRaw(raw));
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────── xml helpers

const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
export function xmlDecode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}
export function xmlEncode(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) out[m[1].replace(/^\w+:/, (p) => (p === 'r:' ? 'r:' : ''))] = xmlDecode(m[3] ?? m[4] ?? '');
  return out;
}
function textOf(xml: string): string {
  let s = '';
  const re = /<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) s += xmlDecode(m[1]);
  return s;
}

// ───────────────────────────────────────────────────────────────────────────── read

export interface XlsxCellStyle {
  numFmt?: string;
  bold?: boolean;
  italic?: boolean;
  fill?: string;
  color?: string;
  align?: 'left' | 'center' | 'right';
}

export interface XlsxSheet {
  name: string;
  hidden: boolean;
  cells: Map<number, { input: string; style?: XlsxCellStyle }>;
  colWidths: Map<number, number>;
  rowHeights: Map<number, number>;
  merges: { r0: number; c0: number; r1: number; c1: number }[];
  frozen: { rows: number; cols: number };
}

export interface XlsxBook {
  sheets: XlsxSheet[];
  names: { name: string; ref: string }[];
  date1904: boolean;
  warnings: string[];
}

function argbToHex(argb: string | undefined): string | undefined {
  if (!argb) return undefined;
  const h = argb.length === 8 ? argb.slice(2) : argb;
  return /^[0-9a-f]{6}$/i.test(h) ? `#${h.toUpperCase()}` : undefined;
}

export async function readXlsx(bytes: Uint8Array, onProgress?: (done: number, total: number) => void): Promise<XlsxBook> {
  const files = await unzip(bytes);
  const dec = new TextDecoder();
  const read = (n: string) => {
    const f = files.get(n);
    return f ? dec.decode(f) : '';
  };
  const warnings: string[] = [];
  const wbXml = read('xl/workbook.xml');
  if (!wbXml) throw new Error('This file is not an Excel workbook (xl/workbook.xml is missing)');
  const rels = new Map<string, string>();
  for (const m of read('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)) {
    const a = attrs(m[0]);
    rels.set(a.Id, a.Target.replace(/^\/?xl\//, '').replace(/^\//, ''));
  }
  const shared: string[] = [];
  for (const m of read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]));
  // Styles
  const stylesXml = read('xl/styles.xml');
  const numFmts = new Map<number, string>(Object.entries(BUILTIN_FORMATS).map(([k, v]) => [Number(k), v]));
  for (const m of stylesXml.matchAll(/<numFmt\b[^>]*>/g)) {
    const a = attrs(m[0]);
    numFmts.set(Number(a.numFmtId), a.formatCode);
  }
  const fonts: { b: boolean; i: boolean; color?: string }[] = [];
  const fontsXml = /<fonts\b[^>]*>([\s\S]*?)<\/fonts>/.exec(stylesXml)?.[1] ?? '';
  for (const m of fontsXml.matchAll(/<font\b[^>]*?(?:\/>|>([\s\S]*?)<\/font>)/g)) {
    const inner = m[1] ?? '';
    const color = /<color\b[^>]*rgb="([^"]+)"/.exec(inner)?.[1];
    fonts.push({ b: /<b\s*\/>|<b\s+val="(1|true)"/.test(inner), i: /<i\s*\/>|<i\s+val="(1|true)"/.test(inner), color: argbToHex(color) });
  }
  const fills: (string | undefined)[] = [];
  const fillsXml = /<fills\b[^>]*>([\s\S]*?)<\/fills>/.exec(stylesXml)?.[1] ?? '';
  for (const m of fillsXml.matchAll(/<fill\b[^>]*?(?:\/>|>([\s\S]*?)<\/fill>)/g)) {
    const inner = m[1] ?? '';
    const solid = /patternType="solid"/.test(inner);
    const fg = /<fgColor\b[^>]*rgb="([^"]+)"/.exec(inner)?.[1];
    fills.push(solid ? argbToHex(fg) : undefined);
  }
  const xfs: XlsxCellStyle[] = [];
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? '';
  for (const m of cellXfs.matchAll(/<xf\b([^>]*?)(?:\/>|>([\s\S]*?)<\/xf>)/g)) {
    const a = attrs(m[1]);
    const st: XlsxCellStyle = {};
    const nf = numFmts.get(Number(a.numFmtId ?? 0));
    if (nf && nf !== 'General') st.numFmt = nf;
    const font = fonts[Number(a.fontId ?? 0)];
    if (font?.b) st.bold = true;
    if (font?.i) st.italic = true;
    if (font?.color && font.color !== '#000000') st.color = font.color;
    const fill = fills[Number(a.fillId ?? 0)];
    if (fill) st.fill = fill;
    const al = /<alignment\b[^>]*horizontal="(left|center|right)"/.exec(m[2] ?? '')?.[1] as XlsxCellStyle['align'];
    if (al) st.align = al;
    xfs.push(st);
  }
  const date1904 = /date1904="(1|true)"/.test(wbXml);
  const names: { name: string; ref: string }[] = [];
  for (const m of wbXml.matchAll(/<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g)) {
    const a = attrs(m[1]);
    if (a.name?.startsWith('_xlnm.')) continue;
    names.push({ name: a.name, ref: xmlDecode(m[2]) });
  }
  const sheetTags = [...wbXml.matchAll(/<sheet\b[^>]*>/g)].map((m) => attrs(m[0]));
  const sheets: XlsxSheet[] = [];
  let si = 0;
  for (const tag of sheetTags) {
    si++;
    onProgress?.(si - 1, sheetTags.length);
    const target = rels.get(tag['r:id'] ?? tag.id ?? '') ?? `worksheets/sheet${si}.xml`;
    const xml = read(`xl/${target}`);
    const sheet: XlsxSheet = {
      name: (tag.name || `Sheet${si}`).replace(/[[\]:*?/\\]/g, ' ').slice(0, 31),
      hidden: tag.state === 'hidden' || tag.state === 'veryHidden',
      cells: new Map(),
      colWidths: new Map(),
      rowHeights: new Map(),
      merges: [],
      frozen: { rows: 0, cols: 0 },
    };
    const pane = /<pane\b[^>]*>/.exec(xml);
    if (pane) {
      const a = attrs(pane[0]);
      if (a.state === 'frozen' || a.state === 'frozenSplit') sheet.frozen = { rows: Math.floor(Number(a.ySplit ?? 0)), cols: Math.floor(Number(a.xSplit ?? 0)) };
    }
    for (const m of xml.matchAll(/<col\b[^>]*>/g)) {
      const a = attrs(m[0]);
      if (!a.width) continue;
      const px = Math.round(Number(a.width) * 7 + 5);
      const lo = Number(a.min) - 1;
      const hi = Math.min(Number(a.max) - 1, lo + 200);
      for (let c = lo; c <= hi; c++) if (Math.abs(px - 96) > 8) sheet.colWidths.set(c, Math.max(24, Math.min(800, px)));
    }
    for (const m of xml.matchAll(/<mergeCell\b[^>]*>/g)) {
      const rect = parseRect(attrs(m[0]).ref ?? '');
      if (rect) sheet.merges.push(rect);
    }
    const sharedF = new Map<string, { formula: string; r: number; c: number }>();
    for (const row of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const ra = attrs(row[1]);
      const rIdx = Number(ra.r) - 1;
      if (ra.ht && ra.customHeight && Number.isFinite(rIdx)) sheet.rowHeights.set(rIdx, Math.round(Number(ra.ht) * (4 / 3)));
      const body = row[2] ?? '';
      for (const cm of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const a = attrs(cm[1]);
        const ref = /^([A-Z]+)(\d+)$/.exec(a.r ?? '');
        if (!ref) continue;
        const c = colIndex(ref[1]);
        const r = Number(ref[2]) - 1;
        const inner = cm[2] ?? '';
        const fm = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(inner);
        const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
        let input = '';
        if (fm) {
          const fa = attrs(fm[1]);
          let f = fm[2] !== undefined ? xmlDecode(fm[2]) : '';
          if (fa.t === 'shared' && fa.si !== undefined) {
            if (f) sharedF.set(fa.si, { formula: f, r, c });
            else {
              const base = sharedF.get(fa.si);
              if (base) f = shiftFormula(`=${base.formula}`, r - base.r, c - base.c).slice(1);
            }
          }
          if (f) input = `=${f.replace(/_xlfn\.|_xlws\./g, '')}`;
        }
        if (!input) {
          const t = a.t ?? 'n';
          if (t === 's' && vm) input = shared[Number(vm[1])] ?? '';
          else if (t === 'inlineStr') input = textOf(inner);
          else if (t === 'str' && vm) input = xmlDecode(vm[1]);
          else if (t === 'b' && vm) input = vm[1] === '1' ? 'TRUE' : 'FALSE';
          else if (t === 'e' && vm) input = vm[1];
          else if (vm) input = vm[1];
          // Text that would read back as a number / formula keeps its type.
          if ((t === 's' || t === 'inlineStr' || t === 'str') && (/^[=+\-@]/.test(input) || /^-?\d/.test(input))) input = `'${input}`;
        }
        const style = a.s !== undefined ? xfs[Number(a.s)] : undefined;
        if (!input && !(style && Object.keys(style).length)) continue;
        sheet.cells.set(cellKey(r, c), { input, style: style && Object.keys(style).length ? style : undefined });
      }
    }
    sheets.push(sheet);
  }
  if (!sheets.length) warnings.push('The workbook has no sheets.');
  onProgress?.(sheetTags.length, sheetTags.length);
  return { sheets, names, date1904, warnings };
}

// ───────────────────────────────────────────────────────────────────────────── write

export interface XlsxWriteCell {
  r: number;
  c: number;
  input: string;
  /** Cached value: number, text, boolean or an error code. */
  value: number | string | boolean | null;
  isError?: boolean;
  style?: XlsxCellStyle;
}

export interface XlsxWriteSheet {
  name: string;
  hidden: boolean;
  cells: XlsxWriteCell[];
  colWidths: [number, number][];
  rowHeights: [number, number][];
  merges: { r0: number; c0: number; r1: number; c1: number }[];
  frozen: { rows: number; cols: number };
}

export function writeXlsx(sheets: XlsxWriteSheet[], names: { name: string; ref: string }[]): Uint8Array {
  const enc = new TextEncoder();
  const styleKeys = new Map<string, number>([['{}', 0]]);
  const styleList: XlsxCellStyle[] = [{}];
  const styleIdx = (s?: XlsxCellStyle) => {
    if (!s) return 0;
    const key = JSON.stringify(s);
    let i = styleKeys.get(key);
    if (i === undefined) {
      i = styleList.length;
      styleList.push(s);
      styleKeys.set(key, i);
    }
    return i;
  };
  const sheetXml = sheets.map((sh) => {
    const rows = new Map<number, XlsxWriteCell[]>();
    for (const cell of sh.cells) {
      let list = rows.get(cell.r);
      if (!list) rows.set(cell.r, (list = []));
      list.push(cell);
    }
    const rowHeights = new Map(sh.rowHeights);
    for (const r of rowHeights.keys()) if (!rows.has(r)) rows.set(r, []);
    const rowXml = [...rows.keys()]
      .sort((a, b) => a - b)
      .map((r) => {
        const cells = rows.get(r)!.sort((a, b) => a.c - b.c);
        const ht = rowHeights.get(r);
        const cx = cells
          .map((cell) => {
            const ref = cellName(cell.r, cell.c);
            const s = styleIdx(cell.style);
            const sAttr = s ? ` s="${s}"` : '';
            const isF = cell.input.startsWith('=') && cell.input.length > 1;
            if (isF) {
              const f = `<f>${xmlEncode(cell.input.slice(1))}</f>`;
              if (cell.isError) return `<c r="${ref}"${sAttr} t="e">${f}<v>${xmlEncode(String(cell.value))}</v></c>`;
              if (typeof cell.value === 'number') return `<c r="${ref}"${sAttr}>${f}<v>${cell.value}</v></c>`;
              if (typeof cell.value === 'boolean') return `<c r="${ref}"${sAttr} t="b">${f}<v>${cell.value ? 1 : 0}</v></c>`;
              return `<c r="${ref}"${sAttr} t="str">${f}<v>${xmlEncode(String(cell.value ?? ''))}</v></c>`;
            }
            if (cell.value === null || cell.input === '') return `<c r="${ref}"${sAttr}/>`;
            if (cell.isError) return `<c r="${ref}"${sAttr} t="e"><v>${xmlEncode(String(cell.value))}</v></c>`;
            if (typeof cell.value === 'number') return `<c r="${ref}"${sAttr}><v>${cell.value}</v></c>`;
            if (typeof cell.value === 'boolean') return `<c r="${ref}"${sAttr} t="b"><v>${cell.value ? 1 : 0}</v></c>`;
            return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEncode(String(cell.value))}</t></is></c>`;
          })
          .join('');
        return `<row r="${r + 1}"${ht ? ` ht="${(ht * 0.75).toFixed(2)}" customHeight="1"` : ''}>${cx}</row>`;
      })
      .join('');
    const cols = sh.colWidths.length
      ? `<cols>${[...sh.colWidths]
          .sort((a, b) => a[0] - b[0])
          .map(([c, px]) => `<col min="${c + 1}" max="${c + 1}" width="${Math.max(1, (px - 5) / 7).toFixed(2)}" customWidth="1"/>`)
          .join('')}</cols>`
      : '';
    const { rows: fr, cols: fc } = sh.frozen;
    const pane =
      fr || fc
        ? `<pane${fc ? ` xSplit="${fc}"` : ''}${fr ? ` ySplit="${fr}"` : ''} topLeftCell="${cellName(fr, fc)}" activePane="${fr && fc ? 'bottomRight' : fr ? 'bottomLeft' : 'topRight'}" state="frozen"/>`
        : '';
    const merges = sh.merges.length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<mergeCell ref="${rectName(m)}"/>`).join('')}</mergeCells>` : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/>${cols}<sheetData>${rowXml}</sheetData>${merges}</worksheet>`;
  });
  // Styles
  const fmtIds = new Map<string, number>();
  const builtinByCode = new Map(Object.entries(BUILTIN_FORMATS).map(([k, v]) => [v, Number(k)]));
  let nextFmt = 164;
  const fontKeys = new Map<string, number>([['{}', 0]]);
  const fontXml = ['<font><sz val="11"/><name val="Calibri"/></font>'];
  const fillKeys = new Map<string, number>();
  const fillXml = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const xfXml = styleList.map((s) => {
    let numFmtId = 0;
    if (s.numFmt) {
      numFmtId = builtinByCode.get(s.numFmt) ?? fmtIds.get(s.numFmt) ?? 0;
      if (!numFmtId) {
        numFmtId = nextFmt++;
        fmtIds.set(s.numFmt, numFmtId);
      }
    }
    const fk = JSON.stringify({ b: !!s.bold, i: !!s.italic, color: s.color });
    let fontId = fontKeys.get(fk === JSON.stringify({ b: false, i: false }) ? '{}' : fk);
    if (fontId === undefined) {
      fontId = fontXml.length;
      fontKeys.set(fk, fontId);
      fontXml.push(`<font>${s.bold ? '<b/>' : ''}${s.italic ? '<i/>' : ''}<sz val="11"/>${s.color ? `<color rgb="FF${s.color.replace('#', '')}"/>` : ''}<name val="Calibri"/></font>`);
    }
    let fillId = 0;
    if (s.fill) {
      const hex = s.fill.replace('#', '').toUpperCase();
      fillId = fillKeys.get(hex) ?? fillXml.length;
      if (!fillKeys.has(hex)) {
        fillKeys.set(hex, fillId);
        fillXml.push(`<fill><patternFill patternType="solid"><fgColor rgb="FF${hex}"/><bgColor indexed="64"/></patternFill></fill>`);
      }
    }
    const align = s.align ? `<alignment horizontal="${s.align}"/>` : '';
    return `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="0" xfId="0"${numFmtId ? ' applyNumberFormat="1"' : ''}${fontId ? ' applyFont="1"' : ''}${fillId ? ' applyFill="1"' : ''}${align ? ' applyAlignment="1">' + align + '</xf>' : '/>'}`;
  });
  const numFmtXml = fmtIds.size ? `<numFmts count="${fmtIds.size}">${[...fmtIds].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${xmlEncode(code)}"/>`).join('')}</numFmts>` : '';
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${numFmtXml}<fonts count="${fontXml.length}">${fontXml.join('')}</fonts><fills count="${fillXml.length}">${fillXml.join('')}</fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfXml.length}">${xfXml.join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const definedNames = names.length ? `<definedNames>${names.map((n) => `<definedName name="${xmlEncode(n.name)}">${xmlEncode(n.ref.replace(/^=/, ''))}</definedName>`).join('')}</definedNames>` : '';
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${sheets
    .map((s, i) => `<sheet name="${xmlEncode(s.name)}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`)
    .join('')}</sheets>${definedNames}<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
    .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets
    .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
  const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Ultranote</Application></Properties>`;
  return zipStore([
    { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
    { name: '_rels/.rels', data: enc.encode(rootRels) },
    { name: 'docProps/app.xml', data: enc.encode(app) },
    { name: 'xl/workbook.xml', data: enc.encode(workbookXml) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(wbRels) },
    { name: 'xl/styles.xml', data: enc.encode(stylesXml) },
    ...sheetXml.map((x, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc.encode(x) })),
  ]);
}

/** CSV delimiter sniffing (§14.5): the most consistent column count over the first 20 lines. */
export function sniffDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).slice(0, 20).filter((l) => l.length);
  let best = ',';
  let bestScore = -1;
  for (const d of [',', ';', '\t', '|']) {
    const counts = lines.map((l) => l.split(d).length - 1);
    if (!counts.length || counts[0] === 0) continue;
    const same = counts.filter((n) => n === counts[0]).length;
    const score = same * 100 + counts[0];
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}
