/**
 * Building blocks for settings sections (1.0 brief §2.4): a section header, groups of rows, the row layout (label and
 * description on the left, control on the right) and the one "More options" disclosure each section ends with. Rows
 * carry `data-setting` so search and deep links can scroll to them and flash them.
 *
 * More options: the caret turns in 120ms and the body opens in 160ms (grid rows + opacity, the same recipe as the
 * sidebar sections, register `disclosureCaret` / `sectionExpand`); reduced motion makes both instant. Its open state
 * lives in `useSettingsUi`, so search and deep links can open it before they scroll.
 */
import { ChevronRight } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { create } from "zustand";
import { cn } from "@/lib/cn";
import type { SectionId } from "./meta";

interface SettingsUi {
  more: Partial<Record<SectionId, boolean>>;
  setMore(section: SectionId, open: boolean): void;
}

export const useSettingsUi = create<SettingsUi>()((set) => ({
  more: {},
  setMore: (section, open) => set((s) => ({ more: { ...s.more, [section]: open } })),
}));

export function SectionHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="st-header">
      <div className="min-w-0 flex-1">
        <h2 className="st-title">{title}</h2>
        {description ? <p className="st-desc">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-none items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function Group({ title, description, actions, children, className, id }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section className={cn("st-group", className)} data-setting={id} aria-label={typeof title === "string" ? title : undefined}>
      {title || actions ? (
        <div className="st-group-head">
          <div className="min-w-0 flex-1">
            {title ? <h3 className="st-group-title">{title}</h3> : null}
            {description ? <p className="st-group-desc">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-none items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className="st-card">{children}</div>
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
  badge?: ReactNode;
  className?: string;
}

export function Row({ id, label, description, children, htmlFor, stacked, badge, className }: RowProps) {
  return (
    <div className={cn("st-row", stacked && "is-stacked", className)} data-setting={id}>
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

/** A block inside a card that isn't a label/control row (previews, lists, progress). */
export function Block({ children, className, id }: { children: ReactNode; className?: string; id?: string }) {
  return (
    <div className={cn("st-block", className)} data-setting={id}>
      {children}
    </div>
  );
}

export function Hint({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("st-hint", className)}>{children}</p>;
}

/** The one "More options" disclosure at the bottom of a section. Closed by default; search and deep links open it. */
export function MoreOptions({ section, children, label = "More options" }: { section: SectionId; children: ReactNode; label?: string }) {
  const open = useSettingsUi((s) => !!s.more[section]);
  const setMore = useSettingsUi((s) => s.setMore);
  const id = useId();
  // Mounted on first open (its panels load data), then kept so closing can animate.
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  return (
    <div className="st-more" data-open={open ? "" : undefined}>
      <button type="button" className="st-more-toggle" aria-expanded={open} aria-controls={id} onClick={() => setMore(section, !open)}>
        <ChevronRight size={14} strokeWidth={2} className="st-more-caret" aria-hidden />
        {label}
      </button>
      <div className="st-more-body" id={id} data-closed={open ? undefined : ""} inert={!open}>
        <div className="st-more-inner">{open || mounted ? children : null}</div>
      </div>
    </div>
  );
}
