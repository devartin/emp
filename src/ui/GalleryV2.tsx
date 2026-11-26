/* Dev-only gallery sections for Design Language v3 "Paper, ink and keys": tokens, type, keys, money, icons, motion. */
import { Filter, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { useState, type ReactNode } from "react";
import { money } from "@/lib/money";
import { Amount } from "./Amount";
import { Button, type ButtonVariant } from "./Button";
import { Delta } from "./Delta";
import { IconButton } from "./IconButton";
import { IconPickerPanel } from "./IconPickerPanel";
import EMOJI_MAP from "./icons/emoji-map.json";
import { Glyph, PageGlyph } from "./icons/Icon";
import { PAGE_ICON_GROUPS } from "./icons/pageIcons";
import { Kbd } from "./Kbd";
import { CLASSES, REGISTER } from "./motion/register";
import { RollingNumber } from "./motion/RollingNumber";
import { Text } from "./Text";

function GSection({ id, title, lead, children }: { id: string; title: string; lead?: string; children: ReactNode }) {
  return (
    <section id={id} className="flex flex-col gap-5 scroll-mt-20">
      <div className="flex flex-col gap-1">
        <Text v="h2">{title}</Text>
        {lead ? (
          <Text v="body" tone="secondary" className="max-w-[680px]">
            {lead}
          </Text>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Label({ children }: { children: ReactNode }) {
  return (
    <Text v="small" tone="tertiary">
      {children}
    </Text>
  );
}

/* ─────────────── Paper, ink and keys ─────────────── */
const SWATCHES: [string, string][] = [
  ["--bg-window", "Window, sidebar"],
  ["--bg-canvas", "Canvas (paper)"],
  ["--bg-surface-2", "Surface 2"],
  ["--bg-surface-3", "Surface 3"],
  ["--text-primary", "Ink"],
  ["--text-secondary", "Secondary"],
  ["--text-tertiary", "Tertiary"],
  ["--gain-text", "Gain (deltas only)"],
  ["--loss-text", "Loss (deltas only)"],
];

export function MaterialsSection() {
  return (
    <GSection
      id="materials"
      title="Paper, ink and keys"
      lead="Surfaces are flat, warm paper. Everything you read is ink, and ink is the only accent: links, focus, selection, checked fills and the chart line. The only raised objects are keys; the only things that float are things you summoned."
    >
      <div className="grid grid-cols-9 gap-3">
        {SWATCHES.map(([v, l]) => (
          <div key={v} className="flex flex-col gap-1.5">
            <span className="block h-12 rounded-md border border-default" style={{ background: `var(${v})` }} />
            <Text v="small">{l}</Text>
            <Text v="micro" tone="tertiary">
              {v}
            </Text>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-8">
        <div className="flex flex-col gap-3">
          <Text v="section">Hairlines, not boxes</Text>
          <Text v="ui" tone="secondary">
            1px at 7–11% ink between rows and under section heads. One container level at most: a frame inside a frame loses its border.
          </Text>
        </div>
        <div className="flex flex-col gap-3">
          <Text v="section">Floating layers</Text>
          <div className="emp-popover">
            <Text v="ui">A menu or popover: opaque paper, a 1px warm ring and a soft layer (E2). Dialogs use E3.</Text>
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <Text v="section">Radii</Text>
          <div className="flex items-end gap-3">
            {[4, 6, 10, 12].map((r) => (
              <div key={r} className="flex flex-col items-center gap-1">
                <span className="block w-10 h-10 border border-strong" style={{ borderRadius: r }} />
                <Text v="micro" tone="tertiary">
                  {r}
                </Text>
              </div>
            ))}
          </div>
        </div>
      </div>
    </GSection>
  );
}

/* ─────────────── Type ─────────────── */
export function TypeSection() {
  const rows: [Parameters<typeof Text>[0]["v"], string][] = [
    ["title", "title 30/39 600"],
    ["h1", "h1 24/31 600"],
    ["h2", "h2 20/26 600"],
    ["h3", "h3 16/24 600"],
    ["section", "section 14/20 600, ruled"],
    ["body", "body 14/20 400"],
    ["doc", "doc 16/24 400"],
    ["ui", "ui 13/18 400"],
    ["small", "small 12/16 400"],
    ["micro", "micro 11/14 500"],
    ["mono", "mono 13/20"],
  ];
  return (
    <GSection id="type" title="Type" lead="IBM Plex Sans in four weights (400, 500, 600, 700). Figures are tabular by default and the minus is as wide as the plus. Tracking is 0 below 20px. No uppercase eyebrows.">
      <div className="flex flex-col">
        {rows.map(([v, spec]) => (
          <div key={v} className="grid grid-cols-[200px_1fr] items-baseline gap-4 py-2 border-b border-default">
            <Label>{spec}</Label>
            <Text v={v}>Pay the quarterly estimate by Jan 15</Text>
          </div>
        ))}
      </div>
    </GSection>
  );
}

/* ─────────────── Keys ─────────────── */
const STATES = [
  ["Rest", undefined],
  ["Hover", "hover"],
  ["Pressed", "press"],
  ["Focus", "focus"],
  ["Disabled", "disabled"],
] as const;

export function StateMatrix() {
  const rows: [string, ButtonVariant, ReactNode, typeof Plus | undefined][] = [
    ["Primary (ink key)", "primary", "New entry", Plus],
    ["Secondary (paper key)", "secondary", "Import", Upload],
    ["Ghost", "ghost", "Rules", Filter],
    ["Destructive", "destructive", "Delete", Trash2],
  ];
  const force = (s: (typeof STATES)[number][1]) =>
    s === "hover" ? { "data-force": "hover" } : s === "press" ? { "data-pressing": "" } : s === "focus" ? { "data-force": "focus" } : {};
  return (
    <div className="grid grid-cols-[170px_repeat(5,1fr)] items-center gap-y-4 gap-x-2">
      <span />
      {STATES.map(([l]) => (
        <Label key={l}>{l}</Label>
      ))}
      {rows.map(([label, v, text, Icon]) => (
        <Row4 key={label} label={label}>
          {STATES.map(([l, s]) => (
            <div key={l}>
              <Button variant={v} icon={Icon} disabled={s === "disabled"} {...(force(s) as object)}>
                {text}
              </Button>
            </div>
          ))}
        </Row4>
      ))}
      <Row4 label="Icon">
        {STATES.map(([l, s]) => (
          <div key={l} className="flex gap-2">
            <IconButton variant="secondary" icon={Pencil} label="Edit" noTooltip disabled={s === "disabled"} {...(force(s) as object)} />
            <IconButton variant="ghost" icon={Plus} label="Add" noTooltip disabled={s === "disabled"} {...(force(s) as object)} />
          </div>
        ))}
      </Row4>
    </div>
  );
}

function Row4({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <Text v="ui" tone="secondary">
        {label}
      </Text>
      {children}
    </>
  );
}

export function KeycapExtras() {
  return (
    <div className="grid grid-cols-2 gap-8">
      <div className="flex flex-col gap-3">
        <Text v="section">Kbd chips</Text>
        <Text v="ui" tone="secondary">
          Flat outlined chips, 18px, radius 4, with a darker bottom edge. A chip goes down for 120ms only when its exact shortcut fires outside a text field: press Ctrl K here. Typing never moves one.
        </Text>
        <div className="flex items-center gap-4">
          <Kbd keys="mod+k" />
          <Kbd keys="mod+shift+l" />
          <Kbd keys="esc" />
          <Button variant="primary" kbd="mod+enter">
            Save
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <Text v="section">Depth budget</Text>
        <Text v="ui" tone="secondary">
          One ink key per view. Paper keys for secondary actions, a 5% ink wash for ghosts. Press travels 0.5px and the bottom edge collapses in 60ms; release is 100ms with no overshoot. Nothing lifts, glows or tilts on hover.
        </Text>
      </div>
    </div>
  );
}

/* ─────────────── Money ─────────────── */
export function MoneySection() {
  const [n, setN] = useState(1342);
  return (
    <GSection
      id="money"
      title="Money, set like a statement"
      lead="Tabular Plex figures, the currency symbol at full size, a true minus before the symbol, no parentheses. One hero per view. Deltas are written as text; colour appears only on deltas and over-budget amounts."
    >
      <div className="grid grid-cols-3 gap-8">
        <div className="flex flex-col gap-1">
          <Text v="ui" tone="secondary">
            Net worth
          </Text>
          <Amount role="hero" value={money("243279.18")} />
          <Text v="ui" className="flex gap-2">
            <Delta money={money("65905")} percent={0.372} />
            <span className="text-secondary">past year</span>
          </Text>
        </div>
        <div className="flex flex-col gap-1">
          <Text v="ui" tone="secondary">
            Checking, exact balance
          </Text>
          <Amount role="hero" exact value={money("4218.37")} />
          <Text v="ui" tone="secondary">
            Superscript cents at 0.55em in secondary ink
          </Text>
        </div>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-0.5">
            <Text v="small" tone="secondary">
              Left to assign
            </Text>
            <Amount role="lg" value={money("1342")} />
          </div>
          <div className="flex flex-col gap-0.5">
            <Text v="small" tone="secondary">
              Effective tax rate
            </Text>
            <Text v="h2" tabular>
              16%
            </Text>
            <Text v="small">
              <Delta points={1.2} digits={1} invert label="vs 2025" />
            </Text>
          </div>
        </div>
      </div>
      <div className="flex flex-col">
        {[
          ["Whole Foods", "-84.17", "Groceries"],
          ["Payroll", "4210.00", "Income"],
          ["Rent", "-2150.00", "Housing"],
          ["Total", "1975.83", ""],
        ].map(([who, amt, cat]) => (
          <div key={who} className="grid grid-cols-[1fr_160px_120px] items-center h-9 border-b border-default">
            <Text v="body">{who}</Text>
            <Text v="small" tone="secondary">
              {cat}
            </Text>
            <Amount role="row" total={who === "Total"} align="end" className="text-right" value={money(amt)} />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-6">
        <Text v="ui" tone="secondary">
          A number rolls only after your own edit:
        </Text>
        <Button variant="secondary" onClick={() => setN((v) => v + 125)}>
          Add 125
        </Button>
        <Text v="h2" tabular>
          <RollingNumber value={n} format={(x) => x.toLocaleString("en-US")} />
        </Text>
      </div>
    </GSection>
  );
}

/* ─────────────── Icons ─────────────── */
/** A legacy emoji icon from stored data (read from the map so no emoji literal lives in UI source). */
const LEGACY_ROCKET = Object.keys(EMOJI_MAP).find((k) => (EMOJI_MAP as Record<string, string>)[k] === "rocket") ?? "";

export function IconsSection() {
  const [pick, setPick] = useState<string>("plane");
  return (
    <GSection
      id="icons"
      title="One monochrome glyph language"
      lead="Curated Lucide only, always absoluteStrokeWidth: 16px at 1.25 in rows and the sidebar, 14px inline, 40px at 1.75 in the page header. Secondary ink in chrome, ink in the header. No emoji anywhere: legacy emoji icons render through the emoji map; unmapped ones show nothing in a header and a neutral file glyph in lists."
    >
      <div className="grid grid-cols-[1fr_340px] gap-8 items-start">
        <div className="flex flex-col gap-6">
          <div className="flex items-end gap-8">
            <div className="flex flex-col gap-2 items-start">
              <PageGlyph icon={{ t: "lucide", v: pick }} context="header" />
              <Label>header 40 @ 1.75</Label>
            </div>
            <div className="flex flex-col gap-2 items-start">
              <span className="flex items-center gap-2 h-7">
                <PageGlyph icon={{ t: "lucide", v: pick }} context="row" />
                <Text v="body">Lisbon in March</Text>
              </span>
              <Label>row 16 @ 1.25</Label>
            </div>
            <div className="flex flex-col gap-2 items-start">
              <span className="flex items-center gap-2 h-7">
                <PageGlyph icon={{ t: "emoji", v: LEGACY_ROCKET }} context="row" />
                <Text v="body">Legacy emoji, mapped</Text>
              </span>
              <span className="flex items-center gap-2 h-7">
                <PageGlyph icon={null} context="row" />
                <Text v="body">No icon</Text>
              </span>
            </div>
          </div>
          {PAGE_ICON_GROUPS.slice(0, 3).map((g) => (
            <div key={g.id} className="flex flex-col gap-2">
              <Label>{g.label}</Label>
              <div className="flex flex-wrap gap-3 text-secondary">
                {g.icons.map((i) => (
                  <Glyph key={i.name} name={i.name} context="row" size={18} aria-label={i.name} />
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="emp-popover">
          <IconPickerPanel value={pick} onSelect={setPick} />
        </div>
      </div>
    </GSection>
  );
}

/* ─────────────── Motion register ─────────────── */
export function MotionLab() {
  return (
    <GSection
      id="motion"
      title="Motion register"
      lead="Motion is earned. The more often something happens, the less it moves. Every animation belongs to one class; the register test fails when an entry leaves its budget. Only three moments get a scene."
    >
      <div className="grid grid-cols-4 gap-6">
        {(Object.keys(CLASSES) as (keyof typeof CLASSES)[]).map((c) => (
          <div key={c} className="flex flex-col gap-2">
            <Text v="section">
              {c} {CLASSES[c].label}
            </Text>
            <Text v="small" tone="secondary">
              in ≤ {CLASSES[c].maxIn}ms, out ≤ {CLASSES[c].maxOut}ms
            </Text>
            <div className="flex flex-col">
              {Object.entries(REGISTER)
                .filter(([, e]) => e.cls === c)
                .map(([k, e]) => (
                  <div key={k} className="flex justify-between gap-2 py-1 border-b border-default">
                    <Text v="ui">{k}</Text>
                    <Text v="ui" tone="tertiary" tabular>
                      {e.in}ms
                    </Text>
                  </div>
                ))}
            </div>
          </div>
        ))}
      </div>
    </GSection>
  );
}
