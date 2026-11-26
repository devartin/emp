/**
 * Minimal XLSX support for database import/export in the browser preview: reads the first worksheet's cell values
 * (shared strings, inline strings, numbers, booleans, dates by number format) and writes a single-sheet workbook.
 * Zip entries are inflated with `DecompressionStream('deflate-raw')`; written entries are stored (no compression).
 * Formulas are never evaluated — cached values only (§9.16).
 */

const MAX_ENTRY = 64 * 1024 * 1024;

interface ZipEntry {
  name: string;
  method: number;
  compSize: number;
  size: number;
  offset: number;
}

function readEntries(buf: DataView): ZipEntry[] {
  // find end of central directory
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65_557); i--) {
    if (buf.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file');
  const count = buf.getUint16(eocd + 10, true);
  let p = buf.getUint32(eocd + 16, true);
  const out: ZipEntry[] = [];
  const dec = new TextDecoder();
  for (let i = 0; i < count && p + 46 <= buf.byteLength; i++) {
    if (buf.getUint32(p, true) !== 0x02014b50) break;
    const method = buf.getUint16(p + 10, true);
    const compSize = buf.getUint32(p + 20, true);
    const size = buf.getUint32(p + 24, true);
    const nameLen = buf.getUint16(p + 28, true);
    const extraLen = buf.getUint16(p + 30, true);
    const commentLen = buf.getUint16(p + 32, true);
    const offset = buf.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buf.buffer, buf.byteOffset + p + 46, nameLen));
    out.push({ name, method, compSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function entryText(buf: DataView, e: ZipEntry): Promise<string> {
  if (e.size > MAX_ENTRY || e.compSize > MAX_ENTRY) throw new Error('This workbook is too large to import');
  const lh = e.offset;
  if (buf.getUint32(lh, true) !== 0x04034b50) throw new Error('Corrupt .xlsx file');
  const start = lh + 30 + buf.getUint16(lh + 26, true) + buf.getUint16(lh + 28, true);
  const data = new Uint8Array(buf.buffer, buf.byteOffset + start, e.compSize);
  if (e.method === 0) return new TextDecoder().decode(data);
  if (e.method !== 8) throw new Error('Unsupported compression in .xlsx file');
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([data.slice()]).stream().pipeThrough(ds);
  return await new Response(stream).text();
}

function colIndex(ref: string): number {
  const m = /^([A-Z]+)/.exec(ref);
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const DATE_FMT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function excelDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000);
  const d = new Date(ms);
  const iso = d.toISOString();
  return serial % 1 === 0 ? iso.slice(0, 10) : iso;
}

export interface XlsxRead {
  sheets: string[];
  rows: string[][];
}

export async function readXlsx(bytes: ArrayBuffer, maxRows = 100_000): Promise<XlsxRead> {
  const buf = new DataView(bytes);
  const entries = readEntries(buf);
  const find = (n: string) => entries.find((e) => e.name === n);
  const parser = new DOMParser();
  const xml = async (n: string) => {
    const e = find(n);
    return e ? parser.parseFromString(await entryText(buf, e), 'application/xml') : null;
  };
  const wb = await xml('xl/workbook.xml');
  const sheets = wb ? Array.from(wb.getElementsByTagName('sheet')).map((s) => s.getAttribute('name') ?? 'Sheet') : ['Sheet1'];
  const ss = await xml('xl/sharedStrings.xml');
  const shared = ss ? Array.from(ss.getElementsByTagName('si')).map((si) => Array.from(si.getElementsByTagName('t')).map((t) => t.textContent ?? '').join('')) : [];
  const styles = await xml('xl/styles.xml');
  const dateStyles = new Set<number>();
  if (styles) {
    const custom = new Map<number, string>();
    for (const nf of Array.from(styles.getElementsByTagName('numFmt'))) custom.set(Number(nf.getAttribute('numFmtId')), nf.getAttribute('formatCode') ?? '');
    const xfs = styles.getElementsByTagName('cellXfs')[0];
    Array.from(xfs?.getElementsByTagName('xf') ?? []).forEach((xf, i) => {
      const id = Number(xf.getAttribute('numFmtId'));
      const code = custom.get(id);
      if (DATE_FMT_IDS.has(id) || (code && /[dmy]/i.test(code.replace(/"[^"]*"/g, '')) && !/0\.0/.test(code))) dateStyles.add(i);
    });
  }
  const first = entries.find((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name) && e.name.endsWith('sheet1.xml')) ?? entries.find((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name));
  if (!first) return { sheets, rows: [] };
  const doc = parser.parseFromString(await entryText(buf, first), 'application/xml');
  const rows: string[][] = [];
  for (const r of Array.from(doc.getElementsByTagName('row'))) {
    if (rows.length >= maxRows) break;
    const line: string[] = [];
    for (const c of Array.from(r.getElementsByTagName('c'))) {
      const idx = colIndex(c.getAttribute('r') ?? '');
      if (idx > 200) continue;
      const t = c.getAttribute('t');
      const s = Number(c.getAttribute('s') ?? -1);
      const v = c.getElementsByTagName('v')[0]?.textContent ?? '';
      let out = '';
      if (t === 's') out = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') out = Array.from(c.getElementsByTagName('t')).map((x) => x.textContent ?? '').join('');
      else if (t === 'b') out = v === '1' ? 'TRUE' : 'FALSE';
      else if (t === 'str' || t === 'e') out = v;
      else if (v !== '' && dateStyles.has(s) && Number.isFinite(Number(v))) out = excelDate(Number(v));
      else out = v;
      while (line.length < idx) line.push('');
      line[idx] = out;
    }
    if (line.some((x) => x !== '')) rows.push(line);
  }
  return { sheets, rows };
}

// ───────────────────────────────────────────────────────────────────────────── writer

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

function zipStore(files: { name: string; data: Uint8Array }[]): Blob {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(8, 0, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, f.data.length, true);
    lh.setUint32(22, f.data.length, true);
    lh.setUint16(26, name.length, true);
    parts.push(new Uint8Array(lh.buffer), name, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, f.data.length, true);
    ch.setUint32(24, f.data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)].map((u) => u.slice()), { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function colName(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** One-sheet workbook; numbers stay numeric, everything else is an inline string. Header row is bold. */
export function writeXlsx(rows: (string | number | null)[][], sheetName = 'Sheet1'): Blob {
  const enc = new TextEncoder();
  const body = rows
    .map((r, ri) => {
      const cells = r
        .map((v, ci) => {
          const ref = `${colName(ci)}${ri + 1}`;
          const style = ri === 0 ? ' s="1"' : '';
          if (v === null || v === '') return '';
          if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${style}><v>${v}</v></c>`;
          return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`;
        })
        .join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join('');
  const name = esc(sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1');
  const files = [
    {
      name: '[Content_Types].xml',
      xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    },
    {
      name: '_rels/.rels',
      xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    {
      name: 'xl/styles.xml',
      xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0"/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>`,
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${body}</sheetData></worksheet>`,
    },
  ];
  return zipStore(files.map((f) => ({ name: f.name, data: enc.encode(f.xml) })));
}
