import { m } from "motion/react";
import type { HTMLAttributes, KeyboardEvent, ReactNode, Ref } from "react";
import { cn } from "@/lib/cn";
import { spring } from "./motion/tokens";
import { useReducedMotionPref } from "./motion/useReducedEffects";

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, "title" | "onDrag" | "onDragStart" | "onDragEnd" | "onAnimationStart"> {
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Header trailing actions. */
  actions?: ReactNode;
  icon?: ReactNode;
  pad?: "none" | "md" | "lg";
  flat?: boolean;
  /** Hover lift (y −1, elev-1→2 via pseudo-element) + press scale .985 (§4.2). */
  interactive?: boolean;
  ref?: Ref<HTMLDivElement>;
}

/** Card (§5.10): radius 14, surface-1, 1px subtle border, elev-1, padding 16 (compact 12, large 20), header gap 12. */
export function Card({ title, subtitle, actions, icon, pad = "md", flat, interactive, className, children, onClick, ref, ...rest }: CardProps) {
  const reduced = useReducedMotionPref();
  const header =
    title || actions ? (
      <div className="emp-card-header">
        {icon}
        <div className="flex flex-col min-w-0 flex-1">
          {title ? <h3 className="emp-card-title truncate">{title}</h3> : null}
          {subtitle ? <span className="emp-card-sub truncate">{subtitle}</span> : null}
        </div>
        {actions ? <div className="flex items-center gap-1 -my-1 -mr-1">{actions}</div> : null}
      </div>
    ) : null;
  if (interactive) {
    return (
      <m.div
        ref={ref}
        role={onClick ? "button" : undefined}
        tabIndex={onClick ? 0 : undefined}
        className={cn("emp-card", className)}
        data-pad={pad === "md" ? undefined : pad}
        data-flat={flat ? "" : undefined}
        data-interactive=""
        whileTap={reduced ? undefined : { scale: 0.985 }}
        transition={spring.snappy}
        onClick={onClick}
        onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
          if (onClick && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            (e.currentTarget as HTMLDivElement).click();
          }
        }}
        {...(rest as object)}
      >
        {header}
        {children}
      </m.div>
    );
  }
  return (
    <div ref={ref} className={cn("emp-card", className)} data-pad={pad === "md" ? undefined : pad} data-flat={flat ? "" : undefined} onClick={onClick} {...rest}>
      {header}
      {children}
    </div>
  );
}
