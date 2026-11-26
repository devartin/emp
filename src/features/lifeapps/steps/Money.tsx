/** money (§16): one amount, or several named amounts (emergency fund, tax payments) with an optional months choice. */
import { MoneyField } from "@/ui/MoneyField";
import { Segmented } from "@/ui/Segmented";
import { humanize } from "./fields";
import { isObj, type StepProps } from "./types";

export function Money({ step, value, onChange, currency, recommendation }: StepProps) {
  if (!isObj(step.default) && !isObj(value)) {
    const n = typeof value === "number" ? value : typeof step.default === "number" ? step.default : 0;
    return (
      <MoneyField
        size="lg"
        currency={currency}
        value={String(n)}
        onChange={(v) => onChange(v === null ? 0 : Number(v))}
        aria-label={step.title}
        className="la-bigmoney"
      />
    );
  }
  const obj = { ...(isObj(step.default) ? step.default : {}), ...(isObj(value) ? value : {}) };
  const opts = step.options ?? [];
  // The field the options choose (e.g. `months` for "3 / 6 / 9–12 months").
  const optField = opts.length ? Object.keys(obj).find((k) => opts.some((o) => Number(o.value) === obj[k])) ?? "months" : null;
  const recMonths = isObj(recommendation?.value) && optField ? recommendation?.value[optField] : undefined;
  return (
    <div className="flex flex-col gap-4">
      {optField ? (
        <div className="flex flex-col gap-2">
          <span className="text-body-sm font-medium text-secondary">Target</span>
          <Segmented
            value={String(obj[optField] ?? opts[0]?.value)}
            onValueChange={(v) => onChange({ ...obj, [optField]: Number(v) })}
            options={opts.map((o) => ({ value: o.value, label: Number(o.value) === recMonths ? `${o.label} ★` : o.label }))}
            block
            aria-label="Target"
          />
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        {Object.keys(obj)
          .filter((k) => k !== optField && typeof obj[k] === "number")
          .map((k) => (
            <MoneyField key={k} size="md" label={humanize(k)} currency={currency} value={String(obj[k] ?? 0)} onChange={(v) => onChange({ ...obj, [k]: v === null ? 0 : Number(v) })} />
          ))}
      </div>
    </div>
  );
}
