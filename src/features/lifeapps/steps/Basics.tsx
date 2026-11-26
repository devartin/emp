/** text · toggle · number steps (§16.1 Step kinds). */
import { Switch } from "@/ui/Switch";
import { NumberField } from "@/ui/NumberField";
import { Textarea } from "@/ui/Textarea";
import { humanize } from "./fields";
import { isObj, type StepProps } from "./types";

const TOGGLE_LABEL: Record<string, [string, string]> = {
  encrypt: ["Turn on encryption", "Protects everything in this workspace with your password."],
  hideAmounts: ["Hide amounts on launch", "Numbers show as ••••• until you reveal them."],
};

export function TextStep({ step, value, onChange }: StepProps) {
  return <Textarea value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.currentTarget.value)} placeholder="Write a line or two…" minRows={2} maxRows={5} maxLength={500} aria-label={step.title} />;
}

export function ToggleStep({ step, value, onChange }: StepProps) {
  if (isObj(step.default) || isObj(value)) {
    const obj = { ...(isObj(step.default) ? step.default : {}), ...(isObj(value) ? value : {}) };
    return (
      <div className="la-toggles panel" data-flat="">
        {Object.keys(obj).map((k) => (
          <Switch key={k} labelFirst checked={!!obj[k]} onCheckedChange={(v) => onChange({ ...obj, [k]: v })} label={TOGGLE_LABEL[k]?.[0] ?? humanize(k)} description={TOGGLE_LABEL[k]?.[1]} />
        ))}
      </div>
    );
  }
  const on = typeof value === "boolean" ? value : !!step.default;
  return (
    <div className="la-toggles panel" data-flat="">
      <Switch labelFirst checked={on} onCheckedChange={onChange} label={on ? "Yes" : "No"} description={step.help} />
    </div>
  );
}

export function NumberStep({ step, value, onChange }: StepProps) {
  return (
    <NumberField
      size="lg"
      value={typeof value === "number" ? value : typeof step.default === "number" ? step.default : null}
      onChange={(v) => onChange(v ?? step.default ?? 0)}
      min={step.min}
      max={step.max}
      step={step.step}
      aria-label={step.title}
      className="max-w-[200px]"
    />
  );
}
