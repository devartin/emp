import * as RD from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useState, type ReactElement, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { IconButton } from "./IconButton";
import { OverlayLayer } from "./layer";
import { presets } from "./motion/presets";

export type DialogSize = "sm" | "md" | "lg" | "xl" | "full";

export interface DialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Uncontrolled trigger element. */
  trigger?: ReactElement;
  title?: ReactNode;
  description?: ReactNode;
  /** Visually hide the title (still announced). */
  hideTitle?: boolean;
  size?: DialogSize;
  /** Alert dialogs are vertically centred and use role=alertdialog. */
  alert?: boolean;
  footer?: ReactNode;
  /** Split footer: first child left, rest right. */
  footerSplit?: boolean;
  closeButton?: boolean;
  /** Block outside-click / Esc dismissal (e.g. while a job runs). */
  dismissible?: boolean;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** Header icon slot (alert dialogs). */
  icon?: ReactNode;
}

/**
 * Dialog (§5.7, §4.2): scrim 180ms + blur(2px); panel opacity/scale 0.96→1/y 8→0 on spring.gentle, exit 140ms ease.in.
 * Positioned 12vh from the top (alerts centred). Initial focus: first `[data-autofocus]`, else first input.
 */
export function Dialog({
  open: openProp,
  onOpenChange,
  trigger,
  title,
  description,
  hideTitle,
  size = "md",
  alert,
  footer,
  footerSplit,
  closeButton = !alert,
  dismissible = true,
  children,
  className,
  bodyClassName,
  icon,
}: DialogProps) {
  const [inner, setInner] = useState(false);
  const open = openProp ?? inner;
  const setOpen = (v: boolean) => {
    if (openProp === undefined) setInner(v);
    onOpenChange?.(v);
  };
  return (
    <RD.Root open={open} onOpenChange={setOpen}>
      {trigger ? <RD.Trigger asChild>{trigger}</RD.Trigger> : null}
      <AnimatePresence>
        {open ? (
          <RD.Portal forceMount key="dlg">
            <RD.Overlay asChild forceMount>
              <m.div className="emp-scrim" {...presets.scrim} />
            </RD.Overlay>
            <div className="emp-dialog-pos" data-centered={alert ? "" : undefined}>
              <RD.Content
                asChild
                forceMount
                role={alert ? "alertdialog" : "dialog"}
                {...(description ? {} : { "aria-describedby": undefined })}
                onOpenAutoFocus={(e) => {
                  const root = e.currentTarget as HTMLElement | null;
                  const target =
                    root?.querySelector<HTMLElement>("[data-autofocus]") ??
                    root?.querySelector<HTMLElement>("input:not([type=hidden]):not([disabled]), textarea:not([disabled])");
                  if (target) {
                    e.preventDefault();
                    target.focus();
                  }
                }}
                onEscapeKeyDown={(e) => !dismissible && e.preventDefault()}
                onPointerDownOutside={(e) => !dismissible && e.preventDefault()}
                onInteractOutside={(e) => !dismissible && e.preventDefault()}
              >
                <m.div className={cn("emp-dialog", className)} data-size={size} {...presets.dialogPanel}>
                  <OverlayLayer.Provider value>
                    {title || description || icon ? (
                      <div className={cn("emp-dialog-header", hideTitle && "sr-only")}>
                        {icon}
                        {title ? <RD.Title className="emp-dialog-title">{title}</RD.Title> : null}
                        {description ? <RD.Description className="emp-dialog-desc">{description}</RD.Description> : null}
                      </div>
                    ) : (
                      <RD.Title className="sr-only">Dialog</RD.Title>
                    )}
                    {children !== undefined ? <div className={cn("emp-dialog-body", bodyClassName)}>{children}</div> : null}
                    {footer ? (
                      <div className="emp-dialog-footer" data-split={footerSplit ? "" : undefined}>
                        {footer}
                      </div>
                    ) : null}
                    {closeButton ? (
                      <RD.Close asChild>
                        <IconButton className="emp-dialog-close" icon={X} label="Close" size="sm" noTooltip />
                      </RD.Close>
                    ) : null}
                  </OverlayLayer.Provider>
                </m.div>
              </RD.Content>
            </div>
          </RD.Portal>
        ) : null}
      </AnimatePresence>
    </RD.Root>
  );
}

export const DialogClose = RD.Close;
