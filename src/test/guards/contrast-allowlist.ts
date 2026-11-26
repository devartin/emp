/**
 * Token pairs below their contrast target today (measured 2026-11-26). Fixed by the v3 token lane (L1 kit, "paper,
 * ink and keys"); the list may only shrink. Format: "<theme>/<accent>: <fg token> on <bg token>".
 *
 * --border-strong is an 18–20% alpha hairline (1.5–1.8:1). Where a border is the only thing that identifies a
 * control (WCAG 1.4.11), it needs ≥ 3:1.
 */
export const CONTRAST_ALLOWLIST: string[] = [
  'light/graphite: --border-strong on --bg-canvas',
  'light/graphite: --border-strong on --bg-surface-1',
  'dark/graphite: --border-strong on --bg-canvas',
  'dark/graphite: --border-strong on --bg-surface-1',
  'midnight/graphite: --border-strong on --bg-canvas',
  'midnight/graphite: --border-strong on --bg-surface-1',
];
