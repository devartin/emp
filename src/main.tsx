/**
 * Entry (§12): read boot prefs → set data-* (already done by the inline script; re-applied here) → mount → boot →
 * window.show(). The window starts hidden; the first screen to commit reports `app_ready` (App.tsx), and
 * `showWindow` after boot is the backup — neither waits on a frame that a hidden window never runs (1.0 brief §5).
 * No frame monitor runs: nothing ticks while nothing changes (brief §4).
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/styles/index.css";
import App from "@/app/App";
import { boot, showWindow } from "@/app/boot";
import { initAppearance } from "@/lib/bootPrefs";
import { mark } from "@/lib/perf";

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
}
