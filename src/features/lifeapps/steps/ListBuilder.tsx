/**
 * list_builder (§16): library chips to add common items in one tap, item cards with the key fields inline and the
 * rest behind a disclosure, plus the optional sibling field of `{ items, <field> }` answers (e.g. income stability).
 */
import { Check, ChevronDown, Plus, X } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { Segmented } from "@/ui/Segmented";
import { spring } from "@/ui/motion/tokens";
import { FieldInput, humanize } from "./fields";
import { isObj, type StepProps } from "./types";

type Item = Record<string, unknown>;

const PRIMARY_PREF = ["amount", "balance", "target", "type", "frequency", "schedule", "broker", "alertAbove"];

/** "duration · daily", "yes/no · 3× week" → item hints. */
function hints(desc: string | undefined): Item {
  if (!desc) return {};
  const d = desc.toLowerCase();
  const out: Item = {};
  if (d.includes("yes/no")) out.type = "yes_no";
  else if (d.includes("duration") || /\bmin\b/.test(d)) out.type = "duration";
  else if (d.includes("count")) out.type = "count";
  else if (d.includes("avoid")) out.type = "avoid";
  else if (/\d+\s+\w+/.test(d)) out.type = "quantity";
  if (d.includes("weekdays")) out.schedule = "weekdays";
  else if (/(\d)×\s*week/.test(d)) {
    out.schedule = "x_per_week";
    out.perWeek = Number(/(\d)×/.exec(d)?.[1] ?? 3);
  } else if (d.includes("weekly")) {
    out.schedule = "x_per_week";
    out.perWeek = 1;
  } else if (d.includes("daily")) out.schedule = "daily";
  const num = /(\d+)\s*(min|glasses)/.exec(d);
  if (num) {
    out.target = Number(num[1]);
    out.unit = num[2];
  }
  return out;
}

export function ListBuilder({ step, value, onChange, currency }: StepProps) {
  const schema = step.itemSchema ?? { name: "text" };
  const wrapped = isObj(step.default) && Array.isArray(step.default.items);
  const extraKey = wrapped ? Object.keys(step.default as Item).find((k) => k !== "items") ?? null : null;
  const rawItems: unknown[] = wrapped ? ((isObj(value) ? value.items : (step.default as Item).items) as unknown[]) ?? [] : Array.isArray(value) ? value : Array.isArray(step.default) ? (step.default as unknown[]) : [];
  const options = step.options ?? [];
  const library = extraKey ? [] : options;
  const items: Item[] = rawItems.map((x) => (typeof x === "string" ? { name: options.find((o) => o.value === x)?.label ?? x, ...hints(options.find((o) => o.value === x)?.description) } : isObj(x) ? x : { name: String(x) }));
  const [open, setOpen] = useState<number | null>(null);

  const commit = (next: Item[], extra?: unknown) => {
    if (wrapped) onChange({ ...(isObj(step.default) ? step.default : {}), ...(isObj(value) ? value : {}), items: next, ...(extraKey && extra !== undefined ? { [extraKey]: extra } : {}) });
    else onChange(next);
  };
  const nameKey = "name" in schema ? "name" : Object.keys(schema)[0];
  const keys = Object.keys(schema);
  const primary = keys.filter((k) => k !== nameKey && PRIMARY_PREF.includes(k)).slice(0, 1);
  const rest = keys.filter((k) => k !== nameKey && !primary.includes(k));
  const has = (label: string) => items.findIndex((i) => String(i[nameKey] ?? "").toLowerCase() === label.toLowerCase());
  const blank = (): Item => {
    const o: Item = {};
    for (const k of keys) {
      const t = schema[k];
      const en = /^enum\((.*)\)$/.exec(t)?.[1]?.split(",")[0];
      o[k] = en ?? (t === "bool" ? false : t === "money" || t === "number" ? null : "");
    }
    return o;
  };

  return (
    <div className="flex flex-col gap-4">
      {extraKey ? (
        <div className="flex flex-col gap-2">
          <span className="text-body-sm font-medium text-secondary">{humanize(extraKey)}</span>
          <Segmented
            value={String((isObj(value) ? value[extraKey] : (step.default as Item)[extraKey]) ?? options[0]?.value ?? "")}
            onValueChange={(v) => commit(items, v)}
            options={options.map((o) => ({ value: o.value, label: o.label }))}
            block
            aria-label={humanize(extraKey)}
          />
        </div>
      ) : null}
      {library.length ? (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick add">
          {library.map((o) => {
            const idx = has(o.label);
            const on = idx >= 0;
            return (
              <m.button
                key={o.value}
                type="button"
                className={cn("la-chip la-chip-sm", on && "is-on")}
                aria-pressed={on}
                whileTap={{ scale: 0.95 }}
                transition={spring.snappy}
                onClick={() => (on ? commit(items.filter((_, i) => i !== idx)) : commit([...items, { ...blank(), [nameKey]: o.label, ...hints(o.description) }]))}
              >
                {on ? <Check size={12} strokeWidth={3} aria-hidden /> : <Plus size={12} strokeWidth={2.5} aria-hidden />}
                {o.label}
              </m.button>
            );
          })}
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        <AnimatePresence initial={false}>
          {items.map((it, i) => (
            <m.div
              key={`${i}`}
              layout="position"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0, transition: spring.gentle }}
              exit={{ opacity: 0, transition: { duration: 0.12 } }}
              className="la-item"
            >
              <div className="la-item-row">
                <FieldInput name={nameKey} type={schema[nameKey] ?? "text"} value={it[nameKey]} onChange={(v) => commit(items.map((x, j) => (j === i ? { ...x, [nameKey]: v } : x)))} label={false} className="min-w-0 flex-1" />
                {primary.map((k) => (
                  <FieldInput key={k} name={k} type={schema[k]} value={it[k]} onChange={(v) => commit(items.map((x, j) => (j === i ? { ...x, [k]: v } : x)))} currency={currency} label={false} className="w-[132px] flex-none" />
                ))}
                {rest.length ? (
                  <IconButton
                    size="sm"
                    icon={ChevronDown}
                    label={open === i ? "Fewer details" : "More details"}
                    className={cn("la-item-more", open === i && "is-open")}
                    onClick={() => setOpen(open === i ? null : i)}
                    aria-expanded={open === i}
                  />
                ) : null}
                <IconButton size="sm" icon={X} label="Remove" onClick={() => commit(items.filter((_, j) => j !== i))} />
              </div>
              <AnimatePresence initial={false}>
                {open === i && rest.length ? (
                  <m.div key="more" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }} className="overflow-hidden">
                    <div className="grid grid-cols-2 gap-3 pt-3">
                      {rest.map((k) => (
                        <FieldInput key={k} name={k} type={schema[k]} value={it[k]} onChange={(v) => commit(items.map((x, j) => (j === i ? { ...x, [k]: v } : x)))} currency={currency} />
                      ))}
                    </div>
                  </m.div>
                ) : null}
              </AnimatePresence>
            </m.div>
          ))}
        </AnimatePresence>
        {!items.length ? <p className="la-hint">Nothing added yet — tap a suggestion above or add your own.</p> : null}
        <div>
          <Button variant="ghost" size="sm" icon={Plus} onClick={() => {
            commit([...items, blank()]);
            setOpen(items.length);
          }}>
            Add {nameKey === "ticker" ? "a ticker" : "another"}
          </Button>
        </div>
      </div>
    </div>
  );
}
