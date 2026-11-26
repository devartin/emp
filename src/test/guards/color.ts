/**
 * Just enough CSS colour maths for the token contrast test: parse hex / rgb[a] / transparent / color-mix(in srgb|oklab),
 * alpha-composite over a surface, and compute the WCAG 2.x contrast ratio.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (s === 'white') return { r: 255, g: 255, b: 255, a: 1 };
  if (s === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    const h = m[1];
    const x = h.length <= 4 ? [...h].map((c) => c + c).join('') : h;
    if (x.length !== 6 && x.length !== 8) return null;
    return { r: parseInt(x.slice(0, 2), 16), g: parseInt(x.slice(2, 4), 16), b: parseInt(x.slice(4, 6), 16), a: x.length === 8 ? parseInt(x.slice(6, 8), 16) / 255 : 1 };
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  return null;
}

const toLin = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const fromLin = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

function toOklab({ r, g, b }: Rgba): [number, number, number] {
  const R = toLin(r);
  const G = toLin(g);
  const B = toLin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function fromOklab([L, A, Bb]: [number, number, number], a: number): Rgba {
  const l = (L + 0.3963377774 * A + 0.2158037573 * Bb) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * Bb) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * Bb) ** 3;
  const R = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const G = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const B = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const clamp = (v: number) => Math.min(255, Math.max(0, fromLin(Math.min(1, Math.max(0, v)))));
  return { r: clamp(R), g: clamp(G), b: clamp(B), a };
}

/** color-mix(in <space>, c1 p1, c2 p2) with premultiplied alpha (CSS Color 5). */
export function mix(space: 'srgb' | 'oklab', c1: Rgba, p1: number, c2: Rgba, p2: number): Rgba {
  const sum = p1 + p2;
  const w1 = p1 / sum;
  const w2 = p2 / sum;
  const alphaScale = Math.min(1, sum);
  const a = c1.a * w1 + c2.a * w2;
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  if (space === 'srgb') {
    const ch = (k: 'r' | 'g' | 'b') => (c1[k] * c1.a * w1 + c2[k] * c2.a * w2) / a;
    return { r: ch('r'), g: ch('g'), b: ch('b'), a: a * alphaScale };
  }
  const o1 = toOklab(c1);
  const o2 = toOklab(c2);
  const ch = (i: number) => (o1[i] * c1.a * w1 + o2[i] * c2.a * w2) / a;
  return fromOklab([ch(0), ch(1), ch(2)], a * alphaScale);
}

/** Composite `top` over an opaque `bottom`. */
export function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a;
  return { r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a), a: 1 };
}

export function luminance(c: Rgba): number {
  return 0.2126 * toLin(c.r) + 0.7152 * toLin(c.g) + 0.0722 * toLin(c.b);
}

export function contrast(fg: Rgba, bg: Rgba): number {
  const solidBg = bg.a < 1 ? over(bg, { r: 255, g: 255, b: 255, a: 1 }) : bg;
  const solidFg = fg.a < 1 ? over(fg, solidBg) : fg;
  const l1 = luminance(solidFg);
  const l2 = luminance(solidBg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

export const hex = (c: Rgba) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('') + (c.a < 1 ? ` @${c.a.toFixed(2)}` : '');
