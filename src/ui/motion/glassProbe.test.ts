import { describe, expect, it } from "vitest";
import { GLASS_OVERLAY_SELECTOR, animationTouchesGlass, createFrameBudget, estimateRefresh, holdsGlass, insideGlass, mutationTouchesGlass } from "./glassProbe";

const R = 1000 / 60;

/** Feed `n` frames where every `everyNth` frame takes `slow` refresh intervals. */
function feed(b: ReturnType<typeof createFrameBudget>, n: number, everyNth = 0, slow = 2) {
  const events: string[] = [];
  for (let i = 1; i <= n; i++) {
    const ev = b.sample(everyNth && i % everyNth === 0 ? R * slow : R, R);
    if (ev !== "none") events.push(ev);
  }
  return events;
}

describe("createFrameBudget", () => {
  it("counts drops like lib/perf.ts (interval > 1.5× refresh; n-1 frames lost)", () => {
    const b = createFrameBudget({ windowFrames: 1000 });
    b.sample(R, R);
    b.sample(R * 1.4, R); // within tolerance
    b.sample(R * 3, R); // 2 dropped
    expect(b.state()).toMatchObject({ frames: 5, dropped: 2 });
  });

  it("skips long tasks (≥ 100ms) — chunk loads and mounts are not glass cost", () => {
    const b = createFrameBudget({ windowFrames: 1000 });
    b.sample(250, R);
    b.sample(100, R);
    expect(b.state()).toMatchObject({ frames: 0, dropped: 0 });
  });

  it("smooth frames pass after 6 clean windows", () => {
    const b = createFrameBudget();
    const events = feed(b, 60 * 6);
    expect(events).toEqual(["window-good", "window-good", "window-good", "window-good", "window-good", "passed"]);
    expect(b.state().done).toBe("passed");
    expect(b.sample(R * 10, R)).toBe("none"); // finished: ignores further input
  });

  it("exceeds after 2 consecutive bad windows (> 10% dropped)", () => {
    const b = createFrameBudget();
    // every 4th frame takes 2 intervals → 1 dropped per 5 counted frames = 20%
    const events = feed(b, 200, 4);
    expect(events).toEqual(["window-bad", "exceeded"]);
    expect(b.state().done).toBe("exceeded");
  });

  it("a clean window between bad ones resets the streak", () => {
    const b = createFrameBudget();
    expect(b.addWindow(60, 12)).toBe("window-bad");
    expect(b.addWindow(60, 3)).toBe("window-good");
    expect(b.addWindow(60, 12)).toBe("window-bad");
    expect(b.addWindow(60, 12)).toBe("exceeded");
  });

  it("exactly 10% is within budget", () => {
    const b = createFrameBudget();
    expect(b.addWindow(60, 6)).toBe("window-good");
    expect(b.addWindow(60, 7)).toBe("window-bad");
  });

  it("reset clears everything", () => {
    const b = createFrameBudget();
    b.addWindow(60, 30);
    b.addWindow(60, 30);
    b.reset();
    expect(b.state()).toMatchObject({ windows: 0, badStreak: 0, done: null });
    expect(b.addWindow(60, 0)).toBe("window-good");
  });
});

describe("estimateRefresh", () => {
  it("finds 60 and 120 Hz despite a few janky frames", () => {
    const at60 = Array.from({ length: 60 }, (_, i) => (i % 7 === 0 ? 40 : 16.7));
    expect(estimateRefresh(at60)).toBeCloseTo(16.7, 1);
    const at120 = Array.from({ length: 60 }, (_, i) => (i % 9 === 0 ? 25 : 8.33));
    expect(estimateRefresh(at120)).toBeCloseTo(8.33, 1);
  });

  it("falls back to 60 Hz with too few samples and ignores long tasks", () => {
    expect(estimateRefresh([16, 300])).toBeCloseTo(1000 / 60, 3);
    expect(estimateRefresh(Array.from({ length: 30 }, () => 500))).toBeCloseTo(1000 / 60, 3);
  });
});

/** Minimal element: `glass` = is a glass layer; `inGlass` = has a glass ancestor; `holds` = has a glass descendant. */
function el({ glass = false, inGlass = false, holds = false, ignored = false } = {}) {
  return {
    closest: (sel: string) => (sel === GLASS_OVERLAY_SELECTOR ? (glass || inGlass ? {} : null) : sel === "[data-glass-probe-ignore]" && ignored ? {} : null),
    matches: (sel: string) => sel === GLASS_OVERLAY_SELECTOR && glass,
    querySelector: (sel: string) => (sel === GLASS_OVERLAY_SELECTOR && holds ? {} : null),
  };
}
const text = { nodeType: 3 };

describe("what wakes the probe", () => {
  it("toasts are not glass overlays for the probe", () => {
    expect(GLASS_OVERLAY_SELECTOR).not.toContain("emp-toast");
  });

  it("only mutations that (un)mount a glass layer or change one count — not route renders", () => {
    const page = el();
    const routeRender = { target: page, addedNodes: [el(), text], removedNodes: [el()] };
    expect(mutationTouchesGlass(routeRender)).toBe(false);
    expect(mutationTouchesGlass({ target: page, addedNodes: [el({ glass: true })], removedNodes: [] })).toBe(true); // menu portal mounted
    expect(mutationTouchesGlass({ target: page, addedNodes: [], removedNodes: [el({ holds: true })] })).toBe(true); // dialog wrapper unmounted
    expect(mutationTouchesGlass({ target: el({ inGlass: true }), addedNodes: [text], removedNodes: [] })).toBe(true); // palette results changed
    expect(mutationTouchesGlass({ target: el({ inGlass: true }), addedNodes: [], removedNodes: [] })).toBe(false);
    expect(mutationTouchesGlass({ target: page, addedNodes: [el({ glass: true, ignored: true })], removedNodes: [] })).toBe(false);
  });

  it("input only counts inside an open glass layer", () => {
    expect(insideGlass(el({ inGlass: true }))).toBe(true);
    expect(insideGlass(el())).toBe(false);
    expect(insideGlass(window_like())).toBe(false);
    expect(insideGlass(null)).toBe(false);
  });

  it("animations count on, inside or around a glass layer, not elsewhere on the page", () => {
    expect(animationTouchesGlass(el({ glass: true }))).toBe(true);
    expect(animationTouchesGlass(el({ inGlass: true }))).toBe(true);
    expect(animationTouchesGlass(el({ holds: true }))).toBe(true);
    expect(animationTouchesGlass(el())).toBe(false); // spinner / shimmer on the page
    expect(animationTouchesGlass(null)).toBe(false);
    expect(holdsGlass(el({ holds: true, ignored: true }))).toBe(false);
  });
});

/** An event target that isn't an element (window / document). */
function window_like() {
  return { addEventListener() {} };
}
