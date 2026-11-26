import * as RP from "@radix-ui/react-popover";
import { lazy, Suspense, useState, type ReactElement } from "react";
import { floatingZ, useInOverlay } from "./layer";

/** The panel (and the curated set's search keywords) load on first open, outside the shared chunks. */
const loadPanel = () => import("./IconPickerPanel");
const IconPickerPanel = lazy(loadPanel);

export interface IconPickerProps {
  /** Called with a Lucide icon name from the curated set (store it as `{ t: 'lucide', v: name }`). */
  onSelect: (name: string) => void;
  /** Shows "Remove" in the footer when given. */
  onRemove?: () => void;
  /** The current glyph name (highlighted). */
  value?: string | null;
  children: ReactElement;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
}

/**
 * Icon picker (docs/DESIGN.md §8): ~120 curated Lucide glyphs in 8 searchable groups, one monochrome family. Replaces
 * the emoji picker everywhere; the app never offers emoji. Type to filter, arrow keys move, Enter picks, Esc closes.
 */
export function IconPicker({ onSelect, onRemove, value, children, open: openProp, onOpenChange, side = "bottom", align = "start" }: IconPickerProps) {
  const [inner, setInner] = useState(false);
  const open = openProp ?? inner;
  const setOpen = (o: boolean) => {
    setInner(o);
    onOpenChange?.(o);
  };
  const z = floatingZ(useInOverlay());
  return (
    <RP.Root open={open} onOpenChange={setOpen}>
      <RP.Trigger asChild onPointerEnter={() => void loadPanel()} onFocus={() => void loadPanel()}>
        {children}
      </RP.Trigger>
      <RP.Portal>
        <RP.Content className="emp-popover emp-pop" data-opaque={z ? "" : undefined} style={z} side={side} align={align} sideOffset={6} collisionPadding={8}>
          <Suspense fallback={<div className="emp-iconpick" data-loading="" aria-busy="true" />}>
            <IconPickerPanel
              value={value}
              onRemove={
                onRemove
                  ? () => {
                      onRemove();
                      setOpen(false);
                    }
                  : undefined
              }
              onSelect={(n) => {
                onSelect(n);
                setOpen(false);
              }}
            />
          </Suspense>
        </RP.Content>
      </RP.Portal>
    </RP.Root>
  );
}
