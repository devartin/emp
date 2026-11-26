/** slider (§16): a bounded number with a live readout. */
import { Slider as UiSlider } from "@/ui/Slider";
import type { StepProps } from "./types";

export function SliderStep({ step, value, onChange }: StepProps) {
  const n = typeof value === "number" ? value : typeof step.default === "number" ? step.default : (step.min ?? 0);
  return (
    <div className="la-sliderfield">
      <div className="tabular text-kpi text-primary">{n.toLocaleString()}</div>
      <UiSlider value={[n]} min={step.min ?? 0} max={step.max ?? 100} step={step.step ?? 1} onValueChange={([x]) => onChange(x)} aria-label={step.title} />
      <div className="flex justify-between text-caption text-tertiary tabular">
        <span>{(step.min ?? 0).toLocaleString()}</span>
        <span>{(step.max ?? 100).toLocaleString()}</span>
      </div>
    </div>
  );
}
