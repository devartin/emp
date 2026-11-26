/**
 * The full page-icon glyph set, loaded lazily by `useLucide` (icons.ts) so the boot chunk only carries the small
 * always-used set. It is the kit registry (src/ui/icons/glyphs.ts: the curated picker plus every emoji-map target), not
 * a copy, plus the few kind / command glyphs the shell addresses by name that the registry does not curate.
 */
import { BedDouble, BookOpenText, CandlestickChart, Circle, CircleDot, GlassWater, LayoutDashboard, PhoneOff, ReceiptText, Sheet, type LucideIcon } from "lucide-react";
import { GLYPHS } from "@/ui/icons/glyphs";

export const ICON_SET: Record<string, LucideIcon> = {
  ...GLYPHS,
  "bed-double": BedDouble,
  "book-open-text": BookOpenText,
  "candlestick-chart": CandlestickChart,
  circle: Circle,
  "circle-dot": CircleDot,
  "glass-water": GlassWater,
  "layout-dashboard": LayoutDashboard,
  "phone-off": PhoneOff,
  "receipt-text": ReceiptText,
  sheet: Sheet,
};
