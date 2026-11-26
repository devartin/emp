/**
 * Renders a page `Icon` (§11.2): emoji, lucide (optionally tinted with a block colour or the accent) or an uploaded
 * asset. Pages without an icon get a kind-specific default glyph in tertiary colour.
 */
import { Database, FileText, LayoutDashboard, Sheet, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/backend";
import type { Icon, Id, PageKind } from "@/backend/types";
import { cn } from "@/lib/cn";
import { lucideByName } from "./icons";

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
  app: Sparkles,
  dashboard: LayoutDashboard,
};

export interface PageIconProps {
  icon?: Icon;
  kind?: PageKind;
  /** Glyph box size in px (sidebar 18, breadcrumbs 16, headers 20+). */
  size?: number;
  className?: string;
}

export function PageIcon({ icon, kind = "doc", size = 18, className }: PageIconProps) {
  const box = { width: size, height: size, fontSize: Math.round(size * 0.86), lineHeight: `${size}px` };
  if (icon?.t === "emoji") {
    return (
      <span className={cn("emp-page-icon inline-flex flex-none items-center justify-center", className)} style={box} aria-hidden>
        {icon.v}
      </span>
    );
  }
  if (icon?.t === "asset") {
    return (
      <span className={cn("emp-page-icon inline-flex flex-none", className)} style={box} aria-hidden>
        <AssetIcon assetId={icon.assetId} size={size} />
      </span>
    );
  }
  const L = (icon?.t === "lucide" ? lucideByName(icon.v) : null) ?? KIND_ICON[kind] ?? FileText;
  const color =
    icon?.t === "lucide" && icon.color
      ? icon.color === "accent"
        ? "var(--accent-text)"
        : `var(--block-${icon.color}-text)`
      : undefined;
  return (
    <span className={cn("emp-page-icon inline-flex flex-none items-center justify-center text-tertiary", className)} style={{ ...box, color }} aria-hidden>
      <L size={Math.round(size * 0.86)} strokeWidth={1.75} />
    </span>
  );
}

export default PageIcon;
