import * as RP from "@radix-ui/react-popover";
import { lazy, Suspense, useState, type ReactElement } from "react";
import { floatingZ, useInOverlay } from "./layer";
import { Skeleton } from "./Skeleton";

const Panel = lazy(() => import("./EmojiPickerPanel"));

let recentMemory: string[] = [];
/** Recently used emoji (session memory; callers may persist via kv and seed with setRecentEmoji). */
export function setRecentEmoji(list: string[]): void {
  recentMemory = list.slice(0, 16);
}
export function getRecentEmoji(): string[] {
  return recentMemory;
}

export interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
  children: ReactElement;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
}

/** Emoji picker popover (lazy chunk with the emoji data). */
export function EmojiPicker({ onSelect, children, open: openProp, onOpenChange, side = "bottom", align = "start" }: EmojiPickerProps) {
  const [inner, setInner] = useState(false);
  const open = openProp ?? inner;
  const setOpen = (o: boolean) => {
    setInner(o);
    onOpenChange?.(o);
  };
  const z = floatingZ(useInOverlay());
  return (
    <RP.Root open={open} onOpenChange={setOpen}>
      <RP.Trigger asChild>{children}</RP.Trigger>
      <RP.Portal>
        <RP.Content className="emp-popover emp-pop" style={{ ...z, padding: 0, maxWidth: "none" }} side={side} align={align} sideOffset={6} collisionPadding={8}>
          <Suspense fallback={<PanelSkeleton />}>
            <Panel
              recent={recentMemory}
              onSelect={(e) => {
                recentMemory = [e, ...recentMemory.filter((x) => x !== e)].slice(0, 16);
                onSelect(e);
                setOpen(false);
              }}
            />
          </Suspense>
        </RP.Content>
      </RP.Portal>
    </RP.Root>
  );
}

function PanelSkeleton() {
  return (
    <div style={{ width: 352, height: 400, padding: 8 }} className="flex flex-col gap-3">
      <Skeleton height={28} radius={8} />
      <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(8, 1fr)" }}>
        {Array.from({ length: 48 }, (_, i) => (
          <Skeleton key={i} height={32} radius={8} />
        ))}
      </div>
    </div>
  );
}
