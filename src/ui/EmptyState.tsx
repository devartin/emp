import { Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Button, renderIcon, type IconComponent } from "./Button";

export interface EmptyStateProps {
  icon: IconComponent | ReactNode;
  title: ReactNode;
  body?: ReactNode;
  actions?: ReactNode;
  /** Life-app contexts: "Set it up for me" (primary, sparkles) + "Start blank" (ghost) (§5.10). */
  lifeApp?: { onSetup: () => void; onBlank: () => void };
  /** Aurora hero background (empty-state heroes only). */
  hero?: boolean;
  className?: string;
}

/** Empty state (§5.10): max-width 360, 48px accent-soft icon tile with an 8px glow, title 15/22 600, body 14/20. */
export function EmptyState({ icon, title, body, actions, lifeApp, hero, className }: EmptyStateProps) {
  const content = (
    <div className={cn("emp-empty", !hero && className)}>
      <div className="emp-empty-icon">{renderIcon(icon)}</div>
      <h3 className="emp-empty-title">{title}</h3>
      {body ? <p className="emp-empty-body">{body}</p> : null}
      {actions || lifeApp ? (
        <div className="emp-empty-actions">
          {lifeApp ? (
            <>
              <Button variant="primary" icon={Sparkles} onClick={lifeApp.onSetup}>
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
  return <div className={cn("emp-aurora rounded-2xl px-6 overflow-hidden", className)}>{content}</div>;
}
