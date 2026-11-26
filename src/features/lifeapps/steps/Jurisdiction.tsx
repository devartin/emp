/** jurisdiction (§16.4): country (with pack tier), state / region, tax year and residency. */
import { Select } from "@/ui/Select";
import { Segmented } from "@/ui/Segmented";
import { Input } from "@/ui/Input";
import { isObj, type StepProps } from "./types";

const US_STATES = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ");

export function Jurisdiction({ step, value, onChange }: StepProps) {
  const v = { ...(isObj(step.default) ? step.default : {}), ...(isObj(value) ? value : {}) };
  const now = new Date();
  // Current year, or the previous one before April 16 (§16.4).
  const defaultYear = now.getMonth() < 3 || (now.getMonth() === 3 && now.getDate() < 16) ? now.getFullYear() - 1 : now.getFullYear();
  const year = Number(v.year ?? defaultYear);
  const country = String(v.country ?? "US");
  const opt = (step.options ?? []).find((o) => o.value === country);
  return (
    <div className="flex flex-col gap-4">
      <Select label="Country" value={country} onValueChange={(c) => onChange({ ...v, country: c, region: c === "US" ? "CA" : "" })} options={(step.options ?? []).map((o) => ({ value: o.value, label: o.label, description: o.description }))} />
      {opt?.description ? <p className="la-hint -mt-2">{opt.description}</p> : null}
      <div className="grid grid-cols-2 gap-3">
        {country === "US" ? (
          <Select label="State" value={String(v.region ?? "CA")} onValueChange={(r) => onChange({ ...v, region: r })} options={US_STATES.map((s) => ({ value: s, label: s }))} searchable helper="Checklist only" />
        ) : (
          <Input label="Region" value={String(v.region ?? "")} onChange={(e) => onChange({ ...v, region: e.currentTarget.value })} helper="Checklist only" />
        )}
        <div className="flex flex-col gap-1.5">
          <span className="text-body-sm font-medium text-secondary">Tax year</span>
          <Segmented value={String(year)} onValueChange={(y) => onChange({ ...v, year: Number(y) })} options={[{ value: String(defaultYear), label: String(defaultYear) }, { value: String(defaultYear - 1), label: String(defaultYear - 1) }]} block aria-label="Tax year" />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-body-sm font-medium text-secondary">Residency</span>
        <Segmented value={String(v.residency ?? "resident")} onValueChange={(r) => onChange({ ...v, residency: r })} options={[{ value: "resident", label: "Full year" }, { value: "part_year", label: "Part year" }, { value: "nonresident", label: "Nonresident" }]} block aria-label="Residency" />
      </div>
    </div>
  );
}
