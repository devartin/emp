/** date (§16): a calendar date, 'YYYY-MM-DD'. */
import { DatePicker } from "@/ui/DatePicker";
import type { StepProps } from "./types";

export function DateStep({ step, value, onChange }: StepProps) {
  return <DatePicker size="lg" value={typeof value === "string" ? value : null} onChange={onChange} placeholder="Pick a date" label={step.title} />;
}
