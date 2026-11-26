import * as RDM from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { floatingZ, useInOverlay } from "./layer";
import { makeMenuParts } from "./menuParts";

const parts = makeMenuParts(RDM);

/** Dropdown menu (§5.6). Compose: <Menu><MenuTrigger asChild>…</MenuTrigger><MenuContent>…items…</MenuContent></Menu>. */
export const Menu = RDM.Root;
export const MenuTrigger = RDM.Trigger;
export const MenuItem = parts.Item;
export const MenuCheckboxItem = parts.CheckboxItem;
export const MenuRadioGroup = parts.RadioGroup;
export const MenuRadioItem = parts.RadioItem;
export const MenuLabel = parts.Label;
export const MenuSeparator = parts.Separator;
export const MenuGroup = parts.Group;
export const MenuSub = parts.Sub;
export const MenuSubTrigger = parts.SubTrigger;
export const MenuSubContent = parts.SubContent;
export type { MenuItemProps } from "./menuParts";

export interface MenuContentProps {
  children: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  sideOffset?: number;
  width?: number;
  className?: string;
  /** Prevent focus returning to the trigger on close. */
  noReturnFocus?: boolean;
}

/** Panel: 220–320 wide, max-height min(480px,70vh), radius 10, elev-2, 6px offset, flip/shift via collision handling. */
export function MenuContent({ children, align = "start", side = "bottom", sideOffset = 6, width, className, noReturnFocus }: MenuContentProps) {
  const z = floatingZ(useInOverlay());
  return (
    <RDM.Portal>
      <RDM.Content
        className={cn("emp-menu emp-pop", className)}
        align={align}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={8}
        loop
        style={{ ...z, ...(width ? { width } : null) }}
        onCloseAutoFocus={noReturnFocus ? (e) => e.preventDefault() : undefined}
      >
        {children}
      </RDM.Content>
    </RDM.Portal>
  );
}
