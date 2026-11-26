import type { LifeAppManifest, Step } from "@/backend/types";

export interface Recommendation {
  value: unknown;
  why: string;
  source: string;
}

export interface StepProps {
  step: Step;
  value: unknown;
  onChange: (v: unknown) => void;
  answers: Record<string, unknown>;
  manifest: LifeAppManifest;
  recommendation?: Recommendation;
  currency: string;
}

export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** For object-valued choice steps the chosen option lives in the default's first field (Rust convention). */
export function choiceKey(step: Step): string | null {
  return isObj(step.default) ? (Object.keys(step.default)[0] ?? null) : null;
}

export function choiceOf(step: Step, value: unknown): string | null {
  const key = choiceKey(step);
  if (key) return isObj(value) && value[key] !== undefined && value[key] !== null ? String(value[key]) : null;
  return typeof value === "string" ? value : null;
}

export function withChoice(step: Step, value: unknown, choice: string): unknown {
  const key = choiceKey(step);
  if (!key) return choice;
  const base = isObj(value) ? value : isObj(step.default) ? step.default : {};
  return { ...base, [key]: choice };
}

/** Recommended option value for a step (unwrapping object recommendations). */
export function recommendedChoice(step: Step, rec: Recommendation | undefined): string | null {
  if (!rec) return null;
  const key = choiceKey(step);
  if (key && isObj(rec.value)) return rec.value[key] !== undefined ? String(rec.value[key]) : null;
  return typeof rec.value === "string" ? rec.value : typeof rec.value === "number" ? String(rec.value) : null;
}
