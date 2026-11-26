import { LazyMotion, MotionConfig } from "motion/react";
import { useEffect, type ReactNode } from "react";
import { installKeycaps } from "./keycaps";
import { useRootAttr } from "./useReducedEffects";

const loadFeatures = () => import("./features").then((m) => m.default);

/**
 * Track the last input modality on <html data-input="keyboard|pointer">, so overlays opened from the keyboard (⌘K,
 * menu keys) appear with no animation while mouse-opened ones grow from their origin (register.ts C0 / C1).
 */
function installInputModality(): () => void {
  if (typeof window === "undefined") return () => undefined;
  const root = document.documentElement;
  const set = (v: "keyboard" | "pointer") => {
    if (root.getAttribute("data-input") !== v) root.setAttribute("data-input", v);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Shift" || e.key === "Alt" || e.key === "Control" || e.key === "Meta") return;
    set("keyboard");
  };
  const onPointer = () => set("pointer");
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("pointerdown", onPointer, true);
  return () => {
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("pointerdown", onPointer, true);
  };
}

/**
 * App-wide motion context (docs/DESIGN.md §7): MotionConfig mirrors the resolved html[data-motion]
 * ("reduced" → "always", "full" → "never"); LazyMotion lazily loads domMax so only `m.*` components are used.
 * Also installs the global listeners once: the Kbd chip listener (full-chord matches only) and input modality.
 */
export function MotionProvider({ children, strict = false }: { children: ReactNode; strict?: boolean }) {
  const motion = useRootAttr("data-motion");
  const reducedMotion = motion === "reduced" ? "always" : motion === "full" ? "never" : "user";
  useEffect(() => {
    const a = installInputModality();
    const b = installKeycaps();
    return () => {
      a();
      b();
    };
  }, []);
  return (
    <MotionConfig reducedMotion={reducedMotion}>
      <LazyMotion features={loadFeatures} strict={strict}>
        {children}
      </LazyMotion>
    </MotionConfig>
  );
}
