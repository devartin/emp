/**
 * Lucide icons addressable by their kebab-case name (page icons `{ t:'lucide', v }`, palette command icons). Imported
 * individually (§12) — a curated set rather than the whole library, with a document icon as the fallback.
 */
import { useEffect, useState } from "react";
import emojiMap from "@/ui/icons/emoji-map.json";
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Bell,
  BookMarked,
  BookOpen,
  Briefcase,
  Calendar,
  CalendarDays,
  Camera,
  ChartCandlestick,
  ChartLine,
  CircleHelp,
  Code,
  Compass,
  Copy,
  CornerLeftUp,
  Database,
  Dumbbell,
  Eye,
  EyeOff,
  File,
  FileDown,
  FilePlus,
  FilePlus2,
  FileText,
  Flag,
  Folder,
  FolderInput,
  FolderKanban,
  Gift,
  Globe,
  GraduationCap,
  Hash,
  Heart,
  HeartPulse,
  House,
  Inbox,
  Kanban,
  Keyboard,
  Landmark,
  LayoutDashboard,
  LayoutTemplate,
  Leaf,
  Lightbulb,
  Link,
  ListTodo,
  Lock,
  Map as MapIcon,
  Music,
  Notebook,
  PanelLeft,
  PanelRight,
  PiggyBank,
  Plane,
  Receipt,
  ReceiptText,
  Search,
  Settings,
  Sheet,
  ShieldCheck,
  ShoppingCart,
  Star,
  StarOff,
  SunMoon,
  Table,
  Tag,
  Target,
  Trash2,
  Users,
  Utensils,
  Wallet,
  WifiOff,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  archive: Archive,
  "arrow-left": ArrowLeft,
  "arrow-right": ArrowRight,
  bell: Bell,
  "book-marked": BookMarked,
  "book-open": BookOpen,
  briefcase: Briefcase,
  calendar: Calendar,
  "calendar-days": CalendarDays,
  camera: Camera,
  "chart-candlestick": ChartCandlestick,
  "candlestick-chart": ChartCandlestick,
  "chart-line": ChartLine,
  "line-chart": ChartLine,
  "circle-help": CircleHelp,
  code: Code,
  compass: Compass,
  copy: Copy,
  "corner-left-up": CornerLeftUp,
  database: Database,
  dumbbell: Dumbbell,
  eye: Eye,
  "eye-off": EyeOff,
  file: File,
  "file-down": FileDown,
  "file-plus": FilePlus,
  "file-plus-2": FilePlus2,
  "file-text": FileText,
  flag: Flag,
  folder: Folder,
  "folder-input": FolderInput,
  "folder-kanban": FolderKanban,
  gift: Gift,
  globe: Globe,
  "graduation-cap": GraduationCap,
  hash: Hash,
  heart: Heart,
  "heart-pulse": HeartPulse,
  house: House,
  home: House,
  inbox: Inbox,
  kanban: Kanban,
  keyboard: Keyboard,
  landmark: Landmark,
  "layout-dashboard": LayoutDashboard,
  "layout-template": LayoutTemplate,
  leaf: Leaf,
  lightbulb: Lightbulb,
  link: Link,
  "list-todo": ListTodo,
  lock: Lock,
  map: MapIcon,
  music: Music,
  notebook: Notebook,
  "panel-left": PanelLeft,
  "panel-right": PanelRight,
  "piggy-bank": PiggyBank,
  plane: Plane,
  receipt: Receipt,
  "receipt-text": ReceiptText,
  search: Search,
  settings: Settings,
  sheet: Sheet,
  "shield-check": ShieldCheck,
  "shopping-cart": ShoppingCart,
  // the Sparkles family is never drawn (DESIGN §8): a stored "sparkles" shows the star, as ✨ does
  sparkles: Star,
  star: Star,
  "star-off": StarOff,
  "sun-moon": SunMoon,
  table: Table,
  tag: Tag,
  target: Target,
  "trash-2": Trash2,
  users: Users,
  utensils: Utensils,
  wallet: Wallet,
  "wifi-off": WifiOff,
  "zoom-in": ZoomIn,
  "zoom-out": ZoomOut,
};

export function lucideByName(name: string | undefined): LucideIcon | null {
  if (!name) return null;
  return ICONS[name] ?? loaded?.[name] ?? null;
}

// ── the full page-icon set (iconSet.ts), loaded once on demand

let loaded: Record<string, LucideIcon> | null = null;
let loading: Promise<Record<string, LucideIcon>> | null = null;
const waiters = new Set<() => void>();

/** Loads the full glyph set (one chunk). Resolves immediately once loaded. */
export function loadIconSet(): Promise<Record<string, LucideIcon>> {
  if (loaded) return Promise.resolve(loaded);
  loading ??= import("./iconSet").then((m) => {
    loaded = m.ICON_SET;
    waiters.forEach((w) => w());
    waiters.clear();
    return loaded;
  });
  return loading;
}

/** True until the full glyph set has loaded (a named glyph may still arrive). */
export function iconSetPending(): boolean {
  return !loaded;
}

/** The glyph for a lucide name: synchronous for the boot set, otherwise null until the full set has loaded. */
export function useLucide(name: string | undefined): LucideIcon | null {
  const [, bump] = useState(0);
  const hit = lucideByName(name);
  useEffect(() => {
    if (hit || !name || loaded) return;
    const w = () => bump((n) => n + 1);
    waiters.add(w);
    void loadIconSet();
    return () => void waiters.delete(w);
  }, [hit, name]);
  return hit;
}

// ── emoji → glyph (no emoji in the app's own chrome; PROGRAMME-v3 owner ruling)

const EMOJI = emojiMap as Record<string, string>;

/** The lucide name an emoji maps to (src/ui/icons/emoji-map.json), or null when it isn't mapped. */
export function glyphForEmoji(emoji: string): string | null {
  const bare = emoji.replace(/[\uFE0E\uFE0F]/g, "").replace(/\u200D.*$/u, "");
  return EMOJI[bare] ?? EMOJI[emoji] ?? null;
}
