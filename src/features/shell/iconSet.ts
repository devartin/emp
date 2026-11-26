/**
 * The full page-icon glyph set, loaded lazily by `useLucide` (icons.ts) so the boot chunk only carries the small
 * always-used set. It is the kit registry (src/ui/icons/glyphs.ts: the curated picker plus every emoji-map target), not
 * a copy, plus the few kind / command glyphs the shell addresses by name that the registry does not curate, and the
 * names life-app manifests give their pages and choices that the registry lacks (list, history, split, table-2, ban,
 * folders, shuffle), so those pages never render an empty glyph box.
 */
import {
  Ban,
  BedDouble,
  BookOpenText,
  ChartCandlestick,
  Circle,
  CircleDot,
  Folders,
  GlassWater,
  History,
  LayoutDashboard,
  List,
  PhoneOff,
  ReceiptText,
  Sheet,
  Shuffle,
  Split,
  Table2,
  type LucideIcon,
} from "lucide-react";
import { GLYPHS } from "@/ui/icons/glyphs";

export const ICON_SET: Record<string, LucideIcon> = {
  ...GLYPHS,
  ban: Ban,
  "bed-double": BedDouble,
  "book-open-text": BookOpenText,
  // Registry-canonical lucide name first; the older alias stays so stored icons and life-app manifests still resolve.
  "chart-candlestick": ChartCandlestick,
  "candlestick-chart": ChartCandlestick,
  circle: Circle,
  "circle-dot": CircleDot,
  folders: Folders,
  "glass-water": GlassWater,
  history: History,
  "layout-dashboard": LayoutDashboard,
  list: List,
  "phone-off": PhoneOff,
  "receipt-text": ReceiptText,
  sheet: Sheet,
  shuffle: Shuffle,
  split: Split,
  "table-2": Table2,
};
