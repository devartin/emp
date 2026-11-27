/**
 * Appearance (§3, §4.3): theme cards with live miniature previews (View Transitions reveal from the card), accent
 * swatches with a live component preview, density, text size, motion (with a demo), visual effects, contrast,
 * gain/loss colours and accessibility fonts. Every change applies instantly and is mirrored to the boot cache.
 */
import { Check, Palette } from "lucide-react";
import { m } from "motion/react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Accent, DeviceSettings, ThemeSetting } from "@/backend/types";
import { retestGlass, setGlassPref, useGlass, type GlassPref, type GlassStatus } from "@/app/glass";
import { cn } from "@/lib/cn";
import { useSettings } from "@/stores/settings";
import { Button } from "@/ui/Button";
import { Checkbox } from "@/ui/Checkbox";
import { Progress } from "@/ui/Progress";
import { Ring } from "@/ui/Ring";
import { Segmented } from "@/ui/Segmented";
import { Switch } from "@/ui/Switch";
import { Tag } from "@/ui/Tag";
import { spring } from "@/ui/motion/tokens";
import { switchThemeWithReveal } from "@/ui/motion/themeTransition";
import { useReducedEffects, useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { Group, Row, SectionHeader } from "../parts";

const THEMES: { id: ThemeSetting; name: string }[] = [
  { id: "system", name: "System" },
  { id: "light", name: "Light" },
  { id: "dark", name: "Dark" },
  { id: "midnight", name: "Midnight" },
];

const PALETTE = {
  light: { win: "#F4F4F6", canvas: "#FFFFFF", ink: "rgba(24,24,27,.85)", line: "rgba(24,24,27,.12)", faint: "rgba(24,24,27,.07)", keyA: "#4b4b53", keyB: "#222226", keySide: "#050506" },
  dark: { win: "#0B0B0E", canvas: "#17171b", ink: "rgba(237,237,240,.9)", line: "rgba(255,255,255,.14)", faint: "rgba(255,255,255,.08)", keyA: "#f4f4f6", keyB: "#d4d4da", keySide: "#8a8a94" },
  midnight: { win: "#000000", canvas: "#08080a", ink: "rgba(237,237,240,.9)", line: "rgba(255,255,255,.14)", faint: "rgba(255,255,255,.08)", keyA: "#f4f4f6", keyB: "#d4d4da", keySide: "#8a8a94" },
} as const;

export const ACCENTS: { id: Accent; name: string; light: string; dark: string }[] = [
  { id: "graphite", name: "Graphite", light: "#18181B", dark: "#EDEDF0" },
  { id: "iris", name: "Iris", light: "#5E5CE6", dark: "#5E5CE6" },
  { id: "ocean", name: "Ocean", light: "#0B6BDF", dark: "#0B6BDF" },
  { id: "jade", name: "Jade", light: "#0C7D56", dark: "#0C7D56" },
  { id: "amber", name: "Amber", light: "#F5A524", dark: "#F5A524" },
  { id: "ruby", name: "Ruby", light: "#CC3344", dark: "#CC3344" },
  { id: "orchid", name: "Orchid", light: "#A93BBD", dark: "#A93BBD" },
];

function Mini({ p, accent }: { p: (typeof PALETTE)[keyof typeof PALETTE]; accent: string }) {
  return (
    <span className="st-mini" style={{ background: `radial-gradient(120% 80% at 60% -10%, ${p.canvas}, ${p.win} 70%)` } as CSSProperties} aria-hidden>
      <span className="st-mini-key" style={{ background: `linear-gradient(180deg, ${accent === "#18181B" || accent === "#EDEDF0" ? p.keyA : accent}, ${accent === "#18181B" || accent === "#EDEDF0" ? p.keyB : accent})`, ["--mk-side" as string]: p.keySide }} />
      <span className="st-mini-side">
        <i style={{ background: p.ink, width: "62%", opacity: 0.8 }} />
        <i style={{ background: p.faint, width: "80%" }} />
        <i style={{ background: accent, width: "70%", opacity: 0.9 }} />
        <i style={{ background: p.faint, width: "56%" }} />
        <i style={{ background: p.faint, width: "68%" }} />
      </span>
      <span className="st-mini-canvas" style={{ background: p.canvas, borderColor: p.line }}>
        <i style={{ background: p.ink, width: "54%", height: 5 }} />
        <i style={{ background: p.faint, width: "88%" }} />
        <i style={{ background: p.faint, width: "76%" }} />
        <span className="st-mini-cards">
          <b style={{ borderColor: p.line, background: p.canvas }}>
            <i style={{ background: accent, width: "40%" }} />
          </b>
          <b style={{ borderColor: p.line, background: p.canvas }}>
            <i style={{ background: p.faint, width: "56%" }} />
          </b>
        </span>
      </span>
    </span>
  );
}

function ThemeCard({ id, name, selected, accent, onPick }: { id: ThemeSetting; name: string; selected: boolean; accent: Accent; onPick: (el: HTMLElement) => void }) {
  const reduced = useReducedMotionPref();
  const a = ACCENTS.find((x) => x.id === accent) ?? ACCENTS[0];
  return (
    <button type="button" role="radio" aria-checked={selected} className={cn("st-theme", selected && "is-on")} onClick={(e) => onPick(e.currentTarget)}>
      <span className="st-theme-preview">
        {id === "system" ? (
          <span className="st-theme-split">
            <Mini p={PALETTE.light} accent={a.light} />
            <span className="st-theme-split-dark">
              <Mini p={PALETTE.dark} accent={a.dark} />
            </span>
          </span>
        ) : (
          <Mini p={PALETTE[id]} accent={id === "light" ? a.light : a.dark} />
        )}
        {selected ? (
          <m.span className="st-theme-check" initial={reduced ? { opacity: 0 } : { scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={spring.bouncy}>
            <Check size={12} strokeWidth={3} />
          </m.span>
        ) : null}
      </span>
      <span className="st-theme-name">{name}</span>
    </button>
  );
}

const NUMBER_SCHEMES: { id: DeviceSettings["numberColors"]; name: string; gain: string; loss: string; note: string }[] = [
  { id: "standard", name: "Standard", gain: "#12A150", loss: "#E5484D", note: "Green up, red down" },
  { id: "cvd", name: "Colour-blind friendly", gain: "#1F77E5", loss: "#E8740C", note: "Blue up, orange down" },
  { id: "eastasian", name: "East Asian", gain: "#E5484D", loss: "#12A150", note: "Red up, green down" },
  { id: "mono", name: "Monochrome", gain: "currentColor", loss: "currentColor", note: "Signs and arrows only" },
];

export function AppearanceSection() {
  const device = useSettings((s) => s.device);
  const setDevice = useSettings((s) => s.setDevice);
  const reduced = useReducedMotionPref();
  const swatchRow = useRef<HTMLDivElement>(null);
  if (!device) return null;
  const set = (patch: Partial<DeviceSettings>) => void setDevice(patch);

  return (
    <div>
      <SectionHeader icon={Palette} title="Appearance" description="Make Ultranote feel like yours. Changes apply instantly on this device." />

      <Group id="theme" title="Theme">
        <div className="st-block">
          <div className="st-themes" role="radiogroup" aria-label="Theme">
            {THEMES.map((t) => (
              <ThemeCard key={t.id} id={t.id} name={t.name} selected={device.theme === t.id} accent={device.accent} onPick={(el) => device.theme !== t.id && switchThemeWithReveal(() => set({ theme: t.id }), el)} />
            ))}
          </div>
        </div>
      </Group>

      <Group id="accent" title="Accent colour" description="One colour for buttons, selection and focus. Graphite keeps Ultranote monochrome.">
        <div className="st-block st-accent-block">
          <div className="st-swatches" role="radiogroup" aria-label="Accent colour" ref={swatchRow}>
            {ACCENTS.map((a) => {
              const on = device.accent === a.id;
              return (
                <button key={a.id} type="button" role="radio" aria-checked={on} aria-label={a.name} title={a.name} className={cn("st-swatch", on && "is-on")} onClick={() => set({ accent: a.id })}>
                  {on ? <m.span layoutId="st-swatch-ring" className="st-swatch-ring" transition={reduced ? { duration: 0 } : spring.ui} /> : null}
                  <span className="st-swatch-fill" data-accent-swatch={a.id} style={{ ["--sw-l" as string]: a.light, ["--sw-d" as string]: a.dark }}>
                    {on ? (
                      <m.span initial={reduced ? false : { scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={spring.snappy}>
                        <Check size={13} strokeWidth={3} />
                      </m.span>
                    ) : null}
                  </span>
                </button>
              );
            })}
            <span className="st-swatch-name">{ACCENTS.find((a) => a.id === device.accent)?.name}</span>
          </div>
          <AccentPreview accent={device.accent} />
        </div>
      </Group>

      <Group title="Layout & text">
        <Row id="density" label="Density" description="Compact trims 4 px from rows, menus and card padding.">
          <Segmented size="sm" value={device.density} onValueChange={(v) => set({ density: v })} options={[{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }]} aria-label="Density" />
        </Row>
        <div className="st-block st-density-demo" aria-hidden>
          {["Weekly review", "Kitchen renovation", "Lisbon in March"].map((t, i) => (
            <m.div key={t} layout={reduced ? false : "position"} transition={spring.layout} className="st-density-row" data-on={i === 1 ? "" : undefined}>
              <span className="st-density-ico" />
              {t}
            </m.div>
          ))}
        </div>
        <Row id="text-size" label="Text size" description={device.textSize === "s" ? "13 px interface · 15 px pages" : device.textSize === "l" ? "15 px interface · 17.5 px pages" : "14 px interface · 16 px pages"}>
          <Segmented
            size="sm"
            value={device.textSize}
            onValueChange={(v) => set({ textSize: v })}
            options={[
              { value: "s", label: <span style={{ fontSize: 11 }}>Aa</span>, "aria-label": "Small" },
              { value: "m", label: <span style={{ fontSize: 13 }}>Aa</span>, "aria-label": "Default" },
              { value: "l", label: <span style={{ fontSize: 15 }}>Aa</span>, "aria-label": "Large" },
            ]}
            aria-label="Text size"
          />
        </Row>
        <Row id="readable-font" label="Readable font" description="Switch the interface and pages to Atkinson Hyperlegible, designed for low vision.">
          <Switch checked={device.readableFont} onCheckedChange={(v) => set({ readableFont: v })} aria-label="Readable font" />
        </Row>
        <Row label="Wider letter spacing" description="Adds space between letters and words.">
          <Switch checked={device.letterSpacing} onCheckedChange={(v) => set({ letterSpacing: v })} aria-label="Wider letter spacing" />
        </Row>
      </Group>

      <Group title="Motion & effects">
        <Row id="motion" label="Motion" description={device.motion === "reduced" ? "Crossfades only — nothing slides, scales or bounces." : device.motion === "full" ? "Every transition and celebration, even if your OS asks for less." : "Follows your operating system’s “reduce motion” setting."}>
          <MotionDemo />
          <Segmented size="sm" value={device.motion} onValueChange={(v) => set({ motion: v })} options={[{ value: "system", label: "System" }, { value: "reduced", label: "Reduced" }, { value: "full", label: "Full" }]} aria-label="Motion" />
        </Row>
        <Row id="effects" label="Visual effects" description={device.effects === "reduced" ? "No glass or blur, softer shadows, no particles. Lighter on older computers." : device.effects === "full" ? "Glass, blur and depth everywhere they’re allowed." : "Full effects, reduced automatically when frames drop or your system asks for less transparency."}>
          <Segmented size="sm" value={device.effects} onValueChange={(v) => set({ effects: v })} options={[{ value: "auto", label: "Auto" }, { value: "full", label: "Full" }, { value: "reduced", label: "Reduced" }]} aria-label="Visual effects" />
        </Row>
        <TransparencyRow />
        <Row id="contrast" label="Contrast" description="More contrast strengthens borders and secondary text, and turns off glass.">
          <Segmented size="sm" value={device.contrast} onValueChange={(v) => set({ contrast: v })} options={[{ value: "system", label: "System" }, { value: "more", label: "More" }]} aria-label="Contrast" />
        </Row>
      </Group>

      <Group id="number-colors" title="Gain and loss colours" description="Applies to every amount, chart and delta chip. Signs and arrows are always shown.">
        <div className="st-block">
          <div className="st-schemes" role="radiogroup" aria-label="Gain and loss colours">
            {NUMBER_SCHEMES.map((s) => {
              const on = device.numberColors === s.id;
              return (
                <button key={s.id} type="button" role="radio" aria-checked={on} className={cn("st-scheme", on && "is-on")} onClick={() => set({ numberColors: s.id })}>
                  <span className="st-scheme-chips">
                    <span className="st-scheme-chip" style={{ color: s.gain, background: s.id === "mono" ? "var(--bg-surface-2)" : `color-mix(in oklab, ${s.gain} 13%, transparent)` }}>
                      ↗ +2.4%
                    </span>
                    <span className="st-scheme-chip" style={{ color: s.loss, background: s.id === "mono" ? "var(--bg-surface-2)" : `color-mix(in oklab, ${s.loss} 13%, transparent)` }}>
                      ↘ −1.1%
                    </span>
                  </span>
                  <span className="st-scheme-name">{s.name}</span>
                  <span className="st-scheme-note">{s.note}</span>
                  {on ? (
                    <m.span className="st-scheme-check" initial={reduced ? { opacity: 0 } : { scale: 0 }} animate={{ scale: 1, opacity: 1 }} transition={spring.bouncy}>
                      <Check size={11} strokeWidth={3} />
                    </m.span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      </Group>
    </div>
  );
}

const TRANSPARENCY_NOTES: Record<GlassStatus, string> = {
  "forced-on": "Frosted glass on menus, dialogs and the command palette, even where Auto would turn it off.",
  "forced-off": "Menus, dialogs and the command palette are solid. Every other effect stays.",
  "auto-on": "Frosted glass on menus, dialogs and the command palette, unless your system asks for less transparency.",
  "auto-probing": "Glass is on while Ultranote checks that menus and dialogs stay smooth on this computer.",
  "auto-passed": "Glass is on. Menus and dialogs run smoothly with it on this computer.",
  "auto-stepped-down": "Turned off on this computer because menus and dialogs dropped frames with glass more than once.",
  "auto-session-off": "Off for now because menus and dialogs dropped frames with glass. Ultranote checks again next time it opens.",
  "auto-os": "Off because your system asks for reduced transparency.",
  "auto-effects": "Off while visual effects are reduced.",
};

/** Transparency: Auto / On / Off (glass on floating layers). Auto measures on Linux and steps down if frames drop. */
function TransparencyRow() {
  const g = useGlass();
  const effectsReduced = useReducedEffects();
  let note = TRANSPARENCY_NOTES[g.status];
  if (g.status === "forced-on" && effectsReduced) note = "On, but glass stays solid while visual effects are reduced.";
  return (
    <Row
      id="transparency"
      label="Transparency"
      description={
        g.status === "auto-stepped-down" || g.status === "auto-session-off" ? (
          <>
            {note}{" "}
            <Button size="xs" variant="link" onClick={() => retestGlass()}>
              Test again
            </Button>
          </>
        ) : (
          note
        )
      }
    >
      <Segmented<GlassPref>
        size="sm"
        value={g.pref}
        onValueChange={(v) => void setGlassPref(v)}
        options={[{ value: "auto", label: "Auto" }, { value: "on", label: "On" }, { value: "off", label: "Off" }]}
        aria-label="Transparency"
      />
    </Row>
  );
}

/** Real kit components rendered with the live accent. */
function AccentPreview({ accent }: { accent: Accent }) {
  const reduced = useReducedMotionPref();
  const first = useRef(true);
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setPulse((n) => n + 1);
  }, [accent]);
  return (
    <div className="st-accent-preview" aria-label="Preview">
      {pulse && !reduced ? <span key={pulse} className="st-relight" aria-hidden /> : null}
      <div key={`c${pulse}`} className={cn("st-ap-col", pulse ? "st-ap-pop" : undefined)}>
        <div className="st-ap-row">
          <Button size="sm" variant="primary" tabIndex={-1}>
            Save changes
          </Button>
          <Button size="sm" variant="soft" tabIndex={-1}>
            Share
          </Button>
          <Button size="sm" variant="link" tabIndex={-1}>
            Learn more
          </Button>
        </div>
        <div className="st-ap-row">
          <Switch checked onCheckedChange={() => undefined} aria-label="Example switch" size="sm" />
          <Checkbox checked onCheckedChange={() => undefined} aria-label="Example checkbox" />
          <Tag color="default">Planning</Tag>
          <span className="st-ap-selected">Selected text</span>
        </div>
        <Progress value={0.64} size={4} aria-label="Example progress" />
      </div>
      <div className="st-ap-ring">
        <Ring value={0.64} size={64} color="var(--accent-solid)" aria-label="Example ring">
          <span className="text-caption text-primary" style={{ fontWeight: 600 }}>
            64%
          </span>
        </Ring>
      </div>
    </div>
  );
}

/** Plays once when the motion preference changes and on hover (nothing loops — DESIGN §5.4.6). */
function MotionDemo() {
  const reduced = useReducedMotionPref();
  const [run, setRun] = useState(0);
  useEffect(() => setRun((n) => n + 1), [reduced]);
  return (
    <span className="st-motion-demo" aria-hidden title={reduced ? "Reduced motion: crossfade only" : "Full motion"} onPointerEnter={() => setRun((n) => n + 1)}>
      <m.span
        key={run}
        className="st-motion-dot"
        initial={reduced ? { opacity: 0.35 } : { x: 0 }}
        animate={reduced ? { opacity: 1 } : { x: [0, 30, 0] }}
        transition={reduced ? { duration: 0.14 } : { duration: 1.1, ease: [0.65, 0, 0.35, 1], times: [0, 0.55, 1] }}
      />
    </span>
  );
}
