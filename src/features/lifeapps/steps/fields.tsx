/**
 * Shared wizard field renderer: one control per `itemSchema` type string — text, number, money, percent, bool, date,
 * time, enum(a,b,…) and recurrence — plus the labels/humanising the steps use.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { DatePicker } from "@/ui/DatePicker";
import { Input } from "@/ui/Input";
import { MoneyField } from "@/ui/MoneyField";
import { NumberField } from "@/ui/NumberField";
import { Select } from "@/ui/Select";
import { Switch } from "@/ui/Switch";
import { RecurrencePicker, type RecurrenceAnswer } from "./RecurrencePicker";

const LABELS: Record<string, string> = {
  apr: "APR",
  minPayment: "Min payment",
  nextPayDate: "Next pay date",
  onBudget: "On budget",
  twoMinute: "Two-minute version",
  timeOfDay: "Time of day",
  taxTreatment: "Tax treatment",
  alertAbove: "Alert above",
  alertBelow: "Alert below",
  dueDay: "Due day",
  autopay: "Autopay",
  perWeek: "Per week",
  monthStartDay: "Month starts on day",
  numberFormat: "Number format",
  billDays: "Remind days before bills",
  splitPct: "Your share %",
  withheldYtd: "Withheld so far",
  withholdingRemaining: "Withholding still to come",
  estimatesPaid: "Estimated payments made",
  priorYearTax: "Last year’s total tax",
  over65: "Age 65+ or blind",
  maxFocusBlocks: "Max focus blocks",
  focusStart: "Peak focus from",
  focusEnd: "Peak focus until",
};

const VALUE_LABELS: Record<string, string> = {
  credit_card: "Credit card",
  student_loan: "Student loan",
  auto_loan: "Auto loan",
  personal_loan: "Personal loan",
  other_asset: "Other asset",
  other_liability: "Other liability",
  roth_ira: "Roth IRA",
  ira: "IRA",
  "401k": "401(k)",
  "403b": "403(b)",
  hsa: "HSA",
  "529": "529 plan",
  yes_no: "Yes / no",
  x_per_week: "X per week",
  every_n_days: "Every N days",
  semimonthly: "Twice a month",
  biweekly: "Every 2 weeks",
  deferred: "Tax-deferred",
  free: "Tax-free",
};

export function humanize(key: string): string {
  if (LABELS[key]) return LABELS[key];
  const s = key.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function humanValue(v: string): string {
  return VALUE_LABELS[v] ?? humanize(v);
}

export function enumValues(type: string): string[] | null {
  const m = /^enum\((.*)\)$/.exec(type.trim());
  return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : null;
}

export interface FieldProps {
  name: string;
  type: string;
  value: unknown;
  onChange: (v: unknown) => void;
  currency?: string;
  label?: ReactNode | false;
  size?: "sm" | "md";
  min?: number;
  max?: number;
  className?: string;
}

/** A labelled control for one schema field. */
export function FieldInput({ name, type, value, onChange, currency = "USD", label, size = "sm", min, max, className }: FieldProps) {
  const lbl = label === false ? undefined : (label ?? humanize(name));
  const values = enumValues(type);
  if (values) {
    return (
      <Select
        className={className}
        size={size}
        label={lbl}
        value={typeof value === "string" ? value : null}
        onValueChange={onChange}
        options={values.map((v) => ({ value: v, label: humanValue(v) }))}
        aria-label={typeof lbl === "string" ? lbl : name}
      />
    );
  }
  switch (type) {
    case "money":
      return (
        <MoneyField
          className={className}
          size={size}
          label={lbl}
          currency={currency}
          value={value === null || value === undefined || value === "" ? null : String(value)}
          onChange={(v) => onChange(v === null ? null : Number(v))}
        />
      );
    case "percent":
      return (
        <NumberField
          className={className}
          size={size}
          label={lbl}
          value={typeof value === "number" ? Math.round(value * 10000) / 100 : null}
          onChange={(v) => onChange(v === null ? null : v / 100)}
          suffix="%"
          min={0}
          max={100}
          step={0.25}
        />
      );
    case "number":
      return <NumberField className={className} size={size} label={lbl} value={typeof value === "number" ? value : null} onChange={onChange} min={min} max={max} />;
    case "bool":
      return (
        <div className={cn("flex h-full items-end pb-1.5", className)}>
          <Switch size="sm" checked={!!value} onCheckedChange={onChange} label={lbl} />
        </div>
      );
    case "date":
      return <DatePicker className={className} size={size} label={lbl} value={typeof value === "string" ? value : null} onChange={onChange} />;
    case "time":
      return (
        <Input
          className={className}
          size={size}
          label={lbl}
          type="time"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      );
    case "recurrence":
      return <RecurrencePicker label={lbl} value={(value ?? null) as RecurrenceAnswer | null} onChange={onChange} />;
    default:
      return (
        <Input
          className={className}
          size={size}
          label={lbl}
          value={typeof value === "string" || typeof value === "number" ? String(value) : ""}
          onChange={(e) => onChange(e.currentTarget.value)}
          maxLength={200}
        />
      );
  }
}
