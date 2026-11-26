/**
 * Largest-Triangle-Three-Buckets downsampling (§13.5: > 500 points → ≤ 2× pixel width).
 * Generic over the point type via accessors; keeps first and last points.
 */
export function lttb<T>(data: readonly T[], threshold: number, x: (d: T, i: number) => number, y: (d: T) => number): T[] {
  const n = data.length;
  if (threshold >= n || threshold <= 2) return data.slice();
  const out: T[] = [data[0]];
  const every = (n - 2) / (threshold - 2);
  let a = 0;
  for (let i = 0; i < threshold - 2; i++) {
    const avgStart = Math.floor((i + 1) * every) + 1;
    const avgEnd = Math.min(Math.floor((i + 2) * every) + 1, n);
    let avgX = 0;
    let avgY = 0;
    for (let j = avgStart; j < avgEnd; j++) {
      avgX += x(data[j], j);
      avgY += y(data[j]);
    }
    const len = Math.max(1, avgEnd - avgStart);
    avgX /= len;
    avgY /= len;
    const rangeStart = Math.floor(i * every) + 1;
    const rangeEnd = Math.floor((i + 1) * every) + 1;
    const ax = x(data[a], a);
    const ay = y(data[a]);
    let maxArea = -1;
    let next = rangeStart;
    for (let j = rangeStart; j < rangeEnd; j++) {
      const area = Math.abs((ax - avgX) * (y(data[j]) - ay) - (ax - x(data[j], j)) * (avgY - ay));
      if (area > maxArea) {
        maxArea = area;
        next = j;
      }
    }
    out.push(data[next]);
    a = next;
  }
  out.push(data[n - 1]);
  return out;
}

/** Convenience for numeric series indexed by position. */
export function lttbValues(values: readonly number[], threshold: number): number[] {
  return lttb(values, threshold, (_d, i) => i, (d) => d);
}

/** Resample a series to exactly `count` points by linear interpolation (used for path morphs). */
export function resample(values: readonly number[], count: number): number[] {
  if (values.length === 0 || count <= 0) return [];
  if (values.length === 1) return Array(count).fill(values[0]);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = (i / (count - 1)) * (values.length - 1);
    const lo = Math.floor(t);
    const hi = Math.min(values.length - 1, lo + 1);
    out.push(values[lo] + (values[hi] - values[lo]) * (t - lo));
  }
  return out;
}
