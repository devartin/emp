import { Check } from "lucide-react";
import { BLOCK_COLORS, type BlockColorName } from "@/lib/hash";
import type { AccentName } from "@/lib/bootPrefs";
import { ACCENTS } from "@/lib/bootPrefs";
import { Tooltip } from "./Tooltip";

export type BlockColorValue = BlockColorName | "default";
const NAMES: Record<BlockColorValue, string> = {
  default: "Default", gray: "Gray", brown: "Brown", orange: "Orange", yellow: "Yellow", green: "Green", blue: "Blue", purple: "Purple", pink: "Pink", red: "Red",
};

export interface ColorPickerProps {
  value: BlockColorValue | null;
  onChange: (c: BlockColorValue) => void;
  /** "text" shows a coloured A; "background" a filled swatch; "tag" a filled swatch with tag text colour. */
  mode?: "text" | "background" | "tag";
  label?: string;
  className?: string;
}

/** Block / tag colour picker (§3.4). Stored documents reference colours by name only. */
export function ColorPicker({ value, onChange, mode = "text", label, className }: ColorPickerProps) {
  const all: BlockColorValue[] = ["default", ...BLOCK_COLORS];
  return (
    <div className={className}>
      {label ? <div className="emp-menu-header" style={{ padding: "4px 2px 6px" }}>{label}</div> : null}
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={label ?? "Colour"}>
        {all.map((c) => {
          const fg = c === "default" ? "var(--text-primary)" : `var(--block-${c}-text)`;
          const bg = c === "default" ? "var(--bg-surface-1)" : `var(--block-${c}-bg)`;
          const selected = value === c;
          return (
            <Tooltip key={c} content={NAMES[c]}>
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={NAMES[c]}
                className="emp-swatch"
                data-selected={selected ? "" : undefined}
                style={mode === "text" ? { color: fg, background: "var(--bg-surface-1)" } : { color: fg, background: bg }}
                onClick={() => onChange(c)}
              >
                {mode === "text" ? "A" : selected ? <Check aria-hidden /> : null}
              </button>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

const ACCENT_SWATCH: Record<AccentName, string> = {
  graphite: "linear-gradient(135deg, #3a3a40, #0b0b0e)",
  iris: "#5e5ce6",
  ocean: "#0b6bdf",
  jade: "#0c7d56",
  amber: "#f5a524",
  ruby: "#cc3344",
  orchid: "#a93bbd",
};

/** Accent swatches (28px) for onboarding/settings (§6.2). */
export function AccentPicker({ value, onChange }: { value: AccentName; onChange: (a: AccentName) => void }) {
  return (
    <div className="flex gap-2.5" role="radiogroup" aria-label="Accent colour">
      {ACCENTS.map((a) => (
        <Tooltip key={a} content={a[0].toUpperCase() + a.slice(1)}>
          <button
            type="button"
            role="radio"
            aria-checked={value === a}
            aria-label={a}
            className="emp-swatch emp-accent-swatch"
            data-selected={value === a ? "" : undefined}
            style={{ background: ACCENT_SWATCH[a], color: a === "amber" ? "#1c1400" : "#fff" }}
            onClick={() => onChange(a)}
          >
            {value === a ? <Check aria-hidden /> : null}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}
