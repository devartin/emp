/**
 * Tax Organizer client data: the household profile (wizard answers, kv `ui.tax`), the Document checklist,
 * Deductions and Estimated payments databases (by role), figures pulled from Money HQ and Portfolio, and the
 * resulting `TaxInput` for `tax_estimate`.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/backend";
import type { CellValue, Id, TaxDocStatus, TaxEstimate, TaxInput, TaxPackInfo, TaxRecords } from "@/backend/types";
import { useWorkspace } from "@/stores/workspace";
import { notify } from "@/stores/toasts";
import { fmtCompact, fmtMoney, fmtWhole, num } from "../finance/shared/format";
import { baseCurrency } from "../finance/shared/currency";
import { useAsync, useDbChanged } from "../finance/shared/hooks";
import { usePortfolioBook } from "../portfolio/data";

export interface TaxProfile {
  v: 1;
  packId: string;
  year: number;
  filingStatus: string;
  dependents: number;
  age65OrBlind: number;
  incomes: TaxInput["incomes"];
  adjustments: TaxInput["adjustments"];
  deductions: "auto" | "standard" | "itemized";
  credits: TaxInput["credits"];
  withheld: string;
  estimatedPaid: string;
  priorYearTax: string;
  priorYearAgi: string;
  method: "safe_harbor" | "current_90" | "even_split";
  pullPortfolio: boolean;
  unsure: boolean;
}

export function defaultProfile(year: number): TaxProfile {
  return { v: 1, packId: `us-federal-${year}`, year, filingStatus: "single", dependents: 0, age65OrBlind: 0, incomes: [{ kind: "wages", amount: "0" }], adjustments: [], deductions: "auto", credits: [], withheld: "0", estimatedPaid: "0", priorYearTax: "0", priorYearAgi: "0", method: "safe_harbor", pullPortfolio: true, unsure: false };
}

export interface DocRow {
  id: Id;
  name: string;
  issuer: string;
  purpose: string;
  expected: string | null;
  status: string;
  notes: string;
}
export interface DedRow {
  id: Id;
  desc: string;
  date: string | null;
  /** The row's `taxded.category` option id (a generated id on desktop, the key in the mock). */
  category: string;
  categoryName: string;
  /** The category key (`TAX_DEDUCTION_CATEGORIES`), matched by option id then name; "other" when unknown. */
  key: string;
  /** The tax engine's itemised kind (charity, medical, salt, mortgage), or null when the category is not itemisable. */
  kind: string | null;
  amount: number;
  /** Deductible share as a fraction (1 = 100%), as stored on both backends. */
  pct: number;
  /** `amount × pct`, computed exactly by the backend. */
  deductible: number;
  payee: string;
  receipt: boolean;
}

/** Itemisable engine kinds (TaxInput.deductions.itemized[].kind). */
export const ITEMIZED_KINDS = ["charity", "medical", "salt", "mortgage"] as const;

/**
 * `taxded.pct` is a fraction (1 = 100%) on both backends (number property, format "percent"). A value above 1 can
 * only be a whole percentage typed into the cell, so read it as one rather than multiplying an amount by 100.
 */
export function deductibleShare(v: number | null | undefined): number {
  if (v == null || !Number.isFinite(v) || v < 0) return 1;
  return v > 1 ? Math.min(v / 100, 1) : v;
}

/** `taxded.receipt` is a files property on desktop and a checkbox in the mock: either counts as kept. */
export function hasReceipt(v: CellValue | null | undefined): boolean {
  if (!v) return false;
  if (v.t === "check") return v.v;
  if (v.t === "files") return v.v.length > 0;
  return false;
}
export interface PayRow {
  id: Id;
  period: string;
  due: string | null;
  amount: number;
  paidOn: string | null;
}

export interface TaxData {
  year: number;
  profile: TaxProfile | null;
  setProfile: (p: Partial<TaxProfile>) => void;
  /** The Taxes databases (for links and change events). */
  dbs: TaxRecords["dbs"];
  docs: DocRow[];
  deductions: DedRow[];
  payments: PayRow[];
  pulled: { label: string; kind: TaxInput["incomes"][number]["kind"]; amount: number; source: string }[];
  input: TaxInput | null;
  estimate: TaxEstimate | undefined;
  estimating: boolean;
  pack: TaxPackInfo | undefined;
  /** ISO 4217 currency for every tax figure: the estimate's, else the pack's, else the workspace base currency. */
  currency: string;
  reload: () => void;
  setDocStatus: (id: Id, status: string) => Promise<void>;
  addDeduction: (d: { desc: string; date: string; category: string; amount: number; payee: string; receipt: boolean }) => Promise<void>;
  /** The `taxded.receipt` property's type: a checkbox (mock) is ticked from the log dialog, files (desktop) are attached in the database. */
  receiptField: "checkbox" | "files" | null;
  recordPayment: (period: string, amount: number, date: string) => Promise<void>;
}

