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
  test("Home's plain mode: text without a prefix is a task, taken as written; prefixes still work", () => {
    expect(parseCapture("buy milk", REF, { plain: true })).toEqual({ kind: "task", title: "buy milk", hasTime: false, tags: [] });
    // No date guessing in plain text ("May" is a name here).
    expect(parseCapture("Call May about the lease", REF, { plain: true })).toEqual({ kind: "task", title: "Call May about the lease", hasTime: false, tags: [] });
    expect(parseCapture("n pottery class idea", REF, { plain: true })).toEqual({ kind: "note", text: "pottery class idea" });
    expect(parseCapture("-12.50 coffee", REF, { plain: true })).toMatchObject({ kind: "money", payee: "coffee" });
    expect(parseCapture("t call mum fri", REF, { plain: true })).toMatchObject({ kind: "task", title: "call mum" });
    expect(parseCapture("   ", REF, { plain: true })).toBeNull();
  });

  test("Home's plain mode leaves ordinary sentences alone: only unmistakable prefixes count", () => {
    const task = (title: string) => ({ kind: "task", title, hasTime: false, tags: [] });
    // A sentence that starts with a prefix word is still a task, titled as typed.
    expect(parseCapture("Note to self buy milk", REF, { plain: true })).toEqual(task("Note to self buy milk"));
    expect(parseCapture("Task list for Monday", REF, { plain: true })).toEqual(task("Task list for Monday"));
    expect(parseCapture("- call the bank", REF, { plain: true })).toEqual(task("- call the bank"));
    // "spent …" is an expense only where Money is installed.
    expect(parseCapture("Spent 12 minutes on the plan", REF, { plain: true })).toEqual(task("Spent 12 minutes on the plan"));
    expect(parseCapture("spent 12.50 lunch", REF, { plain: true, money: true })).toMatchObject({ kind: "money", amount: "-12.5", payee: "lunch" });
    // The word with a colon, and the one-letter prefixes, still work.
    expect(parseCapture("note: pottery class idea", REF, { plain: true })).toEqual({ kind: "note", text: "pottery class idea" });
    expect(parseCapture("Task: call mum fri", REF, { plain: true })).toMatchObject({ kind: "task", title: "call mum" });
    expect(parseCapture("+250 refund", REF, { plain: true })).toMatchObject({ kind: "money", amount: "250", payee: "refund" });
    // ⌘K keeps the word prefixes.
    expect(parseCapture("note to self", REF)).toEqual({ kind: "note", text: "to self" });
  });
});
