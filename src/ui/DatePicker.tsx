import * as RP from "@radix-ui/react-popover";
import { addMonths, format as fmt, isSameDay, isSameMonth, isToday, isWithinInterval, startOfDay } from "date-fns";
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, CornerDownLeft } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { formatDateValue, getWeekStart, isoDay, monthGrid, toDate } from "@/lib/dates";
import { parseNatural } from "@/lib/nlp";
import { Button } from "./Button";
import { Field } from "./Field";
import { IconButton } from "./IconButton";
import { floatingZ, useInOverlay } from "./layer";

export interface CalendarProps {
  value: Date | null;
  onSelect: (d: Date) => void;
  /** Optional range highlight end. */
  rangeEnd?: Date | null;
  month?: Date;
  onMonthChange?: (d: Date) => void;
  className?: string;
}

/** Month grid with roving keyboard focus (arrows, PgUp/PgDn months, Home/End week edges). */
export function Calendar({ value, onSelect, rangeEnd, month: monthProp, onMonthChange, className }: CalendarProps) {
  const [innerMonth, setInnerMonth] = useState(() => value ?? new Date());
  const month = monthProp ?? innerMonth;
  const setMonth = (d: Date) => {
    setInnerMonth(d);
    onMonthChange?.(d);
  };
  const [focus, setFocus] = useState<Date>(() => value ?? new Date());
  const gridRef = useRef<HTMLDivElement>(null);
  const ws = getWeekStart();
  const days = useMemo(() => monthGrid(month, ws), [month, ws]);
  const dow = days.slice(0, 7).map((d) => fmt(d, "EEEEEE"));

  useEffect(() => {
    if (!isSameMonth(focus, month)) setMonth(focus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const move = (d: Date) => {
    setFocus(d);
    requestAnimationFrame(() => gridRef.current?.querySelector<HTMLElement>(`[data-day="${isoDay(d)}"]`)?.focus());
  };
  const onKey = (e: KeyboardEvent) => {
    const map: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (map[e.key] !== undefined) {
      e.preventDefault();
      const d = new Date(focus);
      d.setDate(d.getDate() + map[e.key]);
      move(d);
    } else if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      move(addMonths(focus, e.key === "PageUp" ? -1 : 1));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const idx = (focus.getDay() - ws + 7) % 7;
      const d = new Date(focus);
      d.setDate(d.getDate() + (e.key === "Home" ? -idx : 6 - idx));
      move(d);
    }
  };

  const lo = value && rangeEnd ? (value < rangeEnd ? value : rangeEnd) : null;
  const hi = value && rangeEnd ? (value < rangeEnd ? rangeEnd : value) : null;

  return (
    <div className={cn("emp-cal", className)}>
      <div className="emp-cal-head">
        <span className="emp-cal-title">{fmt(month, "MMMM yyyy")}</span>
        <div className="flex gap-0.5">
          <IconButton size="sm" icon={ChevronLeft} label="Previous month" noTooltip onClick={() => setMonth(addMonths(month, -1))} />
          <IconButton size="sm" icon={ChevronRight} label="Next month" noTooltip onClick={() => setMonth(addMonths(month, 1))} />
        </div>
      </div>
      <div className="emp-cal-grid" role="grid" aria-label={fmt(month, "MMMM yyyy")} ref={gridRef} onKeyDown={onKey}>
        {dow.map((d, i) => (
          <span key={i} className="emp-cal-dow" role="columnheader">
            {d}
          </span>
        ))}
        {days.map((d) => {
          const sel = (value && isSameDay(d, value)) || (rangeEnd && isSameDay(d, rangeEnd));
          const inRange = lo && hi && isWithinInterval(d, { start: startOfDay(lo), end: startOfDay(hi) }) && !sel;
          const focusable = isSameDay(d, focus);
          return (
            <button
              key={d.toISOString()}
              type="button"
              role="gridcell"
              data-day={isoDay(d)}
              tabIndex={focusable ? 0 : -1}
              aria-selected={!!sel}
              aria-label={fmt(d, "EEEE, MMMM d, yyyy")}
              className="emp-cal-day"
              data-outside={isSameMonth(d, month) ? undefined : ""}
              data-today={isToday(d) ? "" : undefined}
              data-selected={sel ? "" : undefined}
              data-in-range={inRange ? "" : undefined}
              onClick={() => {
                setFocus(d);
                onSelect(d);
              }}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export interface DatePickerProps {
  /** 'YYYY-MM-DD' or null. */
  value: string | null;
  onChange: (v: string | null) => void;
  placeholder?: string;
  label?: ReactNode;
  helper?: ReactNode;
  error?: ReactNode;
  disabled?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
  /** Render a custom trigger instead of the input-like one. */
  trigger?: ReactNode;
}

/**
 * Date picker: input-like trigger → popover with a natural-language field ("next fri", "in 3 weeks", "eom"),
 * live preview chip, calendar grid, Today / Clear.
 */
export function DatePicker({ value, onChange, placeholder = "Pick a date", label, helper, error, disabled, size = "md", className, trigger }: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const z = floatingZ(useInOverlay());
  const date = value ? toDate(value) : null;
  const parsed = text.trim() ? parseNatural(text) : null;
  const preview = parsed?.start ?? null;

  const commit = (d: Date | null) => {
    onChange(d ? isoDay(d) : null);
    setOpen(false);
    setText("");
  };

  const body = (ids: { id?: string; describedBy?: string; invalid: boolean }) => (
    <RP.Root open={open} onOpenChange={setOpen}>
      <RP.Trigger asChild disabled={disabled}>
        {trigger ?? (
          <button
            type="button"
            id={ids.id}
            aria-describedby={ids.describedBy}
            className={cn("emp-input emp-select-trigger", className)}
            data-size={size === "md" ? undefined : size}
            data-invalid={ids.invalid ? "" : undefined}
            data-disabled={disabled ? "" : undefined}
            data-placeholder={value ? undefined : ""}
          >
            <span className="emp-select-value">
              <CalendarIcon className="emp-select-chevron" aria-hidden />
              {value ? formatDateValue({ start: value, time: false }) : placeholder}
            </span>
          </button>
        )}
      </RP.Trigger>
      <RP.Portal>
        <RP.Content className="emp-popover emp-pop" align="start" sideOffset={6} collisionPadding={8} style={{ ...z, padding: 10 }}>
          <div className="emp-input" data-size="sm" style={{ marginBottom: 10 }}>
            <input
              autoFocus
              value={text}
              placeholder="Try “next fri” or “in 2 weeks”"
              onChange={(e) => setText(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && preview) {
                  e.preventDefault();
                  commit(preview);
                }
              }}
              aria-label="Type a date"
            />
            {preview ? (
              <span className="emp-badge" data-tone="accent" style={{ gap: 4 }}>
                {formatDateValue({ start: isoDay(preview), time: false })}
                <CornerDownLeft size={10} aria-hidden />
              </span>
            ) : null}
          </div>
          <Calendar value={preview ?? date} onSelect={(d) => commit(d)} key={preview ? isoDay(preview) : "cal"} />
          <div className="flex justify-between mt-2 pt-2" style={{ borderTop: "1px solid var(--border-subtle)" }}>
            <Button size="xs" variant="ghost" onClick={() => commit(new Date())}>
              Today
            </Button>
            {value ? (
              <Button size="xs" variant="ghost" onClick={() => commit(null)}>
                Clear
              </Button>
            ) : null}
          </div>
        </RP.Content>
      </RP.Portal>
    </RP.Root>
  );
  if (label || helper || error) {
    return (
      <Field label={label} helper={helper} error={error}>
        {body}
      </Field>
    );
  }
  return body({ invalid: false });
}
