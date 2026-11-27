import { describe, expect, it } from "vitest";
import type { Property } from "@/backend/types";
import { keyOf, normKey, optIs, optionFor } from "./cells";

const prop = (options: { id: string; name: string }[]): Property =>
  ({ id: "p", name: "Status", type: "status", config: { options }, hidden: false, sortKey: "a" }) as unknown as Property;

describe("option keys (1.0 rule: an app option's id is its manifest key)", () => {
  it("normalises names like Rust's norm", () => {
    expect(normKey("Yes / no")).toBe("yes_no");
    expect(normKey("Yes/no")).toBe("yes_no");
    expect(normKey("X per week")).toBe("x_per_week");
    expect(normKey("  Sent to preparer ")).toBe("sent_to_preparer");
  });

  it("matches by id first, so a renamed option still matches", () => {
    expect(optIs({ id: "done", name: "Finished" }, "done")).toBe(true);
    expect(optIs({ id: "opt_3f2a", name: "Done" }, "done")).toBe(true);
    expect(optIs({ id: "next", name: "Next" }, "done")).toBe(false);
    expect(optIs(null, "done")).toBe(false);
  });

  it("finds the option to write and the key of a read option", () => {
    const p = prop([
      { id: "inbox", name: "Inbox" },
      { id: "opt_x", name: "Done" },
    ]);
    expect(optionFor(p, "inbox")).toBe("inbox");
    expect(optionFor(p, "done")).toBe("opt_x");
    expect(optionFor(p, "someday")).toBeNull();
    expect(keyOf({ id: "opt_x", name: "Done" }, ["inbox", "done"])).toBe("done");
    expect(keyOf({ id: "zzz", name: "Other" }, ["inbox", "done"])).toBeNull();
  });
});
