/**
 * Base-62 fractional indexing (`sort_key`, §10.2). Compatible with the widely used rocicorp/fractional-indexing
 * scheme so keys generated in Rust and TS interleave. Keys compare with plain byte/code-unit order.
 */
export const BASE_62_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

class FractionalIndexError extends Error {}

function midpoint(a: string, b: string | null, digits: string): string {
  const zero = digits[0];
  if (b !== null && a >= b) throw new FractionalIndexError(`${a} >= ${b}`);
  if (a.slice(-1) === zero || (b && b.slice(-1) === zero)) throw new FractionalIndexError("trailing zero");
  if (b) {
    let n = 0;
    while ((a[n] || zero) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n), digits);
  }
  const digitA = a ? digits.indexOf(a[0]) : 0;
  const digitB = b !== null ? digits.indexOf(b[0]) : digits.length;
  if (digitB - digitA > 1) {
    return digits[Math.round(0.5 * (digitA + digitB))];
  }
  if (b && b.length > 1) return b.slice(0, 1);
  return digits[digitA] + midpoint(a.slice(1), null, digits);
}

function integerLength(head: string): number {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - 97 + 2;
  if (head >= "A" && head <= "Z") return 90 - head.charCodeAt(0) + 2;
  throw new FractionalIndexError(`invalid order key head: ${head}`);
}

function validateInteger(int: string): void {
  if (int.length !== integerLength(int[0])) throw new FractionalIndexError(`invalid integer part: ${int}`);
}

function integerPart(key: string): string {
  const len = integerLength(key[0]);
  if (len > key.length) throw new FractionalIndexError(`invalid order key: ${key}`);
  return key.slice(0, len);
}

function validateKey(key: string, digits: string): void {
  if (key === "A" + digits[0].repeat(26)) throw new FractionalIndexError(`invalid order key: ${key}`);
  const i = integerPart(key);
  if (key.slice(i.length).slice(-1) === digits[0]) throw new FractionalIndexError(`invalid order key: ${key}`);
}

function incrementInteger(x: string, digits: string): string | null {
  validateInteger(x);
  const [head, ...digs] = x.split("");
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = digits.indexOf(digs[i]) + 1;
    if (d === digits.length) digs[i] = digits[0];
    else {
      digs[i] = digits[d];
      carry = false;
    }
  }
  if (!carry) return head + digs.join("");
  if (head === "Z") return "a" + digits[0];
  if (head === "z") return null;
  const h = String.fromCharCode(head.charCodeAt(0) + 1);
  if (h > "a") digs.push(digits[0]);
  else digs.pop();
  return h + digs.join("");
}

function decrementInteger(x: string, digits: string): string | null {
  validateInteger(x);
  const [head, ...digs] = x.split("");
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = digits.indexOf(digs[i]) - 1;
    if (d === -1) digs[i] = digits.slice(-1);
    else {
      digs[i] = digits[d];
      borrow = false;
    }
  }
  if (!borrow) return head + digs.join("");
  if (head === "a") return "Z" + digits.slice(-1);
  if (head === "A") return null;
  const h = String.fromCharCode(head.charCodeAt(0) - 1);
  if (h < "Z") digs.push(digits.slice(-1));
  else digs.pop();
  return h + digs.join("");
}

/** A key strictly between `a` and `b` (either may be null for open ends). */
export function generateKeyBetween(a: string | null | undefined, b: string | null | undefined, digits = BASE_62_DIGITS): string {
  const lo = a ?? null;
  const hi = b ?? null;
  if (lo !== null) validateKey(lo, digits);
  if (hi !== null) validateKey(hi, digits);
  if (lo !== null && hi !== null && lo >= hi) throw new FractionalIndexError(`${lo} >= ${hi}`);
  if (lo === null) {
    if (hi === null) return "a" + digits[0];
    const ib = integerPart(hi);
    const fb = hi.slice(ib.length);
    if (ib === "A" + digits[0].repeat(26)) return ib + midpoint("", fb, digits);
    if (ib < hi) return ib;
    const res = decrementInteger(ib, digits);
    if (res === null) throw new FractionalIndexError("cannot decrement any more");
    return res;
  }
  if (hi === null) {
    const ia = integerPart(lo);
    const fa = lo.slice(ia.length);
    const i = incrementInteger(ia, digits);
    return i === null ? ia + midpoint(fa, null, digits) : i;
  }
  const ia = integerPart(lo);
  const fa = lo.slice(ia.length);
  const ib = integerPart(hi);
  const fb = hi.slice(ib.length);
  if (ia === ib) return ia + midpoint(fa, fb, digits);
  const i = incrementInteger(ia, digits);
  if (i === null) throw new FractionalIndexError("cannot increment any more");
  if (i < hi) return i;
  return ia + midpoint(fa, null, digits);
}

/** `n` evenly spread keys between `a` and `b`. */
export function generateNKeysBetween(a: string | null | undefined, b: string | null | undefined, n: number, digits = BASE_62_DIGITS): string[] {
  const lo = a ?? null;
  const hi = b ?? null;
  if (n <= 0) return [];
  if (n === 1) return [generateKeyBetween(lo, hi, digits)];
  if (hi === null) {
    let c = generateKeyBetween(lo, hi, digits);
    const out = [c];
    for (let i = 0; i < n - 1; i++) {
      c = generateKeyBetween(c, hi, digits);
      out.push(c);
    }
    return out;
  }
  if (lo === null) {
    let c = generateKeyBetween(lo, hi, digits);
    const out = [c];
    for (let i = 0; i < n - 1; i++) {
      c = generateKeyBetween(lo, c, digits);
      out.push(c);
    }
    return out.reverse();
  }
  const mid = Math.floor(n / 2);
  const c = generateKeyBetween(lo, hi, digits);
  return [...generateNKeysBetween(lo, c, mid, digits), c, ...generateNKeysBetween(c, hi, n - mid - 1, digits)];
}

export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
