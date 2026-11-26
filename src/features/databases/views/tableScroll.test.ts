import { describe, expect, test } from 'vitest';
import { revealScrollLeft } from './tableScroll';

// Client CRM geometry: 44px gutter + 220px sticky title, Stage at 264..394, a 1192px scroller.
const base = { viewWidth: 1192, stickyWidth: 264 };

describe('revealScrollLeft (sticky-aware horizontal reveal)', () => {
  test('a column hidden under the sticky title scrolls back to sit just right of it', () => {
    // Regression: scrollIntoView left Stage at scrollLeft 316, fully under the title column.
    expect(revealScrollLeft({ ...base, scrollLeft: 316, colLeft: 264, colWidth: 130 })).toBe(0);
    expect(revealScrollLeft({ ...base, scrollLeft: 630, colLeft: 522, colWidth: 128 })).toBe(258);
  });

  test('a partly covered column is revealed too', () => {
    expect(revealScrollLeft({ ...base, scrollLeft: 52, colLeft: 264, colWidth: 130 })).toBe(0);
  });

  test('a visible column does not move the table', () => {
    expect(revealScrollLeft({ ...base, scrollLeft: 0, colLeft: 264, colWidth: 130 })).toBe(0);
    expect(revealScrollLeft({ ...base, scrollLeft: 200, colLeft: 700, colWidth: 160 })).toBe(200);
  });

  test('a column off the right edge scrolls just far enough', () => {
    expect(revealScrollLeft({ ...base, scrollLeft: 0, colLeft: 1300, colWidth: 160 })).toBe(268);
  });

  test('a column wider than the free space aligns with the sticky edge', () => {
    expect(revealScrollLeft({ ...base, scrollLeft: 0, colLeft: 1300, colWidth: 1100 })).toBe(1036);
  });
});
