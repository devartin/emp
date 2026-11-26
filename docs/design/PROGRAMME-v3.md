# Council report: making EMP excellent, and crafted rather than AI-made

**Date:** 2026-11-26 · **Mode:** Explore · **Rounds:** 3 of a possible 4 · **Members:** 6 · **Question:** what are the highest-value improvements to EMP's UI, UX, product features and flows, so that it becomes excellent and feels crafted rather than AI-generated, set out as a prioritised programme agents can build?

This report gives final positions only. Where a member changed their mind, the later round wins, and the change is noted in the Graveyard. Numbers marked **[estimate]** are members' own judgement. **[unverified]** marks claims they could not confirm.

---

## Verdict

**The programme.** EMP gets one coherent five-phase programme, built in parallel file-ownership lanes. The council did not pick a single feature.

| Phase | Work | Builder's estimate |
|---|---|---|
| **P0 Fence** | Guardrails: style and copy ratchets, an emoji lint, a contrast test, a bundle budget and a route-ready mark | 12–16 h |
| **P1 Foundation** | Four lanes: the kit (paper, ink and keys tokens; IBM Plex Sans; money typesetting; icon set), the motion register, truth fixes, and K4's structural deletions | 78–110 h |
| **P2 Structure, then surfaces** | One place per job (sidebar, Home = the day, 5-tab Money HQ, one import dialog, a 3-screen first run, ⌘K hub), then one sweep per area that applies visuals and copy | 52–74 h |
| **P3 Finance loop** | Statement surfacing, honest reconciliation, a review queue triaged by keyboard | 14–20 h |
| **P4 QA** | Final checks, baselines, README | 8–12 h |
| **Total** | | **164–232 agent-hours** [estimate] ([r3_builder](r3_builder.md)) |

**Your rulings are built in.** The council adopts everything you decided between rounds 2 and 3:
- direction A, "paper, ink and keys";
- subtle keys;
- Home = the day;
- earned motion;
- no emoji anywhere in the app ([03_chair_synthesis](03_chair_synthesis.md)).

**Where the council landed.** All six members endorsed the chair's phased plan, each with amendments. They did not agree on a single #1.
- First places split: K2 twice, then K1, K5, K4 and K6 once each.
- The top-3 Borda count puts **motion (K3) first, at 23 points**. It is the only cluster on all six ballots.
- Order matters less than the count suggests, because the phases run as parallel lanes. The disagreement is about emphasis, not about what gets built.

