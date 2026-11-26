import * as RT from "@radix-ui/react-tabs";
import { LayoutGroup, m } from "motion/react";
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { renderIcon, type IconComponent } from "./Button";
import { spring } from "./motion/tokens";

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

/** Underline tabs (§5.5): 36px, 2px primary indicator sliding via shared layoutId over a 1px subtle baseline. */
export function Tabs<V extends string = string>({ value, onValueChange, items, children, className, listClassName, trailing, ...aria }: TabsProps<V>) {
  const group = useId();
  return (
    <RT.Root value={value} onValueChange={(v) => onValueChange(v as V)} className={className}>
      <div className={cn("emp-tabs-list", listClassName)}>
        <LayoutGroup id={group}>
          <RT.List className="flex items-stretch gap-1 min-w-0 overflow-x-auto" aria-label={aria["aria-label"]} style={{ scrollbarWidth: "none" }}>
            {items.map((t) => (
              <RT.Trigger key={t.value} value={t.value} disabled={t.disabled} className="emp-tab isolate">
                <span className="emp-tab-hover" />
                {renderIcon(t.icon)}
                {t.label}
                {t.count !== undefined ? <span className="emp-tab-count tabular">{t.count}</span> : null}
                {value === t.value ? <m.span layoutId="tab-ind" className="emp-tab-indicator" transition={spring.ui} /> : null}
              </RT.Trigger>
            ))}
          </RT.List>
        </LayoutGroup>
        {trailing ? <div className="ml-auto flex items-center gap-1 pl-2">{trailing}</div> : null}
      </div>
      {children}
    </RT.Root>
  );
}

export function TabPanel({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  return (
    <RT.Content value={value} className={cn("outline-none", className)}>
      {children}
    </RT.Content>
  );
}
