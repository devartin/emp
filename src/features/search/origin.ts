/**
 * Where the command palette grows from (DESIGN §5.4.1, S7). A control that opens the palette by pointer (the sidebar
 * Search row, Home's Search key) records its rect just before opening; the palette consumes it once. Opened from the
 * keyboard (⌘K) there is no origin and the palette drops from the top centre instead.
 */
let pending: { rect: DOMRect; at: number } | null = null;

export function setPaletteOrigin(el: Element | null | undefined): void {
  pending = el ? { rect: el.getBoundingClientRect(), at: performance.now() } : null;
}

/** The recorded origin if it was set within the last 600ms; clears it. */
export function takePaletteOrigin(): DOMRect | null {
  const p = pending;
  pending = null;
  if (!p || performance.now() - p.at > 600) return null;
  return p.rect;
}
