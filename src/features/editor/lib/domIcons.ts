/** Lucide glyphs for plain-DOM node views (built with createElementNS, never innerHTML — §9.15). */
type IconNode = [string, Record<string, string>][];

const ICONS = {
  chevronRight: [['path', { d: 'm9 18 6-6-6-6' }]],
  chevronDown: [['path', { d: 'm6 9 6 6 6-6' }]],
  check: [['path', { d: 'M20 6 9 17l-5-5' }]],
  fileText: [
    ['path', { d: 'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z' }],
    ['path', { d: 'M14 2v5a1 1 0 0 0 1 1h5' }],
    ['path', { d: 'M10 9H8' }],
    ['path', { d: 'M16 13H8' }],
    ['path', { d: 'M16 17H8' }],
  ],
  file: [
    ['path', { d: 'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z' }],
    ['path', { d: 'M14 2v5a1 1 0 0 0 1 1h5' }],
  ],
  arrowUpRight: [['path', { d: 'M7 7h10v10' }], ['path', { d: 'M7 17 17 7' }]],
  calendar: [['path', { d: 'M8 2v3' }], ['path', { d: 'M16 2v3' }], ['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }], ['path', { d: 'M3 9h18' }]],
  copy: [['rect', { width: '14', height: '14', x: '8', y: '8', rx: '2', ry: '2' }], ['path', { d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' }]],
  paperclip: [['path', { d: 'm16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551' }]],
  download: [['path', { d: 'M12 15V3' }], ['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }], ['path', { d: 'm7 10 5 5 5-5' }]],
  bell: [['path', { d: 'M10.268 21a2 2 0 0 0 3.464 0' }], ['path', { d: 'M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326' }]],
  listTree: [['path', { d: 'M8 5h13' }], ['path', { d: 'M13 12h8' }], ['path', { d: 'M13 19h8' }], ['path', { d: 'M3 10a2 2 0 0 0 2 2h3' }], ['path', { d: 'M3 5v12a2 2 0 0 0 2 2h3' }]],
  upload: [['path', { d: 'M12 3v12' }], ['path', { d: 'm17 8-5-5-5 5' }], ['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }]],
  wrap: [['path', { d: 'M3 6h18' }], ['path', { d: 'M3 12h15a3 3 0 1 1 0 6h-4' }], ['path', { d: 'm16 16-2 2 2 2' }], ['path', { d: 'M3 18h7' }]],
  plus: [['path', { d: 'M5 12h14' }], ['path', { d: 'M12 5v14' }]],
  trash: [['path', { d: 'M3 6h18' }], ['path', { d: 'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6' }], ['path', { d: 'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2' }]],
} satisfies Record<string, IconNode>;

export type DomIconName = keyof typeof ICONS;

const NS = 'http://www.w3.org/2000/svg';

export function domIcon(name: DomIconName, size = 16, strokeWidth = 1.75): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeWidth));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of ICONS[name] as IconNode) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
  }
  return svg;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, attrs: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
