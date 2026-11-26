/** recurrence (§16): ritual schedules — each recurrence field gets a rule editor; other fields render by schema type. */
import { FieldInput, humanize } from "./fields";
import { RecurrencePicker, type RecurrenceAnswer } from "./RecurrencePicker";
import { isObj, type StepProps } from "./types";

const LABEL: Record<string, string> = {
  weekly: "Weekly check-in",
  monthly: "Monthly review",
  daily: "Daily planning",
  shutdown: "Shutdown",
};

export function Recurrence({ step, value, onChange, currency }: StepProps) {
  const obj = { ...(isObj(step.default) ? step.default : {}), ...(isObj(value) ? value : {}) };
  const schema = step.itemSchema ?? {};
  const keys = Object.keys(obj);
  const rec = keys.filter((k) => (schema[k] ?? (isObj(obj[k]) ? "recurrence" : "")) === "recurrence");
  const rest = keys.filter((k) => !rec.includes(k));
  return (
    <div className="flex flex-col gap-3">
      {rec.map((k) => (
        <div key={k} className="la-card-row">
          <RecurrencePicker label={LABEL[k] ?? humanize(k)} value={obj[k] as RecurrenceAnswer} onChange={(v) => onChange({ ...obj, [k]: v })} />
        </div>
      ))}
      {rest.length ? (
        <div className="grid grid-cols-2 gap-3">
          {rest.map((k) => (
            <FieldInput key={k} name={k} type={schema[k] ?? (typeof obj[k] === "number" ? "number" : "text")} value={obj[k]} onChange={(v) => onChange({ ...obj, [k]: v })} currency={currency} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
