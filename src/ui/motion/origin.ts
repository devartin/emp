/**
 * Overlay origins (docs/DESIGN.md §5.4.1): dialogs grow from the control that opened them. A capture-phase
 * pointerdown listener remembers the last pressed control and its rect (menu items vanish before the dialog mounts),
 * so `resolveOrigin()` can return the trigger even when focus has already moved.
 */
export interface Origin {
  el: Element | null;
  rect: DOMRect;
}

let last: (Origin & { at: number }) | null = null;
let installed = false;

function install() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener(
    "pointerdown",
    (e) => {
      const t = e.target instanceof Element ? e.target.closest("button, [role='button'], [role='menuitem'], [role='option'], a, [data-dialog-origin]") : null;
      if (t) last = { el: t, rect: t.getBoundingClientRect(), at: performance.now() };
    },
    true,
  );
}
install();

function visible(r: DOMRect) {
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
}

/** The trigger to grow from: an explicit ref, else the control pressed in the last 800ms, else none (→ `drop`). */
export function resolveOrigin(explicit?: Element | null): Origin | null {
  if (explicit && explicit.isConnected) {
    const rect = explicit.getBoundingClientRect();
    return visible(rect) ? { el: explicit, rect } : null;
  }
  if (last && performance.now() - last.at < 800) {
    const rect = last.el?.isConnected ? last.el.getBoundingClientRect() : last.rect;
    return visible(rect) ? { el: last.el, rect } : null;
  }
  return null;
}

/** Transform that maps `panel` onto `origin` (translate to its centre, scale by the width ratio clamped .3–.9). */
export function originTransform(origin: Origin, panel: DOMRect) {
  const ox = origin.rect.left + origin.rect.width / 2 - (panel.left + panel.width / 2);
  const oy = origin.rect.top + origin.rect.height / 2 - (panel.top + panel.height / 2);
  const os = Math.max(0.3, Math.min(0.9, origin.rect.width / Math.max(1, panel.width)));
  return { x: ox, y: oy, scale: os };
}
