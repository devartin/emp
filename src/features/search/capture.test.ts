/** Capture grammar (Flow r2 §2.7 table): prefix-only, reference date Thu 2026-11-26. */
import { describe, expect, test } from "vitest";
import { parseCapture } from "./capture";

const REF = new Date(2026, 10, 26, 15, 30);
const day = (d: Date | undefined) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : undefined);

describe("parseCapture", () => {
  test("t call mum fri → task due Friday", () => {
    const c = parseCapture("t call mum fri", REF);
    expect(c?.kind).toBe("task");
    if (c?.kind !== "task") return;
    expect(c.title).toBe("call mum");
    expect(day(c.due)).toBe("2026-11-27");
  });
  test("task pay rent eom !high → end of month, high", () => {
    const c = parseCapture("task pay rent eom !high", REF);
    if (c?.kind !== "task") throw new Error(String(c?.kind));
    expect(c.title).toBe("pay rent");
    expect(day(c.due)).toBe("2026-11-30");
    expect(c.priority).toBe("high");
  });
  test("t review deck tomorrow 3pm → timed", () => {
    const c = parseCapture("t review deck tomorrow 3pm", REF);
    if (c?.kind !== "task") throw new Error(String(c?.kind));
    expect(day(c.due)).toBe("2026-11-27");
    expect(c.hasTime).toBe(true);
    expect(c.due?.getHours()).toBe(15);
  });
  test("t buy milk → no date", () => {
    const c = parseCapture("t buy milk", REF);
    if (c?.kind !== "task") throw new Error(String(c?.kind));
    expect(c.title).toBe("buy milk");
    expect(c.due).toBeUndefined();
  });
  test("n pottery class idea → note", () => {
    expect(parseCapture("n pottery class idea", REF)).toEqual({ kind: "note", text: "pottery class idea" });
  });
  test("-12.50 coffee → expense today", () => {
    const c = parseCapture("-12.50 coffee", REF);
    if (c?.kind !== "money") throw new Error(String(c?.kind));
    expect(c.amount).toBe("-12.5");
    expect(c.payee).toBe("coffee");
    expect(day(c.date)).toBe("2026-11-26");
  });
  test("−12.50 coffee yesterday (U+2212) → dated", () => {
    const c = parseCapture("−12.50 coffee yesterday", REF);
    if (c?.kind !== "money") throw new Error(String(c?.kind));
    expect(day(c.date)).toBe("2026-11-25");
    expect(c.payee).toBe("coffee");
  });
  test("+250 refund amazon → income", () => {
    const c = parseCapture("+250 refund amazon", REF);
    if (c?.kind !== "money") throw new Error(String(c?.kind));
    expect(c.amount).toBe("250");
    expect(c.payee).toBe("refund amazon");
  });
  test("-1,234.56 rent #housing → category", () => {
    const c = parseCapture("-1,234.56 rent #housing", REF);
    if (c?.kind !== "money") throw new Error(String(c?.kind));
    expect(c.amount).toBe("-1234.56");
    expect(c.category).toBe("housing");
    expect(c.payee).toBe("rent");
  });
  test("spent 12.50 coffee → expense", () => {
    const c = parseCapture("spent 12.50 coffee", REF);
    if (c?.kind !== "money") throw new Error(String(c?.kind));
    expect(c.amount).toBe("-12.5");
  });
  test("spent without a number is not a capture", () => {
    expect(parseCapture("spent last month", REF)).toBeNull();
  });
  test("-abc → failure row", () => {
    expect(parseCapture("-abc", REF)).toMatchObject({ kind: "error", target: "money", message: "Couldn’t read an amount" });
  });
  test("- coffee → failure row", () => {
    expect(parseCapture("- coffee", REF)).toMatchObject({ kind: "error", target: "money" });
  });
  test("task list → a capture (the page is ranked second by the palette)", () => {
    expect(parseCapture("task list", REF)).toMatchObject({ kind: "task", title: "list" });
  });
  test("tasks (no space) → normal search", () => {
    expect(parseCapture("tasks", REF)).toBeNull();
  });
  test("$NOVA → quote mode, no capture", () => {
    expect(parseCapture("$NOVA", REF)).toBeNull();
  });
  test("plain text is never parsed", () => {
    expect(parseCapture("Lisbon in March", REF)).toBeNull();
    expect(parseCapture("note", REF)).toBeNull();
  });
});
