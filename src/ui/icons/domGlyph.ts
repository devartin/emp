/**
 * Lucide glyphs for plain-DOM node views (editor callouts, page links): the same registry and sizes as <Glyph>,
 * rendered once per (name, size, stroke) through React into a detached node and cloned from a cache afterwards.
 * Synchronous, no innerHTML. Returns null for names outside the registry.
 */
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { Icon } from "@/backend/types";
import { GLYPHS } from "./glyphs";
import { glyphName, type GlyphContext } from "./Icon";

const SIZE: Record<GlyphContext, { size: number; stroke: number }> = {
  row: { size: 16, stroke: 1.25 },
  inline: { size: 14, stroke: 1.25 },
  header: { size: 40, stroke: 1.75 },
};

const cache = new Map<string, SVGSVGElement>();

/** An SVG element for a registered glyph name, or null. */
export function glyphSvg(name: string, context: GlyphContext = "inline", size?: number): SVGSVGElement | null {
  const G = GLYPHS[name];
  if (!G || typeof document === "undefined") return null;
  const s = SIZE[context];
  const px = size ?? s.size;
  const key = `${name}|${px}|${s.stroke}`;
  let svg = cache.get(key);
  if (!svg) {
    const host = document.createElement("div");
    const root = createRoot(host);
    flushSync(() => root.render(createElement(G, { size: px, strokeWidth: s.stroke, absoluteStrokeWidth: true, "aria-hidden": true })));
    const made = host.querySelector("svg");
    root.unmount();
    if (!made) return null;
    svg = made;
    cache.set(key, svg);
  }
  return svg.cloneNode(true) as SVGSVGElement;
}

/** An SVG element for an Icon (lucide, or a legacy emoji through the map), or null when it has no glyph. */
export function iconSvg(icon: Icon | null | undefined, context: GlyphContext = "inline", size?: number): SVGSVGElement | null {
  const name = glyphName(icon);
  return name ? glyphSvg(name, context, size) : null;
}
