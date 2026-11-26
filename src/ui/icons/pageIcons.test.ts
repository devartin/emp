/// <reference types="node" />
/**
 * Icon data contract: the emoji map is a flat {emoji: lucide-name} object with NFC keys and no variation selectors
 * (the Rust lane include_str!s this exact file), every name is a real lucide-react icon, the curated set has ~120
 * unique glyphs in 8 groups, the registry covers both, and nothing maps to a Sparkle.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { GLYPHS } from "./glyphs";
import { emojiToGlyph, glyphName } from "./Icon";
import { PAGE_ICON_GROUPS, PAGE_ICON_NAMES, searchPageIcons } from "./pageIcons";

const LUCIDE = new Set(
  readdirSync("node_modules/lucide-react/dist/esm/icons")
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => f.slice(0, -4)),
);
const MAP = JSON.parse(readFileSync("src/ui/icons/emoji-map.json", "utf8")) as Record<string, unknown>;

describe("emoji-map.json", () => {
  test("is a flat object of strings with NFC keys and no variation selectors", () => {
    expect(Array.isArray(MAP)).toBe(false);
    for (const [k, v] of Object.entries(MAP)) {
      expect(typeof v, k).toBe("string");
      expect(k.normalize("NFC"), k).toBe(k);
      expect(/[︎️]/.test(k), k).toBe(false);
    }
    expect(Object.keys(MAP).length).toBeGreaterThanOrEqual(150);
  });

  test("every target is a real lucide icon, in the registry, and never a sparkle", () => {
    for (const v of Object.values(MAP) as string[]) {
      expect(LUCIDE.has(v), v).toBe(true);
      expect(GLYPHS[v], v).toBeTruthy();
      expect(/sparkle/.test(v), v).toBe(false);
    }
  });

  test("seed and Notion defaults resolve", () => {
    expect(emojiToGlyph("👋")).toBe("hand");
    expect(emojiToGlyph("✈️")).toBe("plane");
    expect(emojiToGlyph("📖")).toBe("book-open");
    expect(emojiToGlyph("🏃‍♀️")).toBe("person-standing");
    expect(emojiToGlyph("🦄")).toBeNull();
    expect(glyphName({ t: "emoji", v: "🚀" })).toBe("rocket");
    expect(glyphName({ t: "lucide", v: "plane" })).toBe("plane");
  });
});

describe("pageIcons", () => {
  test("~120 unique, real glyphs in 8 groups, all in the registry", () => {
    expect(PAGE_ICON_GROUPS).toHaveLength(8);
    expect(new Set(PAGE_ICON_NAMES).size).toBe(PAGE_ICON_NAMES.length);
    expect(PAGE_ICON_NAMES.length).toBeGreaterThanOrEqual(110);
    expect(PAGE_ICON_NAMES.length).toBeLessThanOrEqual(150);
    for (const n of PAGE_ICON_NAMES) {
      expect(LUCIDE.has(n), n).toBe(true);
      expect(GLYPHS[n], n).toBeTruthy();
      expect(/sparkle/.test(n), n).toBe(false);
    }
  });

  test("search matches names, keywords and groups", () => {
    expect(searchPageIcons("").length).toBe(8);
    expect(searchPageIcons("trip").flatMap((g) => g.icons.map((i) => i.name))).toContain("plane");
    expect(searchPageIcons("money").length).toBeGreaterThan(0);
    expect(searchPageIcons("zzzz")).toEqual([]);
  });

  test("the registry holds exactly the curated set plus the map targets", () => {
    const want = new Set(["file-text", "search", ...PAGE_ICON_NAMES, ...(Object.values(MAP) as string[])]);
    expect(new Set(Object.keys(GLYPHS))).toEqual(want);
  });
});
