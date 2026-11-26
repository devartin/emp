import * as RSA from "@radix-ui/react-scroll-area";
import type { CSSProperties, ReactNode, Ref } from "react";
import { cn } from "@/lib/cn";

export interface ScrollAreaProps {
  children: ReactNode;
  className?: string;
  viewportClassName?: string;
  style?: CSSProperties;
  orientation?: "vertical" | "horizontal" | "both";
  viewportRef?: Ref<HTMLDivElement>;
  onScroll?: React.UIEventHandler<HTMLDivElement>;
}

/** Overlay scrollbars (§5.11): 6px thumb growing to 8px on hover; fades out 800ms after scrolling stops. */
export function ScrollArea({ children, className, viewportClassName, style, orientation = "vertical", viewportRef, onScroll }: ScrollAreaProps) {
  return (
    <RSA.Root className={cn("emp-scroll", className)} style={style} type="scroll" scrollHideDelay={800}>
      <RSA.Viewport ref={viewportRef} className={cn("emp-scroll-viewport", viewportClassName)} onScroll={onScroll}>
        {children}
      </RSA.Viewport>
      {orientation !== "horizontal" ? (
        <RSA.Scrollbar className="emp-scrollbar" orientation="vertical">
          <RSA.Thumb className="emp-scroll-thumb" />
        </RSA.Scrollbar>
      ) : null}
      {orientation !== "vertical" ? (
        <RSA.Scrollbar className="emp-scrollbar" orientation="horizontal">
          <RSA.Thumb className="emp-scroll-thumb" />
        </RSA.Scrollbar>
      ) : null}
      <RSA.Corner />
    </RSA.Root>
  );
}
