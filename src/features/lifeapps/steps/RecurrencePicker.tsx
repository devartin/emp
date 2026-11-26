/** Compact rule editor for ritual answers `{ rrule, time }`: Daily · Weekdays · Weekly (day chips) · Monthly, plus a time. */
import type { ReactNode } from "react";
import { Segmented } from "@/ui/Segmented";
import { describeRRule } from "../engine/recurrence";

export interface RecurrenceAnswer {
  rrule: string;
  time?: string;
}

const DAYS: [string, string][] = [["MO", "M"], ["TU", "T"], ["WE", "W"], ["TH", "T"], ["FR", "F"], ["SA", "S"], ["SU", "S"]];
const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR"];

type Freq = "daily" | "weekdays" | "weekly" | "monthly";

function parse(rrule: string): { freq: Freq; days: string[]; monthly: string } {
  const parts = Object.fromEntries(rrule.split(";").map((p) => p.split("=") as [string, string]));
  const days = (parts.BYDAY ?? "").split(",").filter(Boolean);
  if (parts.FREQ === "MONTHLY") return { freq: "monthly", days: [], monthly: parts.BYDAY ? parts.BYDAY : `D${parts.BYMONTHDAY ?? "1"}` };
  if (parts.FREQ === "DAILY" && (!days.length || days.length === 7)) return { freq: "daily", days: [], monthly: "D1" };
  if (days.length === 5 && WEEKDAYS.every((d) => days.includes(d))) return { freq: "weekdays", days, monthly: "D1" };
  return { freq: "weekly", days: days.length ? days : ["FR"], monthly: "D1" };
}

function build(freq: Freq, days: string[], monthly: string): string {
  switch (freq) {
    case "daily":
      return "FREQ=DAILY";
    case "weekdays":
      return "FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR";
    case "weekly":
      return `FREQ=WEEKLY;BYDAY=${(days.length ? days : ["FR"]).join(",")}`;
    default:
      return monthly.startsWith("D") ? `FREQ=MONTHLY;BYMONTHDAY=${monthly.slice(1)}` : `FREQ=MONTHLY;BYDAY=${monthly}`;
  }
}

export function RecurrencePicker({ value, onChange, label }: { value: RecurrenceAnswer | null; onChange: (v: RecurrenceAnswer) => void; label?: ReactNode }) {
  const v = value ?? { rrule: "FREQ=WEEKLY;BYDAY=FR", time: "09:00" };
  const p = parse(v.rrule);
  const set = (patch: Partial<{ freq: Freq; days: string[]; monthly: string; time: string }>) => {
    const freq = patch.freq ?? p.freq;
    const days = patch.days ?? p.days;
    const monthly = patch.monthly ?? p.monthly;
    onChange({ rrule: build(freq, days, monthly), time: patch.time ?? v.time ?? "09:00" });
  };
  return (
    <div className="la-rec">
      {label ? (
        <div className="la-rec-head">
          <span className="la-rec-label">{label}</span>
          <span className="la-rec-desc">
            {describeRRule(v.rrule)}
            {v.time ? ` · ${formatTime(v.time)}` : ""}
          </span>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<Freq>
          size="sm"
          value={p.freq}
          onValueChange={(f) => set({ freq: f, days: f === "weekly" && !p.days.length ? ["FR"] : p.days })}
          options={[{ value: "daily", label: "Daily" }, { value: "weekdays", label: "Weekdays" }, { value: "weekly", label: "Weekly" }, { value: "monthly", label: "Monthly" }]}
          aria-label="How often"
        />
        <input
          type="time"
          className="la-time"
          value={v.time ?? ""}
          onChange={(e) => set({ time: e.currentTarget.value })}
          aria-label="Time"
        />
      </div>
      {p.freq === "weekly" ? (
        <div className="mt-2 flex gap-1" role="group" aria-label="Days of the week">
          {DAYS.map(([code, short]) => {
            const on = p.days.includes(code);
            return (
              <button
                key={code}
                type="button"
                className="la-daychip slab"
                aria-pressed={on}
                aria-label={code}
                onClick={() => set({ days: on ? p.days.filter((d) => d !== code) : [...p.days, code] })}
              >
                {short}
              </button>
            );
          })}
        </div>
      ) : null}
      {p.freq === "monthly" ? (
        <div className="mt-2">
          <Segmented
            size="sm"
            value={p.monthly.startsWith("D") ? "day" : "first"}
            onValueChange={(x) => set({ monthly: x === "day" ? "D1" : "1SA" })}
            options={[{ value: "day", label: "On the 1st" }, { value: "first", label: "First Saturday" }]}
            aria-label="Which day of the month"
          />
        </div>
      ) : null}
    </div>
  );
}

function formatTime(t: string): string {
  const [h, mm] = t.split(":").map(Number);
  if (!Number.isFinite(h)) return t;
  const d = new Date(2026, 0, 1, h, mm || 0);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
