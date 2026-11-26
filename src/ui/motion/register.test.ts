/// <reference types="node" />
/**
 * Motion register lint (PROGRAMME-v3 K3): every registered animation sits inside its class budget, only the three
 * signature moments are C3, the kit's CSS never runs a finite animation or transition longer than 600ms, no curve
 * overshoots, numbers never roll on arrival, and Kbd chips only answer full-chord matches.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { chordOf, eventChord, specChord } from "./keycaps";
import { CLASSES, REGISTER, SIGNATURE_MOMENTS } from "./register";
import { RollingNumber } from "./RollingNumber";
import { spring } from "./tokens";

const KIT_CSS = ["src/styles/components.css", "src/styles/material.css", "src/styles/theme.css", "src/styles/tokens.css"];

const ms = (v: string) => (v.endsWith("ms") ? parseFloat(v) : parseFloat(v) * 1000);

describe("motion register", () => {
  test("every entry is inside its class budget", () => {
    const over = Object.entries(REGISTER).filter(([, e]) => e.in > CLASSES[e.cls].maxIn || e.out > CLASSES[e.cls].maxOut);
    expect(over.map(([k]) => k)).toEqual([]);
  });

  test("exactly three signature moments", () => {
    const c3 = Object.entries(REGISTER)
      .filter(([, e]) => e.cls === "C3")
      .map(([k]) => k)
      .sort();
    expect(c3).toEqual([...SIGNATURE_MOMENTS].sort());
  });

  test("no curve in the JS table overshoots (all ease-out tweens)", () => {
    for (const [name, t] of Object.entries(spring)) {
      expect(t.type, name).toBe("tween");
      expect(t.duration, name).toBeLessThanOrEqual(0.25);
    }
  });

  test("kit CSS: finite animations and transitions are ≤ 600ms; --dur-* tokens are ≤ 600ms; no linear() springs", () => {
    const bad: string[] = [];
    for (const f of KIT_CSS) {
      const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of src.matchAll(/(?:^|[;{\s])(animation|transition)(?:-duration)?\s*:\s*([^;}]+)/g)) {
        if (/\binfinite\b/.test(m[2])) continue;
        for (const d of m[2].matchAll(/(?<![\w.-])(\d*\.?\d+)(ms|s)\b/g)) if (ms(d[0]) > 600) bad.push(`${f}: ${m[0].trim()}`);
      }
      for (const m of src.matchAll(/--dur-[\w-]+\s*:\s*(\d*\.?\d+)(ms|s)\b/g)) if (ms(`${m[1]}${m[2]}`) > 600) bad.push(`${f}: ${m[0]}`);
      if (/linear\(\s*0\s*,\s*0\.0/.test(src)) bad.push(`${f}: a linear() spring curve`);
    }
    expect(bad).toEqual([]);
  });

  test("RollingNumber: the final value is plain DOM text on the first render (no count-up, no overlay)", () => {
    const html = renderToStaticMarkup(createElement(RollingNumber, { value: 1201, format: (n: number) => n.toLocaleString("en-US"), countUp: true }));
    expect(html).toContain('<span class="emp-roll-value">1,201</span>');
    expect(html).not.toContain("emp-roll-overlay");
    expect(html).not.toContain("aria-hidden");
  });
});

describe("Kbd chips answer full chords only", () => {
  const ev = (key: string, code: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) =>
    ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

  test("a bare letter never matches a modified hint", () => {
    expect(eventChord(ev("k", "KeyK"))).toBe("k");
    expect(eventChord(ev("k", "KeyK"))).not.toBe(specChord("mod+k"));
  });

  test("the full chord matches (Ctrl on Linux / Windows is mod)", () => {
    expect(eventChord(ev("k", "KeyK", { ctrlKey: true }))).toBe(specChord("mod+k"));
    expect(eventChord(ev("L", "KeyL", { ctrlKey: true, shiftKey: true }))).toBe(specChord("mod+shift+l"));
  });

  test("modifier-only presses and symbol shifts", () => {
    expect(eventChord(ev("Shift", "ShiftLeft", { shiftKey: true }))).toBeNull();
    expect(eventChord(ev("?", "Slash", { shiftKey: true }))).toBe(chordOf(["?"]));
    expect(specChord("esc")).toBe("esc");
  });
});
