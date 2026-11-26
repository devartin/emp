import * as RD from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { animate, AnimatePresence, m, usePresence } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactElement, type ReactNode, type Ref, type RefObject } from "react";
import { cn } from "@/lib/cn";
import { pauseFrameMonitor } from "@/lib/perf";
import { IconButton } from "./IconButton";
import { OverlayLayer } from "./layer";
import { originTransform, resolveOrigin, type Origin } from "./motion/origin";
import { presets } from "./motion/presets";
import { ease, spring } from "./motion/tokens";
import { isReducedEffects, isReducedMotion } from "./motion/useReducedEffects";

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

function rectVisible(r: DOMRect) {
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
}

type PanelProps = HTMLAttributes<HTMLDivElement> & { originEl?: Element | null; kind: "dialog" | "sheet"; ref?: Ref<HTMLDivElement> };

/**
 * The origin-aware panel (§5.4.1). Enter: translate+scale from the trigger centre → none on `settle`, opacity in the
 * first 120ms; content rows rise at 16ms after 80ms (CSS `[data-entering]`). Exit reverses into the trigger if it is
 * still connected and visible, else scale .97 + fade (150ms ease-in). No origin → `drop` (y 14, scale .955, blur 6).
 */
export function OriginPanel({ originEl, kind, className, children, ref, ...rest }: PanelProps) {
  const [isPresent, safeToRemove] = usePresence();
  const node = useRef<HTMLDivElement | null>(null);
  const origin = useRef<Origin | null>(null);
  const [entering, setEntering] = useState(true);

  const setRef = (el: HTMLDivElement | null) => {
    node.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) (ref as { current: HTMLDivElement | null }).current = el;
  };

  useLayoutEffect(() => {
    const el = node.current;
    if (!el) return;
    const t = window.setTimeout(() => setEntering(false), 700);
    if (isReducedMotion()) {
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140, easing: "linear" });
      return () => window.clearTimeout(t);
    }
    if (kind === "sheet") {
      animate(el, { x: ["100%", "0%"] }, spring.settle);
      return () => window.clearTimeout(t);
    }
    const o = resolveOrigin(originEl);
    origin.current = o;
    // Hold the start pose for the first (expensive) frame, then run the springs from the next frame so the growth is
    // never swallowed by mount cost.
    let raf = 0;
    if (o) {
      const tr = originTransform(o, el.getBoundingClientRect());
      el.style.opacity = "0";
      el.style.transform = `translate(${tr.x}px, ${tr.y}px) scale(${tr.scale})`;
      raf = requestAnimationFrame(() => {
        el.style.transform = "";
        animate(el, { x: [tr.x, 0], y: [tr.y, 0], scale: [tr.scale, 1] }, spring.settle);
        animate(el, { opacity: [0, 1] }, { duration: 0.12, ease: ease.out });
      });
    } else {
      const blur = !isReducedEffects();
      el.style.opacity = "0";
      raf = requestAnimationFrame(() => {
        animate(el, { y: [14, 0], scale: [0.955, 1] }, spring.settle);
        animate(el, blur ? { opacity: [0, 1], filter: ["blur(6px)", "blur(0px)"] } : { opacity: [0, 1] }, { duration: 0.2, ease: ease.out });
      });
    }
    return () => {
      // StrictMode re-runs this effect: never leave the start pose behind (it would skew the next measurement).
      window.clearTimeout(t);
      cancelAnimationFrame(raf);
      el.style.transform = "";
      el.style.opacity = "";
    };
    // mount-only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isPresent) return;
    const el = node.current;
    if (!el) {
      safeToRemove?.();
      return;
    }
    let done: Promise<unknown>;
    if (isReducedMotion()) {
      done = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: "forwards" }).finished;
    } else if (kind === "sheet") {
      done = Promise.resolve(animate(el, { x: "100%" }, { duration: 0.18, ease: ease.in }));
    } else {
      const o = origin.current;
      const live = o?.el && o.el.isConnected ? o.el.getBoundingClientRect() : null;
      if (o && live && rectVisible(live)) {
        el.style.filter = "none";
        const tr = originTransform({ el: o.el, rect: live }, el.getBoundingClientRect());
        done = Promise.all([
          animate(el, { x: tr.x, y: tr.y, scale: tr.scale }, { duration: 0.2, ease: ease.in }),
          animate(el, { opacity: 0 }, { duration: 0.12, delay: 0.08, ease: ease.in }),
        ]);
      } else {
        done = Promise.resolve(animate(el, { opacity: 0, scale: 0.97 }, { duration: 0.15, ease: ease.in }));
      }
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
