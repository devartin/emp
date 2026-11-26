import { clsx, type ClassValue } from "clsx";

/** Class-name joiner used across the UI kit. Thin alias over clsx (no tailwind-merge: we keep class lists conflict-free). */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}

export default cn;
