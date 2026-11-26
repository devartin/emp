import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Button, renderIcon, type IconComponent } from "./Button";

export interface EmptyStateProps {
  icon?: IconComponent | ReactNode;
  title: ReactNode;
  body?: ReactNode;
  actions?: ReactNode;
  /** Life-app contexts: "Set it up for me" (primary) + "Start blank" (ghost). */
  lifeApp?: { onSetup: () => void; onBlank: () => void };
  /** @deprecated the canvas-halo hero is retired; renders the plain empty state. */
  hero?: boolean;
  /** @deprecated the slab illustration is retired (the full Slab lives only in the app icon and on the lock screen). */
  art?: "slab" | "icon";
  className?: string;
}

/**
 * Empty state (docs/DESIGN.md §5.9): max-width 360. A 24px line glyph in tertiary ink (optional), a 14/600 title, one
 * sentence of 13/18 secondary body, and at most one key. Present at frame 1: nothing settles or rises in.
 */
export function EmptyState({ icon, title, body, actions, lifeApp, className }: EmptyStateProps) {
  return (
    <div className={cn("emp-empty", className)}>
      {icon ? (
        <div className="emp-empty-icon" aria-hidden>
          {renderIcon(icon)}
        </div>
      ) : null}
      <h3 className="emp-empty-title">{title}</h3>
      {body ? <p className="emp-empty-body">{body}</p> : null}
      {actions || lifeApp ? (
        <div className="emp-empty-actions">
          {lifeApp ? (
            <>
              <Button variant="primary" onClick={lifeApp.onSetup}>
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
}
