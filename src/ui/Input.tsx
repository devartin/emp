import { X } from "lucide-react";
import { useRef, useState, type InputHTMLAttributes, type ReactNode, type Ref } from "react";
import { cn } from "@/lib/cn";
import { renderIcon, type IconComponent } from "./Button";
import { Field } from "./Field";
import { IconButton } from "./IconButton";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "prefix"> {
  size?: "sm" | "md" | "lg";
  label?: ReactNode;
  helper?: ReactNode;
  error?: ReactNode;
  /** Visually invalid without a message. */
  invalid?: boolean;
  icon?: IconComponent | ReactNode;
  prefix?: ReactNode;
  suffix?: ReactNode;
  /** Trailing element (buttons, Kbd). */
  trailing?: ReactNode;
  /** Shows an xs ghost clear button on hover/focus when there's a value. */
  clearable?: boolean;
  onClear?: () => void;
  align?: "start" | "end";
  /** Overlay text shown at the trailing edge (NumberField ghost result). */
  ghost?: ReactNode;
  wrapperClassName?: string;
  fieldClassName?: string;
  ref?: Ref<HTMLInputElement>;
}

/** Text input (§5.2): 28/32/40, hover border-strong, focus accent border + 3px ring, error + helper wiring. */
export function Input({
  size = "md",
  label,
  helper,
  error,
  invalid,
  icon,
  prefix,
  suffix,
  trailing,
  clearable,
  onClear,
  align,
  ghost,
  className,
  wrapperClassName,
  fieldClassName,
  disabled,
  readOnly,
  required,
  id,
  ref,
  ...rest
}: InputProps) {
  const inner = useRef<HTMLInputElement | null>(null);
  const [uncontrolledHasValue, setHasValue] = useState(!!rest.defaultValue);
  const hasValue = rest.value !== undefined ? String(rest.value).length > 0 : uncontrolledHasValue;

  const setRefs = (el: HTMLInputElement | null) => {
    inner.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) (ref as { current: HTMLInputElement | null }).current = el;
  };

  const control = (ids: { id?: string; describedBy?: string; invalid: boolean }) => (
    <div
      className={cn("emp-input", wrapperClassName)}
      data-size={size === "md" ? undefined : size}
      data-invalid={ids.invalid || invalid ? "" : undefined}
      data-disabled={disabled ? "" : undefined}
      data-readonly={readOnly ? "" : undefined}
      data-align={align === "end" ? "end" : undefined}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault();
          inner.current?.focus();
        }
      }}
    >
      {icon ? <span className="emp-input-icon">{renderIcon(icon)}</span> : null}
      {prefix ? <span className="emp-input-affix">{prefix}</span> : null}
      <input
        ref={setRefs}
        id={ids.id ?? id}
        className={className}
        disabled={disabled}
        readOnly={readOnly}
        required={required}
        aria-invalid={ids.invalid || invalid || undefined}
        aria-describedby={ids.describedBy}
        {...rest}
        onChange={(e) => {
          setHasValue(e.currentTarget.value.length > 0);
          rest.onChange?.(e);
        }}
      />
      {ghost ? <span className="emp-input-ghost">{ghost}</span> : null}
      {suffix ? <span className="emp-input-affix">{suffix}</span> : null}
      {clearable && hasValue && !disabled && !readOnly ? (
        <IconButton
          className="emp-input-clear"
          icon={X}
          label="Clear"
          size="xs"
          noTooltip
          tabIndex={-1}
          style={{ marginRight: -4 }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const el = inner.current;
            if (el && rest.value === undefined) {
              el.value = "";
              setHasValue(false);
            }
            onClear?.();
            el?.focus();
          }}
        />
      ) : null}
      {trailing}
    </div>
  );

  if (label || helper || error) {
    return (
      <Field label={label} helper={helper} error={error} required={required} id={id} className={fieldClassName}>
        {(ids) => control(ids)}
      </Field>
    );
  }
  return control({ id, invalid: !!invalid });
}
