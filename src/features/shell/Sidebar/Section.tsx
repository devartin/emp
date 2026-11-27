/**
 * A sidebar section (brief §2.1): a quiet header with a caret and an optional "+" that is always visible, and a body
 * that expands and collapses in 160ms (height + opacity; instant under reduced motion). The open state is remembered
 * per device in localStorage `emp.sb.<id>`.
 *
 * The body stays mounted while it collapses and unmounts after, so a collapsed section costs nothing. Expanding
 * mounts it at rest-closed, forces one style flush and opens it, so the transition never waits on a frame callback.
 */
import { ChevronRight, Plus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/ui/Tooltip";

/** Section expand / collapse (register: sectionExpand). */
const COLLAPSE_MS = 160;

export function useSectionOpen(id: string): [boolean, () => void] {
  const key = `emp.sb.${id}`;
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) !== "0";
    } catch {
      return true;
    }
  });
  const toggle = () =>
    setOpen((o) => {
      try {
        localStorage.setItem(key, o ? "0" : "1");
      } catch {
        /* storage unavailable */
      }
      return !o;
    });
  return [open, toggle];
}

export interface SectionProps {
  id: string;
  title: string;
  children: ReactNode;
  onAdd?: () => void;
  addLabel?: string;
  addShortcut?: string;
  className?: string;
  /** Extra attributes for drop targets. */
  "data-drop-favorites"?: string;
}

export function Section({ id, title, children, onAdd, addLabel, addShortcut, className, ...rest }: SectionProps) {
  const [open, toggle] = useSectionOpen(id);
  const [mounted, setMounted] = useState(open);
  const bodyRef = useRef<HTMLDivElement>(null);
  const animate = useRef(false);

  // Collapse: keep the body until the transition is over.
  useEffect(() => {
    if (open) return;
    const t = window.setTimeout(() => setMounted(false), COLLAPSE_MS + 20);
    return () => window.clearTimeout(t);
  }, [open]);

  // Expand: mount closed, flush, open (the transition is CSS; no frame callback involved).
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || !open || !animate.current) return;
    animate.current = false;
    el.setAttribute("data-entering", "");
    void el.getBoundingClientRect();
    el.removeAttribute("data-entering");
  }, [open, mounted]);

  const onToggle = () => {
    animate.current = !open;
    if (!open) setMounted(true);
    toggle();
  };

  const bodyId = `emp-sb-sec-${id}`;
  return (
    <section className={cn("emp-sb-section", className)} aria-label={title} data-section-id={id} {...rest}>
      <div className="emp-sb-head" data-collapsed={open ? undefined : ""}>
        <button type="button" className="emp-sb-head-toggle" onClick={onToggle} aria-expanded={open} aria-controls={mounted ? bodyId : undefined}>
          <span>{title}</span>
          <ChevronRight className="caret" aria-hidden />
        </button>
        {onAdd ? (
          <span className="actions">
            <Tooltip content={addLabel} shortcut={addShortcut}>
              <button type="button" className="emp-sb-mini" aria-label={addLabel} onClick={onAdd}>
                <Plus aria-hidden />
              </button>
            </Tooltip>
          </span>
        ) : null}
      </div>
      {mounted ? (
        <div ref={bodyRef} id={bodyId} className="emp-sb-sec-body" data-closed={open ? undefined : ""} inert={!open || undefined}>
          <div className="emp-sb-sec-inner">{children}</div>
        </div>
      ) : null}
    </section>
  );
}

/** The one quiet line an empty section shows: what goes there, and a click adds one. */
export function SectionEmpty({ label, hint, onClick, drop, section }: { label: string; hint?: string; onClick: () => void; drop?: boolean; section?: string }) {
  return (
    <button type="button" className="emp-sb-row emp-sb-empty" title={hint} onClick={onClick} data-drop-root={section ? "" : undefined} data-section={section} data-drop={drop ? "inside" : undefined}>
      <span className="ico">
        <Plus aria-hidden />
      </span>
      <span className="label">{label}</span>
    </button>
  );
}
