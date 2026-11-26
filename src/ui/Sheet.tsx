import * as RD from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useRef, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { pauseFrameMonitor } from "@/lib/perf";
import { OriginPanel } from "./Dialog";
import { IconButton } from "./IconButton";
import { OverlayLayer } from "./layer";
import { presets } from "./motion/presets";
import { css } from "./motion/tokens";
import { isReducedMotion } from "./motion/useReducedEffects";

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

/**
 * Sheet / side peek (docs/DESIGN.md §6.3): glass-2 from the right, inset 8, radius 14; x 100% → 0 on `settle`, exit
 * 180ms ease-in; content rows rise at 16ms after 120ms. Drag the header right to dismiss (released on `drag`).
 */
export function Sheet({ open, onOpenChange, title, description, size = "default", header, footer, children, className, bodyClassName, scrim = true, dismissible = true }: SheetProps) {
  const panel = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x0: number; t0: number; dx: number } | null>(null);
  useEffect(() => {
    if (open) pauseFrameMonitor();
  }, [open]);

  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (!dismissible || e.button !== 0 || isReducedMotion() || (e.target as HTMLElement).closest("button, a, input, textarea, [role='button']")) return;
    drag.current = { x0: e.clientX, t0: performance.now(), dx: 0 };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || !panel.current) return;
    d.dx = Math.max(0, e.clientX - d.x0);
    panel.current.style.transform = `translateX(${d.dx}px)`;
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    const el = panel.current;
    if (!d || !el) return;
    const v = d.dx / Math.max(1, performance.now() - d.t0); // px/ms
    if (d.dx > el.offsetWidth * 0.35 || (v > 0.6 && d.dx > 24)) {
      onOpenChange(false);
      return;
    }
    el.animate([{ transform: `translateX(${d.dx}px)` }, { transform: "translateX(0)" }], { duration: 420, easing: css.easeOutExpo });
    el.style.transform = "";
  };

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
              <OriginPanel kind="sheet" ref={panel} className={cn("emp-sheet", className)} data-size={size === "wizard" ? "wizard" : undefined}>
                <OverlayLayer.Provider value>
                  {header ? (
                    <div onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
                      {header}
                    </div>
                  ) : (
                    <div className="emp-sheet-header" data-draggable={dismissible ? "" : undefined} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
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
              </OriginPanel>
            </RD.Content>
          </RD.Portal>
        ) : null}
      </AnimatePresence>
    </RD.Root>
  );
}
