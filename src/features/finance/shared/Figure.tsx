/**
 * "Why this number" (N-MO3): the figure itself is the disclosure. Clicking (or Enter/Space on) a headline number opens
 * a kit Popover with its one label, its one definition and the inputs it was computed from — there is no separate
 * "Show math" button anywhere. Label and definition come from the registry (shared/definitions.ts).
 *
 * The trigger keeps the number's own typography; only a dotted underline on hover/focus says it can be opened.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/Popover";
import { FIGURES, figureLabel, type FigureId } from "./definitions";

export interface FigureInput {
  label: ReactNode;
  value: ReactNode;
  /** Mask under Hide numbers (money). Default true. */
  sensitive?: boolean;
}

export interface FigureProps {
  id: FigureId;
  /** The rendered value: the trigger. */
  children: ReactNode;
  /** The inputs behind the value, shown as rows. */
  inputs?: FigureInput[];
  /** Fills a range figure's label ("Time-weighted · 1Y"). */
  range?: string;
  /** Extra plain sentence after the definition (e.g. what is not in net worth). */
  note?: ReactNode;
  /** Optional link-style action at the foot ("See transactions"). */
  action?: { label: string; onSelect: () => void };
  className?: string;
  /** Block-level trigger (a whole hero value) instead of inline. */
  block?: boolean;
}

export function Figure({ id, children, inputs, range, note, action, className, block }: FigureProps) {
  const label = figureLabel(id, range);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={cn("fh-figure", block && "fh-figure-block", className)} aria-haspopup="dialog" data-figure={id}>
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="fh-figure-pop">
        <div className="fh-figure-title">{label}</div>
        <p className="fh-figure-def">{FIGURES[id].definition}</p>
        {note ? <p className="fh-figure-def">{note}</p> : null}
        {inputs?.length ? (
          <dl className="fh-figure-inputs">
            {inputs.map((x, i) => (
              <div key={i}>
                <dt>{x.label}</dt>
                <dd className="tabular" data-sensitive={x.sensitive === false ? undefined : ""}>
                  {x.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        {action ? (
          <button type="button" className="fh-figure-action" onClick={action.onSelect}>
            {action.label}
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
