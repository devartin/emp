/**
 * Tax Organizer client data: the household profile (wizard answers, kv `ui.tax`), the Document checklist,
 * Deductions and Estimated payments databases (by role), figures pulled from Money HQ and Portfolio, and the
 * resulting `TaxInput` for `tax_estimate`.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/backend";
import type { CellValue, DbSchema, Id, RowDTO, TaxEstimate, TaxInput, TaxPackInfo } from "@/backend/types";
import { taxDeductionCategory } from "@/backend/taxDeductions";
import { useWorkspace } from "@/stores/workspace";
import { notify } from "@/stores/toasts";
import { fmtCompact, fmtMoney, fmtWhole, num } from "../finance/shared/format";
import { baseCurrency } from "../finance/shared/currency";
import { cell, queryAll, useAsync, useDbChanged, useRoleDbs, V } from "../finance/shared/hooks";
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

const ROLES = { documents: "taxdoc.status", deductions: "taxded.amount", payments: "taxpay.due" } as const;

export interface TaxData {
  year: number;
  profile: TaxProfile | null;
  setProfile: (p: Partial<TaxProfile>) => void;
  schemas: Partial<Record<keyof typeof ROLES, DbSchema>>;
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

function receiptFieldOf(s: DbSchema | undefined): TaxData["receiptField"] {
  const t = s?.properties.find((p) => p.id === s.database.roles["taxded.receipt"])?.type;
  return t === "checkbox" || t === "files" ? t : null;
}

export function useTaxData(instanceId: Id): TaxData {
  const { schemas, ready } = useRoleDbs(instanceId, ROLES);
  const ids = [schemas.documents?.database.id, schemas.deductions?.database.id, schemas.payments?.database.id];
  const rows = useAsync(async () => {
    const [d, x, p] = await Promise.all(ids.map((id) => (id ? queryAll(id) : Promise.resolve([] as RowDTO[]))));
    return { d, x, p };
  }, [ids.join("|")], { enabled: ready });
  useDbChanged(ids, rows.reload);

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
  const parsed = useMemo(() => {
    const D = schemas.documents;
    const X = schemas.deductions;
    const P = schemas.payments;
    const opt = (s: DbSchema | undefined, role: string, id: string | null) => {
      const p = s?.properties.find((x) => x.id === s.database.roles[role]);
      return ((p?.config.options as { id: string; name: string }[] | undefined) ?? []).find((o) => o.id === id)?.name ?? id ?? "";
    };
    const docs: DocRow[] = (rows.data?.d ?? []).map((r) => ({
      id: r.id,
      name: cell.text(r.values[D!.database.primaryPropId]),
      issuer: cell.text(r.values[D!.database.roles["taxdoc.issuer"]]),
      purpose: cell.text(r.values[D!.database.roles["taxdoc.for"]]),
      expected: cell.date(r.values[D!.database.roles["taxdoc.expected"]]),
      status: cell.sel(r.values[D!.database.roles["taxdoc.status"]]) ?? "expected",
      notes: cell.text(r.values[D!.database.roles["taxdoc.notes"]]),
    }));
    const deductions: DedRow[] = (rows.data?.x ?? [])
      .map((r) => {
        const c = cell.sel(r.values[X!.database.roles["taxded.category"]]) ?? "other";
        const name = opt(X, "taxded.category", c);
        const cat = taxDeductionCategory({ id: c, name });
        return {
          id: r.id,
          desc: cell.text(r.values[X!.database.primaryPropId]),
          date: cell.date(r.values[X!.database.roles["taxded.date"]]),
          category: c,
          categoryName: name,
          key: cat?.key ?? "other",
          kind: cat && "kind" in cat ? cat.kind : null,
          amount: num(cell.money(r.values[X!.database.roles["taxded.amount"]])),
          pct: deductibleShare(cell.num(r.values[X!.database.roles["taxded.pct"]])),
          payee: cell.text(r.values[X!.database.roles["taxded.payee"]]),
          receipt: hasReceipt(r.values[X!.database.roles["taxded.receipt"]]),
        };
      })
      .sort((a, b) => ((a.date ?? "") < (b.date ?? "") ? 1 : -1));
    const payments: PayRow[] = (rows.data?.p ?? [])
      .map((r) => ({
        id: r.id,
        period: cell.text(r.values[P!.database.primaryPropId]),
        due: cell.date(r.values[P!.database.roles["taxpay.due"]]),
        amount: num(cell.money(r.values[P!.database.roles["taxpay.amount"]])),
        paidOn: cell.date(r.values[P!.database.roles["taxpay.date"]]),
      }))
      .sort((a, b) => (a.period < b.period ? -1 : 1));
    return { docs, deductions, payments };
  }, [rows.data, schemas]);

  // Figures pulled from Portfolio (realised gains, taxable dividends) — each needs confirmation in the estimator.
  const lifeapps = useWorkspace((s) => s.lifeapps);
  const pfId = lifeapps.find((i) => i.appId === "portfolio")?.id;
  const realized = useAsync(() => (pfId ? api.portfolio.realized({ instanceId: pfId, year }) : Promise.resolve(null)), [pfId, year]);
  const book = usePortfolioBook(pfId ?? instanceId);
  const pulled = useMemo(() => {
    const out: TaxData["pulled"] = [];
    if (realized.data) {
      const st = num(realized.data.totals.short);
      const lt = num(realized.data.totals.long);
      if (st) out.push({ label: "Short-term gains", kind: "stcg", amount: st, source: "Portfolio · realised this year" });
      if (lt) out.push({ label: "Long-term gains", kind: "ltcg", amount: lt, source: "Portfolio · realised this year" });
    }
    // Dividends paid into taxable accounts this year (sheltered accounts are not taxed now).
    const taxableDivs = book.txns
      .filter((t) => t.type === "dividend" && t.date.startsWith(String(year)) && t.accountId && book.accounts.get(t.accountId)?.tax === "taxable")
      .reduce((a, t) => a + Math.abs(t.amount), 0);
    if (taxableDivs) {
      out.push({ label: "Ordinary dividends", kind: "ordinary_dividends", amount: Math.round(taxableDivs), source: "Portfolio · taxable accounts, paid so far" });
      out.push({ label: "of which qualified", kind: "qualified_dividends", amount: Math.round(taxableDivs * 0.9), source: "Portfolio · common for broad funds (≈90%)" });
    }
    return out;
  }, [realized.data, book.txns, book.accounts, year]);

  const input = useMemo<TaxInput | null>(() => {
    if (!profile) return null;
    const itemized = parsed.deductions.filter((d) => d.kind !== null);
    const medical = itemized.filter((d) => d.kind === "medical").reduce((a, d) => a + d.amount * d.pct, 0);
    const extra = profile.pullPortfolio ? pulled.map((p) => ({ kind: p.kind, amount: p.amount.toFixed(2), source: p.source })) : [];
    const paidEst = parsed.payments.reduce((a, p) => a + (p.paidOn ? p.amount : 0), 0);
    return {
      packId: profile.packId,
      year: profile.year,
      filingStatus: profile.filingStatus,
      dependents: profile.dependents,
      age65OrBlind: profile.age65OrBlind,
      incomes: [...profile.incomes, ...extra],
      adjustments: profile.adjustments,
      deductions:
        profile.deductions === "standard"
          ? "standard"
          : { itemized: [...itemized.filter((d) => d.kind !== "medical").map((d) => ({ kind: d.kind as string, amount: (d.amount * d.pct).toFixed(2) })), ...(medical ? [{ kind: "medical", amount: medical.toFixed(2) }] : [])] },
      credits: profile.credits,
      withheld: profile.withheld,
      estimatedPaid: String(paidEst || num(profile.estimatedPaid)),
      custom: { unsure: profile.unsure },
    };
  }, [profile, parsed.deductions, parsed.payments, pulled]);

  const inputKey = JSON.stringify(input);
  const est = useAsync(() => (input ? api.tax.estimate(input) : Promise.resolve(undefined)), [inputKey], { enabled: !!input });
  const packs = useAsync(() => api.tax.packs({}), []);
  const pack = packs.data?.find((p) => p.id === profile?.packId);
  const currency = taxCurrency(est.data, pack);

  const setDocStatus = useCallback(
    async (id: Id, status: string) => {
      const D = schemas.documents;
      if (!D) return;
      rows.set((prev) => prev && { ...prev, d: prev.d.map((r) => (r.id === id ? { ...r, values: { ...r.values, [D.database.roles["taxdoc.status"]]: V.status(status) } } : r)) });
      try {
        await api.db.rowsUpdate({ updates: [{ id, values: { [D.database.roles["taxdoc.status"]]: V.status(status) } }] });
      } catch (e) {
        notify.fromError(e, "Couldn't update the document");
        rows.reload();
      }
    },
    [schemas.documents, rows],
  );
  const addDeduction = useCallback<TaxData["addDeduction"]>(
    async (d) => {
      const X = schemas.deductions;
      if (!X) return;
      const r = X.database.roles;
      // `d.category` is a category key; desktop option ids are generated, so find the option by key, then name.
      const catProp = X.properties.find((p) => p.id === r["taxded.category"]);
      const options = (catProp?.config.options as { id: string; name: string }[] | undefined) ?? [];
      const option = options.find((o) => taxDeductionCategory(o)?.key === d.category);
      // A checkbox receipt (mock) takes the answer; a files receipt (desktop) is attached in the database itself.
      const receiptProp = X.properties.find((p) => p.id === r["taxded.receipt"]);
      try {
        await api.db.rowCreate({ databaseId: X.database.id, values: { [X.database.primaryPropId]: V.text(d.desc), [r["taxded.date"]]: V.date(d.date), ...(option ? { [r["taxded.category"]]: V.sel(option.id) } : {}), [r["taxded.amount"]]: V.money(d.amount.toFixed(2), currency), [r["taxded.pct"]]: V.num(1), [r["taxded.payee"]]: V.text(d.payee), ...(receiptProp?.type === "checkbox" ? { [r["taxded.receipt"]]: V.check(d.receipt) } : {}), [r["taxded.year"]]: V.num(year) } });
        notify.success("Deduction logged");
        rows.reload();
      } catch (e) {
        notify.fromError(e, "Couldn't log the deduction");
      }
    },
    [schemas.deductions, rows, year, currency],
  );
  const recordPayment = useCallback<TaxData["recordPayment"]>(
    async (period, amount, date) => {
      const P = schemas.payments;
      if (!P) return;
      const r = P.database.roles;
      const existing = parsed.payments.find((p) => p.period === period);
      try {
        if (existing) await api.db.rowsUpdate({ updates: [{ id: existing.id, values: { [r["taxpay.amount"]]: V.money(amount.toFixed(2), currency), [r["taxpay.date"]]: V.date(date), ...(r["taxpay.method"] ? { [r["taxpay.method"]]: V.sel("direct_pay") } : {}) } }] });
        else await api.db.rowCreate({ databaseId: P.database.id, values: { [P.database.primaryPropId]: V.text(period), [r["taxpay.amount"]]: V.money(amount.toFixed(2), currency), [r["taxpay.date"]]: V.date(date) } });
        notify.success(`${period} payment recorded`);
        rows.reload();
      } catch (e) {
        notify.fromError(e, "Couldn't record the payment");
      }
    },
    [schemas.payments, parsed.payments, rows, currency],
  );

  return {
    year,
    profile,
    setProfile,
    schemas,
    ...parsed,
    pulled,
    input,
    estimate: est.data,
    estimating: est.loading,
    pack,
    currency,
    reload: rows.reload,
    setDocStatus,
    addDeduction,
    receiptField: receiptFieldOf(schemas.deductions),
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
export const DOC_FLOW = ["expected", "received", "reviewed", "sent"];
export const DOC_LABEL: Record<string, string> = { expected: "Expected", received: "Received", reviewed: "Reviewed", sent: "Sent to preparer", na: "N/A" };

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
