import { AnimatePresence, m } from "motion/react";
import { isValidElement, useEffect, useRef, useState, type ButtonHTMLAttributes, type ComponentType, type MouseEvent, type ReactNode, type Ref } from "react";
import { cn } from "@/lib/cn";
import { Kbd } from "./Kbd";
import { Spinner } from "./Spinner";
import { Tooltip } from "./Tooltip";
import { ease } from "./motion/tokens";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "soft" | "destructive" | "destructive-ghost" | "link";
export type ButtonSize = "xs" | "sm" | "md" | "lg" | "xl";
export type IconComponent = ComponentType<{ className?: string; size?: number | string; strokeWidth?: number | string; "aria-hidden"?: boolean }>;
/** Opt-in icon micro-motions on hover (docs/DESIGN.md §5.7). Never use inside menus, tables or sidebars. */
export type IconMotion = "plus" | "arrow" | "trash" | "bell" | "download" | "settings" | "refresh" | "search" | "sparkle" | "upload" | "send";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon (lucide component or element). */
  icon?: IconComponent | ReactNode;
  /** Trailing icon. */
  iconRight?: IconComponent | ReactNode;
  /** Trailing shortcut hint — an inline mini keycap that depresses with the real key. */
  kbd?: string;
  loading?: boolean;
  /** Controlled success morph: flips to a drawn check for 1200ms whenever this becomes true. */
  success?: boolean;
  /** When onClick returns a promise: show loading while pending, then the success morph. */
  successFeedback?: boolean;
  /** Tooltip explaining why the button is disabled (wraps it in a focusable span, §5.1). */
  disabledReason?: ReactNode;
  /** Tooltip for enabled state. */
  tooltip?: ReactNode;
  block?: boolean;
  /** Latched (toolbars, toggles): the key stays half-down. */
  active?: boolean;
  /** Hover micro-motion for the leading icon (§5.7). */
  iconMotion?: IconMotion;
  /** Sheen sweep on hover — defaults to on for primary lg/xl (§4.6). */
  sheen?: boolean;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => unknown;
  ref?: Ref<HTMLButtonElement>;
}

export function renderIcon(icon: IconComponent | ReactNode | undefined) {
  if (!icon) return null;
  if (isValidElement(icon) || typeof icon === "string" || typeof icon === "number") return icon as ReactNode;
  if (typeof icon === "function" || (typeof icon === "object" && "$$typeof" in (icon as object))) {
    const I = icon as IconComponent;
    return <I aria-hidden />;
  }
  return icon as ReactNode;
}

/**
 * Button — a tactile keycap (docs/DESIGN.md §4.2, §6.1). Seven variants × five sizes on the `.slab` recipe: the face
 * lifts 1px on hover, seats onto its side in 70ms on press (pure CSS, 1-frame feedback) and springs back with 11%
 * overshoot. `active` latches it half-down. Loading fades the label behind a spinner; success lifts the label out and
 * draws a check. Primary lg/xl buttons get a one-shot sheen sweep on hover.
 */
export function Button({
  variant = "secondary",
  size = "md",
  icon,
  iconRight,
  kbd,
  loading,
  success,
  successFeedback,
  disabledReason,
  tooltip,
  block,
  active,
  iconMotion,
  sheen,
  className,
  children,
  disabled,
  onClick,
  type = "button",
  ref,
  ...rest
}: ButtonProps) {
  const [pending, setPending] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(timer.current);
    };
  }, []);

  const flashSuccess = () => {
    setShowSuccess(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => mounted.current && setShowSuccess(false), 1200 + 280);
  };
  const prevSuccess = useRef(success);
  useEffect(() => {
    if (success && !prevSuccess.current) flashSuccess();
    prevSuccess.current = success;
  }, [success]);

  const busy = !!loading || pending;
  const iconOnly = !children && !!icon;
  const withSheen = sheen ?? (variant === "primary" && (size === "lg" || size === "xl"));

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (busy) {
      e.preventDefault();
      return;
    }
    const r = onClick?.(e);
    if (r && typeof (r as Promise<unknown>).then === "function") {
      setPending(true);
      (r as Promise<unknown>).then(
        () => {
          if (!mounted.current) return;
          setPending(false);
          if (successFeedback) flashSuccess();
        },
        () => mounted.current && setPending(false),
      );
    }
  };

  const btn = (
    <button
      ref={ref}
      type={type}
      className={cn("emp-btn", variant !== "link" && "slab", className)}
      data-variant={variant}
      data-size={size}
      data-icon-only={iconOnly ? "" : undefined}
      data-lead-icon={icon && !iconOnly ? "" : undefined}
      data-block={block ? "" : undefined}
      data-active={active ? "" : undefined}
      data-success={showSuccess ? "" : undefined}
      data-icon-motion={iconMotion}
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={handleClick}
      {...rest}
    >
      {withSheen ? (
        <span className="emp-btn-sheen-clip" aria-hidden>
          <span className="emp-btn-sheen" />
        </span>
      ) : null}
      <span className="emp-btn-label">
        {renderIcon(icon)}
        {children}
        {renderIcon(iconRight)}
        {kbd ? <Kbd keys={kbd} size="xs" className="emp-btn-kbd" /> : null}
      </span>
      {busy ? (
        <span className="emp-btn-overlay" data-kind="spinner">
          <Spinner size={size === "xs" || size === "sm" ? 14 : 16} />
        </span>
      ) : null}
      <AnimatePresence>
        {showSuccess && !busy ? (
          <m.span
            key="ok"
            className="emp-btn-overlay"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.16, ease: ease.out } }}
            exit={{ opacity: 0, transition: { duration: 0.16 } }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <m.path d="M5 12.5l4.5 4.5L19 7.5" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.28, ease: ease.out, delay: 0.06 }} />
            </svg>
            <span className="sr-only">Done</span>
          </m.span>
        ) : null}
      </AnimatePresence>
    </button>
  );

  if (disabled && disabledReason) {
    return (
      <Tooltip content={disabledReason}>
        <span className="emp-btn-wrap" tabIndex={0} data-block={block ? "" : undefined}>
          {btn}
        </span>
      </Tooltip>
    );
  }
  if (tooltip) return <Tooltip content={tooltip}>{btn}</Tooltip>;
  return btn;
}