/** The currency tax figures are in: the estimate's, else the pack's (both additive), else the workspace base currency. */
export function taxCurrency(est?: TaxEstimate | null, pack?: TaxPackInfo | null): string {
  return est?.currency ?? pack?.currency ?? baseCurrency();
}

/** Money formatters bound to a tax currency (whole units, exact, compact). */
export function taxMoney(currency: string) {
  return {
    whole: (v: string | number, o: { signed?: boolean } = {}) => fmtWhole(v, { ...o, currency }),
    money: (v: string | number, o: { noCents?: boolean; signed?: boolean } = {}) => fmtMoney(v, currency, o),
    compact: (v: number, signed = false) => fmtCompact(v, currency, signed),
  };
}


export function useTaxData(instanceId: Id): TaxData {
  const [profile, setProfileState] = useState<TaxProfile | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      const own = await api.kv.get({ ns: "ui.tax", key: `profile:${instanceId}` }).catch(() => null);
      const shared = own ? null : await api.kv.get({ ns: "ui.tax", key: "profile" }).catch(() => null);
      const today = new Date();
      const year = today.getMonth() < 3 || (today.getMonth() === 3 && today.getDate() < 16) ? today.getFullYear() - 1 : today.getFullYear();
      if (live) setProfileState({ ...defaultProfile(year), ...((own ?? shared) as Partial<TaxProfile> | null) });
    })();
    return () => {
      live = false;
    };
  }, [instanceId]);
  const setProfile = useCallback(
    (p: Partial<TaxProfile>) =>
      setProfileState((prev) => {
        const next = { ...(prev ?? defaultProfile(new Date().getFullYear())), ...p };
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => void api.kv.set({ ns: "ui.tax", key: `profile:${instanceId}`, value: next }).catch(() => undefined), 400);
        return next;
      }),
    [instanceId],
  );

  const year = profile?.year ?? new Date().getFullYear();
  // The documents, deductions and payments with option keys and exact sums, plus Portfolio's figures for the year
  // (`tax_records`): computed by the backend, not by pulling every row here.
  const recs = useAsync(() => api.tax.records({ instanceId, year }), [instanceId, year], { enabled: !!profile });
  const recIds = recs.data ? (Object.values(recs.data.dbs).filter(Boolean) as Id[]) : [];
  const lifeapps = useWorkspace((s) => s.lifeapps);
  const pfId = lifeapps.find((i) => i.appId === "portfolio")?.id;
  const pfBook = usePortfolioBook(pfId);
  // Portfolio's databases change the pulled figures too.
  useDbChanged([...recIds, ...(Object.values(pfBook.dbs).filter(Boolean) as Id[])], recs.reload);

  const parsed = useMemo(() => {
    const r = recs.data;
    const docs: DocRow[] = (r?.docs ?? []).map((d) => ({ id: d.id, name: d.name, issuer: d.issuer, purpose: d.purpose, expected: d.expected, status: d.status, notes: d.notes }));
    const deductions: DedRow[] = (r?.deductions ?? []).map((d) => ({ id: d.id, desc: d.desc, date: d.date, category: d.key, categoryName: d.categoryName, key: d.key, kind: d.kind, amount: num(d.amount), pct: d.pct, deductible: num(d.deductible), payee: d.payee, receipt: d.receipt }));
    const payments: PayRow[] = (r?.payments ?? []).map((p) => ({ id: p.id, period: p.period, due: p.due, amount: num(p.amount), paidOn: p.paidOn }));
    return { docs, deductions, payments };
  }, [recs.data]);

  const pulled = useMemo<TaxData["pulled"]>(() => (recs.data?.pulled ?? []).map((p) => ({ label: p.label, kind: p.kind, amount: num(p.amount), source: p.source })), [recs.data]);

  const input = useMemo<TaxInput | null>(() => {
    if (!profile || !recs.data) return null;
    const extra = profile.pullPortfolio ? (recs.data.pulled ?? []).map((p) => ({ kind: p.kind, amount: p.amount, source: p.source })) : [];
    const paidEst = recs.data.paidEstimated;
    return {
      packId: profile.packId,
      year: profile.year,
      filingStatus: profile.filingStatus,
      dependents: profile.dependents,
      age65OrBlind: profile.age65OrBlind,
      incomes: [...profile.incomes, ...extra],
      adjustments: profile.adjustments,
      deductions: profile.deductions === "standard" ? "standard" : { itemized: recs.data.itemized.map((d) => ({ kind: d.kind, amount: d.amount })) },
      credits: profile.credits,
      withheld: profile.withheld,
      estimatedPaid: num(paidEst) ? paidEst : String(num(profile.estimatedPaid)),
      custom: { unsure: profile.unsure },
    };
  }, [profile, recs.data]);

  const inputKey = JSON.stringify(input);
  const est = useAsync(() => (input ? api.tax.estimate(input) : Promise.resolve(undefined)), [inputKey], { enabled: !!input });
  const packs = useAsync(() => api.tax.packs({}), []);
  const pack = packs.data?.find((p) => p.id === profile?.packId);
  const currency = taxCurrency(est.data, pack);

  const setDocStatus = useCallback(
    async (id: Id, status: string) => {
      recs.set((prev) => prev && { ...prev, docs: prev.docs.map((d) => (d.id === id ? { ...d, status: status as TaxDocStatus } : d)) });
      try {
        await api.tax.docStatus({ instanceId, id, status: status as TaxDocStatus });
      } catch (e) {
        notify.fromError(e, "Couldn't update the document");
        recs.reload();
      }
    },
    [instanceId, recs],
  );
  const addDeduction = useCallback<TaxData["addDeduction"]>(
    async (d) => {
      try {
        await api.tax.deductionAdd({ instanceId, desc: d.desc, date: d.date, category: d.category, amount: d.amount.toFixed(2), payee: d.payee, receipt: d.receipt, year });
        notify.success("Deduction logged");
        recs.reload();
      } catch (e) {
        notify.fromError(e, "Couldn't log the deduction");
      }
    },
    [instanceId, recs, year],
  );
  const recordPayment = useCallback<TaxData["recordPayment"]>(
    async (period, amount, date) => {
      try {
        await api.tax.paymentRecord({ instanceId, period, amount: amount.toFixed(2), date });
        notify.success(`${period} payment recorded`);
        recs.reload();
      } catch (e) {
        notify.fromError(e, "Couldn't record the payment");
      }
    },
    [instanceId, recs],
  );

  return {
    year,
    profile,
    setProfile,
    dbs: recs.data?.dbs ?? { documents: null, deductions: null, payments: null },
    ...parsed,
    pulled,
    input,
    estimate: est.data,
    estimating: est.loading,
    pack,
    currency,
    reload: recs.reload,
    setDocStatus,
    addDeduction,
    receiptField: recs.data?.receiptField ?? null,
    recordPayment,
  };
}

