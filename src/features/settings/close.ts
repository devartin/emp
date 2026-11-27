/** Leaving the Settings dialog (1.0 brief §2.4), shared by the dialog and the sections that hand off elsewhere. */
import { navigate } from "@/app/router";
import { useNav } from "@/stores/nav";

/** Back to the page underneath when that is where Settings was opened from, else Home. */
export function closeSettings(): void {
  const nav = useNav.getState();
  if (nav.route.t !== "settings") return;
  const prev = nav.back[nav.back.length - 1];
  if (prev && prev.t !== "settings") nav.goBack();
  else navigate({ t: "home" }, { replace: true });
}
