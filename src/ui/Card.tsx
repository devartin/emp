import type { HTMLAttributes, KeyboardEvent, ReactNode, Ref } from "react";
import { cn } from "@/lib/cn";
import { EdgeLight } from "./motion/EdgeLight";

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Header trailing actions. */
  actions?: ReactNode;
  icon?: ReactNode;
  pad?: "none" | "md" | "lg";
  flat?: boolean;
  /** Interactive plate: lifts 2px with a pre-baked raise shadow on hover, presses to .99 (CSS, §4.5). */
  interactive?: boolean;
  /** Pointer-tracked edge light (hero cards, widgets, KPI tiles — never rows). */
  light?: boolean;
  /** Broad specular wash under the pointer (hero cards and KPI only). Implies `light`. */
  specular?: boolean;
  /** Pointer tilt, at most 3° (KPI tiles, gallery tiles, choice cards). */
  tilt?: boolean;
  ref?: Ref<HTMLDivElement>;
}

/**
 * Card — a machined panel (docs/DESIGN.md §4.5, §6.3): top-lit gradient, inner highlight, rim, grain and a soft
 * contact shadow. Radius 14, padding 16 (compact 12, large 20), header 15/22 600.
 */
export function Card({ title, subtitle, actions, icon, pad = "md", flat, interactive, light, specular, tilt, className, children, onClick, onKeyDown, ref, ...rest }: CardProps) {
  const lit = light || specular;
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
      data-flat={flat ? "" : undefined}
      data-interactive={interactive ? "" : undefined}
      data-raise={interactive ? "" : undefined}
      data-light={lit ? "" : undefined}
      data-specular={specular ? "" : undefined}
      data-tilt={tilt && interactive ? "3" : undefined}
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
      {lit ? <EdgeLight specular={specular} /> : null}
      {header}
      {children}
    </div>
  );
}
