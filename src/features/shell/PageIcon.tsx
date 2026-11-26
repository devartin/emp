/**
 * Renders a page `Icon` (§11.2): emoji, lucide (optionally tinted with a block colour or the accent) or an uploaded
 * asset. Pages without an icon get a kind-specific default glyph in tertiary colour.
 */
import { Database, FileText, LayoutDashboard, LayoutGrid, Sheet } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/backend";
import type { Icon, Id, PageKind } from "@/backend/types";
import { cn } from "@/lib/cn";
import { PageGlyphWith, requestedGlyph } from "@/ui/icons/glyphCore";
import { iconSetPending, lucideByName, useLucide } from "./icons";

const assetUrls = new Map<Id, string>();
const pending = new Map<Id, Promise<string | null>>();

function loadAssetUrl(id: Id): Promise<string | null> {
  const hit = assetUrls.get(id);
  if (hit) return Promise.resolve(hit);
  let p = pending.get(id);
  if (!p) {
    p = api.asset
      .get({ ids: [id] })
      .then((list) => {
        const url = list[0]?.url ?? null;
        if (url) assetUrls.set(id, url);
        return url;
      })
      .catch(() => null)
      .finally(() => pending.delete(id));
    pending.set(id, p);
  }
  return p;
}

function AssetIcon({ assetId, size }: { assetId: Id; size: number }) {
  const [url, setUrl] = useState(() => assetUrls.get(assetId) ?? null);
  useEffect(() => {
    let live = true;
    if (!url) void loadAssetUrl(assetId).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [assetId, url]);
  if (!url) return <span className="inline-block rounded-[4px] bg-surface-3" style={{ width: size, height: size }} aria-hidden />;
  return <img src={url} alt="" width={size} height={size} className="rounded-[4px] object-cover" style={{ width: size, height: size }} draggable={false} />;
}

const KIND_ICON: Record<PageKind, typeof FileText> = {
  doc: FileText,
  database: Database,
  sheet: Sheet,
  app: LayoutGrid,
  dashboard: LayoutDashboard,
};

export interface PageIconProps {
  icon?: Icon;
  kind?: PageKind;
  /** Glyph box size in px (sidebar 18, breadcrumbs 16, headers 20+). */
  size?: number;
  className?: string;
}

/**
 * Delegates to the kit's `PageGlyph` logic (`PageGlyphWith`, src/ui/icons): lucide names and legacy emoji both map
 * through the one registry and render as monochrome Lucide line glyphs in secondary ink, so no emoji ever reaches
 * the sidebar, breadcrumbs or tabs. The lookup is the shell's boot set plus the lazily loaded kit registry, so the
 * boot chunk stays small; a named glyph that is still loading keeps its box empty rather than flash the kind glyph.
 */
export function PageIcon({ icon, kind = "doc", size = 18, className }: PageIconProps) {
  const box = { width: size, height: size };
  const want = requestedGlyph(icon);
  const Named = useLucide(want ?? undefined);
  const px = Math.round(size * 0.89);
  if (icon?.t === "asset") {
    return (
      <span className={cn("emp-page-icon inline-flex flex-none", className)} style={box} aria-hidden>
        <AssetIcon assetId={icon.assetId} size={size} />
      </span>
    );
  }
  const waiting = !!want && !Named && iconSetPending();
  return (
    <span className={cn("emp-page-icon inline-flex flex-none items-center justify-center", className)} style={box} aria-hidden>
      {waiting ? null : <PageGlyphWith icon={Named ? icon : null} context="row" size={px} fallback="file" lookup={lookup} kindFallback={KIND_ICON[kind] ?? FileText} />}
    </span>
  );
}

const lookup = (name: string) => lucideByName(name);

export default PageIcon;
