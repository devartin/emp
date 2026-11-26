import * as RCM from "@radix-ui/react-context-menu";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { GlideHighlight } from "./GlideHighlight";
import { floatingZ, useInOverlay } from "./layer";
import { makeMenuParts } from "./menuParts";

const parts = makeMenuParts(RCM);

/** Context menu (§5.6) — same skin as Menu; opens at the pointer on right-click / long-press / Shift+F10. */
export const ContextMenu = RCM.Root;
export const ContextMenuTrigger = RCM.Trigger;
export const ContextMenuItem = parts.Item;
export const ContextMenuCheckboxItem = parts.CheckboxItem;
export const ContextMenuRadioGroup = parts.RadioGroup;
export const ContextMenuRadioItem = parts.RadioItem;
export const ContextMenuLabel = parts.Label;
export const ContextMenuSeparator = parts.Separator;
export const ContextMenuGroup = parts.Group;
export const ContextMenuSub = parts.Sub;
export const ContextMenuSubTrigger = parts.SubTrigger;
export const ContextMenuSubContent = parts.SubContent;

export function ContextMenuContent({ children, className, width }: { children: ReactNode; className?: string; width?: number }) {
  const inOverlay = useInOverlay();
  return (
    <RCM.Portal>
      <RCM.Content
        className={cn("emp-menu emp-pop", className)}
        data-opaque={inOverlay ? "" : undefined}
        collisionPadding={8}
        loop
        style={{ ...floatingZ(inOverlay), ...(width ? { width } : null) }}
      >
        <GlideHighlight />
        {children}
      </RCM.Content>
    </RCM.Portal>
  );
}
