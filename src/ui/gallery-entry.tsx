/* Dev-only entry for the component gallery (http://localhost:1420/ui-gallery.html). Not part of the app bundle. */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/styles/index.css";
import { initAppearance } from "@/lib/bootPrefs";
import { Gallery } from "./Gallery";
import { MotionProvider } from "./motion/MotionProvider";
import { Toaster } from "./Toast";
import { TooltipProvider } from "./Tooltip";

initAppearance();
const params = new URLSearchParams(location.search);
const root = document.documentElement;
for (const k of ["theme", "accent", "density", "motion", "privacy", "numbers", "contrast", "effects", "text-size"]) {
  const v = params.get(k);
  if (v) root.setAttribute(`data-${k}`, v);
}

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <StrictMode>
      <MotionProvider strict>
        <TooltipProvider>
          <Gallery />
          <Toaster />
        </TooltipProvider>
      </MotionProvider>
    </StrictMode>,
  );
}
