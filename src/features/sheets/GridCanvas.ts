/**
 * GridCanvas: retina-crisp canvas renderer for the sheet grid (§5.11 "Sheet grid (canvas)", §18 sheets budget).
 * Two layers:
 *   base     — cells: fills, gridlines, merges, data bars, borders, text (with overflow into empty neighbours),
 *              painted per pane (frozen corner / frozen rows / frozen cols / main).
 *   overlay  — headers, selection (2px accent border, accent fill at .08, 6×6 fill handle), the copy marquee
 *              (marching ants), formula reference highlights, find matches, spill outline, resize guides.
 * S15 (docs/DESIGN.md): the selection rectangle and active-cell border glide between cells on the `glide` spring
 * (none under reduced motion), the primary range carries a soft lit halo, the fill handle is a small lit dome that
 * grows under the pointer, the fill drag shows a ghost range with a count badge, headers ghost-highlight the row and
 * column under the pointer, and committed numeric results roll their changed digits (`roll` spring, 28ms stagger,
 * right to left). Colours come from CSS tokens and are re-read when the theme / accent changes; stored hex fills are
 * adapted for dark themes.
 */
import type { CellStyle, Rect } from '@/backend/types';
import { subscribeRootAttrs, isReducedMotion } from '@/ui/motion/useReducedEffects';
import { cellKey, colName, MAX_COLS, MAX_ROWS, parseCell, rectContains, rectsIntersect, splitSheetRef } from './engine/addr';
import { tokenize } from './engine/lexer';
import type { CellData, GridController, Layout, PaintLayer } from './GridController';

interface Theme {
  dark: boolean;
  bg: string;
  text: string;
  text2: string;
  text3: string;
  grid: string;
  headerBg: string;
  headerTop: string;
  headerHl: string;
  ghost: string;
  ghostStrong: string;
  headerBorder: string;
  headerText: string;
  headerSelBg: string;
  headerSelFullBg: string;
  headerSelText: string;
  accent: string;
  accentText: string;
  accentSoft: string;
  inputBg: string;
  inputText: string;
  loss: string;
  lossText: string;
  gainText: string;
  warning: string;
  warningSoft: string;
  borderStrong: string;
  frozenShadow: string;
  cat: string[];
  font: string;
  scale: number;
}

/** Parses #rgb / #rrggbb / rgb() / rgba() into [r, g, b, a]. */
function parseColor(c: string): [number, number, number, number] | null {
  const s = c.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [parseInt(m[1][0] + m[1][0], 16), parseInt(m[1][1] + m[1][1], 16), parseInt(m[1][2] + m[1][2], 16), 1];
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, m[2] ? parseInt(m[2], 16) / 255 : 1];
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(s);
  if (m) return [+m[1], +m[2], +m[3], m[4] ? (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4]) : 1];
  return null;
}

