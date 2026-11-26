/* Shared menu skin for DropdownMenu (Menu.tsx) and ContextMenu (ContextMenu.tsx) — §5.6. */
import * as RDM from "@radix-ui/react-dropdown-menu";
import * as RCM from "@radix-ui/react-context-menu";
import { Check, ChevronRight } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { renderIcon, type IconComponent } from "./Button";
import { GlideHighlight } from "./GlideHighlight";
import { Kbd } from "./Kbd";

type NS = typeof RDM | typeof RCM;

export interface MenuItemProps {
  icon?: IconComponent | ReactNode;
  children: ReactNode;
  shortcut?: string;
  trailing?: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  onSelect?: (e: Event) => void;
  className?: string;
  /** Keep the menu open after selecting. */
  keepOpen?: boolean;
  textValue?: string;
}

export function makeMenuParts(P: NS) {
  // Radix's dropdown and context menu parts share the same prop shapes; we type against the dropdown variants.
  const D = P as unknown as typeof RDM;

  function Item({ icon, children, shortcut, trailing, destructive, disabled, onSelect, className, keepOpen, textValue }: MenuItemProps) {
    return (
      <D.Item
        className={cn("emp-menu-item", className)}
        data-destructive={destructive ? "" : undefined}
        disabled={disabled}
        textValue={textValue}
        onSelect={(e) => {
          if (keepOpen) e.preventDefault();
          onSelect?.(e);
        }}
      >
        {icon ? <span className="emp-menu-icon">{renderIcon(icon)}</span> : null}
        <span className="emp-menu-label">{children}</span>
        {trailing || shortcut ? (
          <span className="emp-menu-trail">
            {trailing}
            {shortcut ? <Kbd keys={shortcut} size="xs" /> : null}
          </span>
        ) : null}
      </D.Item>
    );
  }

  function CheckboxItem({ checked, onCheckedChange, icon, children, shortcut, disabled, keepOpen = true }: Omit<MenuItemProps, "onSelect" | "destructive"> & { checked: boolean; onCheckedChange: (v: boolean) => void }) {
    return (
      <D.CheckboxItem
        className="emp-menu-item"
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        onSelect={(e) => keepOpen && e.preventDefault()}
      >
        {icon ? <span className="emp-menu-icon">{renderIcon(icon)}</span> : null}
        <span className="emp-menu-label">{children}</span>
        <span className="emp-menu-trail">
          {shortcut ? <Kbd keys={shortcut} size="xs" /> : null}
          <D.ItemIndicator className="emp-menu-check">
            <Check aria-hidden />
          </D.ItemIndicator>
        </span>
      </D.CheckboxItem>
    );
  }

  function RadioItem({ value, icon, children, disabled }: { value: string; icon?: IconComponent | ReactNode; children: ReactNode; disabled?: boolean }) {
    return (
      <D.RadioItem className="emp-menu-item" value={value} disabled={disabled}>
        {icon ? <span className="emp-menu-icon">{renderIcon(icon)}</span> : null}
        <span className="emp-menu-label">{children}</span>
        <span className="emp-menu-trail">
          <D.ItemIndicator className="emp-menu-check">
            <Check aria-hidden />
          </D.ItemIndicator>
        </span>
      </D.RadioItem>
    );
  }

  function Label({ children }: { children: ReactNode }) {
    return <D.Label className="emp-menu-header">{children}</D.Label>;
  }
  function Separator() {
    return <D.Separator className="emp-menu-sep" />;
  }
  function SubTrigger({ icon, children, disabled }: { icon?: IconComponent | ReactNode; children: ReactNode; disabled?: boolean }) {
    return (
      <D.SubTrigger className="emp-menu-item" disabled={disabled}>
        {icon ? <span className="emp-menu-icon">{renderIcon(icon)}</span> : null}
        <span className="emp-menu-label">{children}</span>
        <span className="emp-menu-trail">
          <ChevronRight size={14} aria-hidden />
        </span>
      </D.SubTrigger>
    );
  }
  function SubContent({ children, className }: { children: ReactNode; className?: string }) {
    return (
      <D.Portal>
        <D.SubContent className={cn("emp-menu emp-pop", className)} data-sub="" sideOffset={2} alignOffset={-5} collisionPadding={8}>
          <GlideHighlight />
          {children}
        </D.SubContent>
      </D.Portal>
    );
  }
  return {
    Item,
    CheckboxItem,
    RadioItem,
    Label,
    Separator,
    SubTrigger,
    SubContent,
    Sub: D.Sub,
    Group: D.Group,
    RadioGroup: D.RadioGroup as (p: ComponentProps<typeof RDM.RadioGroup>) => ReactNode,
  };
}
