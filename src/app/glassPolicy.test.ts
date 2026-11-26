import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  EMPTY_LOG,
  FAIL_SESSIONS,
  STRIKE_TTL_MS,
  VERDICT_TTL_MS,
  decideGlass,
  isLinuxUserAgent,
  mergeGlassFields,
  parseKvPref,
  readGlassFields,
  recordProbeResult,
  verdictExpired,
  type GlassInputs,
  type GlassPref,
  type GlassVerdict,
} from "./glassPolicy";

const base: GlassInputs = { pref: "auto", verdict: null, linux: false, reducedTransparency: false, effectsReduced: false };

describe("decideGlass", () => {
  it("On forces glass everywhere, even on Linux with a failed probe or reduced transparency", () => {
    for (const linux of [false, true])
      for (const reducedTransparency of [false, true]) {
        const d = decideGlass({ ...base, pref: "on", linux, reducedTransparency, verdict: "failed" });
        expect(d).toEqual({ glass: "on", status: "forced-on", probe: false });
      }
  });

  it("Off turns glass off everywhere", () => {
    expect(decideGlass({ ...base, pref: "off" })).toEqual({ glass: "off", status: "forced-off", probe: false });
    expect(decideGlass({ ...base, pref: "off", linux: true })).toMatchObject({ glass: "off", probe: false });
  });

  it("Auto on macOS/Windows is on without probing", () => {
    expect(decideGlass(base)).toEqual({ glass: "on", status: "auto-on", probe: false });
  });

  it("Auto respects reduced transparency and reduced effects before anything else", () => {
    expect(decideGlass({ ...base, reducedTransparency: true })).toMatchObject({ glass: "off", status: "auto-os" });
    expect(decideGlass({ ...base, linux: true, reducedTransparency: true })).toMatchObject({ glass: "off", status: "auto-os", probe: false });
    expect(decideGlass({ ...base, effectsReduced: true })).toMatchObject({ glass: "off", status: "auto-effects" });
    expect(decideGlass({ ...base, linux: true, effectsReduced: true })).toMatchObject({ glass: "off", probe: false });
  });

  it("Auto on Linux probes with glass on, then follows the verdict", () => {
    expect(decideGlass({ ...base, linux: true })).toEqual({ glass: "on", status: "auto-probing", probe: true });
    expect(decideGlass({ ...base, linux: true, verdict: "failed" })).toEqual({ glass: "off", status: "auto-stepped-down", probe: false });
    expect(decideGlass({ ...base, linux: true, passed: true })).toEqual({ glass: "on", status: "auto-passed", probe: false });
    expect(decideGlass({ ...base, linux: true, sessionFailed: true })).toEqual({ glass: "off", status: "auto-session-off", probe: false });
  });

  it("a session step-down only applies to Auto on Linux", () => {
    expect(decideGlass({ ...base, pref: "on", linux: true, sessionFailed: true })).toMatchObject({ glass: "on", status: "forced-on" });
    expect(decideGlass({ ...base, sessionFailed: true })).toMatchObject({ glass: "on", status: "auto-on" });
    expect(decideGlass({ ...base, linux: true, sessionFailed: true, reducedTransparency: true })).toMatchObject({ status: "auto-os" });
  });

  it("A stale verdict doesn't affect non-Linux", () => {
    expect(decideGlass({ ...base, verdict: "failed" })).toMatchObject({ glass: "on", status: "auto-on" });
  });
});

