/** Tax Organizer row parsing that must agree across backends (desktop option ids are generated; receipts differ). */
import { describe, expect, it } from 'vitest';
import { taxDeductionCategory } from '@/backend/taxDeductions';
import { deductibleShare, hasReceipt, taxCurrency } from './data';

describe('tax data helpers', () => {
  it('maps a desktop option (generated id) to its category by name', () => {
    expect(taxDeductionCategory({ id: '01HX9ZQ4', name: 'Charitable gifts' })?.key).toBe('charity');
    expect(taxDeductionCategory({ id: 'a1b2', name: 'State & local taxes' })?.key).toBe('salt');
    expect(taxDeductionCategory({ id: 'zz', name: 'Mortgage interest' })?.key).toBe('mortgage');
    expect(taxDeductionCategory({ id: 'medical', name: 'Medical & dental' })?.key).toBe('medical');
  });
  it('reads Deductible % as a fraction and tolerates a typed whole percentage', () => {
    expect(deductibleShare(1)).toBe(1);
    expect(deductibleShare(0.5)).toBe(0.5);
    expect(deductibleShare(50)).toBe(0.5);
    expect(deductibleShare(100)).toBe(1);
    expect(deductibleShare(null)).toBe(1);
  });
  it('treats a ticked box (mock) or an attached file (desktop) as a kept receipt', () => {
    expect(hasReceipt({ t: 'check', v: true })).toBe(true);
    expect(hasReceipt({ t: 'check', v: false })).toBe(false);
    expect(hasReceipt({ t: 'files', v: [{ assetId: 'a', name: 'r.pdf' }] })).toBe(true);
    expect(hasReceipt({ t: 'files', v: [] })).toBe(false);
    expect(hasReceipt(null)).toBe(false);
  });
  it('formats in the estimate currency, else the pack currency', () => {
    expect(taxCurrency({ currency: 'CAD' } as never, { currency: 'USD' } as never)).toBe('CAD');
    expect(taxCurrency(undefined, { currency: 'USD' } as never)).toBe('USD');
  });
});
