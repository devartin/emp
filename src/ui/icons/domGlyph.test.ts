/**
 * glyphSvg builds node-view glyphs from the icon's own data (no React render, so it works inside a lifecycle). The
 * spec it builds from must match what lucide-react renders for the same glyph, size and stroke.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { glyphSpec } from "./domGlyph";
import { GLYPHS } from "./glyphs";

const attr = (html: string, name: string) => html.match(new RegExp(`<svg[^>]*\\s${name}="([^"]*)"`))?.[1];

describe("glyphSpec", () => {
  test("matches lucide-react's render for every registered glyph", () => {
    for (const [name, G] of Object.entries(GLYPHS)) {
      const spec = glyphSpec(name, "row");
      expect(spec, name).not.toBeNull();
      const html = renderToStaticMarkup(createElement(G, { size: 16, strokeWidth: 1.25, absoluteStrokeWidth: true }));
      expect(Number(spec!.attrs["stroke-width"]), name).toBeCloseTo(Number(attr(html, "stroke-width")), 6);
      expect(spec!.attrs.viewBox, name).toBe(attr(html, "viewBox"));
      expect(spec!.attrs.width, name).toBe(attr(html, "width"));
      // every child path / shape, in order
      const tags = [...html.matchAll(/<(path|circle|rect|line|polyline|polygon|ellipse)\b/g)].map((m) => m[1]);
      expect(spec!.node.map(([t]) => t), name).toEqual(tags);
    }
  });

  test("header context is 40px at a 1.75 stroke; unknown names are null", () => {
    const spec = glyphSpec("file-text", "header");
    expect(spec?.attrs.width).toBe("40");
    expect(Number(spec?.attrs["stroke-width"])).toBeCloseTo((1.75 * 24) / 40, 6);
    expect(glyphSpec("not-a-glyph")).toBeNull();
  });
});
