/** Editor: workspace page defaults (font, width, small text) and writing behaviour (vault settings). */
import { PencilLine } from "lucide-react";
import { m } from "motion/react";
import type { PageFont, VaultSettings } from "@/backend/types";
import { cn } from "@/lib/cn";
import { useSettings } from "@/stores/settings";
import { useWorkspace } from "@/stores/workspace";
import { Select } from "@/ui/Select";
import { Switch } from "@/ui/Switch";
import { spring } from "@/ui/motion/tokens";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { Group, Row, SectionHeader } from "../parts";

const FONTS: { id: PageFont; name: string; family: string; note: string }[] = [
  { id: "sans", name: "Default", family: "var(--font-ui)", note: "IBM Plex Sans · the interface font" },
  { id: "serif", name: "Serif", family: "var(--font-serif-page)", note: "Newsreader · for long reads" },
  { id: "mono", name: "Mono", family: "var(--font-mono-code)", note: "JetBrains Mono · for drafts" },
];

export function EditorSection() {
  const vault = useSettings((s) => s.vault) as VaultSettings;
  const setVault = useSettings((s) => s.setVault);
  const defaults = useWorkspace((s) => s.workspace?.defaults);
  const setDefaults = useWorkspace((s) => s.setDefaults);
  const reduced = useReducedMotionPref();

  return (
    <div>
      <SectionHeader icon={PencilLine} title="Editor" description="How new pages look and how typing behaves." />

      <Group id="page-font" title="New pages" description="Defaults for pages you create. Each page can still change its own font and width from the ⋯ menu.">
        <div className="st-block">
          <div className="st-fonts" role="radiogroup" aria-label="Default page font">
            {FONTS.map((f) => {
              const on = (defaults?.font ?? "sans") === f.id;
              return (
                <m.button key={f.id} type="button" role="radio" aria-checked={on} className={cn("st-font", on && "is-on")} onClick={() => void setDefaults({ font: f.id })} whileTap={reduced ? undefined : { scale: 0.985 }} transition={spring.snappy}>
                  <span className="st-font-ag" style={{ fontFamily: f.family }}>
                    Ag
                  </span>
                  <span className="st-font-name">{f.name}</span>
                  <span className="st-font-note">{f.note}</span>
                </m.button>
              );
            })}
          </div>
        </div>
        <Row id="full-width" label="Full width" description="Use the whole window instead of a 720 px reading column.">
          <Switch checked={!!defaults?.fullWidth} onCheckedChange={(v) => void setDefaults({ fullWidth: v })} aria-label="Full width" />
        </Row>
        <Row id="small-text" label="Small text" description="14 px body text instead of 16 px.">
          <Switch checked={!!defaults?.smallText} onCheckedChange={(v) => void setDefaults({ smallText: v })} aria-label="Small text" />
        </Row>
      </Group>

      <Group title="Writing">
        <Row id="spellcheck" label="Spell check" description="Uses your system dictionary. Nothing is sent anywhere.">
          <Switch checked={vault.spellcheck} onCheckedChange={(v) => void setVault({ spellcheck: v })} aria-label="Spell check" />
        </Row>
        <Row id="typography" label="Smart quotes and dashes" description={"Turns \"straight\" quotes into “curly” ones, -- into — and ... into …"}>
          <Switch checked={vault.typography} onCheckedChange={(v) => void setVault({ typography: v })} aria-label="Smart quotes and dashes" />
        </Row>
        <Row id="markdown-shortcuts" label="Markdown shortcuts" description="Type # for a heading, - for a list, [] for a to-do, > for a quote.">
          <Switch checked={vault.markdownShortcuts} onCheckedChange={(v) => void setVault({ markdownShortcuts: v })} aria-label="Markdown shortcuts" />
        </Row>
      </Group>

      <Group title="Images">
        <Row id="remote-images" label="Images from the web" description="Remote images can reveal when you open a page. Ask shows a placeholder you can load once.">
          <Select
            size="sm"
            value={vault.remoteImages}
            onValueChange={(v) => void setVault({ remoteImages: v })}
            options={[
              { value: "ask", label: "Ask each time" },
              { value: "allow", label: "Always load" },
              { value: "block", label: "Never load" },
            ]}
            className="w-[180px]"
            aria-label="Images from the web"
          />
        </Row>
      </Group>
    </div>
  );
}
