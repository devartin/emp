/**
 * Pointer light + tilt — retired in v3 (docs/DESIGN.md §9 "What not to do": no pointer light, no tilt, no magnet).
 * `installPointerLight` stays as a no-op so MotionProvider and older callers keep their API; no global pointermove
 * listener is installed, so nothing is written to the DOM on pointer movement.
 */
export function installPointerLight(): () => void {
  return () => undefined;
}