**What to expect** (members' own estimates):
- **Will it stop looking AI-made?**
  - Skeptic: about **65%** that you judge the top 8 screens no longer AI-generated.
  - Craft: about **70%** that it passes a blind check next to Notion and Things.
  - Flow: about **70–80%** of routes reach the bar.
  - Markets, Settings and the gallery are the most likely to stay templated ([r3_skeptic](r3_skeptic.md), [r3_craft](r3_craft.md), [r3_flow](r3_flow.md)).
- **Will it finish on time?**
  - Builder: about **60%** that P0–P2 finish with 5 agents in 5 days, with P3 the likely casualty ([r3_builder](r3_builder.md)).
  - Skeptic: 5–7 agent-days rather than 3–5.
  - Skeptic also puts the chance of a core-flow regression reaching release at about 50% without new end-to-end flows, and about 20% with them ([r3_skeptic](r3_skeptic.md)).
- **Speed.** Median settle time today is 1,259 ms; with reduced motion it is 737 ms ([r2_builder](r2_builder.md)). Members expect it to fall to:
  - ≤ 400 ms (Builder);
  - about 740 ms (Craft);
  - 0.7–0.9 s (Scout).
- **Finance.**
  - Money: about 75% that the pre-tag schema and import fixes land, and about 50% for the review queue ([r3_money](r3_money.md)).
  - Scout: reviewers will still raise sync first ([r3_scout](r3_scout.md)).

**Your first 3 actions**
1. **Start P0 now.** Snap the ratchets to today's counts, then add the copy, emoji and contrast lints, the bundle budget and the `emp:route-ready` mark. Before any hand-off, make Flow's Home spec the source of truth and annotate the parts of `a-home.html` you rejected ([r3_skeptic](r3_skeptic.md)).
2. **Land the pre-tag finance fixes before you tag v0.1.0,** once the parallel team's finance work has merged:
   - add `txn.reviewed` to `money-hq.json` at 1.0.0;
   - make the Rust import write `cleared`, `source` and `reviewed=false`;
   - fix the effective tax rate and `itemizedWouldBe`;
   - add the mock↔desktop parity fixture ([r3_money](r3_money.md)).
3. **Run a one-day IBM Plex Sans spike in the kit lane, with Inter as the fallback.** In the same lane, flip the motion defaults: `countUp` off, route transitions at 0 ms, stagger at 0 ([r3_craft](r3_craft.md), [r2_builder](r2_builder.md)).

---

## Ranked shortlist

**The clusters**
- **K1 Crafted visual system:** tokens, keys, type, money typesetting, icons.
- **K2 Copy and voice.**
- **K3 Motion register.**
- **K4 One place per job:** IA, Home, first run, ⌘K, the interaction contract.
- **K5 Finance truth loop.**
- **K6 Guardrails and performance.**

**Final rubric scores** (out of 65: Q×3, V×3, G×2, F×2, R×2, B×1; all [estimate], from the round-3 files)

| Cluster | Builder | Craft | Flow | Money | Scout | Skeptic | Mean |
|---|---|---|---|---|---|---|---|
| K2 Copy and voice | 56 | 56 | 56 | 56 | 59 | 55 | **56.3** |
| K3 Motion register | 55 | 55 | 55 | 55 | 55 | 53 | **54.7** |
| K1 Crafted visual system | 53 | 53 | 53 | 53 | 51 | 48 | **51.8** |
| K4 One place per job | 53 | 53 | 53 | 49 | 51 | 51 | **51.7** |
| K5 Finance truth loop | 46 | 45 | 47 | 50 | 47 | 48 | **47.2** |
| K6 Guardrails and performance | 48 | 51 | 44 | 46 | 50 | 44 | **47.2** |

The means are the chair's arithmetic.

**Final ballots and Borda count** (top 3, scored 5/4/3; the number after the bar is the member's conviction)

| Member | #1 | #2 | #3 |
|---|---|---|---|
| Builder | K6 \| 4 | K3 \| 5 | K1 \| 4 |
| Craft | K1 \| 5 | K3 \| 5 | K2 \| 5 |
| Flow | K4 \| 4 | K3 \| 5 | K1 \| 4 |
| Money | K5 \| 4 | K1 \| 4 | K3 \| 4 |
| Scout | K2 \| 5 | K3 \| 4 | K1 \| 4 |
| Skeptic | K2 \| 5 | K3 \| 4 | K5 \| 4 |

| Cluster | Borda | On ballots | First places |
|---|---|---|---|
| **K3 Motion** | **23** | 6/6 | 0 |
| **K1 Visual** | **18** | 5/6 | 1 |
| **K2 Copy** | **13** | 3/6 | 2 |
| K5 Finance | 8 | 2/6 | 1 |
| K4 Structure | 5 | 1/6 | 1 |
| K6 Guardrails | 5 | 1/6 | 1 |

**How to read this.** K2 has the highest mean score but only 13 Borda points. The reason is not opposition: Builder and Flow both say K2 is "non-negotiable" or "safe on every ballot", and they left it off because it rides inside every lane's sweep. Money dropped K2 for the same reason ([r3_builder](r3_builder.md), [r3_flow](r3_flow.md), [r3_money](r3_money.md)). K6 was "already adopted in Phase 0" (Skeptic).

---

## Deep dives

The specs below merge the round-3 amendments into the chair's plan ([03_chair_synthesis](03_chair_synthesis.md)).

### File-ownership lanes (Builder)

Lanes are exclusive: each set of files has one owner ([r2_builder](r2_builder.md) §2a, [r3_builder](r3_builder.md)).

| Lane | Owns |
|---|---|
| **L0** Guardrails | `css-guards.test.ts`, `style-budget.json`, copy lint, `scripts/census.mjs`, `bundle-budget.mjs`, `e2e/`, the route-ready mark in `src/app/routes.tsx` |
| **L1** Kit | `src/styles/{tokens,material,theme,components,index,fonts}.css`, `src/ui/**` including motion, `docs/DESIGN.md`, the icon picker |
| **L2** Shell / Home / IA | `src/features/{shell,home,search}/**`, `src/app/{commands,shortcuts}.ts`, Onboarding |
| **L3** Life apps | `src/features/lifeapps/**`, `calendar/**` |
| **L4** Finance UI | `src/features/{finance,portfolio,taxes,markets}/**`, covering both styling and K5 UI. One lane, per Money. |
| **L5** Work surfaces | editor, databases, sheets, `editor.css`, `grid.css` |
| **L6** Settings / vault / integrations | `src/features/{settings,vault,integrations}/**`, except Onboarding |
| **L7** Contract | `crates/emp-finance/**`, the `emp-store` migration and importers, manifests, `src-tauri/src/commands/finance.rs`, and the finance sections of `types.ts` and the mock. One agent owns both sides. |

**Rules that apply to every lane**
- **Merge gate.** Nobody touches finance files, `types.ts`, the mock's `finance.ts`, Appearance or the glass files until the parallel team has merged.
- **Token freeze.** Tokens freeze after Phase 1. Sweep lanes may not edit `tokens.css`, `material.css` or `theme.css` (Skeptic).
- **Copy is not a lane.** Each lane rewrites the strings in its own files, working from one shared table.

### K6 · Phase 0 guardrails

Builder's estimate: 12–16 h ([r3_builder](r3_builder.md)).

**These checks fail CI.** They run in vitest and the bundle script; this list merges the round-3 files.

- **Style ratchet.** Per-file counts may only fall, from today's snapshot. It counts:
  - raw hex or rgb outside tokens;
  - literal `box-shadow`;
  - `*-gradient(` in feature CSS;
  - stray `backdrop-filter`;
  - `infinite` keyframes;
  - inline visual styles;
  - `text-transform: uppercase` (56 today);
  - ` · ` middle-dot strings (296 today);
  - `"USD"` literals (194 → 1);
  - `toFixed(` in finance features;
  - `DeltaPill` imports;
  - `Sparkles` imports.

  Sources: Builder, Money, Scout, Skeptic.
- **Scale checks:**
  - font weights outside {400, 500, 600, 700};
  - radii outside {4, 6, 10, 12}, plus an allowlist for round shapes;
  - `transition: all` ([r3_craft](r3_craft.md)).
- **Contrast test on tokens:** text at ≥ 4.5:1, tertiary at ≥ 3:1. It has already caught Craft's own 2.83:1 tertiary colour.
- **Emoji lint.** Any `\p{Extended_Pictographic}` in `src/**`, the seed, the defaults or the `lifeapps/*.json` manifests fails, except in test and user-document fixtures, with © and ™ allowlisted. There are about 450 hits in 62 files today ([r3_builder](r3_builder.md)).
- **Copy lint.** It fails on banned phrases, from Builder's list in [r2_builder](r2_builder.md) §2c plus Skeptic's additions:
  - greetings, "Consider", "Common guideline", "Show math", "Needs attention";
  - "we spotted/found";
  - "let's";
  - tap, long-press, swipe;
  - "!" at the end of a string, em dashes, "level up";
  - Title Case on buttons.

  Each area must reach 0 when its sweep closes.
- **Behaviour tests:**
  - every visible kbd hint is bound;
  - 0 keys lost when typing at 0 ms after ⌘K;
  - no duplicate nav label and no "Today" tab;
  - a keycap fires while focus is in an input → fail;
  - `RollingNumber` animates on mount by default → fail;
  - any console error on the 59-route smoke → fail.

  Sources: Flow, Skeptic, Money.
- **Finance tests:**
  - formatter tests: no −0, years shown in cross-year ranges, consistent decimals;
  - the demo-vs-desktop parity fixture (OFX, CSV, QIF);
  - non-tabular money in the `<Money>` kit test → fail.

  Sources: Money, Scout.
- **Bundle budget:**
  - any chunk more than +5% larger (gzip);
  - any new chunk over 50 KB;
  - Home boot more than +3% larger (Builder; Scout wanted 3% overall).

**These are local phase-exit gates, not CI.**
- **Census on Home and Money HQ:** ≤ 12 shadows, ≤ 1 gradient, ≤ 5 radii, ≤ 4 weights.
- **Settle:** ≤ 150 ms after `emp:route-ready` (Builder, Skeptic), with no count-up on arrival. Craft's round-3 gate says ≤ 300 ms after data-ready.
- **Visual baselines** in one pinned environment, approved by the chair. Builder measured 0 px of diff between runs ([r2_builder](r2_builder.md)).
- **Flow's kill bar for Home:** Home fails if any section shows more than one number, or if it contains any bordered container.

**Added before Phase 2 (Skeptic).** CI gains four Playwright flows:
1. first run on the empty seed;
2. create a page and type;
3. import an OFX file and review it by keyboard;
4. ⌘K to a hub tab.

### K1 · Phase 1 kit: tokens and type

From Craft's N-CR1, corrected in [r2_craft](r2_craft.md) and constrained by [r3_craft](r3_craft.md).

**Palette** (token *values* change; token names stay, per CLAUDE.md override 5)

| Token | Light | Dark |
|---|---|---|
| `--bg-canvas` | `#fdfdfc` (kept; not cream) | `#1a1a19` |
| `--bg-window` / sidebar | `#f7f6f4` | `#1f1f1e` |
| `--bg-surface-2` / `-3` | `#f1f0ed` / `#e8e7e3` | `#252524` / `#2e2e2c` |
| `--text-primary` | `#262624` | `#ecebe8` (14.6:1) |
| `--text-secondary` | `#6e6b65` | `#a8a59f` (7.1:1) |
| `--text-tertiary` | **`#87847e`** (3.66:1 on canvas; replaces the failing `#9b9892`) | `#7a7772` (3.9:1) |
| `--border` / `-strong` | `rgba(40,30,10,.08)` / `.14` | `rgba(255,255,240,.08)` / `.14` |
| `--state-hover` / selected | `rgba(40,34,24,.05)` / `.06` | `.055` / `.08` |

**Accent and colour**
- **The accent is graphite ink.** Ink is the text colour and is used for links (with a 40% underline), the focus ring (2px ink at 50% with a 1px offset), selection and the chart line.
- **Gain and loss colour** appears only on deltas and over-budget amounts.
- **Categorical colours:** at most 6 muted hues, used only inside charts and as 6px category dots. The Tailwind-500 set is retired ([r2_money](r2_money.md)).
- **Removed:** grain, the canvas halo, `--glow-*`, edge-light and specular, tilt, magnet, sheen, and the aurora and dusk covers.

**Type**
- **Typeface:** IBM Plex Sans, after a one-day spike; all-Inter is the fallback.
  - Three members measured that Plex digits are tabular by default and that U+2212 (minus) is as wide as "+" ([r3_skeptic](r3_skeptic.md), [r3_scout](r3_scout.md), [r3_money](r3_money.md)).
  - Plex has no `sups` feature, so cents are positioned with CSS.
  - The Latin file is 45.7 KB against Inter's 73 KB, and Plex sets about 5% narrower ([r2_craft](r2_craft.md)).
  - Spike conditions: a latin-ext subset; await fonts before the grid paints; a `tnum` test; a sheets measurement re-check; and a side-by-side for you.
- **Weights:** 400, 500, 600 and 700 only.
- **Scale** (size/line in px):
  - 11/14 w500;
  - 12/16 meta;
  - 13/18 dense UI;
  - 14/20 controls;
  - 16/24 body;
  - 20/26, 24/31 and 30/39 at w600;
  - 32/38 w700 for app titles;
  - 40/48 w700 for document titles.
- **Tracking:** 0 below 20px, −0.01em at 20–30px, −0.02em at 40px. No uppercase eyebrows.
- **Density:** 13px UI. Row height is not settled: Builder says 28px rows, Craft says 36px rows.

**Spacing and depth**
- **Radii:** 4, 6, 10 and 12, plus full radius for avatars and switch tracks only.
- **Elevation:**
  - E0: flat.
  - E1: a 1px warm ring.
  - E2 (menus): `0 8px 12px rgba(25,25,25,.03), 0 2px 6px rgba(25,25,25,.03), 0 0 0 1px rgba(42,28,0,.07)`.
  - E3 (dialogs, palette, toasts): `0 20px 24px rgba(25,25,25,.05), 0 5px 8px rgba(25,25,25,.03), 0 0 0 1px rgba(42,28,0,.07)`.
- **Container rule:** one container level, enforced as a DOM check that no bordered container sits inside another (N-CR5).

**Keys** (you chose the subtle variant, the left column of `keys-compare.png`)
- **`.key`, the primary action, at most one per view:**
  - face: `linear-gradient(#3b3b38, #262624)`;
  - shadow: `inset 0 -1px 0 rgba(0,0,0,.38), 0 1px 1.5px rgba(30,25,10,.22)`;
  - no pseudo-elements.
  - Craft proposes raising the bottom edge to 1.5px.
  - Press: 0.5px travel, with the edge collapsing in 60 ms. Release: 100 ms ease-out, no overshoot.
- **`Kbd`:** 18px tall, radius 4, with a 1px ring and a 1px bottom edge.
- **Thumbs** (segmented, switch, slider): a paper face, a 1px ring and a 1px shadow.
- **Secondary buttons:** ghost, with a 5% wash that comes in at 0 ms and goes out over 120 ms.
- **Kept off the kit:** the full Slab survives only as the app icon and on the lock screen. Inputs become a flat 1px field with a focus ring. There is no glass at rest.

**Money typesetting** (N-MO4 values, [r2_money](r2_money.md) §2.3)

| Role | Size/line | Weight | Notes |
|---|---|---|---|
| `num-hero` | 32/38 | 500 per Money; 600 per Craft (open) | One per screen. Label 13/18 above, delta line 13/18 below. |
| `num-lg` | 20/26 | 500 | Replaces KPI cards. Label 12/16 in sentence case. |
| `num-row` | 14/20 (13/18 dense) | 400; totals 600 | Right-aligned. Cents full size in tertiary (the existing `dimCents`). |
| `num-axis` | 11/14 | 400 | Tertiary. |

**Number rules**
- **Currency symbol:** full size, set via `Intl.NumberFormat` with `currencyDisplay: 'narrowSymbol'`. Never concatenate "$".
- **Cents:**
  - none on summaries of 1,000 or more;
  - exact balances at hero size use superscript cents at 0.55em, `vertical-align: 0.42em`, in secondary;
  - rows show cents full size in tertiary;
  - never mix 0 and 2 decimals in one card.
- **Negatives:** U+2212 before the symbol. Never parentheses, and never red for ordinary expenses.
- **Deltas:** `Delta` replaces `DeltaPill`. It reads `+$65,905 (+37.2%)` plus a label, with no pill and no arrow. Differences between rates are written "pts".
- **Decimals:**

  | Kind | Decimals |
  |---|---|
  | Prices ≥ $1 | 2 |
  | Prices < $1 | 4 |
  | Return percentages | 1 |
  | Drift and tax rates | 0 |

  Never show "−0.0".
- **Date ranges** carry years when they cross a year boundary.
- **Charts:**
  - balance lines are a 1.75px ink line with a 1px dotted reference line;
  - no gridlines and no gradient fill;
  - y-axis on the right with 3–5 ticks;
  - bars start at zero;
  - the donut becomes a sorted list of 4px bars;
  - **zero rings in Money, Portfolio and Tax.** Budgets get 4px bars.
- **Crosshair scrub:** the header figure becomes the scrubbed value, and the chart is keyboard-focusable.
- **Fixed chart heights:** 220 for hero charts, 140 for card charts.

**Icons** (under your no-emoji ruling)
- **One set:** curated Lucide only, in one family, not a grab-bag (Scout), with `absoluteStrokeWidth` always.
- **Sizes and strokes:**

  | Where | Size | Stroke |
  |---|---|---|
  | Sidebar, breadcrumb, rows | 16px | 1.25px |
  | Inline | 14px | 1.25px |
  | Page header | 40px | 1.75px |

- **Colour:** secondary in chrome, ink in the page header. No sparkles, and no icons in tabs or headings.
- **Picker:** about 120 glyphs in 8 searchable groups (Craft); Flow and Skeptic want about 150 or more, plus one tint. It replaces the emoji picker in `PageHeader.tsx`, `DatabasePage.tsx` and `OverlayHost.tsx`, and `EmojiPicker*` and `emoji-data.ts` are deleted.
- **Pages with no icon:** not settled. Craft shows nothing; Flow shows a kind glyph (doc, database or sheet).
- **Emoji → icon map:** about 150 entries (for example 👋→hand, 🚀→rocket, ✈️→plane). Unmapped emoji fall back. The map is used by the store migration, the importers and the generated callouts (`markdown.rs:871`).
- **Existing data:**
  - keep `Emoji` deserialisable, so older vaults and backups still load;
  - keep the original emoji in page metadata, so export can round-trip (Skeptic).
- **No §11 change:** `Icon` already has a `lucide` variant.
- **Seed and finance:**
  - seed pages: Getting Started → `book-open`, Lisbon → `plane`;
  - habits become glyph buttons;
  - finance manifests lose their emoji (36 in `money-hq.json`, 12 in `portfolio.json`, 10 in `tax-organizer.json`), and category rows show a 16px ink glyph.
- **Untouched:** text users type in their own documents.
- **Effort:** 14–20 h ([r3_builder](r3_builder.md), [r3_craft](r3_craft.md), [r3_flow](r3_flow.md), [r3_money](r3_money.md)).

**Lane L1 also ships:**
- the `<Text>` primitive (N-BU4);
- the material diet (N-BU2): reduced effects must also drop gradients and blends in pseudo-elements;
- `DESIGN.md` v3, which includes the R-4 signature rules.

**What makes A recognisably EMP** (the R-4 consensus)
1. Ink as the only accent.
2. Keys that answer your hands.
3. Plex numerals set like a bank statement.
4. Ruled, not boxed, at 13px density.
5. One monochrome glyph language.

**Avoid** cream `#F4F1EA`, serif display type, terracotta, all-caps eyebrows, stat-banner rows, gradient covers, coloured tiles, glass at rest, confetti and rings.

### K3 · Phase 1 motion register

Sources: [r2_craft](r2_craft.md) §2.5, [r2_builder](r2_builder.md), [r3_craft](r3_craft.md). A new `src/ui/motion/register.ts` maps every animation to a class, and a lint enforces it.

| Class | What | Rule |
|---|---|---|
| **C0, constant** | Hover-in, row focus, tab, segmented and sidebar selection, route change, palette or menus opened by keyboard, Home | 0 ms in; out ≤ 120 ms; content present at frame 1 |
| **C1, feedback** | Key press, checkbox tick (120 ms) plus strike-through (150 ms), switch, mouse-opened menus (scale .97→1), toast (150 ms in, 100 ms out) | ≤ 150 ms; no overshoot |
| **C2, continuity** | Side peek, dialog, drag lift and drop, FLIP reorder, chart range morph; a number rolls **only when your own edit changed it** | 180–250 ms; critically damped; interruptible |
| **C3, moments** (exactly three) | **Vault unlock**; **life-app build** (its length is the real work); **reconcile success** (≤ 600 ms, a quiet check) | ≤ 900 ms; skippable; a crossfade under reduced motion |

**Removed:**
- arrival choreography;
- count-up on view;
- the word-blur greeting;
- the 8-ray burst;
- the page-open morph;
- velocity squash;
- tilt, magnet and sheen;
- halo pulses;
- confetti for chores (`ImportWizard.tsx:20`).

The goal burst becomes a C2 confirmation, not a C3 moment.

**Implementation** (Builder: none of these changes a component API):
- `countUp` defaults to `false` (`RollingNumber.tsx:119`; 27 call sites already pass `false`);
- `RouteOutlet` transitions take 0 ms (`routes.tsx:10`);
- stagger is set to 0 in `presets.ts`;
- the greeting is removed from `HomePage.tsx`.

**Rolling numbers.** The DOM, the copied text and the accessibility text all hold the final value from frame 1. The roll is an overlay that is `aria-hidden` and `user-select: none`.

**Charts.** Lines draw in for ≤ 300 ms on the first data load only. A value that changes while mounted crossfades in ≤ 150 ms.

**Living keycaps** fire only on a full-chord match, outside text fields. This fixes `keycaps.ts:77-90`, which depresses every matching keycap while you type.

### K5a + K2 · Phase 1 truth fixes (lanes L7 and L4a)

These are defects that polish would hide. Builder estimates L7 at 20–28 h and L4a at 12–16 h.

| Fix | Evidence |
|---|---|
| Rust import writes `txn.cleared`, `txn.source` and `reviewed=false` | `finance.rs:2147-2198` never sets them; the mock does (`finance.ts:1498-1499`), so reconciliation on desktop is wrong ([r2_money](r2_money.md)) |
| `txn.reviewed` checkbox role added to `money-hq.json` **at 1.0.0, before the v0.1.0 tag** | Migrations can only `addTemplate` (`manifest.rs:324-331`). Adding it after release has no path. `reconciled` already exists on Cleared (`money-hq.json:1720`). |
| Effective tax rate = total tax ÷ AGI; fix the mock (`tax.ts:225`) | Mock shows 15.7% where desktop would show ~16.1% [estimate]; which denominator IRS SOI uses is [unverified] |
| `TaxEstimate.deduction.itemizedWouldBe?` (additive); the hub uses it | `TaxHub.tsx:105` ignores the 7.5% medical floor and the SALT cap |
| Tax pack: $1,000 / $2,000 non-itemiser cash charity deduction, 0.5% AGI floor for itemisers, Roth removed from deductions | IRS OBBB provisions ([r1_money](r1_money.md) N-MO5) |
| "Covered — nothing more needed" → "No penalty expected · $1,224 due Apr 15" | IRS Pub 505 |
| Budget pace: bills judged paid/due, not linear; classification by `is_income`/`is_saving` flags, not group names | `Budget.tsx:52`; `figures.ts:10-17` |
| N-MO3 `<Figure id>` registry: one label, one definition and a popover per headline figure, replacing "Show math" in 3 files | "Spent" shown with 3 values, returns with 3 figures, debt-free dates disagree ([r2_money](r2_money.md) §2.2) |
| Rolling-number copy yields digit strips | `RollingNumber.tsx:206` ([r1_skeptic](r1_skeptic.md)) |
| False loading states ("All caught up", "0 open", "not enough data" before data is ready) | `LifeOS.tsx:418,425`; `MoneyHQ.tsx:137` |
| Keycaps depress while typing | `keycaps.ts:77-90` |
| Touch copy on desktop ("Tap… long-press") | `Habits.tsx:485` |
| First run builds nothing and lands on "0 OF 6 SET UP"; fix with `lifeapp_install` `mode:'quick'` | `Onboarding.tsx:146-163` |
| ⌘K loses keystrokes; fix with `autoFocus` plus a key buffer | `CommandPalette.tsx:401-405` |
| `ImportDialog.tsx:36` over-claims Notion database fidelity | Obsidian's team says file exports can't recreate databases (#421) |
| Currency: `useCurrency()` replaces "USD" literals; show "Not in net worth: …" for foreign accounts. FX conversion stays P1 | 194 literals ([r2_builder](r2_builder.md)) |

**Every truth fix gets a Rust test and a mock↔desktop parity test** (Skeptic, Money).

**The complete contract delta:**
- `FinanceImportPreview.statement?: { balance, asOf?, source: 'ofx'|'csv' }`;
- `itemizedWouldBe?`;
- the `txn.reviewed` row in the SPEC §16 role table.

There are no new commands ([r2_money](r2_money.md) §2.1-D).

### K4 · Phase 2 structure

Sources: [r2_flow](r2_flow.md) §2, amended in [r3_flow](r3_flow.md). In each lane, K4's deletions land before that area's sweep, so no deleted screen gets restyled. Those deletions are:
- the Home widget grid;
- Life OS's Today tab;
- Habits' Today tab;
- four of Money HQ's tabs.

**Sidebar**
- **Primary rows:** Search ⌘K, Home, Calendar. Users can hide or reorder them.
- **Settings** moves to the footer.
- **The daily note** leaves the primary rows. It is reached by:
  - the "Today's note" link under Home's H1;
  - ⌘⌥D;
  - `@today` in ⌘K;
  - the Journal page in the tree.
- **Sections, in order:**
  1. Favorites, unchanged;
  2. Life apps (sentence case), listing installed apps only. A visible "Add a life app" row appears when none are installed (W3C Visible Controls). Markets is listed only when Portfolio or a watchlist exists;
  3. Pages;
  4. Templates · Import · Trash.

**Home = the day** (a 720px column in C0, fixed order; empty sections are omitted)
1. **H1:** the date. There is no greeting.
2. **Capture field:** "Add a task, note or expense…".
3. **Upcoming:** the agenda, Life OS tasks due or overdue, and unchecked to-dos from *today's* note, read from its TipTap JSON (2–3 h).
4. **Money line:** "$1,342 left in November · 14 to review · Checking statement 12 days old". Each part links; zero or fresh parts are omitted; it never shows net worth ([r2_money](r2_money.md) §2.4).
5. **Recents:** six rows.

There is no "Needs attention" section and no customise control. A fresh vault shows the date, the capture field, a self-ticking 4-item Get started list, and one Life apps line.

**Landing tabs** (fixed; they never change with data)

| App | Lands on | Tabs |
|---|---|---|
| Money HQ | Overview | Overview · Transactions · Budget · Accounts (net worth inside) · Plan (Recurring, Debt, Forecast, Goals) |
| Life OS | Tasks, with focus in the input | Tasks · Projects · Review |
| Habits | Check-in | Check-in · Habits · Stats |

- Transactions defaults to a **To review** lane when its count is above 0, otherwise to All.
- **One import dialog** sniffs bank formats. The sidebar, ⌘K, Money HQ and first run all route to it.

**First run: 3 screens** (5 with encryption)
1. **Welcome**, with three choices: Start fresh; Bring in Notion, Markdown or Obsidian; Bring in money.
2. **Protect:** encrypt or not. The password and recovery screens are unchanged.
3. **What should EMP help with:** the six v1 picks only. The "More coming" tiles are removed.

Picks that need no personal data (Life OS, Habits, Spreadsheet Studio) build headless, with real progress. The flow then lands on Home. The Personalize and Connections steps go.

**⌘K hub**
- **Indexes** every app tab (about 23).
- **Verbs:** New page, New database (with its title focused), New sheet, New event, Add transaction, Add task.
- **Contextual commands** register through `registerCommands` while their feature is mounted.
- **Capture by prefix only:**
  - `t `/`task ` → a Life OS task, via `parseNatural`;
  - `n `/`note ` → a paragraph appended to today's note;
  - money takes a verb (`spent 12.50 coffee`), with a preview that shows the account. There is no phantom Cash account.
- **Failure:** a parse failure shows a row ("Couldn't read an amount") and Enter opens the dialog. It never silently creates a page.
- **Tests:** 14 table-driven cases ([r2_flow](r2_flow.md) §2.7).

**Interaction contract (N-FL4)**
- Every visible kbd hint is bound.
- ⌘1–9 switch hub tabs.
- J/K, Enter, C, E, Space and X work in the ledger and in task lists.
- Created items stay in view until you leave.
- Toasts carry View and Undo.
- Input never waits on motion.

**Area sweeps.** These apply the K1 anatomy and the K2 copy, one area at a time:
1. shell and Home (Home is built once, directly in v3);
2. life apps and calendar;
3. finance, portfolio, taxes and markets;
4. editor, databases and sheets (bug-bash and Notion's visual values only);
5. settings, vault and integrations.

The sweeps total 52–74 h. Copy for Home, first run and the sidebar ships with K4 (Scout).

**K2's rules for every sweep:**
- one voice: sentence case, verbs on buttons;
- no cheerleading and no explanatory subtitles;
- guidance moves into wizards and `<Figure>` popovers;
- one disclaimer per area, and the tax banner on the Estimator only;
- the existing 60-string rewrite table, plus middle-dot and caps cleanup.

Scout expects 35–50% fewer words on hubs [estimate].

### K5b · Phase 3 finance loop

Builder estimates 14–20 h. Money's specs are in [r2_money](r2_money.md) §2.1-B/C.

- **Statement surfacing.**
  - The wizard skips column mapping for OFX/QFX.
  - Its last step is a **Balance check**: "Bank $10,900.99 on Nov 26 · EMP $10,900.99 · Matches → Mark reconciled", or "Off by $79.20" with up to 3 likely causes.
  - There is no confetti.
- **Honest reconciliation.** This is UI-only through `rowsUpdate` and `rowCreate`.
  - The statement field starts empty, with a date.
  - A tick list of uncleared rows shows a live difference.
  - "Record $X adjustment" covers a difference that can't be found.
  - Editing a reconciled row shows a warning.
- **Review queue.**
  - Default scope is "this import"; for files, that means uncategorised plus low-confidence rows (Skeptic).
  - Keys: ↑/↓ or j/k, X, C, R, S, T (transfer), E, N.
  - A batch is capped at **25**, after Copilot.
  - Provenance shows as quiet text.
  - Uncategorised rows read "Uncategorised" in neutral text, not orange pills.
  - `T` offers a transfer rule through `ruleUpsert`.
- **Statement day UI**, only if it stays UI-only (Scout's dissent):
  - per-account "Last statement: 14 days";
  - dropping several statement files at once.

**Cut list for this programme:**
- S8 global hotkey;
- vibrancy and Mica;
- S18, S19 and S20;
- the N-SC3 plain-files mirror;
- free-form natural-language grammar;
- new editor or database features;
- database sub-grouping;
- SimpleFIN;
- a customisable Home;
- month close;
- Newsreader titles;
- a long-lived style flag.

**If time runs short,** cut in this order:
1. P3;
2. low-traffic sweeps (Markets, Settings, the gallery) before K4's sidebar, Home or first run (Flow);
3. L5;
4. L6;
5. L3.

### Phase 4 · QA

Builder estimates 8–12 h.
- Full checks and the 59-route smoke.
- Local baselines and the parity fixture.
- Tighten the ratchets to their final values and delete dead v2 recipes.
- New README screenshots and the CHANGELOG.
- A blind check with you against Notion and Things (Craft).

---

## Tests and next steps

Write these bars down before anyone builds.

| Phase | Pass bar | Fail or fallback |
|---|---|---|
| **P0** | Ratchets green on main, snapped to today's counts. Planted-regression drill: 6 plants caught, 0 false failures in 10 reruns, wall time ≤ 6 min ([r2_builder](r2_builder.md) §5) | More than 1 plant missed or any flake → simplify the guards. If P0 runs over 16 h, Builder would drop K6 |
| **P1 kit** | **Plex spike:** `tnum` test, sheets measurement re-check, a 13px census, and your side-by-side; any failure → all Inter. **Contrast test:** passes. **Census** on Home and Money HQ: ≤ 12 shadows (Home today is about 100), ≤ 1 gradient, ≤ 5 radii, ≤ 4 weights | |
| **P1 motion** | Settle ≤ 150 ms after `emp:route-ready` on the 8 most-seen routes (≤ 400 ms elsewhere); median today 1,259 ms. 0 springs with overshoot outside C3. 0 idle animations 1 s after settle (Markets has 9 today) | You call the instant version "dead" in a before/after video → widen C1/C2 budgets, never add arrival choreography (Craft, Builder) |
| **P1 truth** | Selected text equals the formatted value on Money HQ, Portfolio and Markets. No "caught up", "0" or "not enough data" text 100 ms before ready. 0 keys lost at 0 ms after ⌘K. Parity fixture identical to the cent for cleared, balance, statement, review count, `tax.effective` and `tax.itemisable`. Engine tests for the $1,000/$2,000 cap, the 0.5% floor and the medical floor on the hub. **Emoji lint = 0** | Any mock↔desktop difference blocks the tag |
| **P2 structure** | **Home:** H1 is the date; 0 bordered containers; ≤ 1 number per section; Upcoming and Money above the fold; `grep -c '>Today<'` = 0. **10-job script:** total actions −40% or more, all 10 keyboard-only, none worse. **First run** (`?seed=empty`): lands on `#/home`; "0 OF 6 SET UP" never appears; first item in ≤ 10 actions and ≤ 90 s. **Notion import fixture suite:** 8 failure modes, plus emoji mapped and reported ([r2_scout](r2_scout.md)). **Owner tests:** tree test ≥ 80% first-click and ≥ 20 points better than the old IA; 5-second test 3 of 3 ([r2_flow](r2_flow.md) §5) | You reach for the old widget grid → revisit the Home spec |
| **P2 copy** | You prefer the new copy in ≥ 8 of 10 blind pairs; 5 of 5 figures explained correctly; words on Home and Money HQ −35% or more; banned phrases = 0 ([r2_scout](r2_scout.md), [r2_skeptic](r2_skeptic.md)) | ≥ 3 pairs prefer the old copy, or a figure is misread → restore that guidance as a "why" popover, never as a subtitle |
| **P3** | 25 rows reviewed by keyboard in Playwright. Review count matches between Home and Money. **Your month** ([r2_money](r2_money.md) §5): the balance check matches the statement to the cent or names the cause; review plus reconcile of ≤ 150 rows takes ≤ 10 min; 0 labels that collide with different values | |
| **P4** | Blind pairs against Notion and Things, with a, b and today ([r2_craft](r2_craft.md) §6): a beats today 6 of 6. 59-route smoke has 0 console errors. Chair reviews contact sheets once, after P2 | Owner rejects A → fall back to subtraction-only variant b, which stays documented (Skeptic) |

**Gaps the council did not resolve** (flagged for you or the chair):
- **Hero figure weight:** 500 (Money) or 600 (Craft).
- **Settle gate:** 150 ms (Builder, Skeptic) or 300 ms (Craft).
- **Bundle tolerance:** 3% (Scout) or 5%.
- **Icon picker size:** about 120 or about 150 glyphs.
- **Pages with no icon:** show nothing, or show a kind glyph.
- **Row height:** 28px or 36px.
- **Sheets grid font.** Money, Scout and Skeptic keep the current grid font this programme. Builder found the grid reads `--font-ui`, so keeping it means pinning it deliberately.
- **Middle dots.** The specced Home money line uses " · ", but the ratchet targets middle dots, so it needs an allowlist decision. This tension is the chair's observation.
- **Untested platforms.** WebKitGTK, macOS and Windows are unmeasured.
- **Plex checks not done:** ClearType hinting and the licence file for the exact build are [unverified].

---

## Graveyard

Members withdrew or conceded the items marked (W).

| Idea | Fate | Evidence |
|---|---|---|
| **S8** global quick-capture hotkey | Deferred to P1; in-app ⌘K capture comes first | Wayland has no global-shortcut protocol (tauri#4364). It also needs capability grants and a second window, and can't be tested on macOS or Windows here. Mean score 32.8 ([02](02_chair_synthesis.md)) |
| **S17** vibrancy and Mica | Cut | Needs a transparent window; Mica is Windows 11 only; acrylic performs poorly when dragging (Tauri config); CSS blur runs on the CPU in WebKitGTK (bug 240865). The overlay title bar already exists |
| **S18** encrypted folder sync | Killed for this programme | A single SQLite store with no op log or CRDT, 80 h+ ([r1_builder](r1_builder.md)). Say honestly that this is reviewers' #1 objection ([r1_scout](r1_scout.md)) |
| **S19** mobile | Killed | No mobile target in `tauri.conf.json` |
| **S20** local AI | Killed unanimously | Contradicts "less AI-made", conflicts with the CSP, adds model weight. 35% of consumers reject AI on their devices (Circana). Don't market "no AI" as identity, either: Obsidian's opt-in AI plugins have millions of downloads ([r2_scout](r2_scout.md)) |
| **N-SC3** plain-files mirror | Cut | Plaintext leakage would undermine the encryption story; invisible in screenshots |
| **Month close** (N-MO2 part; Craft's third C3 moment) | Cut by all 6 (W: Money, Craft) | No demand data (Scout). A third moment plus prose is where coach copy returns (Skeptic). Its facts live in the Home money line instead |
| **SimpleFIN bridge** (N-SC2) | Out of programme; P1 at most | Not credential-free: SimpleFIN outsources to MX. $1.50 a month or $15 a year, US/Canada only, 20–30 h, untestable without a paid account. Scout keeps only the UI part of "statement day" |
| Watched downloads folder | Deferred | Needs per-OS filesystem permission |
| **Customisable Home** | Cut (W: Flow) | Notion 3.4 (2026-03-26) moved Home off a full page because the sidebar was "far too crowded". "Customise" hands judgement to the user (Skeptic) |
| "Needs attention" section on Home | Cut (W: Flow) | It is the Suggestions dashboard rebuilt as a list ([r2_skeptic](r2_skeptic.md) §2.3) |
| **Newsreader serif** for titles and money | Rejected (W: Builder conceded to Plex) | A high-contrast serif display on warm paper is trait 1 in Anthropic's list of AI clusters |
| **Long-lived `data-style` flag** (N-BU1) | Dropped (W: Builder) | Doubles visual baselines (40 → 80) and census budgets, adds +30–50% to sweeps [estimate], and invites a component fork per style. Your bake-off replaced it |
| **Free-form natural-language grammar** in ⌘K | Dropped (W: Flow) | Collides "Task list" (a page) with "task …" (capture), and "−5" with the `=` mode. No evidence that users want more grammar |
| Event capture in ⌘K | Dropped (W: Flow) | No demand evidence |
| Seeded default "Cash" account | Killed | A phantom account invents a balance that can never be reconciled (Skeptic) |
| Money HQ landing on Transactions when rows are uncategorised | Dropped (W: Flow) | A landing tab that changes with data is unpredictable |
| Category rings in finance | Cut (W: Money) | 14+ desktop rows need a common baseline; Overview had 8 + 2 rings plus a donut ([r2_money](r2_money.md)) |
| "Keep emoji" (Skeptic, round 1) | Overridden by your ruling (W: Skeptic) | Safeguards: lossless import metadata and a large enough icon set |
| Living keycaps as implemented | Killed in that form; restricted | A global listener depresses matching caps while you type (`keycaps.ts:77-90`) |
| **S12/S13** new editor and database features | Bug-bash and audit only | Parity is verified: turn-into, peek, slash menu, filter, sort, group and markdown paste all work. The editor is 12.7k lines |
| Database sub-grouping | Deferred | The only real gap; 12–18 h of Rust plus IPC |
| Cross-page index of dated to-dos | Deferred | Needs a Rust index and a new command, 12–20 h. Home reads today's note only |
| FX conversion | P1 | Show the exclusion honestly instead |
| N-SC4 progressive disclosure; finance presets beyond YNAB | Below the cut line, partly absorbed (Life apps lists installed apps only) | Rests on analogy, not retention data ([r2_scout](r2_scout.md)) |
| Visual baselines and pinned-container Playwright in CI | Local only this programme | Builder dissents (below) |

---

## Dissents

These are quoted verbatim from each member's round-3 file.

**Builder** ([r3_builder](r3_builder.md)):
> Local-only baselines stop protecting EMP once this programme ends. Add a pinned-container Playwright CI job and a nightly tauri-driver/xvfb WebKitGTK smoke test by P4.

**Craft** ([r3_craft](r3_craft.md)):
> If Plex fails its spike, stay all-Inter. Do not put Newsreader on titles or money figures: a serif display on warm paper is Anthropic's first listed AI cluster.

**Flow** ([r3_flow](r3_flow.md)):
> If time runs short, cut the low-traffic sweeps (Markets, Settings, gallery) before K4's sidebar, Home and first run. Every session starts with those.

**Money** ([r3_money](r3_money.md)):
> Builder makes K5's contract half the first cut. I dissent:
> - the `txn.reviewed` property and the Rust import's `cleared`/`source` fix must ship before v0.1.0, even if their UI ships later;
> - otherwise reviewed has no migration path, and desktop reconciliation stays wrong for every user.

**Scout** ([r3_scout](r3_scout.md)):
> "Statement day" was cut together with SimpleFIN. Its core is UI-only: per-account "last statement: 14 days" and multi-file drop. Import-only users need it most: YNAB dropped EU direct import ([HN 39773819](https://news.ycombinator.com/item?id=39773819)), and Actual users asked for imports across multiple accounts at once ([#525](https://github.com/actualbudget/actual/issues/525)). Keep it in K5b.

**Skeptic** ([r3_skeptic](r3_skeptic.md)):
> Direction A's palette sits inside a published AI-default cluster, and with no emoji, user colour is gone too. Identity now rests on three things: Plex, statement numbers and keys. If the sweeps dilute them, it reads as a tasteful Notion/Linear clone. Keep subtraction-only (variant b) documented as the fallback.

---

## How the council worked

**Roster.** All six members ran on Opus 5.5 at high reasoning.

| Member | Lens |
|---|---|
| Craft | Visual design and taste |
| Flow | UX, IA and keyboard interaction |
| Scout | User evidence |
| Money | Finance domain and number typesetting |
| Builder | Feasibility, performance and guardrails |
| Skeptic | Red team |

**Round 1** ([02_chair_synthesis](02_chair_synthesis.md)).
- Members scored the chair's 20 seeds and proposed 26 new ideas.
- The chair grouped everything into six clusters (K1–K6).
- S2 copy (mean 55.5) and S14 motion (52.0) settled at once.
- S1's visual reset was contested, with scores ranging from 41 to 56.

**Round 2.** Members cross-examined each other by name and ran deep dives:
- Craft built static prototypes: variant a, "paper, ink and keys", against variant b, subtraction only, plus a typeface study and a key-depth comparison.
- Flow wrote a reconciled IA spec with wireframes.
- Money split K5 into UI, schema and contract work.
- Builder measured all 59 routes and proposed lanes and phases.

Round-2 Borda count: K2 22, K3 20, K1 18.

**Your bake-off, between rounds 2 and 3.** You saw A-home, A-money, B-money, Flow's Home and the key comparison. You chose A, subtle keys, Home = the day and earned motion, and added the no-emoji ruling. That closed disputes D1–D4 ([03_chair_synthesis](03_chair_synthesis.md)).

**Round 3.** All six endorsed the plan with amendments, so the council converged by endorsement inside the 4-round cap.

**Major corrections along the way**
- **Already built:**
  - The Notion importer exists (`notion.rs`, 648 lines). S9 as new work was dead.
  - The overlay title bar with traffic-light inset already exists.
  - Density, text-size, contrast and effects settings already exist.
  - The editor, databases and sheets work and are the most restrained surfaces. The AI look concentrates on the hubs.
- **Misdiagnoses in the brief:**
  - The greeting is not the tell. Notion greets too. The tell is the giant, animated, word-by-word hero.
  - Favorites duplicating pages is standard Notion behaviour. The real IA problems are five things called "Today", 7 primary rows against SPEC's 4, two task systems that never meet, and apps that open on dashboards.
  - First run can be tested with `?seed=empty`, and it already breaks its promise.
  - Users praise Linear for "no waiting", not for an absence of motion ([r2_scout](r2_scout.md)).
- **Performance and motion measurements:**
  - "Reduced effects" saves nothing on raster. Removing any one of shadows, gradients or blend/filter cuts Home's 340–420 ms raster by about 75%.
  - Backdrop blur at rest is 0 on 56 of 59 routes.
  - Motion roughly doubles settle time, up to 3.5× on Money HQ (2,979 vs 831 ms).
  - Pixel baselines are deterministic within one environment (0 px diff on 10 routes).
- **Defects found:**
  - The Rust import never writes `cleared` or `source`.
  - The effective tax rate differs between mock and desktop.
  - Living keycaps fire while you type.
  - Craft's own tertiary colour failed contrast at 2.83:1.
- **Scope corrections:**
  - `reviewed` is a manifest role, not an IPC change. The §11 delta is a single additive optional field.
  - Notion 3.4 retreated from a full-page Home.

---

## Sources

**Council files:** [00_brief](00_brief.md), [01_chair_position](01_chair_position.md), [r1_craft](r1_craft.md), [r1_flow](r1_flow.md), [r1_scout](r1_scout.md), [r1_money](r1_money.md), [r1_builder](r1_builder.md), [r1_skeptic](r1_skeptic.md), [02_chair_synthesis](02_chair_synthesis.md), [r2_craft](r2_craft.md), [r2_flow](r2_flow.md), [r2_scout](r2_scout.md), [r2_money](r2_money.md), [r2_builder](r2_builder.md), [r2_skeptic](r2_skeptic.md), [03_chair_synthesis](03_chair_synthesis.md), [r3_builder](r3_builder.md), [r3_craft](r3_craft.md), [r3_flow](r3_flow.md), [r3_money](r3_money.md), [r3_scout](r3_scout.md), [r3_skeptic](r3_skeptic.md). Prototypes and measurements are in the session scratchpad under `council/{craft/proto,builder,flow/wire}/`.

**Craft, AI tells and motion**
- Anthropic frontend-design guidance: https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md
- Krebs' design-slop audit: https://www.adriankrebs.ch/blog/design-slop/
- uxdesign.cc on fluent AI design: https://uxdesign.cc/ai-design-isnt-ugly-it-s-fluent-and-that-s-the-problem-131b2f4eb78c
- HN on shadcn sameness: https://news.ycombinator.com/item?id=46179202 and https://news.ycombinator.com/item?id=48792287
- Linear, how we redesigned the UI: https://linear.app/now/how-we-redesigned-the-linear-ui
- Linear, behind the latest design refresh: https://linear.app/now/behind-the-latest-design-refresh
- Linear Liquid Glass: https://linear.app/now/linear-liquid-glass
- Apple HIG Motion: https://developer.apple.com/design/human-interface-guidelines/motion
- NN/g animation duration: https://www.nngroup.com/articles/animation-duration/
- NN/g on distracting animations: https://www.nngroup.com/videos/distracting-animations/
- NN/g sparkles icon: https://www.nngroup.com/articles/ai-sparkles-icon-problem/
- Emil Kowalski, you don't need animations: https://emilkowal.ski/ui/you-dont-need-animations
- Rauno Freiberg on interaction design: https://rauno.me/craft/interaction-design
- MacStories review of Things 3: https://www.macstories.net/reviews/things-3-beauty-and-delight-in-a-task-manager/
- HN on Linear's speed: https://news.ycombinator.com/item?id=44834604
- W3C Visible Controls: https://w3c.github.io/wcag/understanding/visible-controls

**IA, Home and import**
- Notion 3.4 release: https://notion.com/releases/2026-03-26
- Notion help, sidebar: https://www.notion.com/help/sidebar
- Notion help, Home and My Tasks: https://www.notion.com/help/home-and-my-tasks
- Thomas Frank on Notion Home: https://thomasjfrank.com/notion-home-everything-you-need-to-know/
- Things features: https://culturedcode.com/things/features/
- Linear personalised sidebar changelog: https://linear.app/changelog/2024-12-18-personalized-sidebar
- Logseq forum, Home vs Journals: https://discuss.logseq.com/t/go-to-home-and-go-to-journals-point-to-the-same-all-journals-view-shouldnt-go-to-home-actually-zoom-in-onto-the-todays-journal/20966
- Superhuman on command palettes: https://blog.superhuman.com/how-to-build-a-remarkable-command-palette/
- Obsidian community plugin stats: https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json
- Obsidian importer issues: https://github.com/obsidianmd/obsidian-importer/issues/421 (also #75, #92, #223, #266, #364, #450, #561)
- NN/g empty states: https://www.nngroup.com/articles/empty-state-interface-design/
- Dr. Drang on Fantastical's visible parse: https://leancrew.com/all-this/2013/04/whats-really-great-about-fantastical/

**Finance and tax**
- Copilot bulk editing: https://help.copilot.money/en/articles/7668990-bulk-editing-transactions
- Copilot To Review card: https://www.copilot.money/dispatch/to-review-card-for-mac
- Copilot for macOS: https://help.copilot.money/en/articles/6778561-copilot-for-macos
- Monarch transaction review: https://help.monarch.com/hc/en-us/articles/5528707082516
- Lunch Money transaction status: https://support.lunchmoney.app/finances/transactions/transaction-status
- YNAB reconciling guide: https://support.ynab.com/en_us/reconciling-accounts-a-guide-BJFE3fHys.md
- YNAB, benefits of active entry: https://www.ynab.com/blog/benefits-of-active-entry
- Actual reconciliation docs: https://actualbudget.org/docs/accounts/reconciliation
- Actual issues: https://github.com/actualbudget/actual/issues/1628, https://github.com/actualbudget/actual/issues/3924, https://github.com/actualbudget/actual/issues/525
- SimpleFIN security: https://beta-bridge.simplefin.org/info/security
- Stripe chart layout: https://docs.stripe.com/stripe-apps/patterns/chart-layout
- GIPS on annualising: https://www.gipsstandards.org/?GIPSID=370
- IRS Pub 505: https://www.irs.gov/publications/p505
- IRS Topic 502: https://www.irs.gov/taxtopics/tc502
- IRS non-itemiser charity deduction: https://www.irs.gov/newsroom/irs-reminder-permanent-charitable-contribution-deduction-begins-for-returns-filed-next-year-for-taxpayers-who-do-not-itemize
- Lunch Money multicurrency: https://lunchmoney.app/features/multicurrency

**Platform and engineering**
- Tauri global-shortcut plugin: https://v2.tauri.app/plugin/global-shortcut/
- Tauri Wayland global-shortcut issue: https://github.com/tauri-apps/tauri/issues/4364
- Tauri config reference: https://v2.tauri.app/reference/config/
- Tauri WebDriver in CI: https://v2.tauri.app/develop/tests/webdriver/ci/
- WebKit blur performance bug: https://bugs.webkit.org/show_bug.cgi?id=240865
- Igalia, WebKitGTK 2.46 Skia: https://blogs.igalia.com/carlosgc/?p=1029
- Playwright snapshots: https://playwright.dev/docs/test-snapshots
- Notion on page-load speed: https://www.notion.com/blog/faster-page-load-navigation
- Sonos CEO steps down after app redesign: https://www.macrumors.com/2025/01/13/sonos-ceo-steps-down-after-app-redesign

**Key code references (path:line, as cited by members)**
- Motion and keycaps: `src/ui/motion/RollingNumber.tsx:119,206`; `src/ui/motion/keycaps.ts:77-90`; `src/app/routes.tsx:10`.
- Palette and first run: `src/features/search/CommandPalette.tsx:401-405`; `src/features/vault/Onboarding/Onboarding.tsx:146-163`; `steps.tsx:509`.
- Sidebar and Home: `src/features/shell/Sidebar/Sidebar.tsx:276-292`; `src/features/home/widgets/Today.tsx:49-74`.
- Finance import and contract: `src-tauri/src/commands/finance.rs:1911,2147-2198`; `src/backend/mock/commands/finance.ts:1498-1499`; `crates/emp-finance/src/import/mod.rs:221`; `src/backend/types.ts:1102`.
- Life-app manifests: `crates/emp-store/src/lifeapps/manifest.rs:324-331`; `crates/emp-store/lifeapps/money-hq.json:1703-1720`.
- Tax: `src/backend/mock/commands/tax.ts:225`; `crates/emp-finance/src/tax/engine.rs:880-884`; `src/features/taxes/TaxHub.tsx:105`.
- Finance UI: `src/features/finance/MoneyHQ/Accounts.tsx:217`; `src/features/finance/shared/figures.ts:10-17`.
- Other: `src/features/lifeapps/apps/Habits.tsx:485`; `src/features/shell/ImportDialog.tsx:36`; `src/styles/tokens.css:17-20`; `GridCanvas.ts:119,349-350`.

## Chair resolutions and verification

**Open details the council left unresolved, decided by the chair so that builders aren't blocked:**

| Question | Decision |
|---|---|
| Money hero weight | **600** for the one hero figure per view; 500 for secondary figures; 400 in ledgers (dimmed cents). |
| Settle gate | **Local gate ≤ 300 ms** after data-ready (must pass); **target ≤ 150 ms** (report it). |
| Bundle tolerance | **+5%** gzipped per chunk; a new chunk > 50 KB fails; Home boot > +3% fails. |
| Icon picker | About **120 curated Lucide glyphs** in 8 searchable groups; the import map covers about **150 emoji** (unmapped ones are dropped). |
| Page with no icon | **Page header shows nothing**. The sidebar, recents and links show a neutral `file-text` glyph in tertiary ink so rows stay aligned (an index, not decoration). |
| Row height | **28 px** for sidebar, menu and list rows; **36 px** for database table rows and the header (Notion is 37/36). |
| Sheets grid font | The grid reads `--font-ui`. It must **await `document.fonts.ready`** before first paint and re-measure on font change. No separate pin. |
| Middle-dot separator | " · " is **allowed** as a separator in metadata lines (Notion uses it). It is **not** a ratchet target. |

**Verification of the claims the verdict rests on (chair, 2026-11-26):**
- The Rust import never sets `cleared`/`source`: **confirmed**. Only `crates/emp-store/src/lifeapps/sample.rs:118,172` and the TS mock set them, and the import commit path does not.
- Life-app migrations only support `addTemplate`: **confirmed** (`crates/emp-store/src/lifeapps/manifest.rs:325-331`). So `txn.reviewed` must ship in the 0.1.0 manifest.
- `Icon` already has a `lucide` variant: **confirmed** (`src/backend/types.ts:50`). No §11 change is needed for the no-emoji migration.
- The keycap listener reacts to every keydown: **confirmed** (`src/ui/motion/keycaps.ts:106`, the module-level keydown listener).
- Notion 3.4's Home change and the Plex tabular-figure measurement were not re-fetched by the chair. They rest on Scout's, Craft's and Builder's cited measurements.
