import { LazyMotion, MotionConfig } from "motion/react";
import { useEffect, type ReactNode } from "react";
import { installKeycaps } from "./keycaps";
import { installPointerLight } from "./pointerLight";
import { useRootAttr } from "./useReducedEffects";

const loadFeatures = () => import("./features").then((m) => m.default);

/**
 * App-wide motion context (docs/DESIGN.md §5.8, §6.3): MotionConfig mirrors the resolved html[data-motion]
 * ("reduced" → "always", "full" → "never"); LazyMotion lazily loads domMax so only `m.*` components are used.
 * Also installs the two global listeners once: the pointer light / tilt tracker and the living-keycap key listener.
 */
export function MotionProvider({ children, strict = false }: { children: ReactNode; strict?: boolean }) {
  const motion = useRootAttr("data-motion");
  const reducedMotion = motion === "reduced" ? "always" : motion === "full" ? "never" : "user";
  useEffect(() => {
    const a = installPointerLight();
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
