/**
 * Building blocks for settings sections: a section header, grouped cards of rows, and the row layout
 * (label + description on the left, control on the right). Rows carry `data-setting` so search and deep links can
 * scroll to them and flash them.
 */
import { m } from "motion/react";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { spring } from "@/ui/motion/tokens";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";

export function SectionHeader({ icon: Icon, title, description, actions }: { icon: LucideIcon; title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="st-header">
      <span className="st-header-icon" aria-hidden>
        <Icon size={20} strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <h1 className="st-title">{title}</h1>
        {description ? <p className="st-desc">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-none items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function Group({ title, description, actions, children, className, id, footer, flush, bare }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; id?: string; footer?: ReactNode; flush?: boolean; /** No card around the content (embedded panels that bring their own cards). */ bare?: boolean }) {
  return (
    <section className={cn("st-group", className)} data-setting={id} aria-label={typeof title === "string" ? title : undefined}>
      {title || actions ? (
        <div className="st-group-head">
          <div className="min-w-0 flex-1">
            {title ? <h2 className="st-group-title">{title}</h2> : null}
            {description ? <p className="st-group-desc">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-none items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {bare ? <div className="st-bare">{children}</div> : <div className={cn("st-card", flush && "is-flush")}>{children}</div>}
      {footer ? <div className="st-group-foot">{footer}</div> : null}
    </section>
  );
}

export interface RowProps {
  id?: string;
  label: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  htmlFor?: string;
  /** Stack the control under the label (wide controls). */
  stacked?: boolean;
  icon?: ReactNode;
  badge?: ReactNode;
  className?: string;
}

export function Row({ id, label, description, children, htmlFor, stacked, icon, badge, className }: RowProps) {
  return (
    <div className={cn("st-row", stacked && "is-stacked", className)} data-setting={id}>
      {icon ? <span className="st-row-icon">{icon}</span> : null}
      <div className="st-row-text">
        <div className="st-row-label">
          {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
          {badge}
        </div>
        {description ? <div className="st-row-desc">{description}</div> : null}
      </div>
      {children !== undefined ? <div className="st-row-control">{children}</div> : null}
    </div>
  );
}

/** A status chip (green / amber / neutral) that springs in when its state changes. */
export function StatusChip({ tone, children, icon: Icon }: { tone: "ok" | "warn" | "neutral" | "bad"; children: ReactNode; icon?: LucideIcon }) {
  const reduced = useReducedMotionPref();
  return (
    <m.span
      layout={reduced ? false : "position"}
      className="st-chip"
      data-tone={tone}
      initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={spring.ui}
    >
      {Icon ? <Icon size={13} strokeWidth={2.25} aria-hidden /> : <span className="st-chip-dot" aria-hidden />}
      {children}
    </m.span>
  );
}

export function Hint({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("st-hint", className)}>{children}</p>;
}
