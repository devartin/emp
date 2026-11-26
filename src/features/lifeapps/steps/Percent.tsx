/** percent (§16): a fraction 0..1 with a big readout and a slider. */
import { Slider } from "@/ui/Slider";
import type { StepProps } from "./types";

export function Percent({ step, value, onChange }: StepProps) {
  const n = typeof value === "number" ? value : typeof step.default === "number" ? step.default : 0;
  const pct = Math.round(n * 1000) / 10;
  return (
    <div className="la-sliderfield">
      <div className="tabular text-kpi text-primary">{pct}%</div>
      <Slider value={[pct]} min={(step.min ?? 0) * 100} max={(step.max ?? 1) * 100} step={(step.step ?? 0.005) * 100} onValueChange={([x]) => onChange(Math.round(x * 10) / 1000)} formatValue={(x) => `${x}%`} aria-label={step.title} />
    </div>
  );
}
