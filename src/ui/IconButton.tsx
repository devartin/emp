import type { ReactNode } from "react";
import { Button, type ButtonProps, type IconComponent } from "./Button";
import { Tooltip } from "./Tooltip";

export interface IconButtonProps extends Omit<ButtonProps, "children" | "icon" | "iconRight" | "kbd" | "tooltip"> {
  icon: IconComponent | ReactNode;
  /** Accessible name; also the tooltip text. */
  label: string;
  /** Shortcut shown in the tooltip. */
  shortcut?: string;
  /** Hide the tooltip (label stays as aria-label). */
  noTooltip?: boolean;
  tooltipSide?: "top" | "right" | "bottom" | "left";
}

/** Square icon-only button (§5.1) with a tooltip carrying label + shortcut. Press scales to 0.92. */
export function IconButton({ icon, label, shortcut, noTooltip, tooltipSide, variant = "ghost", size = "md", ...rest }: IconButtonProps) {
  const btn = <Button {...rest} variant={variant} size={size} icon={icon} aria-label={label} />;
  if (noTooltip || rest.disabled) return btn;
  return (
    <Tooltip content={label} shortcut={shortcut} side={tooltipSide}>
      {btn}
    </Tooltip>
  );
}