describe("isLinuxUserAgent", () => {
  it("matches desktop Linux (Chromium, WebKitGTK) but not Android, macOS or Windows", () => {
    expect(isLinuxUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0 Safari/537.36")).toBe(true);
    expect(isLinuxUserAgent("Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15")).toBe(true);
    expect(isLinuxUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36")).toBe(false);
    expect(isLinuxUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)")).toBe(false);
    expect(isLinuxUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36")).toBe(false);
  });
});

describe("boot cache fields", () => {
  it("reads defaults from missing or invalid values", () => {
    expect(readGlassFields(null)).toEqual({ pref: "auto", verdict: null, log: EMPTY_LOG });
    expect(readGlassFields({ glass: "maybe", glassProbe: "passed", glassLog: "x" })).toEqual({ pref: "auto", verdict: null, log: EMPTY_LOG });
    expect(readGlassFields({ glass: "off", glassProbe: "failed" })).toEqual({ pref: "off", verdict: "failed", log: EMPTY_LOG });
    expect(readGlassFields({ glassLog: { strikes: 1.7, lastFail: 5, passes: -2, lastPass: "x", failedVersion: 3 } }).log).toEqual({ ...EMPTY_LOG, strikes: 1, lastFail: 5 });
  });

  it("merges without touching the five bootPrefs keys", () => {
    const raw = JSON.stringify({ theme: "dark", accent: "jade", motion: "system", density: "compact", textSize: "l" });
    const out = mergeGlassFields(raw, { pref: "on", verdict: null });
    expect(JSON.parse(out as string)).toEqual({ theme: "dark", accent: "jade", motion: "system", density: "compact", textSize: "l", glass: "on" });
  });

  it("omits defaults and drops stale fields", () => {
    const raw = JSON.stringify({ theme: "light", glass: "on", glassProbe: "failed" });
    expect(JSON.parse(mergeGlassFields(raw, { pref: "auto", verdict: null }) as string)).toEqual({ theme: "light" });
    expect(JSON.parse(mergeGlassFields(raw, { pref: "auto", verdict: "failed" }) as string)).toEqual({ theme: "light", glassProbe: "failed" });
  });

  it("writes the probe log only when it has content, and keeps it when omitted", () => {
    const raw = JSON.stringify({ theme: "light", glassLog: { strikes: 1, lastFail: 9 } });
    expect(JSON.parse(mergeGlassFields(raw, { pref: "on", verdict: null }) as string)).toEqual({ theme: "light", glass: "on", glassLog: { strikes: 1, lastFail: 9 } });
    expect(JSON.parse(mergeGlassFields(raw, { pref: "auto", verdict: null, log: EMPTY_LOG }) as string)).toEqual({ theme: "light" });
    expect(mergeGlassFields(null, { pref: "auto", verdict: null, log: EMPTY_LOG })).toBeNull();
    expect(JSON.parse(mergeGlassFields(null, { pref: "auto", verdict: null, log: { ...EMPTY_LOG, passes: 1, lastPass: 2 } }) as string)).toEqual({ glassLog: { ...EMPTY_LOG, passes: 1, lastPass: 2 } });
  });

  it("reports no-op merges so callers skip the write", () => {
    const raw = JSON.stringify({ theme: "light", glass: "off" });
    expect(mergeGlassFields(raw, { pref: "off", verdict: null })).toBeNull();
    expect(mergeGlassFields(null, { pref: "auto", verdict: null })).toBeNull();
  });

  it("restores fields after a whitelisting rewrite and survives corrupt JSON", () => {
    // writeBootPrefs() keeps only five keys; the controller re-merges.
    const stripped = JSON.stringify({ theme: "dark", accent: "graphite", motion: "system", density: "comfortable", textSize: "m" });
    const log = { ...EMPTY_LOG, strikes: 1, lastFail: 1000, passes: 3, lastPass: 500 };
    expect(readGlassFields(JSON.parse(mergeGlassFields(stripped, { pref: "auto", verdict: "failed", log }) as string))).toEqual({ pref: "auto", verdict: "failed", log });
    expect(JSON.parse(mergeGlassFields("{not json", { pref: "off", verdict: null }) as string)).toEqual({ glass: "off" });
  });

  it("parses kv values", () => {
    expect(parseKvPref({ pref: "on" })).toBe("on");
    expect(parseKvPref("off")).toBe("off");
    expect(parseKvPref({ pref: "sometimes" })).toBeNull();
    expect(parseKvPref(null)).toBeNull();
  });
});

describe("probe outcomes across sessions", () => {
  const DAY = 24 * 3600 * 1000;
  const T0 = Date.UTC(2026, 10, 26);

  it("one bad session steps down for that session only; the next session measures again", () => {
    const s1 = recordProbeResult(EMPTY_LOG, "exceeded", T0, "1.0.0");
    expect(FAIL_SESSIONS).toBe(2);
    expect(s1).toMatchObject({ verdict: null, sessionFailed: true, log: { strikes: 1, lastFail: T0 } });
    // Next launch: nothing persisted → boot and Auto resolve to glass on, probing.
    expect(decideGlass({ ...base, linux: true, verdict: s1.verdict })).toMatchObject({ glass: "on", status: "auto-probing" });
  });

  it("a second consecutive bad session persists the step-down, stamped with time and version", () => {
    const s1 = recordProbeResult(EMPTY_LOG, "exceeded", T0, "1.0.0");
    const s2 = recordProbeResult(s1.log, "exceeded", T0 + DAY, "1.0.0");
    expect(s2).toMatchObject({ verdict: "failed", sessionFailed: false, log: { strikes: 2, failedAt: T0 + DAY, failedVersion: "1.0.0" } });
  });

  it("a clean session in between clears the strikes", () => {
    const s1 = recordProbeResult(EMPTY_LOG, "exceeded", T0, "1.0.0");
    const p = recordProbeResult(s1.log, "passed", T0 + DAY, "1.0.0");
    expect(p).toMatchObject({ verdict: null, sessionFailed: false, log: { strikes: 0, passes: 1, lastPass: T0 + DAY } });
    expect(recordProbeResult(p.log, "exceeded", T0 + 2 * DAY, "1.0.0")).toMatchObject({ verdict: null, sessionFailed: true, log: { strikes: 1 } });
  });

  it("an old strike is forgotten", () => {
    const s1 = recordProbeResult(EMPTY_LOG, "exceeded", T0, "1.0.0");
    expect(recordProbeResult(s1.log, "exceeded", T0 + STRIKE_TTL_MS + 1, "1.0.0")).toMatchObject({ verdict: null, sessionFailed: true, log: { strikes: 1 } });
  });

  it("a persisted step-down expires with age or a new app version", () => {
    const log = { ...EMPTY_LOG, strikes: 2, failedAt: T0, failedVersion: "1.0.0" };
    expect(verdictExpired("failed", log, T0 + DAY, "1.0.0")).toBe(false);
    expect(verdictExpired("failed", log, T0 + DAY, "")).toBe(false); // version not known yet
    expect(verdictExpired("failed", log, T0 + DAY, "1.1.0")).toBe(true);
    expect(verdictExpired("failed", log, T0 + VERDICT_TTL_MS + 1, "1.0.0")).toBe(true);
    expect(verdictExpired(null, log, T0 + VERDICT_TTL_MS + 1, "2.0.0")).toBe(false);
    // Unstamped (hand-written / older build): not expired; the controller stamps it.
    expect(verdictExpired("failed", EMPTY_LOG, T0, "1.0.0")).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────── inline boot script parity

const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

function inlineScript(file: string): { text: string; comment: string } {
  const html = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
  const scripts = [...html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)].filter((m) => !/\bsrc=/.test(m[1] ?? ""));
  expect(scripts).toHaveLength(1); // the ONLY inline script (CSP hash)
  const comment = /allowed by CSP hash sha256-([A-Za-z0-9+/=]+)/.exec(html)?.[1] ?? "";
  return { text: scripts[0][2], comment };
}

function runBoot(text: string, opts: { ua: string; boot: Record<string, unknown> | null; reducedTransparency: boolean }) {
  const attrs: Record<string, string> = {};
  const ctx = {
    document: { documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v), style: {} as Record<string, string> } },
    localStorage: { getItem: (k: string) => (k === "emp.boot" && opts.boot ? JSON.stringify(opts.boot) : null) },
    navigator: { userAgent: opts.ua },
    matchMedia: (q: string) => ({ matches: q === "(prefers-reduced-transparency: reduce)" ? opts.reducedTransparency : false }),
  };
  (ctx as Record<string, unknown>).window = ctx;
  runInNewContext(text, ctx);
  return attrs;
}

describe.each(["index.html", "ui-gallery.html"])("inline boot script in %s", (file) => {
  const { text, comment } = inlineScript(file);

  it("carries the right CSP hash comment", () => {
    expect(comment).toBe(createHash("sha256").update(text).digest("base64"));
  });

  it("resolves data-glass exactly like decideGlass for every OS × setting × verdict × reduced transparency", () => {
    const prefs: (GlassPref | undefined)[] = [undefined, "auto", "on", "off"];
    const verdicts: GlassVerdict[] = [null, "failed"];
    for (const ua of [LINUX_UA, MAC_UA])
      for (const p of prefs)
        for (const v of verdicts)
          for (const reducedTransparency of [false, true]) {
            const boot: Record<string, unknown> = { theme: "dark" };
            if (p) boot.glass = p;
            if (v) boot.glassProbe = v;
            const attrs = runBoot(text, { ua, boot, reducedTransparency });
            const want = decideGlass({ pref: p ?? "auto", verdict: v, linux: ua === LINUX_UA, reducedTransparency, effectsReduced: reducedTransparency });
            expect({ ua: ua === LINUX_UA ? "linux" : "mac", p, v, reducedTransparency, glass: attrs["data-glass"] }).toEqual({ ua: ua === LINUX_UA ? "linux" : "mac", p, v, reducedTransparency, glass: want.glass });
            expect(attrs["data-effects"]).toBe(reducedTransparency ? "reduced" : "full");
            expect(attrs["data-theme"]).toBe("dark");
          }
  });

  it("boots with glass on (probing) on Linux with no cache, and on elsewhere", () => {
    expect(runBoot(text, { ua: LINUX_UA, boot: null, reducedTransparency: false })["data-glass"]).toBe("on");
    expect(runBoot(text, { ua: MAC_UA, boot: null, reducedTransparency: false })["data-glass"]).toBe("on");
  });
});
