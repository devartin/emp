/** The lock screen says why it is showing (audit firstrun-vault #11): only an idle lock claims to be automatic. */
import { describe, expect, test } from "vitest";
import { captionFor } from "./LockScreen";

describe("lock caption", () => {
  test("manual, idle and a fresh launch read differently", () => {
    expect(captionFor("manual", 15)).toBe("You locked Ultranote");
    expect(captionFor("idle", 15)).toBe("Locked automatically after 15 minutes without use");
    expect(captionFor("idle", 60)).toBe("Locked automatically after 1 hour without use");
    expect(captionFor("idle", 1)).toBe("Locked automatically after 1 minute without use");
    // A fresh launch has no reason: it must not claim an automatic lock.
    expect(captionFor(null, 15)).toBe("Your workspace is encrypted");
    expect(captionFor("sleep", 15)).toBe("Locked when your computer went to sleep");
  });
});
