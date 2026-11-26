import { LazyMotion, MotionConfig } from "motion/react";
import type { ReactNode } from "react";
import { useRootAttr } from "./useReducedEffects";

const loadFeatures = () => import("./features").then((m) => m.default);

/**
 * App-wide motion context (§4.1, §4.3): MotionConfig mirrors the resolved html[data-motion]
 * ("reduced" → "always", "full" → "never"); LazyMotion lazily loads domMax so only `m.*` components are used.
 */
export function MotionProvider({ children, strict = false }: { children: ReactNode; strict?: boolean }) {
  const motion = useRootAttr("data-motion");
  const reducedMotion = motion === "reduced" ? "always" : motion === "full" ? "never" : "user";
  return (
    <MotionConfig reducedMotion={reducedMotion}>
      <LazyMotion features={loadFeatures} strict={strict}>
        {children}
      </LazyMotion>
    </MotionConfig>
  );
}
