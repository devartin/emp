import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { renderIcon, type IconComponent } from "./Button";
import { IconButton } from "./IconButton";

export type BannerTone = "info" | "warning" | "danger" | "success" | "neutral";
const ICON: Record<BannerTone, IconComponent> = { info: Info, warning: AlertTriangle, danger: AlertCircle, success: CheckCircle2, neutral: Info };

export interface BannerProps {
  tone?: BannerTone;
  children: ReactNode;
  icon?: IconComponent | ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
  /** Rounded inline variant (inside cards/dialogs) instead of the full-bleed 40px bar. */
  inline?: boolean;
  className?: string;
}

/** Banner (§5.11): 40px, semantic soft background, 1px bottom border at .3 alpha, dismissible. */
export function Banner({ tone = "info", children, icon, action, onDismiss, inline, className }: BannerProps) {
  return (
    <div className={cn("emp-banner", inline && "py-2", className)} data-tone={tone === "info" ? undefined : tone} data-rounded={inline ? "" : undefined} role={tone === "danger" ? "alert" : "status"}>
      <span className="emp-banner-icon">{renderIcon(icon ?? ICON[tone])}</span>
      <div className="emp-banner-text">{children}</div>
      {action}
      {onDismiss ? <IconButton icon={X} label="Dismiss" size="xs" noTooltip onClick={onDismiss} /> : <span style={{ width: 6 }} />}
    </div>
  );
}
