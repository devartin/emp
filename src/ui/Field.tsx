import { AlertCircle } from "lucide-react";
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface FieldProps {
  label?: ReactNode;
  /** Helper text below the control (tertiary). */
  helper?: ReactNode;
  /** Error message — replaces helper, loss colour, alert icon (§5.2). */
  error?: ReactNode;
  required?: boolean;
  /** Extra element on the label row (e.g. a link). */
  labelAside?: ReactNode;
  className?: string;
  /** Render-prop receives ids so the control can wire aria-describedby / id. */
  children: (ids: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
  id?: string;
}

/** Label (12/16 500 secondary, 6px above) + control + helper/error (6px below). */
export function Field({ label, helper, error, required, labelAside, className, children, id: idProp }: FieldProps) {
  const auto = useId();
  const id = idProp ?? `f${auto}`;
  const helpId = `${id}-help`;
  const hasHelp = !!(error || helper);
  return (
    <div className={cn("emp-field", className)}>
      {label ? (
        <div className="flex items-center justify-between gap-2">
          <label className="emp-label" htmlFor={id}>
            {label}
            {required ? <span className="emp-label-required">Required</span> : null}
          </label>
          {labelAside}
        </div>
      ) : null}
      {children({ id, describedBy: hasHelp ? helpId : undefined, invalid: !!error })}
      {hasHelp ? (
        <div id={helpId} className="emp-helper" data-invalid={error ? "" : undefined} role={error ? "alert" : undefined}>
          {error ? <AlertCircle aria-hidden /> : null}
          <span>{error ?? helper}</span>
        </div>
      ) : null}
    </div>
  );
}
