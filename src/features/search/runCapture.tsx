/**
 * Commit a capture and confirm it: "Added to Tasks · Fri, Nov 27 · View" with Undo. Shared by ⌘K and Home's
 * capture field, so both behave the same.
 */
import { navigate } from "@/app/router";
import type { Id } from "@/backend/types";
import { notify } from "@/stores/toasts";
import { useUi } from "@/stores/ui";
import { commitCapture, type Capture } from "./capture";

export async function runCapture(c: Exclude<Capture, { kind: "error" }>, accountId?: Id | null): Promise<boolean> {
  try {
    const done = await commitCapture(c, {
      accountId,
      view: (r) => (r.t === "row" ? useUi.getState().openPeek(r) : navigate(r)),
    });
    window.dispatchEvent(new CustomEvent("emp:captured"));
    notify.undo(done.title, done.undo, {
      type: "success",
      duration: 8000,
      description: (
        <span>
          {done.detail ? `${done.detail} · ` : ""}
          <button type="button" className="emp-link" onClick={done.view}>
            View
          </button>
        </span>
      ),
    });
    return true;
  } catch (e) {
    notify.fromError(e, "Couldn’t add that");
    return false;
  }
}