/** Mixes colour `a` into `b` by `t` (0..1), returning an opaque rgb(). */
function mixColor(a: string, b: string, t: number): string {
  const x = parseColor(a) ?? [94, 92, 230, 1];
  const y = parseColor(b) ?? [255, 255, 255, 1];
  const c = [0, 1, 2].map((i) => Math.round(y[i] + (x[i] - y[i]) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

function readTheme(): Theme {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const v = (n: string, fb = '') => cs.getPropertyValue(n).trim() || fb;
  const t = root.getAttribute('data-theme');
  const dark = t === 'dark' || t === 'midnight';
  const fontSize = parseFloat(cs.fontSize) || 14;
  const accent = v('--accent-solid', '#5E5CE6');
  const mono = (root.getAttribute('data-accent') ?? 'graphite') === 'graphite';
  return {
    dark,
    bg: v('--bg-canvas', dark ? '#111114' : '#FFFFFF'),
    text: v('--text-primary', dark ? '#EDEDF0' : '#18181B'),
    text2: v('--text-secondary', '#52525B'),
    text3: v('--text-tertiary', '#6E6E77'),
    grid: dark ? 'rgba(255,255,255,0.075)' : 'rgba(24,24,27,0.085)',
    headerBg: v('--bg-surface-2', dark ? '#1D1D22' : '#F4F4F5'),
    headerTop: mixColor(v('--panel-top', dark ? '#232329' : '#FFFFFF'), v('--bg-surface-2', dark ? '#1D1D22' : '#F4F4F5'), 0.55),
    headerHl: dark ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0.9)',
    ghost: dark ? 'rgba(255,255,255,0.05)' : 'rgba(16,16,24,0.035)',
    ghostStrong: dark ? 'rgba(255,255,255,0.09)' : 'rgba(16,16,24,0.07)',
    headerBorder: v('--border', dark ? 'rgba(255,255,255,.10)' : 'rgba(24,24,27,.10)'),
    headerText: v('--text-tertiary', '#6E6E77'),
    headerSelBg: mixColor(accent, v('--bg-surface-2', '#F4F4F5'), dark ? 0.2 : 0.1),
    headerSelFullBg: mixColor(accent, v('--bg-surface-2', '#F4F4F5'), dark ? 0.36 : 0.22),
    headerSelText: v('--accent-text', '#4B49C8'),
    accent,
    accentText: v('--accent-text', '#4B49C8'),
    accentSoft: v('--accent-soft', 'rgba(94,92,230,.10)'),
    // Input cells keep the spreadsheet convention of "blue inputs"; with the monochrome (graphite) accent the accent
    // is grey, so fall back to the info blue to stay distinguishable from formula cells.
    inputBg: mixColor(mono ? v('--info', '#3B82F6') : accent, v('--bg-canvas', '#FFFFFF'), dark ? 0.18 : 0.08),
    inputText: mono ? v('--info-text', '#1F6FD1') : v('--accent-text', '#4B49C8'),
    loss: v('--loss', '#E5484D'),
    lossText: v('--loss-text', '#C9302C'),
    gainText: v('--gain-text', '#0B7F45'),
    warning: v('--warning', '#F5A524'),
    warningSoft: dark ? 'rgba(245,165,36,.22)' : 'rgba(245,165,36,.26)',
    borderStrong: v('--border-strong', 'rgba(24,24,27,.18)'),
    frozenShadow: dark ? 'rgba(0,0,0,.45)' : 'rgba(24,24,27,.10)',
    cat: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v(`--cat-${i}`)).map((c, i) => c || ['#5E5CE6', '#0EA5E9', '#14B8A6', '#F59E0B', '#EC4899', '#A855F7', '#65A30D', '#EA580C'][i]),
    font: v('--font-ui', 'Inter Variable, Inter, system-ui, sans-serif'),
    scale: fontSize / 14,
  };
}

// ───────────────────────────────────────────────────────────── colour adaptation (stored hex → theme)

function hexToHsl(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h /= 6;
  return [h, s, l];
}

const hsl = (h: number, s: number, l: number) => `hsl(${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 1000) / 10}%)`;

const fillCache = new Map<string, string>();
export function adaptFill(hex: string, dark: boolean): string {
  if (!dark) return hex;
  const k = `f${hex}`;
  const hit = fillCache.get(k);
  if (hit) return hit;
  const c = hexToHsl(hex);
  let out = hex;
  if (c) {
    const [h, s, l] = c;
    // Pastels become deep tints; saturated mid-tones are muted.
    out = l > 0.6 ? hsl(h, Math.min(0.55, s * 0.6), 0.1 + (1 - l) * 0.9) : hsl(h, s * 0.75, Math.max(0.22, l * 0.7));
  }
  fillCache.set(k, out);
  return out;
}

export function adaptText(hex: string, dark: boolean): string {
  if (!dark) return hex;
  const k = `t${hex}`;
  const hit = fillCache.get(k);
  if (hit) return hit;
  const c = hexToHsl(hex);
  let out = hex;
  if (c) {
    const [h, s, l] = c;
    out = l < 0.55 ? hsl(h, s, Math.min(0.82, 1 - l * 0.7)) : hex;
  }
  fillCache.set(k, out);
  return out;
}

// ───────────────────────────────────────────────────────────── renderer

interface PaneRect {
  x: number;
  y: number;
  w: number;
  h: number;
  r0: number;
  r1: number;
  c0: number;
  c1: number;
  /** Text may overflow to the right past the pane (frozen columns while nothing is scrolled under them). */
  spill?: boolean;
}

interface AnimRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const PAD = 6;

/** Display-only: numeric cells paint a true minus (U+2212) instead of the ASCII hyphen the engine emits for export/formula-bar use. */
function shownText(cd: CellData): string {
  return cd.k === 1 && cd.d.charCodeAt(0) === 45 ? '\u2212' + cd.d.slice(1) : cd.d;
}

/**
 * Damped-spring step response (0 → 1) at `ms`, matching the motion token table (`glide` 420/34, `roll` 200/24).
 * Drives canvas glides without a JS animation library; transform-free because it is a canvas.
 */
function springAt(ms: number, k: number, c: number): number {
  const t = Math.max(0, ms) / 1000;
  const w0 = Math.sqrt(k);
  const z = c / (2 * w0);
  if (z >= 1) return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  const wd = w0 * Math.sqrt(1 - z * z);
  return 1 - Math.exp(-z * w0 * t) * (Math.cos(wd * t) + ((z * w0) / wd) * Math.sin(wd * t));
}
const GLIDE = { k: 420, c: 34, ms: 460 };
const ROLL = { k: 200, c: 24, ms: 600, stagger: 28 };

export interface GridHover {
  zone: 'cell' | 'colhead' | 'rowhead' | 'corner';
  r: number;
  c: number;
  fill: boolean;
}

export class GridCanvas {
  private ctrl: GridController;
  private base: HTMLCanvasElement;
  private over: HTMLCanvasElement;
  private bctx: CanvasRenderingContext2D;
  private octx: CanvasRenderingContext2D;
  private theme: Theme;
  private dpr = 1;
  private w = 0;
  private h = 0;
  private offPaint: () => void;
  private offTheme: () => void;
  private anim: { from: AnimRect; to: AnimRect; t0: number } | null = null;
  private animActive: { from: AnimRect; to: AnimRect; t0: number } | null = null;
  private lastPrimary: AnimRect | null = null;
  private lastActive: AnimRect | null = null;
  private loopRaf = 0;
  private hover: GridHover | null = null;
  private roll: { r: number; c: number; sheetId: string; before: string; t0: number; dir: number } | null = null;
  private measureCache = new Map<string, number>();
  private mq: MediaQueryList | null = null;

  constructor(ctrl: GridController, base: HTMLCanvasElement, over: HTMLCanvasElement) {
    this.ctrl = ctrl;
    this.base = base;
    this.over = over;
    this.bctx = base.getContext('2d', { alpha: false })!;
    this.octx = over.getContext('2d')!;
    this.theme = readTheme();
    this.offPaint = ctrl.onPaint((layer) => this.draw(layer));
    ctrl.onCommitted = (r, c, before, sheetId) => this.startRoll(r, c, before, sheetId);
    this.offTheme = subscribeRootAttrs(() => {
      this.theme = readTheme();
      fillCache.clear();
      this.measureCache.clear();
      ctrl.paint();
    });
    this.watchDpr();
    if (typeof document !== 'undefined' && document.fonts?.ready) void document.fonts.ready.then(() => {
      this.measureCache.clear();
      ctrl.paint();
    });
  }

  private watchDpr(): void {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    this.mq?.removeEventListener('change', this.onDpr);
    this.mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    this.mq.addEventListener('change', this.onDpr);
  }

  private onDpr = () => {
    this.resize(this.w, this.h);
    this.watchDpr();
  };

  dispose(): void {
    if (this.ctrl.onCommitted) this.ctrl.onCommitted = null;
    this.offPaint();
    this.offTheme();
    this.mq?.removeEventListener('change', this.onDpr);
    if (this.loopRaf) cancelAnimationFrame(this.loopRaf);
  }

  resize(w: number, h: number): void {
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.w = w;
    this.h = h;
    for (const c of [this.base, this.over]) {
      c.width = Math.max(1, Math.round(w * this.dpr));
      c.height = Math.max(1, Math.round(h * this.dpr));
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    this.draw('base');
    this.draw('overlay');
  }

  /** Pointer hover (header ghosts, fill-handle dome); repaints the overlay on the next frame when it changes. */
  setHover(h: GridHover | null): void {
    const a = this.hover;
    const same = a === h || (!!a && !!h && a.zone === h.zone && a.r === h.r && a.c === h.c && a.fill === h.fill);
    if (same) return;
    this.hover = h;
    this.loop();
  }

  /** S15: roll the changed digits of a committed numeric result. */
  private startRoll(r: number, c: number, before: string, sheetId: string): void {
    const cd = this.ctrl.cell(r, c);
    if (!cd || cd.k !== 1 || sheetId !== this.ctrl.sheetId || cd.d === before || isReducedMotion()) return;
    if (!/\d/.test(cd.d) || cd.d.length > 24) return;
    const num = (t: string) => parseFloat(t.replace(/[−–]/g, '-').replace(/[^0-9.\-]/g, ''));
    const a = num(before);
    const b = num(cd.d);
    this.roll = { r, c, sheetId, before: /\d/.test(before) ? before.replace(/^-/, '\u2212') : '', t0: performance.now(), dir: Number.isFinite(a) && Number.isFinite(b) && b < a ? -1 : 1 };
    this.draw('base');
    this.draw('overlay');
  }

  private rollMatches(r: number, c: number): boolean {
    const ro = this.roll;
    return !!ro && ro.r === r && ro.c === c && ro.sheetId === this.ctrl.sheetId;
  }

  /** x of a 1-device-pixel-crisp line. */
  private crisp(x: number): number {
    const d = this.dpr;
    return (Math.round(x * d) + 0.5) / d;
  }

  private fontFor(st: CellStyle, scale = this.theme.scale): string {
    const size = (st.font?.size ?? 13) * scale;
    return `${st.font?.i ? 'italic ' : ''}${st.font?.b ? 600 : 400} ${size}px ${this.theme.font}`;
  }

  private measure(ctx: CanvasRenderingContext2D, text: string, font: string): number {
    const k = `${font}|${text}`;
    let w = this.measureCache.get(k);
    if (w === undefined) {
      ctx.font = font;
      w = ctx.measureText(text).width;
      if (this.measureCache.size > 20_000) this.measureCache.clear();
      this.measureCache.set(k, w);
    }
    return w;
  }

  /** The panes (frozen corner, frozen rows, frozen cols, main) with their visible index ranges. */
  private panes(l: Layout): PaneRect[] {
    const ctrl = this.ctrl;
    const v = ctrl.visible();
    const out: PaneRect[] = [];
    const fx = l.headerW + l.frozenW;
    const fy = l.headerH + l.frozenH;
    const main: PaneRect = { x: fx, y: fy, w: Math.max(0, this.w - fx), h: Math.max(0, this.h - fy), r0: v.r0, r1: v.r1, c0: v.c0, c1: v.c1 };
    // With nothing scrolled under the frozen columns, their text may run on into the next columns, so they paint last.
    const spill = this.ctrl.vp.scrollLeft === 0;
    if (l.fr) out.push({ x: fx, y: l.headerH, w: main.w, h: l.frozenH, r0: 0, r1: l.fr - 1, c0: v.c0, c1: v.c1 });
    out.push(main);
    if (l.fr && l.fc) out.push({ x: l.headerW, y: l.headerH, w: l.frozenW, h: l.frozenH, r0: 0, r1: l.fr - 1, c0: 0, c1: l.fc - 1, spill });
    if (l.fc) out.push({ x: l.headerW, y: fy, w: l.frozenW, h: main.h, r0: v.r0, r1: v.r1, c0: 0, c1: l.fc - 1, spill });
    return out;
  }

  draw(layer: PaintLayer): void {
    if (!this.w || !this.h) return;
    if (layer === 'base') this.drawBase();
    else this.drawOverlay();
  }

  // ───────────────────────────────────────────────────────────── base

  private drawBase(): void {
    const ctx = this.bctx;
    const th = this.theme;
    const l = this.ctrl.layout();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, this.w, this.h);
    for (const pane of this.panes(l)) {
      if (pane.w <= 0 || pane.h <= 0) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(pane.x, pane.y, pane.spill ? this.w - pane.x : pane.w, pane.h);
      ctx.clip();
      this.drawPane(ctx, pane, l);
      ctx.restore();
    }
    // Frozen pane dividers: a 2px line plus a soft shadow once content scrolls under them.
    if (l.fc) {
      const x = l.headerW + l.frozenW;
      if (this.ctrl.vp.scrollLeft > 0) {
        const g = ctx.createLinearGradient(x, 0, x + 8, 0);
        g.addColorStop(0, th.frozenShadow);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x, l.headerH, 8, this.h - l.headerH);
      }
      ctx.fillStyle = th.borderStrong;
      // Above the frozen rows the divider steps aside for titles that run across it.
      const top = this.ctrl.vp.scrollLeft === 0 ? l.headerH + l.frozenH : l.headerH;
      ctx.fillRect(x - 1, top, 2, this.h - top);
    }
    if (l.fr) {
      const y = l.headerH + l.frozenH;
      if (this.ctrl.vp.scrollTop > 0) {
        const g = ctx.createLinearGradient(0, y, 0, y + 8);
        g.addColorStop(0, th.frozenShadow);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(l.headerW, y, this.w - l.headerW, 8);
      }
      ctx.fillStyle = th.borderStrong;
      ctx.fillRect(l.headerW, y - 1, this.w - l.headerW, 2);
    }
  }

  private effStyle(cd: CellData | undefined): CellStyle {
    const ctrl = this.ctrl;
    const base = ctrl.style(cd?.s);
    if (!cd?.cf) return base;
    const o = ctrl.style(cd.cf);
    return { ...base, ...o, font: { ...base.font, ...o.font }, align: { ...base.align, ...o.align }, border: { ...base.border, ...o.border } };
  }

  private drawPane(ctx: CanvasRenderingContext2D, p: PaneRect, l: Layout): void {
    const ctrl = this.ctrl;
    const th = this.theme;
    const rows = ctrl.rows;
    const cols = ctrl.cols;
    const right = p.x + p.w;
    const bottom = p.y + p.h;
    // Column / row screen positions for the pane.
    const xs: number[] = [];
    const ys: number[] = [];
    // Edges from the pane's first index plus sizes (the next pane's scroll offset must not leak in).
    xs.push(ctrl.colX(p.c0, l));
    for (let c = p.c0; c <= p.c1; c++) xs.push(xs[xs.length - 1] + cols.size(c));
    ys.push(ctrl.rowY(p.r0, l));
    for (let r = p.r0; r <= p.r1; r++) ys.push(ys[ys.length - 1] + rows.size(r));
    // Merges intersecting the pane.
    const paneRect = { r0: p.r0, c0: p.c0, r1: p.r1, c1: p.c1 };
    const merges: Rect[] = [];
    const covered = new Set<number>();
    for (const m of ctrl.merges.values()) {
      if (!rectsIntersect(m, paneRect)) continue;
      merges.push(m);
      for (let r = Math.max(m.r0, p.r0); r <= Math.min(m.r1, p.r1); r++) for (let c = Math.max(m.c0, p.c0); c <= Math.min(m.c1, p.c1); c++) covered.add(cellKey(r, c));
    }

    // 1. gridlines
    ctx.beginPath();
    ctx.strokeStyle = th.grid;
    ctx.lineWidth = 1 / this.dpr;
    for (let i = 1; i < xs.length; i++) {
      const x = this.crisp(xs[i] - 0.5);
      if (x < p.x || x > right) continue;
      ctx.moveTo(x, p.y);
      ctx.lineTo(x, bottom);
    }
    for (let i = 1; i < ys.length; i++) {
      const y = this.crisp(ys[i] - 0.5);
      if (y < p.y || y > bottom) continue;
      ctx.moveTo(p.x, y);
      ctx.lineTo(right, y);
    }
    ctx.stroke();

    // 2. fills, bars and borders
    const lineW = 1 / this.dpr;
    for (let ri = 0; ri <= p.r1 - p.r0; ri++) {
      const r = p.r0 + ri;
      const y = ys[ri];
      const hgt = ys[ri + 1] - y;
      if (hgt <= 0) continue;
      for (let ci = 0; ci <= p.c1 - p.c0; ci++) {
        const c = p.c0 + ci;
        const key = cellKey(r, c);
        if (covered.has(key)) continue;
        const cd = ctrl.cell(r, c);
        if (!cd) continue;
        const x = xs[ci];
        const w = xs[ci + 1] - x;
        this.paintCellBack(ctx, cd, x, y, w, hgt, lineW);
      }
    }
    for (const m of merges) {
      const rp = ctrl.rectPx(m, l);
      const cd = ctrl.cell(m.r0, m.c0);
      ctx.fillStyle = th.bg;
      ctx.fillRect(rp.x, rp.y, rp.w - lineW, rp.h - lineW);
      if (cd) this.paintCellBack(ctx, cd, rp.x, rp.y, rp.w, rp.h, lineW);
    }

    // 3. text
    ctx.textBaseline = 'middle';
    for (let ri = 0; ri <= p.r1 - p.r0; ri++) {
      const r = p.r0 + ri;
      const y = ys[ri];
      const hgt = ys[ri + 1] - y;
      if (hgt <= 0) continue;
      // Start a few columns early so overflowing text from the left still shows.
      const startC = Math.max(r < l.fr || p.c0 < l.fc ? p.c0 : l.fc, p.c0 - 3);
      for (let c = startC; c <= p.c1; c++) {
        const key = cellKey(r, c);
        if (covered.has(key)) continue;
        const cd = ctrl.cell(r, c);
        if (!cd || !cd.d) continue;
        const x = c >= p.c0 ? xs[c - p.c0] : ctrl.colX(c, l);
        const w = cols.size(c);
        this.paintText(ctx, cd, r, c, x, y, w, hgt, p, l);
      }
    }
    for (const m of merges) {
      const cd = ctrl.cell(m.r0, m.c0);
      if (!cd?.d) continue;
      const rp = ctrl.rectPx(m, l);
      this.paintText(ctx, cd, m.r0, m.c0, rp.x, rp.y, rp.w, rp.h, p, l, true);
    }
    void rows;
  }

  private paintCellBack(ctx: CanvasRenderingContext2D, cd: CellData, x: number, y: number, w: number, h: number, lineW: number): void {
    const th = this.theme;
    const st = this.effStyle(cd);
    let fill = st.fill ? adaptFill(st.fill, th.dark) : null;
    if (!fill && st.role === 'input') fill = th.inputBg;
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fillRect(x, y, w - lineW, h - lineW);
    }
    if (cd.bar !== undefined && cd.bar > 0) {
      const bs = this.ctrl.style(cd.barStyle);
      const color = bs.fill ?? th.accent;
      const bw = Math.max(2, (w - 6) * cd.bar);
      ctx.save();
      ctx.globalAlpha = th.dark ? 0.3 : 0.24;
      ctx.fillStyle = color;
      roundRect(ctx, x + 3, y + 4, bw, h - 9, 3);
      ctx.fill();
      ctx.globalAlpha = th.dark ? 0.75 : 0.7;
      ctx.fillRect(x + 3, y + 4, Math.min(2, bw), h - 9);
      ctx.restore();
    }
    if (st.border) {
      for (const side of ['t', 'r', 'b', 'l'] as const) {
        const b = st.border[side];
        if (!b) continue;
        const wpx = b.style === 'thick' ? 3 : b.style === 'medium' ? 2 : 1;
        ctx.save();
        ctx.fillStyle = adaptText(b.color || '#000000', th.dark);
        if (b.style === 'dashed') {
          ctx.strokeStyle = ctx.fillStyle;
          ctx.setLineDash([3, 2]);
          ctx.lineWidth = 1;
          ctx.beginPath();
          if (side === 't' || side === 'b') {
            const yy = this.crisp(side === 't' ? y : y + h - 1);
            ctx.moveTo(x, yy);
            ctx.lineTo(x + w, yy);
          } else {
            const xx = this.crisp(side === 'l' ? x : x + w - 1);
            ctx.moveTo(xx, y);
            ctx.lineTo(xx, y + h);
          }
          ctx.stroke();
        } else if (side === 't') ctx.fillRect(x, y - (wpx > 1 ? 1 : 0), w, wpx);
        else if (side === 'b') ctx.fillRect(x, y + h - wpx, w, wpx);
        else if (side === 'l') ctx.fillRect(x - (wpx > 1 ? 1 : 0), y, wpx, h);
        else ctx.fillRect(x + w - wpx, y, wpx, h);
        ctx.restore();
      }
    }
  }

  private paintText(ctx: CanvasRenderingContext2D, cd: CellData, r: number, c: number, x: number, y: number, w: number, h: number, p: PaneRect, l: Layout, merged = false): void {
    if (this.rollMatches(r, c)) return; // the overlay draws the rolling digits
    const th = this.theme;
    const ctrl = this.ctrl;
    const st = this.effStyle(cd);
    const font = this.fontFor(st);
    ctx.font = font;
    let color = th.text;
    if (cd.k === 4) color = th.lossText;
    else if (st.font?.color) color = adaptText(st.font.color, th.dark);
    else if (st.role === 'input') color = th.inputText;
    const numFmt = ctrl.style(cd.s).numFmt ?? '';
    if (/\[red\]/i.test(numFmt) && /^[-(−]/.test(cd.d)) color = th.lossText;
    const hAlign = st.align?.h ?? (cd.k === 1 ? 'right' : cd.k === 3 || cd.k === 4 ? 'center' : 'left');
    const vAlign = st.align?.v ?? 'middle';
    const shown = shownText(cd);
    let text = shown;
    const tw = this.measure(ctx, text, font);
    let clipX0 = x;
    let clipX1 = x + w;
    const wrap = !!st.align?.wrap && cd.k === 2;
    if (!wrap && !merged && tw > w - PAD * 2) {
      if (cd.k === 1) {
        // Numbers that don't fit show #### like Excel.
        const hashW = this.measure(ctx, '#', font);
        text = '#'.repeat(Math.max(1, Math.floor((w - PAD * 2) / Math.max(1, hashW))));
      } else if (cd.k === 2 && hAlign === 'left') {
        // Overflow into empty cells to the right.
        let cc = c + 1;
        let extra = 0;
        while (tw > w + extra - PAD * 2 && cc < MAX_COLS && cc < c + 40) {
          const n = ctrl.cell(r, cc);
          if ((n && n.k !== 0) || ctrl.mergeAt(r, cc) || (cc === l.fc && c < l.fc && !p.spill)) break;
          extra += ctrl.cols.size(cc);
          cc++;
        }
        if (extra) {
          clipX1 = x + w + extra;
          // Hide the gridlines the text runs across.
          ctx.fillStyle = th.bg;
          const covered = { r0: r, c0: c + 1, r1: r, c1: cc - 1 };
          for (let k = covered.c0; k <= covered.c1; k++) {
            const n = ctrl.cell(r, k);
            const nst = this.effStyle(n);
            if (nst.fill || nst.role === 'input') continue;
            const kx = ctrl.colX(k, l);
            ctx.fillRect(kx - 1, y, ctrl.cols.size(k) + 1, h - 1);
          }
          ctx.fillStyle = color;
        }
      }
    }
    // Clip to the cell (plus any overflow) and the pane.
    ctx.save();
    ctx.beginPath();
    const cx0 = Math.max(clipX0, p.x);
    const cx1 = Math.min(clipX1, p.spill ? this.w : p.x + p.w);
    ctx.rect(cx0, Math.max(y, p.y), Math.max(0, cx1 - cx0), Math.max(0, Math.min(y + h, p.y + p.h) - Math.max(y, p.y)));
    ctx.clip();
    ctx.fillStyle = color;
    const size = (st.font?.size ?? 13) * th.scale;
    if (wrap) {
      const lines = this.wrapLines(ctx, text, font, w - PAD * 2);
      const lh = Math.round(size * 1.3);
      const total = lines.length * lh;
      let ty = vAlign === 'top' ? y + 4 + lh / 2 : vAlign === 'bottom' ? y + h - 4 - total + lh / 2 : y + (h - total) / 2 + lh / 2;
      for (const line of lines) {
        const lw = this.measure(ctx, line, font);
        const tx = hAlign === 'right' ? x + w - PAD - lw : hAlign === 'center' ? x + (w - lw) / 2 : x + PAD;
        ctx.fillText(line, tx, ty);
        ty += lh;
      }
    } else {
      const drawW = text === shown ? tw : this.measure(ctx, text, font);
      const tx = hAlign === 'right' ? x + w - PAD - drawW : hAlign === 'center' ? x + (w - drawW) / 2 : x + PAD;
      const ty = vAlign === 'top' ? y + 4 + size / 2 : vAlign === 'bottom' ? y + h - 4 - size / 2 : y + h / 2 + 0.5;
      ctx.fillText(text, tx, ty);
      if (st.font?.u || st.font?.s) {
        ctx.fillRect(tx, st.font?.u ? ty + size * 0.5 : ty, drawW, Math.max(1, size / 13));
      }
    }
    if (cd.k === 4) {
      // A small loss-coloured corner marks errors.
      ctx.fillStyle = th.loss;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 6, y);
      ctx.lineTo(x, y + 6);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  private wrapLines(ctx: CanvasRenderingContext2D, text: string, font: string, maxW: number): string[] {
    const out: string[] = [];
    for (const para of text.split('\n')) {
      const words = para.split(/(\s+)/);
      let line = '';
      for (const word of words) {
        const next = line + word;
        if (line && this.measure(ctx, next, font) > maxW) {
          out.push(line.trimEnd());
          line = word.trimStart();
        } else line = next;
      }
      out.push(line);
      if (out.length > 50) break;
    }
    return out;
  }

  // ───────────────────────────────────────────────────────────── overlay

  private drawOverlay(): void {
    const ctx = this.octx;
    const ctrl = this.ctrl;
    const th = this.theme;
    const l = ctrl.layout();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const now = performance.now();
    let animating = false;

    // Selection
    const editing = ctrl.edit && ctrl.edit.sheetId === ctrl.sheetId ? ctrl.edit : null;
    ctx.save();
    ctx.beginPath();
    ctx.rect(l.headerW, l.headerH, this.w - l.headerW, this.h - l.headerH);
    ctx.clip();

    // Find matches
    if (ctrl.find.open && ctrl.find.results.length) {
      const v = ctrl.visible();
      const vr = { r0: 0, c0: 0, r1: v.r1, c1: v.c1 };
      ctrl.find.results.forEach((m, i) => {
        if (m.sheetId !== ctrl.sheetId || !rectContains(vr, m.row, m.col)) return;
        const rp = ctrl.rectPx({ r0: m.row, c0: m.col, r1: m.row, c1: m.col }, l);
        ctx.fillStyle = th.warningSoft;
        ctx.fillRect(rp.x, rp.y, rp.w - 1, rp.h - 1);
        if (i === ctrl.find.index) {
          ctx.strokeStyle = th.warning;
          ctx.lineWidth = 2;
          ctx.strokeRect(rp.x + 1, rp.y + 1, rp.w - 3, rp.h - 3);
        }
      });
    }

    // Committed result rolling its digits (base skips this cell's text meanwhile).
    if (this.roll) {
      if (this.drawRoll(ctx, l, now)) animating = true;
      else {
        this.roll = null;
        this.draw('base');
      }
    }

    const ranges = ctrl.sel.ranges;
    const primaryIdx = ranges.length - 1;
    ranges.forEach((range, i) => {
      const rect = this.clampRect(range);
      const target = ctrl.rectPx(rect, l);
      let rp = target;
      if (i === primaryIdx) {
        const anim = this.animFor('primary', target, rect, l, now);
        if (anim.animating) animating = true;
        rp = anim.rect;
      }
      this.withPaneClip(ctx, rect, l, () => {
        const single = rect.r0 === rect.r1 && rect.c0 === rect.c1;
        const m = ctrl.mergeAt(rect.r0, rect.c0);
        const isOneMerged = !!m && m.r0 === rect.r0 && m.c0 === rect.c0 && m.r1 === rect.r1 && m.c1 === rect.c1;
        if (!single && !isOneMerged) {
          ctx.fillStyle = th.accent;
          ctx.globalAlpha = th.dark ? 0.14 : 0.08;
          ctx.fillRect(rp.x, rp.y, rp.w, rp.h);
          ctx.globalAlpha = 1;
        }
        if (i === primaryIdx && !editing) {
          // A soft lit halo outside the border: the selection reads as a raised, lit frame.
          ctx.strokeStyle = th.accent;
          ctx.globalAlpha = th.dark ? 0.26 : 0.14;
          ctx.lineWidth = 3;
          ctx.strokeRect(rp.x - 2.5, rp.y - 2.5, rp.w + 4, rp.h + 4);
          ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = th.accent;
        ctx.lineWidth = i === primaryIdx ? 2 : 1;
        const inset = i === primaryIdx ? 1 : 0.5;
        ctx.strokeRect(rp.x - 1 + inset, rp.y - 1 + inset, rp.w + 1 - inset * 2 + (i === primaryIdx ? 0 : 0), rp.h + 1 - inset * 2);
      });
    });

    // Active cell: punch the fill out and outline it when inside a larger range.
    {
      const a = ctrl.sel.active;
      const m = ctrl.mergeAt(a.r, a.c);
      const ar = m ?? { r0: a.r, c0: a.c, r1: a.r, c1: a.c };
      const pr = this.clampRect(ctrl.primary);
      const bigger = pr.r1 > ar.r1 || pr.c1 > ar.c1 || pr.r0 < ar.r0 || pr.c0 < ar.c0 || ranges.length > 1;
      if (bigger) {
        const target = ctrl.rectPx(ar, l);
        const anim = this.animFor('active', target, ar, l, now);
        if (anim.animating) animating = true;
        const rp = anim.rect;
        this.withPaneClip(ctx, ar, l, () => {
          ctx.clearRect(rp.x, rp.y, rp.w - 1, rp.h - 1);
          ctx.strokeStyle = th.accent;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(rp.x + 0.75, rp.y + 0.75, rp.w - 2.5, rp.h - 2.5);
        });
      } else this.lastActive = null;
    }

    // Spill outline for the active dynamic array.
    const spill = this.spillRect();
    if (spill) {
      const rp = ctrl.rectPx(spill, l);
      this.withPaneClip(ctx, spill, l, () => {
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = th.accent;
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(rp.x) + 0.5, Math.round(rp.y) + 0.5, rp.w - 2, rp.h - 2);
        ctx.restore();
      });
    }

    // Fill handle (6×6) at the primary range's bottom-right.
    if (!editing && ranges.length === 1) {
      const pr = this.clampRect(ctrl.primary);
      const full = ctrl.primary.r1 >= MAX_ROWS - 1 || ctrl.primary.c1 >= MAX_COLS - 1;
      if (!full) {
        const glide = this.anim ? this.toScreen(this.interp(this.anim, now), pr, l) : null;
        const rp = glide ?? (this.lastPrimary ? this.toScreen(this.lastPrimary, pr, l) : ctrl.rectPx(pr, l));
        const cx = rp.x + rp.w - 1;
        const cy = rp.y + rp.h - 1;
        if (cx > l.headerW + 2 && cy > l.headerH + 2) this.drawFillDome(ctx, cx, cy, !!this.hover?.fill || !!ctrl.fillPreview);
      }
    }

    // Fill drag preview: a ghost range (tint + dashed rim) with a count badge at the far corner.
    if (ctrl.fillPreview) {
      const fp = ctrl.fillPreview;
      const rp = ctrl.rectPx(fp, l);
      const p = ctrl.primary;
      ctx.save();
      ctx.fillStyle = th.accent;
      ctx.globalAlpha = th.dark ? 0.1 : 0.06;
      ctx.fillRect(rp.x, rp.y, rp.w, rp.h);
      ctx.globalAlpha = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = th.accent;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(rp.x + 0.75, rp.y + 0.75, rp.w - 1.5, rp.h - 1.5);
      ctx.restore();
      const rows = fp.r1 - fp.r0 - (p.r1 - p.r0);
      const cols = fp.c1 - fp.c0 - (p.c1 - p.c0);
      const n = rows > 0 ? rows : cols;
      if (n > 0) {
        const label = `+${n.toLocaleString()} ${rows > 0 ? (n === 1 ? 'row' : 'rows') : n === 1 ? 'column' : 'columns'}`;
        const down = fp.r1 > p.r1 || fp.c1 > p.c1;
        const ax = down ? rp.x + rp.w : rp.x;
        const ay = down ? rp.y + rp.h : rp.y;
        this.drawBadge(ctx, label, ax, ay, down, l);
      }
    }

    // Copy marquee: marching ants.
    if (ctrl.marquee && ctrl.marquee.sheetId === ctrl.sheetId) {
      const rect = this.clampRect(ctrl.marquee.rect);
      const rp = ctrl.rectPx(rect, l);
      const reduced = isReducedMotion();
      this.withPaneClip(ctx, rect, l, () => {
        ctx.save();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = th.bg;
        ctx.strokeRect(rp.x + 1, rp.y + 1, rp.w - 3, rp.h - 3);
        ctx.setLineDash([5, 4]);
        ctx.lineDashOffset = reduced ? 0 : -((now / 45) % 9);
        ctx.strokeStyle = th.accent;
        ctx.strokeRect(rp.x + 1, rp.y + 1, rp.w - 3, rp.h - 3);
        ctx.restore();
      });
      if (!reduced) animating = true;
    }

    // Formula reference highlights while editing.
    if (editing && editing.text.startsWith('=')) this.drawRefHighlights(ctx, editing.text, l);
    ctx.restore();

    this.drawHeaders(ctx, l);

    // Resize guide
    if (ctrl.resizeGuide) {
      const g = ctrl.resizeGuide;
      ctx.fillStyle = th.accent;
      if (g.axis === 'cols') {
        const x = ctrl.colX(g.index, l) + g.size;
        ctx.fillRect(Math.round(x) - 1, 0, 2, this.h);
      } else {
        const y = ctrl.rowY(g.index, l) + g.size;
        ctx.fillRect(0, Math.round(y) - 1, this.w, 2);
      }
    }

    if (animating) this.loop();
  }

  /** The fill handle as a small lit dome (keycap family), with a bg ring so it reads on any fill. */
  private drawFillDome(ctx: CanvasRenderingContext2D, cx: number, cy: number, hot: boolean): void {
    const th = this.theme;
    const s = hot ? 10 : 8;
    const x = cx - s / 2;
    const y = cy - s / 2;
    ctx.save();
    // contact shadow
    ctx.fillStyle = th.dark ? 'rgba(0,0,0,0.55)' : 'rgba(16,16,24,0.22)';
    roundRect(ctx, x - 0.5, y + 1, s + 1, s + 1, 3);
    ctx.fill();
    // bg ring
    ctx.fillStyle = th.bg;
    roundRect(ctx, x - 1.5, y - 1.5, s + 3, s + 3, 3.5);
    ctx.fill();
    // lit face
    const g = ctx.createLinearGradient(0, y, 0, y + s);
    g.addColorStop(0, mixColor('#ffffff', th.accent, th.dark ? 0.1 : 0.22));
    g.addColorStop(1, th.accent);
    ctx.fillStyle = g;
    roundRect(ctx, x, y, s, s, 2.5);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillRect(x + 2, y + 0.75, s - 4, 1);
    ctx.restore();
  }

  /** A small ink pill (fill count) anchored at a range corner, kept inside the grid. */
  private drawBadge(ctx: CanvasRenderingContext2D, label: string, ax: number, ay: number, after: boolean, l: Layout): void {
    const th = this.theme;
    const font = `600 ${11 * th.scale}px ${th.font}`;
    const tw = this.measure(ctx, label, font);
    const w = tw + 14;
    const h = 20;
    let x = after ? ax + 6 : ax - w - 6;
    let y = after ? ay + 6 : ay - h - 6;
    x = Math.min(Math.max(l.headerW + 4, x), this.w - w - 4);
    y = Math.min(Math.max(l.headerH + 4, y), this.h - h - 4);
    ctx.save();
    ctx.fillStyle = th.dark ? 'rgba(0,0,0,0.5)' : 'rgba(16,16,24,0.18)';
    roundRect(ctx, x, y + 1.5, w, h, 10);
    ctx.fill();
    ctx.fillStyle = th.text;
    roundRect(ctx, x, y, w, h, 10);
    ctx.fill();
    ctx.fillStyle = th.bg;
    ctx.font = font;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(label, x + 7, y + h / 2 + 0.5);
    ctx.restore();
  }

  /** Draws the rolling digits of `this.roll`; returns false once settled. */
  private drawRoll(ctx: CanvasRenderingContext2D, l: Layout, now: number): boolean {
    const ro = this.roll;
    const ctrl = this.ctrl;
    if (!ro || ro.sheetId !== ctrl.sheetId) return false;
    const cd = ctrl.cell(ro.r, ro.c);
    if (!cd || cd.k !== 1) return false;
    const elapsed = now - ro.t0;
    const text = shownText(cd);
    const total = ROLL.ms + ROLL.stagger * Math.min(text.length, 10);
    if (elapsed > total) return false;
    const th = this.theme;
    const st = this.effStyle(cd);
    const font = this.fontFor(st);
    let color = th.text;
    if (st.font?.color) color = adaptText(st.font.color, th.dark);
    else if (st.role === 'input') color = th.inputText;
    const numFmt = ctrl.style(cd.s).numFmt ?? '';
    if (/\[red\]/i.test(numFmt) && /^[-(−]/.test(text)) color = th.lossText;
    const rect = { r0: ro.r, c0: ro.c, r1: ro.r, c1: ro.c };
    const m = ctrl.mergeAt(ro.r, ro.c);
    const rp = ctrl.rectPx(m ?? rect, l);
    const tw = this.measure(ctx, text, font);
    if (tw > rp.w - PAD * 2) return false;
    const hAlign = st.align?.h ?? 'right';
    const size = (st.font?.size ?? 13) * th.scale;
    const vAlign = st.align?.v ?? 'middle';
    const ty = vAlign === 'top' ? rp.y + 4 + size / 2 : vAlign === 'bottom' ? rp.y + rp.h - 4 - size / 2 : rp.y + rp.h / 2 + 0.5;
    const xFor = (w: number) => (hAlign === 'left' ? rp.x + PAD : hAlign === 'center' ? rp.x + (rp.w - w) / 2 : rp.x + rp.w - PAD - w);
    const before = ro.before;
    const bw = before ? this.measure(ctx, before, font) : 0;
    const nx = xFor(tw);
    const bx = xFor(bw);
    const travel = Math.min(rp.h * 0.72, size * 1.25);
    this.withPaneClip(ctx, m ?? rect, l, () => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(rp.x + 1, rp.y + 1, rp.w - 3, rp.h - 3);
      ctx.clip();
      ctx.font = font;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillStyle = color;
      const n = Math.max(text.length, before.length);
      let order = 0;
      for (let j = 0; j < n; j++) {
        const ni = text.length - 1 - j;
        const bi = before.length - 1 - j;
        const nc = ni >= 0 ? text[ni] : '';
        const bc = bi >= 0 ? before[bi] : '';
        const npos = ni >= 0 ? nx + this.measure(ctx, text.slice(0, ni), font) : 0;
        const bpos = bi >= 0 ? bx + this.measure(ctx, before.slice(0, bi), font) : 0;
        if (nc === bc && Math.abs(npos - bpos) < 0.5) {
          ctx.globalAlpha = 1;
          ctx.fillText(nc, npos, ty);
          continue;
        }
        const p = Math.min(1, springAt(elapsed - order * ROLL.stagger, ROLL.k, ROLL.c));
        const q = Math.max(0, Math.min(1, (elapsed - order * ROLL.stagger) / 140));
        order++;
        if (bc) {
          ctx.globalAlpha = Math.max(0, 1 - q);
          ctx.fillText(bc, bpos, ty - ro.dir * travel * p);
        }
        if (nc) {
          ctx.globalAlpha = Math.min(1, q * 1.2);
          ctx.fillText(nc, npos, ty + ro.dir * travel * (1 - p));
        }
      }
      ctx.restore();
    });
    return true;
  }

  private loop(): void {
    if (this.loopRaf) return;
    this.loopRaf = requestAnimationFrame(() => {
      this.loopRaf = 0;
      this.drawOverlay();
    });
  }

  private clampRect(r: Rect): Rect {
    const ctrl = this.ctrl;
    return { r0: r.r0, c0: r.c0, r1: Math.min(r.r1, ctrl.rows.count - 1), c1: Math.min(r.c1, ctrl.cols.count - 1) };
  }

  /** Content-space rect (frozen-aware) → screen. */
  private toScreen(a: AnimRect, rect: Rect, l: Layout): { x: number; y: number; w: number; h: number } {
    const sx = rect.c0 >= l.fc ? this.ctrl.vp.scrollLeft : 0;
    const sy = rect.r0 >= l.fr ? this.ctrl.vp.scrollTop : 0;
    return { x: l.headerW + a.x0 - sx, y: l.headerH + a.y0 - sy, w: a.x1 - a.x0, h: a.y1 - a.y0 };
  }

  /** Glide the selection between positions (content coordinates, so scrolling never animates). */
  private animFor(which: 'primary' | 'active', target: { x: number; y: number; w: number; h: number }, rect: Rect, l: Layout, now: number): { rect: { x: number; y: number; w: number; h: number }; animating: boolean } {
    const ctrl = this.ctrl;
    const straddles = (rect.c0 < l.fc && rect.c1 >= l.fc) || (rect.r0 < l.fr && rect.r1 >= l.fr);
    const to: AnimRect = { x0: ctrl.cols.offset(rect.c0), y0: ctrl.rows.offset(rect.r0), x1: ctrl.cols.end(rect.c1), y1: ctrl.rows.end(rect.r1) };
    const last = which === 'primary' ? this.lastPrimary : this.lastActive;
    let cur = which === 'primary' ? this.anim : this.animActive;
    const reduced = isReducedMotion();
    const same = (a: AnimRect | null) => !!a && a.x0 === to.x0 && a.y0 === to.y0 && a.x1 === to.x1 && a.y1 === to.y1;
    if (!same(cur?.to ?? null) && last && !straddles && !reduced && !this.ctrl.fillPreview) {
      const from = cur ? this.interp(cur, now) : last;
      const far = Math.abs(from.x0 - to.x0) + Math.abs(from.y0 - to.y0) > 1600;
      cur = far ? null : { from, to, t0: now };
    } else if (!same(cur?.to ?? null)) cur = null;
    if (which === 'primary') {
      this.anim = cur;
      this.lastPrimary = to;
    } else {
      this.animActive = cur;
      this.lastActive = to;
    }
    if (!cur || straddles) return { rect: target, animating: false };
    if (now - cur.t0 >= GLIDE.ms) {
      if (which === 'primary') this.anim = null;
      else this.animActive = null;
      return { rect: target, animating: false };
    }
    return { rect: this.toScreen(this.interp(cur, now), rect, l), animating: true };
  }

  private interp(a: { from: AnimRect; to: AnimRect; t0: number }, now: number): AnimRect {
    const e = now - a.t0 >= GLIDE.ms ? 1 : springAt(now - a.t0, GLIDE.k, GLIDE.c);
    const lerp = (x: number, y: number) => x + (y - x) * e;
    return { x0: lerp(a.from.x0, a.to.x0), y0: lerp(a.from.y0, a.to.y0), x1: lerp(a.from.x1, a.to.x1), y1: lerp(a.from.y1, a.to.y1) };
  }

  /** Clip drawing of a range to the pane(s) it lives in, so it never paints over frozen panes. */
  private withPaneClip(ctx: CanvasRenderingContext2D, rect: Rect, l: Layout, fn: () => void): void {
    const fx = l.headerW + l.frozenW;
    const fy = l.headerH + l.frozenH;
    let x0 = l.headerW;
    let x1 = this.w;
    let y0 = l.headerH;
    let y1 = this.h;
    if (l.fc) {
      if (rect.c0 >= l.fc) x0 = fx;
      else if (rect.c1 < l.fc) x1 = fx;
    }
    if (l.fr) {
      if (rect.r0 >= l.fr) y0 = fy;
      else if (rect.r1 < l.fr) y1 = fy;
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0 - 1, y0 - 1, x1 - x0 + 2, y1 - y0 + 2);
    ctx.clip();
    fn();
    ctx.restore();
  }

  private spillRect(): Rect | null {
    const ctrl = this.ctrl;
    const a = ctrl.sel.active;
    let anchor: { r: number; c: number } | null = null;
    if (ctrl.activeInfo.spillOf) anchor = parseCell(ctrl.activeInfo.spillOf);
    else {
      const cd = ctrl.cell(a.r, a.c);
      if (cd?.f === 1 && (ctrl.cell(a.r + 1, a.c)?.f === 2 || ctrl.cell(a.r, a.c + 1)?.f === 2)) anchor = a;
    }
    if (!anchor) return null;
    let r1 = anchor.r;
    let c1 = anchor.c;
    while (ctrl.cell(r1 + 1, anchor.c)?.f === 2 && r1 - anchor.r < 100_000) r1++;
    while (ctrl.cell(anchor.r, c1 + 1)?.f === 2 && c1 - anchor.c < 16_384) c1++;
    if (r1 === anchor.r && c1 === anchor.c) return null;
    return { r0: anchor.r, c0: anchor.c, r1, c1 };
  }

  private drawRefHighlights(ctx: CanvasRenderingContext2D, text: string, l: Layout): void {
    const ctrl = this.ctrl;
    const th = this.theme;
    const seen = new Map<string, number>();
    const sheetName = ctrl.sheet?.name ?? '';
    const editSheet = ctrl.sheets.find((s) => s.id === ctrl.edit?.sheetId)?.name ?? sheetName;
    for (const tok of tokenize(text)) {
      if (tok.t !== 'ref' || !tok.ref) continue;
      const target = tok.ref.sheet ?? editSheet;
      if (target.toLowerCase() !== sheetName.toLowerCase()) continue;
      const key = tok.v.replace(/\$/g, '').toUpperCase();
      let idx = seen.get(key);
      if (idx === undefined) {
        idx = seen.size;
        seen.set(key, idx);
      }
      const color = th.cat[refColorIndex(idx)];
      const rect = this.clampRect(tok.ref.rect);
      const rp = ctrl.rectPx(rect, l);
      this.withPaneClip(ctx, rect, l, () => {
        ctx.fillStyle = color;
        ctx.globalAlpha = th.dark ? 0.16 : 0.1;
        ctx.fillRect(rp.x, rp.y, rp.w, rp.h);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(rp.x + 0.25, rp.y + 0.25, rp.w - 1.5, rp.h - 1.5);
        for (const [cx, cy] of [[rp.x, rp.y], [rp.x + rp.w - 1, rp.y], [rp.x, rp.y + rp.h - 1], [rp.x + rp.w - 1, rp.y + rp.h - 1]]) {
          ctx.fillStyle = th.bg;
          ctx.fillRect(cx - 3, cy - 3, 6, 6);
          ctx.fillStyle = color;
          ctx.fillRect(cx - 2, cy - 2, 4, 4);
        }
      });
    }
    void splitSheetRef;
  }

  private drawHeaders(ctx: CanvasRenderingContext2D, l: Layout): void {
    const ctrl = this.ctrl;
    const th = this.theme;
    const v = ctrl.visible();
    const fontSize = 11 * th.scale;
    const font = `500 ${fontSize}px ${th.font}`;
    const fontSel = `600 ${fontSize}px ${th.font}`;
    // Selection coverage per header.
    const colState = (c: number): 0 | 1 | 2 => {
      let s: 0 | 1 | 2 = 0;
      for (const r of ctrl.sel.ranges) {
        if (c < r.c0 || c > r.c1) continue;
        if (r.r0 === 0 && r.r1 >= MAX_ROWS - 1) return 2;
        s = 1;
      }
      return s;
    };
    const rowState = (rr: number): 0 | 1 | 2 => {
      let s: 0 | 1 | 2 = 0;
      for (const r of ctrl.sel.ranges) {
        if (rr < r.r0 || rr > r.r1) continue;
        if (r.c0 === 0 && r.c1 >= MAX_COLS - 1) return 2;
        s = 1;
      }
      return s;
    };
    const hv = this.hover;
    // Column header strip: a machined plate (lit top, slightly darker foot).
    const hg = ctx.createLinearGradient(0, 0, 0, l.headerH);
    hg.addColorStop(0, th.headerTop);
    hg.addColorStop(1, th.headerBg);
    ctx.fillStyle = hg;
    ctx.fillRect(l.headerW, 0, this.w - l.headerW, l.headerH);
    ctx.fillStyle = th.headerHl;
    ctx.fillRect(l.headerW, 0, this.w - l.headerW, 1);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    const colsToDraw: number[] = [];
    for (let c = 0; c < l.fc; c++) colsToDraw.push(c);
    for (let c = v.c0; c <= v.c1; c++) colsToDraw.push(c);
    const fx = l.headerW + l.frozenW;
    for (const c of colsToDraw) {
      const x = ctrl.colX(c, l);
      const w = ctrl.cols.size(c);
      ctx.save();
      ctx.beginPath();
      if (c >= l.fc) ctx.rect(fx, 0, this.w - fx, l.headerH);
      else ctx.rect(l.headerW, 0, l.frozenW, l.headerH);
      ctx.clip();
      const s = colState(c);
      if (s) {
        ctx.fillStyle = s === 2 ? th.headerSelFullBg : th.headerSelBg;
        ctx.fillRect(x, 0, w, l.headerH);
        ctx.fillStyle = th.accent;
        roundRect(ctx, x + 2, l.headerH - 2.5, Math.max(2, w - 4), 2.5, 1.25);
        ctx.fill();
      } else if (hv && hv.c === c && hv.zone !== 'rowhead' && hv.zone !== 'corner') {
        ctx.fillStyle = hv.zone === 'colhead' ? th.ghostStrong : th.ghost;
        ctx.fillRect(x, 0, w, l.headerH);
      }
      ctx.font = s ? fontSel : font;
      ctx.fillStyle = s ? th.headerSelText : th.headerText;
      ctx.fillText(colName(c), x + w / 2, l.headerH / 2 + 0.5);
      ctx.fillStyle = th.headerBorder;
      ctx.fillRect(Math.round(x + w) - 1, 4, 1 / this.dpr + 0.0, l.headerH - 8);
      ctx.restore();
    }
    ctx.fillStyle = th.headerBorder;
    ctx.fillRect(0, l.headerH - 1 / this.dpr, this.w, 1 / this.dpr);

    // Row header strip
    const rg = ctx.createLinearGradient(0, 0, l.headerW, 0);
    rg.addColorStop(0, th.headerTop);
    rg.addColorStop(1, th.headerBg);
    ctx.fillStyle = rg;
    ctx.fillRect(0, l.headerH, l.headerW, this.h - l.headerH);
    ctx.textAlign = 'right';
    const rowsToDraw: number[] = [];
    for (let r = 0; r < l.fr; r++) rowsToDraw.push(r);
    for (let r = v.r0; r <= v.r1; r++) rowsToDraw.push(r);
    const fy = l.headerH + l.frozenH;
    for (const r of rowsToDraw) {
      const y = ctrl.rowY(r, l);
      const h = ctrl.rows.size(r);
      ctx.save();
      ctx.beginPath();
      if (r >= l.fr) ctx.rect(0, fy, l.headerW, this.h - fy);
      else ctx.rect(0, l.headerH, l.headerW, l.frozenH);
      ctx.clip();
      const s = rowState(r);
      if (s) {
        ctx.fillStyle = s === 2 ? th.headerSelFullBg : th.headerSelBg;
        ctx.fillRect(0, y, l.headerW, h);
        ctx.fillStyle = th.accent;
        roundRect(ctx, l.headerW - 2.5, y + 2, 2.5, Math.max(2, h - 4), 1.25);
        ctx.fill();
      } else if (hv && hv.r === r && hv.zone !== 'colhead' && hv.zone !== 'corner') {
        ctx.fillStyle = hv.zone === 'rowhead' ? th.ghostStrong : th.ghost;
        ctx.fillRect(0, y, l.headerW, h);
      }
      ctx.font = s ? fontSel : font;
      ctx.fillStyle = s ? th.headerSelText : th.headerText;
      ctx.fillText(String(r + 1), l.headerW - 8, y + h / 2 + 0.5);
      ctx.fillStyle = th.headerBorder;
      ctx.fillRect(6, Math.round(y + h) - 1, l.headerW - 12, 1 / this.dpr);
      ctx.restore();
    }
    ctx.fillStyle = th.headerBorder;
    ctx.fillRect(l.headerW - 1 / this.dpr, 0, 1 / this.dpr, this.h);
    // Frozen dividers continue through the headers.
    ctx.fillStyle = th.borderStrong;
    if (l.fc) ctx.fillRect(fx - 1, 0, 2, l.headerH);
    if (l.fr) ctx.fillRect(0, fy - 1, l.headerW, 2);
    // Corner: select-all triangle.
    ctx.fillStyle = hv?.zone === 'corner' ? mixColor(th.text, th.headerBg, th.dark ? 0.08 : 0.05) : th.headerBg;
    ctx.fillRect(0, 0, l.headerW - 1 / this.dpr, l.headerH - 1 / this.dpr);
    const all = ctrl.sel.ranges.some((r) => r.r0 === 0 && r.c0 === 0 && r.r1 >= MAX_ROWS - 1 && r.c1 >= MAX_COLS - 1);
    ctx.fillStyle = all ? th.accent : th.text3;
    ctx.globalAlpha = all ? 1 : 0.45;
    ctx.beginPath();
    ctx.moveTo(l.headerW - 6, l.headerH - 6);
    ctx.lineTo(l.headerW - 6, l.headerH - 15);
    ctx.lineTo(l.headerW - 15, l.headerH - 6);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  }
}

/** Reference colours cycle through the categorical palette (iris, amber, teal, pink, sky, violet, lime, orange). */
export function refColorIndex(i: number): number {
  return [0, 3, 2, 4, 1, 5, 6, 7][i % 8];
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}
