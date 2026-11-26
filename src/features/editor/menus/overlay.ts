/**
 * Overlay requests from plain-DOM node views (callout icon, code language, inline maths, date mentions, links …) to
 * the React overlay host each editor renders. One overlay is open at a time across the app.
 */
import { create } from 'zustand';

export type OverlayKind =
  | 'calloutIcon'
  | 'codeLang'
  | 'mathInline'
  | 'date'
  | 'link'
  | 'blockMenu'
  | 'tableMenu'
  | 'pastePrompt';

export interface OverlayRequest {
  kind: OverlayKind;
  editorId: string;
  /** Document position the overlay acts on (node position for node views, `from` for text ranges). */
  pos: number;
  to?: number;
  /** Viewport rect to anchor to. */
  rect: { x: number; y: number; width: number; height: number };
  data?: Record<string, unknown>;
}

interface OverlayState {
  req: OverlayRequest | null;
  open(req: OverlayRequest): void;
  close(): void;
}

export const useOverlay = create<OverlayState>()((set) => ({
  req: null,
  open: (req) => set({ req }),
  close: () => set({ req: null }),
}));

export function rectOf(el: Element): OverlayRequest['rect'] {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

export function openOverlay(req: OverlayRequest): void {
  useOverlay.getState().open(req);
}
