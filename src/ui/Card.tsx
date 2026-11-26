import type { HTMLAttributes, KeyboardEvent, ReactNode, Ref } from "react";
import { cn } from "@/lib/cn";

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Header trailing actions. */
  actions?: ReactNode;
  icon?: ReactNode;
  pad?: "none" | "md" | "lg";
  /** A quiet hairline frame (radius 10, no shadow). Use for the one container level a view may have. */
  framed?: boolean;
  /** @deprecated alias of `framed`. */
  flat?: boolean;
  /** Clickable: an instant ink wash on hover (no lift). */
  interactive?: boolean;
  /** @deprecated edge light is retired; ignored. */
  light?: boolean;
  /** @deprecated specular is retired; ignored. */
  specular?: boolean;
  /** @deprecated tilt is retired; ignored. */
  tilt?: boolean;
  ref?: Ref<HTMLDivElement>;
}

/**
 * Card — ruled, not boxed (docs/DESIGN.md §5.6, N-CR5). By default a section with no frame and no shadow: a 14/600
 * head over a hairline, then content. `framed` gives it a quiet hairline frame (radius 10). A card inside a card or a
 * panel loses its frame automatically, so a view never nests containers.
 */
export function Card({ title, subtitle, actions, icon, pad = "md", framed, flat, interactive, light: _l, specular: _s, tilt: _t, className, children, onClick, onKeyDown, ref, ...rest }: CardProps) {
  void _l;
  void _s;
  void _t;
  const header =
    title || actions ? (
      <div className="emp-card-header">
        {icon}
        <div className="flex flex-col min-w-0 flex-1">
          {title ? <h3 className="emp-card-title truncate">{title}</h3> : null}
          {subtitle ? <span className="emp-card-sub truncate">{subtitle}</span> : null}
        </div>
        {actions ? <div className="emp-card-actions flex items-center gap-1 -my-1 -mr-1">{actions}</div> : null}
      </div>
    ) : null;
  const clickable = interactive && !!onClick;
  return (
    <div
      ref={ref}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      className={cn("emp-card panel", className)}
      data-pad={pad === "md" ? undefined : pad}
      data-framed={framed || flat ? "" : undefined}
      data-interactive={interactive ? "" : undefined}
      onClick={onClick}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        if (clickable && e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          e.currentTarget.click();
        }
        onKeyDown?.(e);
      }}
      {...rest}
    >
      {header}
      {children}
    </div>
  );
}
