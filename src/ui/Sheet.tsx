import * as RD from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { IconButton } from "./IconButton";
import { OverlayLayer } from "./layer";
import { presets } from "./motion/presets";

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
  /** 480 default, 720 for wizards (§5.7). */
  size?: "default" | "wizard";
  header?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** Show the dimming scrim (side peek can opt out). */
  scrim?: boolean;
  dismissible?: boolean;
}

/** Sheet / side peek (§5.7, §4.2): from the right, inset 8, radius 14; x 100%→0 spring.gentle, exit 180ms ease.in. */
export function Sheet({ open, onOpenChange, title, description, size = "default", header, footer, children, className, bodyClassName, scrim = true, dismissible = true }: SheetProps) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange} modal={scrim}>
      <AnimatePresence>
        {open ? (
          <RD.Portal forceMount key="sheet">
            {scrim ? (
              <RD.Overlay asChild forceMount>
                <m.div className="emp-scrim" {...presets.scrim} />
              </RD.Overlay>
            ) : null}
            <RD.Content
              asChild
              forceMount
              onEscapeKeyDown={(e) => !dismissible && e.preventDefault()}
              onPointerDownOutside={(e) => (!dismissible || !scrim) && e.preventDefault()}
            >
              <m.div className={cn("emp-sheet", className)} data-size={size === "wizard" ? "wizard" : undefined} {...presets.sheetPanel}>
                <OverlayLayer.Provider value>
                  {header ?? (
                    <div className="emp-sheet-header">
                      <div className="flex items-start gap-3 pr-8">
                        <div className="flex flex-col gap-1 min-w-0">
                          <RD.Title className="emp-dialog-title">{title ?? "Panel"}</RD.Title>
                          {description ? <RD.Description className="emp-dialog-desc">{description}</RD.Description> : null}
                        </div>
                      </div>
                    </div>
                  )}
                  {header && !title ? <RD.Title className="sr-only">Panel</RD.Title> : null}
                  <div className={cn("emp-sheet-body", bodyClassName)}>{children}</div>
                  {footer ? <div className="emp-sheet-footer">{footer}</div> : null}
                  <RD.Close asChild>
                    <IconButton className="emp-dialog-close" icon={X} label="Close" size="sm" noTooltip />
                  </RD.Close>
                </OverlayLayer.Provider>
              </m.div>
            </RD.Content>
          </RD.Portal>
        ) : null}
      </AnimatePresence>
    </RD.Root>
  );
}
