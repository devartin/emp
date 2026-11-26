import { describe, expect, it } from "vitest";
import { spanLabel, summarizeSeries } from "./a11y";

const short = (v: unknown) => String(v).slice(5, 7);

describe("spanLabel", () => {
  it("names both years when the range crosses a year boundary", () => {
    const s = spanLabel("2025-12-31", "2026-11-30", short);
    expect(s).toContain("2025");
    expect(s).toContain("2026");
    expect(s).toContain(" to ");
  });
  it("keeps the day for daily data within one month and never repeats one label", () => {
    const s = spanLabel("2026-11-01", "2026-11-26", short);
    expect(s).toMatch(/1/);
    expect(s).toMatch(/26/);
    expect(s).toContain("2026");
    const parts = s.split(" to ");
    expect(parts[0]).not.toBe(parts[1]);
  });
  it("collapses an identical range to one date", () => {
    expect(spanLabel("2026-11-26", "2026-11-26", short)).not.toContain(" to ");
  });
  it("falls back to the axis format for non-dates", () => {
    expect(spanLabel("a", "b", (v) => String(v).toUpperCase())).toBe("A to B");
  });
});

describe("summarizeSeries", () => {
  it("uses the span when given", () => {
    const s = summarizeSeries("Net worth", [1, 2], String, undefined, undefined, spanLabel("2025-12", "2026-11", short));
    expect(s).toMatch(/^Net worth from .*2025.* to .*2026/);
  });
});
