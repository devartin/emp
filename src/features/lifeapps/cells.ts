/** Cell helpers for life-app dashboards: read typed values from `RowDTO`s and build `CellValue`s for writes. */
import type { CellValue, DateValue, Id, Property, RowDTO } from "@/backend/types";

export const read = {
  text(r: RowDTO, p: Property | undefined): string {
    if (!p) return "";
    const v = r.values[p.id];
    if (!v) return "";
    if (v.t === "text") return v.v.map((s) => s.text).join("");
    if (v.t === "computed") return v.v.display;
    if (v.t === "url" || v.t === "email" || v.t === "phone") return v.v ?? "";
    return "";
  },
  opt(r: RowDTO, p: Property | undefined): { id: Id; name: string; color?: string } | null {
    if (!p) return null;
    const v = r.values[p.id];
    if (!v || (v.t !== "select" && v.t !== "status") || !v.v) return null;
    const opts = (p.config.options as { id: Id; name: string; color?: string }[] | undefined) ?? [];
    return opts.find((o) => o.id === v.v) ?? null;
  },
  multi(r: RowDTO, p: Property | undefined): { id: Id; name: string; color?: string }[] {
    if (!p) return [];
    const v = r.values[p.id];
    if (!v || v.t !== "multi") return [];
    const opts = (p.config.options as { id: Id; name: string; color?: string }[] | undefined) ?? [];
    return v.v.map((id) => opts.find((o) => o.id === id)).filter((x): x is { id: Id; name: string; color?: string } => !!x);
  },
  num(r: RowDTO, p: Property | undefined): number | null {
    if (!p) return null;
    const v = r.values[p.id];
    if (!v) return null;
    if (v.t === "number" || v.t === "rating" || v.t === "progress") return v.v;
    if (v.t === "money") return v.v === null ? null : Number(v.v);
    if (v.t === "computed" && typeof v.v.value === "number") return v.v.value;
    return null;
  },
  date(r: RowDTO, p: Property | undefined): DateValue | null {
    if (!p) return null;
    const v = r.values[p.id];
    return v && v.t === "date" ? v.v : null;
  },
  bool(r: RowDTO, p: Property | undefined): boolean {
    if (!p) return false;
    const v = r.values[p.id];
    return !!v && v.t === "check" && v.v;
  },
  rel(r: RowDTO, p: Property | undefined): Id[] {
    if (!p) return [];
    const v = r.values[p.id];
    return v && v.t === "relation" ? v.v : [];
  },
};

export const write = {
  text: (s: string): CellValue => ({ t: "text", v: s ? [{ text: s }] : [] }),
  num: (n: number | null): CellValue => ({ t: "number", v: n }),
  date: (start: string, end?: string, time = false): CellValue => ({ t: "date", v: end ? { start, end, time } : { start, time } }),
  check: (b: boolean): CellValue => ({ t: "check", v: b }),
  status: (id: Id | null): CellValue => ({ t: "status", v: id }),
  select: (id: Id | null): CellValue => ({ t: "select", v: id }),
  rel: (ids: Id[]): CellValue => ({ t: "relation", v: ids }),
};

export function optionId(p: Property | undefined, name: string): Id | null {
  if (!p) return null;
  const opts = (p.config.options as { id: Id; name: string }[] | undefined) ?? [];
  return opts.find((o) => o.name.toLowerCase() === name.toLowerCase())?.id ?? null;
}

/** Normalises an option name like Rust's `norm` (`Yes / no` → `yes_no`, `X per week` → `x_per_week`). */
export function normKey(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Whether an option is the manifest option `key`. Rule (1.0, both backends): an app-generated option's id IS its
 * manifest key (`done`, `p1`, `yes_no`), so a renamed option still matches. The normalised-name fallback covers
 * browser-preview data whose option ids are random.
 */
export function optIs(o: { id: Id; name: string } | null | undefined, key: string): boolean {
  return !!o && (o.id === key || normKey(o.name) === key);
}

/** The option of `p` that is manifest key `key` (id, else normalised name), for writes. */
export function optionFor(p: Property | undefined, key: string): Id | null {
  if (!p) return null;
  const opts = (p.config.options as { id: Id; name: string }[] | undefined) ?? [];
  return (opts.find((o) => o.id === key) ?? opts.find((o) => normKey(o.name) === key))?.id ?? null;
}

/** The first of `keys` that option `o` is, else `null`. */
export function keyOf(o: { id: Id; name: string } | null | undefined, keys: readonly string[]): string | null {
  return keys.find((k) => optIs(o, k)) ?? null;
}

/** 'YYYY-MM-DD' in local time. */
export function localDay(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
