/**
 * Lucide glyphs for plain-DOM node views (editor callouts, page links): the same registry and sizes as <Glyph>,
 * built once per (name, size, stroke) and cloned from a cache afterwards. Synchronous, no innerHTML, and no React
 * render: the SVG is built from the icon's own node data with createElementNS, so it is safe to call from inside a
 * React lifecycle or a ProseMirror node view (a flushSync render there is deferred and returned nothing).
 * There is no React fallback. Returns null for names outside the registry.
 */
import type { Icon } from "@/backend/types";
import { GLYPHS } from "./glyphs";
import { canonicalGlyph, glyphName, type GlyphContext } from "./Icon";

const SIZE: Record<GlyphContext, { size: number; stroke: number }> = {
  row: { size: 16, stroke: 1.25 },
  inline: { size: 14, stroke: 1.25 },
  header: { size: 40, stroke: 1.75 },
};

const SVG_NS = "http://www.w3.org/2000/svg";
type IconElement = [string, Record<string, string | number>, IconElement[]?];
type IconNode = IconElement[];
interface IconData {
  name?: string;
  size?: number;
  node: IconNode;
}

const cache = new Map<string, SVGSVGElement>();

/**
 * The icon's node data. A lucide-react icon is a forwardRef whose render function only wraps its data in an element
 * (no hooks), so calling it is pure.
 */
function iconData(G: unknown): IconData | null {
  const render = (G as { render?: (props: object, ref: null) => { props?: { icon?: IconData } } | null }).render;
  if (typeof render !== "function") return null;
  try {
    const icon = render({}, null)?.props?.icon;
    return icon && Array.isArray(icon.node) ? icon : null;
  } catch {
    return null;
  }
}

function appendNodes(parent: Element, nodes: IconNode) {
  for (const [tag, attrs, children] of nodes) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (k !== "key") el.setAttribute(k, String(v));
    if (children?.length) appendNodes(el, children);
    parent.appendChild(el);
  }
}

/** The SVG attributes lucide-react's <Icon> sets with `absoluteStrokeWidth`, for this size and stroke. */
function svgAttrs(data: IconData, px: number, stroke: number): Record<string, string> {
  const vb = data.size ?? 24;
  return {
    width: String(px),
    height: String(px),
    viewBox: `0 0 ${vb} ${vb}`,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": String((stroke * vb) / px),
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: data.name ? `lucide lucide-${data.name}` : "lucide",
    "aria-hidden": "true",
  };
}

/** What `glyphSvg` builds, as data (no DOM): the root attributes and the child nodes. Null outside the registry. */
export function glyphSpec(name: string, context: GlyphContext = "inline", size?: number): { attrs: Record<string, string>; node: IconNode } | null {
  const G = GLYPHS[canonicalGlyph(name)];
  const data = G ? iconData(G) : null;
  if (!data) return null;
  const s = SIZE[context];
  return { attrs: svgAttrs(data, size ?? s.size, s.stroke), node: data.node };
}

function buildSvg(data: IconData, px: number, stroke: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries(svgAttrs(data, px, stroke))) svg.setAttribute(k, v);
  appendNodes(svg, data.node);
  return svg;
}

/** An SVG element for a registered glyph name, or null. */
export function glyphSvg(name: string, context: GlyphContext = "inline", size?: number): SVGSVGElement | null {
  name = canonicalGlyph(name);
  const G = GLYPHS[name];
  if (!G || typeof document === "undefined") return null;
  const s = SIZE[context];
  const px = size ?? s.size;
  const key = `${name}|${px}|${s.stroke}`;
  let svg = cache.get(key);
  if (!svg) {
    // Never a React render (no flushSync, no createRoot): safe synchronously from any plain-DOM caller, including
    // ProseMirror node views constructed while React is rendering. domGlyph.test.ts checks every registry glyph
    // exposes its node data, so a null here means a non-lucide entry, which has no glyph.
    const data = iconData(G);
    if (!data) return null;
    svg = buildSvg(data, px, s.stroke);
    cache.set(key, svg);
  }
  return svg.cloneNode(true) as SVGSVGElement;
}

/** An SVG element for an Icon (lucide, or a legacy emoji through the map), or null when it has no glyph. */
export function iconSvg(icon: Icon | null | undefined, context: GlyphContext = "inline", size?: number): SVGSVGElement | null {
  const name = glyphName(icon);
  return name ? glyphSvg(name, context, size) : null;
}
