/**
 * The Tax Organizer's "Deductions & credits" categories (`taxded.category`), identical on both backends: the desktop
 * manifest (`crates/emp-store/lifeapps/tax-organizer.json`, option `key` and `name`) and the mock seed
 * (`src/backend/mock/seed/finance.ts`, option `id` = `key`). `src/backend/mock/parity.test.ts` and the Rust parity
 * test hold all three to `crates/emp-finance/tests/fixtures/parity/fixture.json` `deductionCategories`.
 *
 * `kind` is the tax engine's itemised kind (`TaxInput.deductions.itemized[].kind`) for itemisable categories. Desktop
 * option ids are generated, so map a row's option with {@link taxDeductionKind} (it matches the id, then the name).
 * The amount sent is `amount × taxded.pct`, where `pct` is a fraction (1 = 100%) on both backends.
 * Contributions to a traditional IRA or an HSA made outside payroll are adjustments (`TaxInput.adjustments`), not
 * itemised deductions; a Roth IRA contribution is neither (IRS Pub 590-A).
 */
export const TAX_DEDUCTION_CATEGORIES = [
  { key: 'charity', name: 'Charitable gifts', kind: 'charity' },
  { key: 'medical', name: 'Medical & dental', kind: 'medical' },
  { key: 'salt', name: 'State & local taxes', kind: 'salt' },
  { key: 'mortgage', name: 'Mortgage interest', kind: 'mortgage' },
  { key: 'home_office', name: 'Home office' },
  { key: 'business', name: 'Business expense' },
  { key: 'education', name: 'Education' },
  { key: 'childcare', name: 'Childcare' },
  { key: 'hsa', name: 'HSA contribution', adjustment: 'hsa' },
  { key: 'ira', name: 'Traditional IRA contribution', adjustment: 'ira' },
  { key: 'other', name: 'Other' },
] as const satisfies readonly { key: string; name: string; kind?: string; adjustment?: 'hsa' | 'ira' }[];

export type TaxDeductionCategory = (typeof TAX_DEDUCTION_CATEGORIES)[number];

/** The category of a `taxded.category` option: by id (mock ids are the keys), else by name (desktop). */
export function taxDeductionCategory(option: { id?: string | null; name?: string | null } | null | undefined): TaxDeductionCategory | undefined {
  if (!option) return undefined;
  const id = option.id?.trim();
  const name = option.name?.trim().toLowerCase();
  return TAX_DEDUCTION_CATEGORIES.find((c) => c.key === id) ?? TAX_DEDUCTION_CATEGORIES.find((c) => c.name.toLowerCase() === name);
}

/** The engine's itemised kind for a `taxded.category` option, or `undefined` when the category is not itemisable. */
export function taxDeductionKind(option: { id?: string | null; name?: string | null } | null | undefined): string | undefined {
  const c = taxDeductionCategory(option);
  return c && 'kind' in c ? c.kind : undefined;
}
