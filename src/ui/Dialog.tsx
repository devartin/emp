import * as RD from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { animate, AnimatePresence, m, usePresence } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactElement, type ReactNode, type Ref, type RefObject } from "react";
import { cn } from "@/lib/cn";
import { pauseFrameMonitor } from "@/lib/perf";
import { IconButton } from "./IconButton";
import { OverlayLayer } from "./layer";
import { presets } from "./motion/presets";
import { ease, spring } from "./motion/tokens";
import { isReducedMotion } from "./motion/useReducedEffects";

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
  /**
   * The element the dialog grows from and closes back into. Defaults to the control pressed just before opening;
   * without one (keyboard shortcut, off-screen trigger) the dialog drops in from above.
   */
  originRef?: RefObject<Element | null>;
}


type PanelProps = HTMLAttributes<HTMLDivElement> & { originEl?: Element | null; kind: "dialog" | "sheet"; ref?: Ref<HTMLDivElement> };

/** True when the last input was the keyboard (MotionProvider sets html[data-input]). */
const keyboardInvoked = () => typeof document !== "undefined" && document.documentElement.getAttribute("data-input") === "keyboard";

/**
 * The dialog / sheet panel (docs/DESIGN.md §7, register.ts). Opened from the keyboard (⌘K, menu keys) it appears at
 * once (C0). Opened with the pointer, a dialog fades in and settles from .98 in 160ms and a sheet slides in over
 * 200ms (C2, ease-out, no overshoot, no blur). Exit: 100ms fade (sheets slide out in 140ms). Content never staggers.
 * Reduced motion: a 120ms crossfade. `originEl` is accepted for API compatibility; panels no longer grow from it.
 */
export function OriginPanel({ originEl: _origin, kind, className, children, ref, ...rest }: PanelProps) {
  void _origin;
  const [isPresent, safeToRemove] = usePresence();
  const node = useRef<HTMLDivElement | null>(null);
  const [entering, setEntering] = useState(true);
  const instant = useRef(false);

  const setRef = (el: HTMLDivElement | null) => {
    node.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) (ref as { current: HTMLDivElement | null }).current = el;
  };

  useLayoutEffect(() => {
    const el = node.current;
    if (!el) return;
    const t = window.setTimeout(() => setEntering(false), 250);
    instant.current = keyboardInvoked();
    if (instant.current) return () => window.clearTimeout(t);
    if (isReducedMotion()) {
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: "linear" });
      return () => window.clearTimeout(t);
    }
    if (kind === "sheet") {
      animate(el, { x: ["100%", "0%"] }, spring.settle);
      return () => window.clearTimeout(t);
    }
    animate(el, { opacity: [0, 1], scale: [0.98, 1] }, { duration: 0.16, ease: ease.out });
    return () => window.clearTimeout(t);
    // mount-only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isPresent) return;
    const el = node.current;
    if (!el || keyboardInvoked()) {
      safeToRemove?.();
      return;
    }
    let done: Promise<unknown>;
    if (isReducedMotion()) {
      done = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 100, fill: "forwards" }).finished;
    } else if (kind === "sheet") {
      done = Promise.resolve(animate(el, { x: "100%" }, { duration: 0.14, ease: ease.in }));
    } else {
      done = Promise.resolve(animate(el, { opacity: 0, scale: 0.99 }, { duration: 0.1, ease: ease.in }));
    }
    done.catch(() => undefined).finally(() => safeToRemove?.());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPresent]);

  return (
    <div ref={setRef} className={className} data-entering={entering ? "" : undefined} {...rest}>
      {children}
    </div>
  );
}

/**
 * Dialog (docs/DESIGN.md §6.3): glass-2, radius 14, padding 20. Grows from its trigger (origin-aware), closes back into
 * it; scrim is an opacity fade (300ms in, 150ms out) with no blur. Positioned 12vh from the top (alerts centred).
 * Initial focus: first `[data-autofocus]`, else first input.
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
  originRef,
}: DialogProps) {
  const [inner, setInner] = useState(false);
  const open = openProp ?? inner;
  // Opening an overlay is one-off heavy work (mount, focus, blur layer) — not animation jank (§4.4 frame monitor).
  useEffect(() => {
    if (open) pauseFrameMonitor();
  }, [open]);
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
              <m.div className="emp-scrim" {...presets.scrim} initial={keyboardInvoked() ? false : presets.scrim.initial} />
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
                <OriginPanel kind="dialog" originEl={originRef?.current} className={cn("emp-dialog", className)} data-size={size}>
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
                </OriginPanel>
              </RD.Content>
            </div>
          </RD.Portal>
        ) : null}
      </AnimatePresence>
    </RD.Root>
  );
}

export const DialogClose = RD.Close;
