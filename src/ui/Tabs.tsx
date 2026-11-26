import * as RT from "@radix-ui/react-tabs";
import { type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { renderIcon, type IconComponent } from "./Button";

export interface TabItem<V extends string = string> {
  value: V;
  label: ReactNode;
  icon?: IconComponent | ReactNode;
  count?: number;
  disabled?: boolean;
}

export interface TabsProps<V extends string = string> {
  value: V;
  onValueChange: (v: V) => void;
  items: TabItem<V>[];
  /** Panels keyed by value; omit to use Tabs as a pure tab bar. */
  children?: ReactNode;
  className?: string;
  listClassName?: string;
  /** Extra controls at the end of the tab row. */
  trailing?: ReactNode;
  "aria-label"?: string;
}

/**
 * Tabs (docs/DESIGN.md §5.4): a hairline baseline with a 2px ink underline on the active tab. Switching is instant
 * (register.ts C0): no gliding bar, no panel slide. Counts are tertiary text, never pills.
 */
export function Tabs<V extends string = string>({ value, onValueChange, items, children, className, listClassName, trailing, ...aria }: TabsProps<V>) {
  const index = items.findIndex((t) => t.value === value);
  const change = (v: string) => {
    if (v === value) return;
    void index;
    onValueChange(v as V);
  };
  // Radix focuses the trigger with a plain focus() inside mousedown, which Chrome treats as keyboard-like and paints
  // the focus ring on every mouse click. Do the same work first with `focusVisible: false` (Radix skips its handler
  // once the event is default-prevented).
  const onTriggerMouseDown = (e: ReactMouseEvent<HTMLButtonElement>, v: string, disabled?: boolean) => {
    if (disabled || e.button !== 0 || e.ctrlKey) return;
    e.preventDefault();
    e.currentTarget.focus({
      preventScroll: true,
      focusVisible: false,
    } as FocusOptions);
    change(v);
  };

  return (
    <RT.Root value={value} onValueChange={change} className={className}>
      <div className={cn("emp-tabs-list", listClassName)}>
        <RT.List className="relative flex items-stretch min-w-0 overflow-x-auto [scrollbar-width:none]" aria-label={aria["aria-label"]}>
          {items.map((t) => (
            <RT.Trigger
              key={t.value}
              value={t.value}
              disabled={t.disabled}
              className="emp-tab isolate"
              data-tab-value={t.value}
              onMouseDown={(e) => onTriggerMouseDown(e, t.value, t.disabled)}
            >
              {renderIcon(t.icon)}
              {t.label}
              {t.count !== undefined ? <span className="emp-tab-count tabular">{Math.round(t.count)}</span> : null}
            </RT.Trigger>
          ))}
        </RT.List>
        {trailing ? <div className="ml-auto flex items-center gap-1 pl-2">{trailing}</div> : null}
      </div>
      {children}
    </RT.Root>
  );
}

/** A tab panel. Switching is instant (C0): the content is there at frame 1. */
export function TabPanel({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  return (
    <RT.Content value={value} className={cn("outline-none", className)}>
      {children}
    </RT.Content>
  );
}
