import { useLayoutEffect, useRef, type ReactNode, type Ref, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { Field } from "./Field";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode;
  helper?: ReactNode;
  error?: ReactNode;
  minRows?: number;
  maxRows?: number;
  ref?: Ref<HTMLTextAreaElement>;
}

/** Auto-growing textarea, 3 → 12 rows (§5.2). */
export function Textarea({ label, helper, error, minRows = 3, maxRows = 12, className, required, id, ref, ...rest }: TextareaProps) {
  const el = useRef<HTMLTextAreaElement | null>(null);
  const resize = () => {
    const t = el.current;
    if (!t) return;
    const lh = parseFloat(getComputedStyle(t).lineHeight) || 20;
    t.style.height = "auto";
    const h = Math.min(Math.max(t.scrollHeight, lh * minRows), lh * maxRows);
    t.style.height = `${h}px`;
    t.style.overflowY = t.scrollHeight > lh * maxRows ? "auto" : "hidden";
  };
  useLayoutEffect(resize, [rest.value, minRows, maxRows]);

  const setRefs = (node: HTMLTextAreaElement | null) => {
    el.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) (ref as { current: HTMLTextAreaElement | null }).current = node;
  };

  const control = (ids: { id?: string; describedBy?: string; invalid: boolean }) => (
    <div className="emp-input" data-multiline="" data-invalid={ids.invalid ? "" : undefined} data-disabled={rest.disabled ? "" : undefined}>
      <textarea
        ref={setRefs}
        id={ids.id ?? id}
        rows={minRows}
        className={cn(className)}
        required={required}
        aria-invalid={ids.invalid || undefined}
        aria-describedby={ids.describedBy}
        {...rest}
        onInput={(e) => {
          resize();
          rest.onInput?.(e);
        }}
      />
    </div>
  );
  if (label || helper || error) {
    return (
      <Field label={label} helper={helper} error={error} required={required} id={id}>
        {control}
      </Field>
    );
  }
  return control({ id, invalid: false });
}
