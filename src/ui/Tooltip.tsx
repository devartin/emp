import * as RT from "@radix-ui/react-tooltip";
import { createContext, useContext, type ReactElement, type ReactNode } from "react";
import { tooltipDelay } from "./motion/tokens";
import { Kbd } from "./Kbd";

const HasProvider = createContext(false);

/**
 * Delay group for tooltips (§4.2): 500ms to open, then 0ms for 300ms after the last one closes.
 * Mount once near the root; <Tooltip> falls back to a local provider when none is present.
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RT.Provider delayDuration={tooltipDelay.open} skipDelayDuration={tooltipDelay.skip}>
      <HasProvider.Provider value>{children}</HasProvider.Provider>
    </RT.Provider>
  );
}

export interface TooltipProps {
  content: ReactNode;
  /** Optional shortcut shown as Kbd after the label. */
  shortcut?: string;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  /** Disable without unmounting the trigger. */
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactElement;
}

/** Tooltip (§5.7): opens on hover and focus, opaque, 12/16 500, max width 240. */
export function Tooltip({ content, shortcut, side = "top", align = "center", sideOffset = 6, disabled, open, onOpenChange, children }: TooltipProps) {
  const has = useContext(HasProvider);
  if (disabled || (!content && !shortcut)) return children;
  const root = (
    <RT.Root open={open} onOpenChange={onOpenChange}>
      <RT.Trigger asChild>{children}</RT.Trigger>
      <RT.Portal>
        <RT.Content className="emp-tip" side={side} align={align} sideOffset={sideOffset} collisionPadding={8}>
          {content}
          {shortcut ? <Kbd keys={shortcut} size="xs" /> : null}
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  );
  return has ? root : <TooltipProvider>{root}</TooltipProvider>;
}
