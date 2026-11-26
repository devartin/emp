import { describe, expect, it } from "vitest";
import { formatMoney } from "@/lib/money";
import { fmtMoney, toMoney } from "./format";

describe("fmtMoney fast path", () => {
  const values = [0, 0.004, -0.004, 0.005, -0.005, 0.49, 0.5, -0.5, 1.5, 2.5, 12.345, -12.345, 999.995, 1234.5, -1234.49, 236000.6, -65905.2, 1e9 + 0.25, 307.42, -2.37];
  for (const currency of ["USD", "EUR", "JPY"]) {
    for (const v of values) {
      for (const opts of [{}, { noCents: true }, { signed: true }, { noCents: true, signed: true }]) {
        it(`${currency} ${v} ${JSON.stringify(opts)}`, () => {
          expect(fmtMoney(v, currency, opts)).toBe(formatMoney(toMoney(v, currency), opts));
        });
      }
    }
  }
});
