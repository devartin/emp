import { AnimatePresence, m, type HTMLMotionProps } from "motion/react";
import { isValidElement, useEffect, useRef, useState, type ButtonHTMLAttributes, type ComponentType, type MouseEvent, type ReactNode, type Ref } from "react";
import { cn } from "@/lib/cn";
import { Kbd } from "./Kbd";
import { Spinner } from "./Spinner";
import { Tooltip } from "./Tooltip";
import { spring, ease } from "./motion/tokens";
import { useReducedMotionPref } from "./motion/useReducedEffects";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "soft" | "destructive" | "destructive-ghost" | "link";
export type ButtonSize = "xs" | "sm" | "md" | "lg" | "xl";
export type IconComponent = ComponentType<{ className?: string; size?: number | string; strokeWidth?: number | string; "aria-hidden"?: boolean }>;

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon (lucide component or element). */
  icon?: IconComponent | ReactNode;
  /** Trailing icon. */
  iconRight?: IconComponent | ReactNode;
  /** Trailing shortcut hint. */
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
  /** Render as selected/active (toolbars). */
  active?: boolean;
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

/** Button (§5.1) — 7 variants × 5 sizes, spring press, loading + success morph, Kbd hint. */
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
  className,
  children,
  disabled,
  onClick,
  type = "button",
  ref,
  ...rest
}: ButtonProps) {
  const reduced = useReducedMotionPref();
  const [pending, setPending] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => () => {
    mounted.current = false;
    window.clearTimeout(timer.current);
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
  const press = reduced || variant === "link" ? undefined : { scale: size === "xs" || size === "sm" || iconOnly ? 0.92 : 0.97 };

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
    <m.button
      ref={ref}
      type={type}
      className={cn("emp-btn", className)}
      data-variant={variant}
      data-size={size}
      data-icon-only={iconOnly ? "" : undefined}
      data-lead-icon={icon && !iconOnly ? "" : undefined}
      data-block={block ? "" : undefined}
      data-active={active ? "" : undefined}
      data-success={showSuccess ? "" : undefined}
      aria-busy={busy || undefined}
      disabled={disabled}
      whileTap={press}
      transition={spring.snappy}
      onClick={handleClick}
      {...(rest as HTMLMotionProps<"button">)}
    >
      <span className="emp-btn-label">
        {renderIcon(icon)}
        {children}
        {renderIcon(iconRight)}
        {kbd ? <Kbd keys={kbd} /> : null}
      </span>
      {busy ? (
        <span className="emp-btn-overlay" data-kind="spinner">
          <Spinner size={16} />
        </span>
      ) : null}
      <AnimatePresence>
        {showSuccess && !busy ? (
          <m.span
            key="ok"
            className="emp-btn-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: 0.12 } }}
            exit={{ opacity: 0, transition: { duration: 0.16 } }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <m.path d="M5 12.5l4.5 4.5L19 7.5" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.28, ease: ease.out }} />
            </svg>
            <span className="sr-only">Done</span>
          </m.span>
        ) : null}
      </AnimatePresence>
    </m.button>
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
