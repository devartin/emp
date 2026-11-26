/**
 * Horizontal reveal for the table grid. The gutter and the title column are `position: sticky`, so the browser's own
 * `scrollIntoView({ inline: 'nearest' })` happily "reveals" a cell by parking it under them (the Stage column slid
 * under Company after keyboard navigation and stayed there after a row was opened). The usable viewport for a
 * scrolling column starts at the sticky edge, not at the scroller's left edge.
 */

export interface RevealInput {
  /** Current `scrollLeft` of the table scroller. */
  scrollLeft: number;
  /** `clientWidth` of the table scroller. */
  viewWidth: number;
  /** Width covered by sticky columns at the left (gutter + title). */
  stickyWidth: number;
  /** The target column's left edge in content coordinates (from 0 at the gutter's left edge). */
  colLeft: number;
  colWidth: number;
}

/**
 * The `scrollLeft` that brings a scrolling column fully into the unobstructed part of the viewport, moving as little
 * as possible. A column wider than the free space aligns its left edge with the sticky edge. Never negative.
 */
export function revealScrollLeft({ scrollLeft, viewWidth, stickyWidth, colLeft, colWidth }: RevealInput): number {
  const freeLeft = scrollLeft + stickyWidth;
  const freeRight = scrollLeft + viewWidth;
  const colRight = colLeft + colWidth;
  let next = scrollLeft;
  if (colLeft < freeLeft) next = colLeft - stickyWidth;
  else if (colRight > freeRight) next = Math.min(colRight - viewWidth, colLeft - stickyWidth);
  return Math.max(0, next);
}
