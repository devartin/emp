/**
 * Appearance (1.0 brief §2.4): theme (Light, Dark, Midnight, Match system), accent, text size and reduce motion.
 * More options: density, new page style (font, width, text), spell check and typing helpers, gain and loss colours,
 * contrast, readable font, letter spacing and celebrations. Every change applies at once on this device (device
 * settings) or in this workspace (page defaults, writing behaviour) and persists in Rust.
 */
import { Check, PartyPopper } from "lucide-react";
import { useRef } from "react";
import type { Accent, DeviceSettings, PageFont, ThemeSetting, VaultSettings } from "@/backend/types";
import { cn } from "@/lib/cn";
import { useSettings } from "@/stores/settings";
import { useWorkspace } from "@/stores/workspace";
import { Button } from "@/ui/Button";
import { Segmented } from "@/ui/Segmented";
import { Switch } from "@/ui/Switch";
import { celebrate, setCelebrationsEnabled } from "@/ui/motion/Celebrate";
import { Block, Group, MoreOptions, Row, SectionHeader } from "../parts";

const THEMES: { id: ThemeSetting; name: string }[] = [
  { id: "light", name: "Light" },
  { id: "dark", name: "Dark" },
  { id: "midnight", name: "Midnight" },
  { id: "system", name: "Match system" },
];

/** Flat swatches for the theme previews (no gradients, brief §4 sweep). */
const PALETTE = {
  light: { win: "#F4F4F6", canvas: "#FFFFFF", ink: "rgba(24,24,27,.8)", faint: "rgba(24,24,27,.1)", line: "rgba(24,24,27,.12)" },
  dark: { win: "#0B0B0E", canvas: "#17171B", ink: "rgba(237,237,240,.85)", faint: "rgba(255,255,255,.1)", line: "rgba(255,255,255,.14)" },
  midnight: { win: "#000000", canvas: "#08080A", ink: "rgba(237,237,240,.85)", faint: "rgba(255,255,255,.1)", line: "rgba(255,255,255,.14)" },
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

const FONTS: { id: PageFont; name: string; family: string }[] = [
  { id: "sans", name: "Default", family: "var(--font-ui)" },
  { id: "serif", name: "Serif", family: "var(--font-serif-page)" },
  { id: "mono", name: "Mono", family: "var(--font-mono-code)" },
];

const NUMBER_SCHEMES: { id: DeviceSettings["numberColors"]; name: string; note: string }[] = [
  { id: "standard", name: "Standard", note: "Green up, red down" },
  { id: "cvd", name: "Colour-blind friendly", note: "Blue up, orange down" },
  { id: "eastasian", name: "East Asian", note: "Red up, green down" },
  { id: "mono", name: "Monochrome", note: "Signs and arrows only" },
];

function Mini({ p, accent }: { p: (typeof PALETTE)[keyof typeof PALETTE]; accent: string }) {
  return (
    <span className="st-mini" style={{ background: p.win }} aria-hidden>
      <span className="st-mini-side">
        <i style={{ background: p.ink, width: "60%" }} />
        <i style={{ background: accent, width: "72%" }} />
        <i style={{ background: p.faint, width: "54%" }} />
        <i style={{ background: p.faint, width: "66%" }} />
      </span>
      <span className="st-mini-canvas" style={{ background: p.canvas, borderColor: p.line }}>
        <i style={{ background: p.ink, width: "52%", height: 5 }} />
        <i style={{ background: p.faint, width: "86%" }} />
        <i style={{ background: p.faint, width: "74%" }} />
        <i style={{ background: accent, width: "28%", height: 6 }} />
      </span>
    </span>
  );
}

function ThemeCard({ id, name, selected, accent, onPick }: { id: ThemeSetting; name: string; selected: boolean; accent: Accent; onPick: () => void }) {
  const a = ACCENTS.find((x) => x.id === accent) ?? ACCENTS[0];
  return (
    <button type="button" role="radio" aria-checked={selected} className={cn("st-theme", selected && "is-on")} onClick={onPick} data-theme-option={id}>
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
          <span className="st-theme-check">
            <Check size={12} strokeWidth={3} />
          </span>
        ) : null}
      </span>
      <span className="st-theme-name">{name}</span>
    </button>
  );
}