export const TaxCtx = createContext<TaxData | null>(null);
export function useTax(): TaxData {
  const c = useContext(TaxCtx);
  if (!c) throw new Error("Tax context missing");
  return c;
}

export const STATUS_LABEL: Record<string, string> = { single: "Single", mfj: "Married filing jointly", mfs: "Married filing separately", hoh: "Head of household", qss: "Qualifying surviving spouse" };
/** Document status keys (`taxdoc.status`, `TaxDocStatus`) in checklist order. */
export const DOC_FLOW = ["expected", "received", "reviewed", "sent_to_preparer"];
export const DOC_LABEL: Record<string, string> = { expected: "Expected", received: "Received", reviewed: "Reviewed", sent_to_preparer: "Sent to preparer", n_a: "N/A" };

/**
 * `tax.due` as a short fact for the quarterly views: "$1,224 due Apr 15" when the estimate leaves a balance due at
 * filing, else null. Used with `noPaymentNeeded` (definitions.ts) so a quarter with no payment never reads "Covered" while money
 * is still owed.
 */
export function dueAtFilingText(estimate: { balance: string } | undefined, year: number, fmt: (v: number) => string, day: (d: string) => string): { amount: number; text: string } | null {
  const bal = estimate ? Number(estimate.balance) || 0 : 0;
  if (bal <= 0.5) return null;
  return { amount: bal, text: `${fmt(bal)} due ${day(`${year + 1}-04-15`)}` };
}
