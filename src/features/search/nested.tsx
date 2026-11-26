/**
 * Nested palette pages ("Theme →", "Accent →" …). Options read the live settings; theme, accent and density preview
 * on highlight (html data-* only, nothing saved) and the palette restores the previous look on Esc.
 */
import { Monitor, Moon, MoonStar, Palette, Rows3, Settings, Sun, SunMoon, Type, Waves, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { navigate } from "@/app/router";
import type { Accent, DeviceSettings, ThemeSetting } from "@/backend/types";
import { SECTIONS } from "@/features/settings/meta";
import { resolveTheme } from "@/lib/bootPrefs";
import { useSettings } from "@/stores/settings";
import { switchThemeWithReveal, crossfadeColors } from "@/ui/motion/themeTransition";

export type NestedId = "theme" | "accent" | "density" | "text" | "motion" | "settings";

export interface NestedOption {
  value: string;
  title: string;
  subtitle?: string;
  keywords?: string[];
  icon: ReactNode;
  checked?: boolean;
  preview?: () => void;
  apply: (origin: HTMLElement | null) => void;
}

export interface NestedPage {
  id: NestedId;
  title: string;
  placeholder: string;
  icon: LucideIcon;
  keywords: string[];
  options: () => NestedOption[];
}

const device = (): DeviceSettings | null => useSettings.getState().device;
const setDevice = (patch: Partial<DeviceSettings>) => void useSettings.getState().setDevice(patch);
const root = () => document.documentElement;

function tile(children: ReactNode, style?: React.CSSProperties): ReactNode {
  return (
    <span className="cmdk-icon" style={style} aria-hidden>
      {children}
    </span>
  );
}

const ACCENTS: { id: Accent; name: string; color: string }[] = [
  { id: "graphite", name: "Graphite", color: "#3F3F46" },
  { id: "iris", name: "Iris", color: "#5E5CE6" },
  { id: "ocean", name: "Ocean", color: "#0B6BDF" },
  { id: "jade", name: "Jade", color: "#0C7D56" },
  { id: "amber", name: "Amber", color: "#F5A524" },
  { id: "ruby", name: "Ruby", color: "#CC3344" },
  { id: "orchid", name: "Orchid", color: "#A93BBD" },
];

const THEMES: { id: ThemeSetting; name: string; sub: string; icon: LucideIcon }[] = [
  { id: "system", name: "Match system", sub: "Follows your OS appearance", icon: Monitor },
  { id: "light", name: "Light", sub: "Bright and paper-like", icon: Sun },
  { id: "dark", name: "Dark", sub: "Easy on the eyes at night", icon: Moon },
  { id: "midnight", name: "Midnight", sub: "True black for OLED screens", icon: MoonStar },
];

export const NESTED: Record<NestedId, NestedPage> = {
  theme: {
    id: "theme",
    title: "Theme",
    placeholder: "Choose a theme…",
    icon: SunMoon,
    keywords: ["dark mode", "light mode", "appearance", "midnight"],
    options: () =>
      THEMES.map((t) => ({
        value: t.id,
        title: t.name,
        subtitle: t.sub,
        icon: tile(<t.icon size={16} strokeWidth={1.75} />),
        checked: device()?.theme === t.id,
        preview: () => {
          crossfadeColors(160);
          root().setAttribute("data-theme", resolveTheme(t.id));
        },
        apply: (origin) => switchThemeWithReveal(() => setDevice({ theme: t.id }), origin),
      })),
  },
  accent: {
    id: "accent",
    title: "Accent colour",
    placeholder: "Choose an accent…",
    icon: Palette,
    keywords: ["color", "colour", "tint", "highlight"],
    options: () =>
      ACCENTS.map((a) => ({
        value: a.id,
        title: a.name,
        subtitle: a.id === "graphite" ? "Monochrome (default)" : undefined,
        icon: tile(<span className="cmdk-swatch" style={{ background: a.color }} />),
        checked: device()?.accent === a.id,
        preview: () => {
          crossfadeColors(160);
          root().setAttribute("data-accent", a.id);
        },
        apply: () => setDevice({ accent: a.id }),
      })),
  },
  density: {
    id: "density",
    title: "Density",
    placeholder: "Comfortable or compact…",
    icon: Rows3,
    keywords: ["compact", "spacing", "rows"],
    options: () =>
      (["comfortable", "compact"] as const).map((d) => ({
        value: d,
        title: d === "comfortable" ? "Comfortable" : "Compact",
        subtitle: d === "comfortable" ? "Roomy rows and cards" : "4px tighter rows, menus and cards",
        icon: tile(<Rows3 size={16} strokeWidth={d === "compact" ? 2.25 : 1.5} />),
        checked: device()?.density === d,
        preview: () => root().setAttribute("data-density", d),
        apply: () => setDevice({ density: d }),
      })),
  },
  text: {
    id: "text",
    title: "Text size",
    placeholder: "Small, default or large…",
    icon: Type,
    keywords: ["font size", "zoom", "bigger", "smaller"],
    options: () =>
      ([
        ["s", "Small", "13 px interface · 15 px pages"],
        ["m", "Default", "14 px interface · 16 px pages"],
        ["l", "Large", "15 px interface · 17.5 px pages"],
      ] as const).map(([v, name, sub]) => ({
        value: v,
        title: name,
        subtitle: sub,
        icon: tile(<span style={{ fontSize: v === "s" ? 11 : v === "m" ? 13 : 15, fontWeight: 600 }}>Aa</span>),
        checked: device()?.textSize === v,
        apply: () => setDevice({ textSize: v }),
      })),
  },
  motion: {
    id: "motion",
    title: "Motion",
    placeholder: "System, reduced or full…",
    icon: Waves,
    keywords: ["animation", "reduced motion", "accessibility"],
    options: () =>
      ([
        ["system", "Match system", "Follows your OS “reduce motion” setting"],
        ["reduced", "Reduced", "Crossfades only — no movement"],
        ["full", "Full", "Every transition and celebration"],
      ] as const).map(([v, name, sub]) => ({
        value: v,
        title: name,
        subtitle: sub,
        icon: tile(<Waves size={16} strokeWidth={1.75} />),
        checked: device()?.motion === v,
        apply: () => setDevice({ motion: v }),
      })),
  },
  settings: {
    id: "settings",
    title: "Open settings",
    placeholder: "Jump to a settings section…",
    icon: Settings,
    keywords: ["preferences", "options", "configure"],
    options: () =>
      SECTIONS.map((s) => ({
        value: s.id,
        title: s.title,
        subtitle: s.description,
        keywords: s.keywords,
        icon: tile(<s.icon size={16} strokeWidth={1.75} />),
        apply: () => navigate({ t: "settings", section: s.id }),
      })),
  },
};
