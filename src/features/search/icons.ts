/**
 * Lucide icon names used by registered palette commands (`AppCommand.icon`) → components, imported individually
 * (§12 import style). Unknown names fall back to a neutral command glyph.
 */
import {
  ALargeSmall, ArrowLeft, ArrowRight, Calendar, CalendarDays, ChartCandlestick, ChevronsUpDown, Copy, CornerLeftUp, Command,
  EyeOff, FileDown, FilePlus, FilePlus2, History, House, Keyboard, LayoutTemplate, Link, Lock, MoveHorizontal, PanelLeft,
  PanelRight, Replace, Save, Search, Settings, ShieldCheck, Star, StarOff, SunMoon, Trash2, Type, WifiOff, ZoomIn,
  ZoomOut, Palette, Printer, Download, Upload, Archive, Moon, Sun, Monitor, Rows3, CaseSensitive, Activity, Eye, Database, Sheet,
  ListTodo, Receipt, Landmark, HeartPulse, LayoutGrid, Wallet, Kanban, ReceiptText,
  type LucideIcon,
} from "lucide-react";

const MAP: Record<string, LucideIcon> = {
  "a-large-small": ALargeSmall,
  "arrow-left": ArrowLeft,
  "arrow-right": ArrowRight,
  calendar: Calendar,
  "calendar-days": CalendarDays,
  "chart-candlestick": ChartCandlestick,
  "candlestick-chart": ChartCandlestick, // legacy name (older data / manifests)
  "chevrons-up-down": ChevronsUpDown,
  copy: Copy,
  "corner-left-up": CornerLeftUp,
  "eye-off": EyeOff,
  eye: Eye,
  "file-down": FileDown,
  "file-plus": FilePlus,
  "file-plus-2": FilePlus2,
  history: History,
  house: House,
  home: House,
  keyboard: Keyboard,
  "layout-template": LayoutTemplate,
  link: Link,
  lock: Lock,
  "move-horizontal": MoveHorizontal,
  "panel-left": PanelLeft,
  "panel-right": PanelRight,
  replace: Replace,
  save: Save,
  search: Search,
  settings: Settings,
  "shield-check": ShieldCheck,
  star: Star,
  "star-off": StarOff,
  "sun-moon": SunMoon,
  "trash-2": Trash2,
  type: Type,
  "wifi-off": WifiOff,
  "zoom-in": ZoomIn,
  "zoom-out": ZoomOut,
  palette: Palette,
  printer: Printer,
  download: Download,
  upload: Upload,
  archive: Archive,
  moon: Moon,
  sun: Sun,
  monitor: Monitor,
  rows: Rows3,
  "case-sensitive": CaseSensitive,
  activity: Activity,
  database: Database,
  sheet: Sheet,
  "list-todo": ListTodo,
  receipt: Receipt,
  landmark: Landmark,
  "heart-pulse": HeartPulse,
  "layout-grid": LayoutGrid,
  wallet: Wallet,
  kanban: Kanban,
  "receipt-text": ReceiptText, // legacy name; palette commands use "receipt"
};

export function commandIcon(name: string | undefined): LucideIcon {
  return (name && MAP[name]) || Command;
}
