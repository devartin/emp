import * as RP from "@radix-ui/react-popover";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useInOverlay } from "./layer";

/** Popover (docs/DESIGN.md §6.3): glass-1 (opaque inside dialogs), origin-aware scale+fade, padding 12 (16 for forms), radius 12. */
export const Popover = RP.Root;
export const PopoverTrigger = RP.Trigger;
export const PopoverAnchor = RP.Anchor;
export const PopoverClose = RP.Close;

export interface PopoverContentProps {
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  /** Form popovers use 16px padding. */
  form?: boolean;
  className?: string;
  style?: React.CSSProperties;
  /** Skip auto-focus on open (e.g. hover cards). */
  noAutoFocus?: boolean;
  onOpenAutoFocus?: (e: Event) => void;
  /** Elevated z-index for popovers opened inside dialogs (z 70). */
  inDialog?: boolean;
}

export function PopoverContent({ children, side = "bottom", align = "start", sideOffset = 6, form, className, style, noAutoFocus, onOpenAutoFocus, inDialog }: PopoverContentProps) {
  const inOverlay = useInOverlay() || inDialog;
  return (
    <RP.Portal>
      <RP.Content
        className={cn("emp-popover emp-pop", className)}
        data-form={form ? "" : undefined}
        data-opaque={inOverlay ? "" : undefined}
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        style={{ ...(inOverlay ? { zIndex: 70 } : null), ...style }}
        onOpenAutoFocus={noAutoFocus ? (e) => e.preventDefault() : onOpenAutoFocus}
      >
        {children}
      </RP.Content>
    </RP.Portal>
  );
}
