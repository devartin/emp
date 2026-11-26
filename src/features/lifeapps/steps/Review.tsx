/** review (§6.5 "Review & create"): every answer in one place with a jump-back link, plus sample data. */
import { PencilLine } from "lucide-react";
import type { LifeAppManifest, Step } from "@/backend/types";
import { formatCurrency } from "@/lib/format";
import { Switch } from "@/ui/Switch";
import { describeRRule } from "../engine/recurrence";
import { humanValue } from "./fields";
import { choiceKey, isObj } from "./types";

export function summarize(step: Step, value: unknown, currency: string): string {
  if (value === null || value === undefined || value === "") return "—";
  const label = (v: string) => step.options?.find((o) => o.value === v)?.label ?? humanValue(v);
  switch (step.kind) {
    case "choice_cards":
    case "connect": {
      const key = choiceKey(step);
      const v = key && isObj(value) ? value[key] : value;
      return typeof v === "string" ? label(v) : "—";
    }
    case "multi_chips":
      return Array.isArray(value) && value.length ? value.map((v) => label(String(v))).join(", ") : "None";
    case "money":
      if (typeof value === "number") return formatCurrency(value, currency, { maximumFractionDigits: 0 });
      if (isObj(value) && typeof value.months === "number") return `${value.months} months${typeof value.current === "number" && value.current ? ` · ${formatCurrency(value.current, currency, { maximumFractionDigits: 0 })} saved` : ""}`;
      return isObj(value) ? Object.values(value).filter((x) => typeof x === "number" && x > 0).length + " amounts" : "—";
    case "percent":
      return typeof value === "number" ? `${Math.round(value * 1000) / 10}%` : "—";
    case "list_builder": {
      const items = Array.isArray(value) ? value : isObj(value) && Array.isArray(value.items) ? value.items : [];
      const names = items.map((x) => (typeof x === "string" ? label(x) : isObj(x) ? String(x.name ?? x.ticker ?? "") : "")).filter(Boolean);
      return names.length ? (names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ")) : "None yet";
    }
    case "recurrence": {
      if (!isObj(value)) return "—";
      const first = Object.values(value).find((x) => isObj(x) && typeof x.rrule === "string") as { rrule: string; time?: string } | undefined;
      return first ? `${describeRRule(first.rrule)}${first.time ? ` · ${first.time}` : ""}` : "Custom";
    }
    case "file_import":
      return isObj(value) ? label(String(value.source ?? "blank")) : "—";
    case "jurisdiction":
      return isObj(value) ? `${value.country ?? ""}${value.region ? ` · ${value.region}` : ""} · ${value.year ?? ""}` : "—";
    case "toggle":
      if (typeof value === "boolean") return value ? "On" : "Off";
      return isObj(value) ? Object.entries(value).filter(([, v]) => v === true).map(([k]) => humanValue(k)).join(", ") || "Off" : "—";
    case "text":
      return typeof value === "string" ? value : "—";
    default:
      return typeof value === "string" || typeof value === "number" ? String(value) : "—";
  }
}

export function Review({ manifest, steps, answers, currency, sample, onSample, onJump }: { manifest: LifeAppManifest; steps: Step[]; answers: Record<string, unknown>; currency: string; sample: boolean; onSample: (v: boolean) => void; onJump: (stepId: string) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <dl className="la-review">
        {steps
          .filter((s) => s.kind !== "review")
          .map((s) => (
            <div key={s.id} className="la-review-row">
              <dt>{s.title}</dt>
              <dd>
                <span className="min-w-0 truncate">{summarize(s, answers[s.id], currency)}</span>
                <button type="button" className="la-review-edit" onClick={() => onJump(s.id)} aria-label={`Change “${s.title}”`}>
                  <PencilLine size={13} aria-hidden />
                </button>
              </dd>
            </div>
          ))}
      </dl>
      <div className="la-card-row">
        <Switch labelFirst checked={sample} onCheckedChange={onSample} label="Include sample data" description={`Explore ${manifest.title} with realistic example rows, clearly tagged. Remove them in one click later.`} />
      </div>
    </div>
  );
}
