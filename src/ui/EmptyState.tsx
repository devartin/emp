import { Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Button, renderIcon, type IconComponent } from "./Button";
import { SlabGlyph } from "./SlabGlyph";

export interface EmptyStateProps {
  icon: IconComponent | ReactNode;
  title: ReactNode;
  body?: ReactNode;
  actions?: ReactNode;
  /** Life-app contexts: "Set it up for me" (primary, sparkles) + "Start blank" (ghost) (§5.10). */
  lifeApp?: { onSetup: () => void; onBlank: () => void };
  /** Canvas-halo hero background (empty-state heroes only). */
  hero?: boolean;
  /**
   * "slab" (default): the animated isometric slab glyph on a 72px well disc, with `icon` on a small keycap badge.
   * "icon": just `icon` in a 48px well tile (compact contexts).
   */
  art?: "slab" | "icon";
  className?: string;
}

/**
 * Empty state (docs/DESIGN.md §6.3): max-width 360. The illustration is the EMP slab glyph on a recessed disc; on
 * mount its three slabs settle in from y −8 with a 60ms stagger and the context icon pops onto a keycap badge, then
 * title, body and actions rise in. Title 15/22 600, body 14/20 secondary; the primary action is a slab.
 */
export function EmptyState({ icon, title, body, actions, lifeApp, hero, art = "slab", className }: EmptyStateProps) {
  const content = (
    <div className={cn("emp-empty", !hero && className)}>
      {art === "slab" ? (
        <div className="emp-empty-disc" aria-hidden>
          <SlabGlyph size={38} animate />
          {icon ? <span className="emp-empty-badge">{renderIcon(icon)}</span> : null}
        </div>
      ) : (
        <div className="emp-empty-icon">{renderIcon(icon)}</div>
      )}
      <h3 className="emp-empty-title">{title}</h3>
      {body ? <p className="emp-empty-body">{body}</p> : null}
      {actions || lifeApp ? (
        <div className="emp-empty-actions">
          {lifeApp ? (
            <>
              <Button variant="primary" icon={Sparkles} iconMotion="sparkle" onClick={lifeApp.onSetup}>
                Set it up for me
              </Button>
              <Button variant="ghost" onClick={lifeApp.onBlank}>
                Start blank
              </Button>
            </>
          ) : null}
          {actions}
        </div>
      ) : null}
    </div>
  );
  if (!hero) return content;
  return <div className={cn("emp-empty-hero canvas-halo panel rounded-2xl px-6 overflow-hidden", className)}>{content}</div>;
}
