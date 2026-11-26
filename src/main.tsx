/**
 * Entry (§12): read boot prefs → set data-* (already done by the inline script; re-applied here) → mount → boot →
 * first rAF → window.show(); perf marks are reported once the first shell frame is on screen.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/styles/index.css";
import App from "@/app/App";
import { boot, showWindow } from "@/app/boot";
import { degradeEffects, initAppearance } from "@/lib/bootPrefs";
import { mark, startFrameMonitor } from "@/lib/perf";

mark("main:start");
initAppearance();

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  mark("main:render");
  void boot().finally(() => void showWindow());
  // §4.4: flip data-effects="reduced" when more than 10% of frames drop over 5 s (only while the pref is "auto").
  startFrameMonitor({ onDegrade: degradeEffects });
}
