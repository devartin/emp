/**
 * choice_cards (§16): cards for ≤ 6 options, a searchable compact list beyond that. Object-valued steps keep extra
 * fields (e.g. debt "extra per month", currency "month starts on day") under the cards.
 */
import { Check, Search } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { formatCurrency } from "@/lib/format";
import { ChoiceCard } from "@/ui/ChoiceCard";
import { Slider } from "@/ui/Slider";
import { spring } from "@/ui/motion/tokens";
import { iconByName } from "../identity";
import { FieldInput } from "./fields";
import { choiceKey, choiceOf, isObj, recommendedChoice, withChoice, type StepProps } from "./types";

export function ChoiceCards({ step, value, onChange, recommendation, currency }: StepProps) {
  const options = step.options ?? [];
  const current = choiceOf(step, value);
  const rec = recommendedChoice(step, recommendation);
  const [q, setQ] = useState("");
  const many = options.length > 6;
  const shown = useMemo(() => (q ? options.filter((o) => `${o.label} ${o.value} ${o.description ?? ""}`.toLowerCase().includes(q.toLowerCase())) : options), [q, options]);
  const key = choiceKey(step);
  const obj = isObj(value) ? value : isObj(step.default) ? step.default : null;
  const extras = key && obj ? Object.keys(obj).filter((k) => k !== key) : [];

  return (
    <div className="flex flex-col gap-4">
      {many ? (
        <div className="la-optlist" role="radiogroup" aria-label={step.title}>
          <label className="la-optsearch">
            <Search size={14} aria-hidden />
            <input value={q} onChange={(e) => setQ(e.currentTarget.value)} placeholder="Search" aria-label="Search options" />
          </label>
          <div className="la-optlist-body">
            {shown.map((o) => {
              const on = current === o.value;
              return (
                <button key={o.value} type="button" role="radio" aria-checked={on} className={cn("la-optrow", on && "is-on")} onClick={() => onChange(withChoice(step, value, o.value))}>
                  <span className="la-optrow-label">{o.label}</span>
                  {o.description ? <span className="la-optrow-desc">{o.description}</span> : null}
                  {rec === o.value ? <span className="la-recchip">Recommended</span> : null}
                  <span className="la-optrow-check" aria-hidden>
                    <AnimatePresence>{on ? <m.span initial={{ scale: 0 }} animate={{ scale: 1, transition: spring.bouncy }} exit={{ scale: 0, transition: { duration: 0.1 } }}><Check size={14} strokeWidth={3} /></m.span> : null}</AnimatePresence>
                  </span>
                </button>
              );
            })}
            {!shown.length ? <p className="px-3 py-4 text-body-sm text-tertiary">No matches.</p> : null}
          </div>
        </div>
      ) : (
        <div className={cn("grid gap-3", options.length === 3 ? "grid-cols-1" : "grid-cols-2")} role="radiogroup" aria-label={step.title}>
          {options.map((o) => (
            <ChoiceCard
              key={o.value}
              className={cn("la-choice", options.length === 3 && "la-choice-row")}
              selected={current === o.value}
              onSelect={() => onChange(withChoice(step, value, o.value))}
              title={o.label}
              description={o.description}
              icon={iconByName(o.icon)}
              recommended={rec === o.value}
            />
          ))}
        </div>
      )}
      {extras.length ? (
        <div className="la-extras">
          {extras.map((k) => {
            const type = step.itemSchema?.[k] ?? (typeof obj?.[k] === "number" ? "number" : typeof obj?.[k] === "boolean" ? "bool" : "text");
            const v = obj?.[k];
            const set = (nv: unknown) => onChange({ ...(obj ?? {}), ...(isObj(value) ? value : {}), [k]: nv });
            if (type === "number" && step.max !== undefined && (k === "extra" || step.max > 100)) {
              const n = typeof v === "number" ? v : 0;
              return (
                <div key={k} className="la-sliderfield">
                  <div className="flex items-baseline justify-between">
                    <span className="text-body-sm font-medium text-secondary">Extra toward debt each month</span>
                    <span className="tabular text-title text-primary">{formatCurrency(n, currency, { maximumFractionDigits: 0 })}</span>
                  </div>
                  <Slider value={[n]} min={step.min ?? 0} max={step.max} step={step.step ?? 1} onValueChange={([x]) => set(x)} formatValue={(x) => formatCurrency(x, currency, { maximumFractionDigits: 0 })} aria-label="Extra per month" />
                </div>
              );
            }
            if (k === "code" || k === "numberFormat") return null;
            return <FieldInput key={k} name={k} type={type} value={v} onChange={set} currency={currency} min={k === "monthStartDay" ? 1 : undefined} max={k === "monthStartDay" ? 28 : undefined} />;
          })}
        </div>
      ) : null}
    </div>
  );
}
