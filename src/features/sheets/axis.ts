/**
 * One grid axis (rows or columns): a default size plus sparse overrides, with O(log n) offset ↔ index lookups.
 */
export class Axis {
  readonly def: number;
  count: number;
  private sizes = new Map<number, number>();
  /** Sorted override indices and prefix sums of (size − def). */
  private idx: number[] = [];
  private prefix: number[] = [];
  private dirty = false;

  constructor(def: number, count: number) {
    this.def = def;
    this.count = count;
  }

  set(i: number, size: number | null): void {
    if (size === null || size === this.def) this.sizes.delete(i);
    else this.sizes.set(i, size);
    this.dirty = true;
  }

  setMany(entries: [number, number][], range?: [number, number]): void {
    if (range) for (const i of [...this.sizes.keys()]) if (i >= range[0] && i <= range[1]) this.sizes.delete(i);
    for (const [i, s] of entries) {
      if (s === this.def) this.sizes.delete(i);
      else this.sizes.set(i, s);
    }
    this.dirty = true;
  }

  clear(): void {
    this.sizes.clear();
    this.dirty = true;
  }

  size(i: number): number {
    return this.sizes.get(i) ?? this.def;
  }

  hasOverride(i: number): boolean {
    return this.sizes.has(i);
  }

  private build(): void {
    if (!this.dirty) return;
    this.idx = [...this.sizes.keys()].sort((a, b) => a - b);
    this.prefix = [];
    let acc = 0;
    for (const i of this.idx) {
      acc += this.sizes.get(i)! - this.def;
      this.prefix.push(acc);
    }
    this.dirty = false;
  }

  /** Pixel offset where index i starts. */
  offset(i: number): number {
    this.build();
    // number of overrides with index < i
    let lo = 0;
    let hi = this.idx.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.idx[mid] < i) lo = mid + 1;
      else hi = mid;
    }
    return i * this.def + (lo > 0 ? this.prefix[lo - 1] : 0);
  }

  end(i: number): number {
    return this.offset(i) + this.size(i);
  }

  total(): number {
    return this.offset(this.count);
  }

  /** Index containing pixel offset px (clamped to [0, count − 1]). */
  indexAt(px: number): number {
    if (px <= 0) return 0;
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offset(mid) <= px) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}