export function AppearanceSection() {
  const device = useSettings((s) => s.device);
  const vault = useSettings((s) => s.vault) as VaultSettings;
  const setDevice = useSettings((s) => s.setDevice);
  const setVault = useSettings((s) => s.setVault);
  const defaults = useWorkspace((s) => s.workspace?.defaults);
  const setDefaults = useWorkspace((s) => s.setDefaults);
  const partyRef = useRef<HTMLButtonElement>(null);
  if (!device) return null;
  const set = (patch: Partial<DeviceSettings>) => void setDevice(patch);

  return (
    <div>
      <SectionHeader title="Appearance" description="Changes apply at once on this computer." />

      <Group>
        <Block id="theme">
          <div className="st-row-label mb-3">Theme</div>
          <div className="st-themes" role="radiogroup" aria-label="Theme">
            {THEMES.map((t) => (
              <ThemeCard key={t.id} id={t.id} name={t.name} selected={device.theme === t.id} accent={device.accent} onPick={() => device.theme !== t.id && set({ theme: t.id })} />
            ))}
          </div>
        </Block>
        <Row id="accent" label="Accent colour" description={`${ACCENTS.find((a) => a.id === device.accent)?.name ?? ""}. Buttons, selection and focus use it.`}>
          <div className="st-swatches" role="radiogroup" aria-label="Accent colour">
            {ACCENTS.map((a) => {
              const on = device.accent === a.id;
              return (
                <button key={a.id} type="button" role="radio" aria-checked={on} aria-label={a.name} title={a.name} className={cn("st-swatch", on && "is-on")} onClick={() => set({ accent: a.id })}>
                  <span className="st-swatch-fill" style={{ ["--sw-l" as string]: a.light, ["--sw-d" as string]: a.dark }}>
                    {on ? <Check size={12} strokeWidth={3} /> : null}
                  </span>
                </button>
              );
            })}
          </div>
        </Row>
        <Row id="text-size" label="Text size" description={device.textSize === "s" ? "Smaller: 13 px interface, 15 px pages." : device.textSize === "l" ? "Larger: 15 px interface, 17.5 px pages." : "Default: 14 px interface, 16 px pages."}>
          <Segmented
            size="sm"
            value={device.textSize}
            onValueChange={(v) => set({ textSize: v })}
            options={[
              { value: "s", label: <span style={{ fontSize: 11 }}>Aa</span>, "aria-label": "Smaller" },
              { value: "m", label: <span style={{ fontSize: 13 }}>Aa</span>, "aria-label": "Default" },
              { value: "l", label: <span style={{ fontSize: 15 }}>Aa</span>, "aria-label": "Larger" },
            ]}
            aria-label="Text size"
          />
        </Row>
        <Row id="motion" label="Reduce motion" description={device.motion === "reduced" ? "On: things fade instead of sliding or scaling." : device.motion === "full" ? "Off: every transition plays, even if your system asks for less." : "Follows your system’s reduce motion setting."}>
          <Segmented
            size="sm"
            value={device.motion}
            onValueChange={(v) => set({ motion: v })}
            options={[
              { value: "system", label: "Match system" },
              { value: "reduced", label: "On" },
              { value: "full", label: "Off" },
            ]}
            aria-label="Reduce motion"
          />
        </Row>
      </Group>

      <MoreOptions section="appearance">
        <Group title="Layout">
          <Row id="density" label="Density" description="Compact fits more rows on screen.">
            <Segmented size="sm" value={device.density} onValueChange={(v) => set({ density: v })} options={[{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }]} aria-label="Density" />
          </Row>
          <Block id="page-font">
            <div className="st-row-label">New page style</div>
            <div className="st-row-desc mb-3">For pages you create from now on. Each page can still change its own from its menu.</div>
            <div className="st-fonts" role="radiogroup" aria-label="Font for new pages">
              {FONTS.map((f) => {
                const on = (defaults?.font ?? "sans") === f.id;
                return (
                  <button key={f.id} type="button" role="radio" aria-checked={on} className={cn("st-font", on && "is-on")} onClick={() => void setDefaults({ font: f.id })}>
                    <span className="st-font-ag" style={{ fontFamily: f.family }}>
                      Ag
                    </span>
                    <span className="st-font-name">{f.name}</span>
                  </button>
                );
              })}
            </div>
          </Block>
          <Row label="Full width" description="New pages use the whole window instead of a reading column.">
            <Switch checked={!!defaults?.fullWidth} onCheckedChange={(v) => void setDefaults({ fullWidth: v })} aria-label="Full width for new pages" />
          </Row>
          <Row label="Small text" description="New pages use 14 px body text instead of 16 px.">
            <Switch checked={!!defaults?.smallText} onCheckedChange={(v) => void setDefaults({ smallText: v })} aria-label="Small text for new pages" />
          </Row>
        </Group>

        <Group title="Writing">
          <Row id="spellcheck" label="Spell check" description="Uses your system dictionary. Nothing is sent anywhere.">
            <Switch checked={vault.spellcheck} onCheckedChange={(v) => void setVault({ spellcheck: v })} aria-label="Spell check" />
          </Row>
          <Row id="typography" label="Smart quotes and dashes" description={"Turns \"straight\" quotes into “curly” ones and -- into —."}>
            <Switch checked={vault.typography} onCheckedChange={(v) => void setVault({ typography: v })} aria-label="Smart quotes and dashes" />
          </Row>
          <Row id="markdown-shortcuts" label="Markdown shortcuts" description="Type # for a heading, - for a list, [] for a to-do.">
            <Switch checked={vault.markdownShortcuts} onCheckedChange={(v) => void setVault({ markdownShortcuts: v })} aria-label="Markdown shortcuts" />
          </Row>
        </Group>

        <Group title="Numbers and accessibility">
          <Block id="number-colors">
            <div className="st-row-label">Gain and loss colours</div>
            <div className="st-row-desc mb-3">For every amount, chart and change. Signs and arrows always show.</div>
            <div className="st-schemes" role="radiogroup" aria-label="Gain and loss colours">
              {NUMBER_SCHEMES.map((s) => {
                const on = device.numberColors === s.id;
                return (
                  <button key={s.id} type="button" role="radio" aria-checked={on} className={cn("st-scheme", on && "is-on")} data-numbers-preview={s.id} onClick={() => set({ numberColors: s.id })}>
                    <span className="st-scheme-chips">
                      <span className="st-scheme-chip" data-dir="up">↗ +2.4%</span>
                      <span className="st-scheme-chip" data-dir="down">↘ −1.1%</span>
                    </span>
                    <span className="st-scheme-name">{s.name}</span>
                    <span className="st-scheme-note">{s.note}</span>
                  </button>
                );
              })}
            </div>
          </Block>
          <Row id="contrast" label="Contrast" description="More strengthens borders and secondary text.">
            <Segmented size="sm" value={device.contrast} onValueChange={(v) => set({ contrast: v })} options={[{ value: "system", label: "Match system" }, { value: "more", label: "More" }]} aria-label="Contrast" />
          </Row>
          <Row id="readable-font" label="Readable font" description="Atkinson Hyperlegible for the interface and pages, designed for low vision.">
            <Switch checked={device.readableFont} onCheckedChange={(v) => set({ readableFont: v })} aria-label="Readable font" />
          </Row>
          <Row id="letter-spacing" label="Wider letter spacing" description="More space between letters and words.">
            <Switch checked={device.letterSpacing} onCheckedChange={(v) => set({ letterSpacing: v })} aria-label="Wider letter spacing" />
          </Row>
          <Row id="celebrations" label="Celebrations" description="A small burst when you finish a checklist or reach a goal. Never with reduced motion.">
            <Button ref={partyRef} size="sm" variant="ghost" icon={PartyPopper} disabled={!vault.celebrations} onClick={() => partyRef.current && celebrate(partyRef.current)}>
              Preview
            </Button>
            <Switch
              checked={vault.celebrations}
              onCheckedChange={(v) => {
                setCelebrationsEnabled(v);
                void setVault({ celebrations: v });
              }}
              aria-label="Celebrations"
            />
          </Row>
        </Group>
      </MoreOptions>
    </div>
  );
}
