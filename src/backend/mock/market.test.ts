/**
 * Deterministic mock market (PROGRAMME-v3 K5 "data truth"): prices must not depend on which page asks first.
 * Before the fix, opening Portfolio first (long-range bars first) produced a different portfolio value than opening
 * Home first ($249,933 vs $236,001 in the verify run).
 */
import { describe, expect, it } from 'vitest';
import { mockApi } from '@/test/helpers';
import { barsFor, closeOn, INSTRUMENTS, priceNow, resetMarketCache } from './market';

const NOW = Date.parse('2026-11-26T15:30:00Z');

function snapshot(): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const i of INSTRUMENTS) {
    out[`${i.key}:now`] = priceNow(i.key, NOW);
    out[`${i.key}:2025-03-03`] = closeOn(i.key, Date.UTC(2025, 2, 3, 21));
    out[`${i.key}:2026-11-20`] = closeOn(i.key, Date.UTC(2026, 10, 20, 21));
  }
  return out;
}

describe('mock market determinism', () => {
  it('gives the same bars and prices whatever is asked first', () => {
    // Order A: a long chart first (what Portfolio's performance view asks for), then quotes.
    resetMarketCache();
    for (const i of INSTRUMENTS) barsFor(i.key, '1d', '2024-01-01', '2026-11-26', NOW);
    const a = snapshot();
    const barsA = barsFor(INSTRUMENTS[0].key, '1d', '2025-06-01', '2026-11-26', NOW);
    // Order B: today's quotes first (what Home asks for), then history in small, out-of-order chunks.
    resetMarketCache();
    for (const i of [...INSTRUMENTS].reverse()) priceNow(i.key, NOW);
    for (const i of INSTRUMENTS) barsFor(i.key, '1d', '2026-11-01', '2026-11-26', NOW);
    for (const i of INSTRUMENTS) barsFor(i.key, '1d', '2025-01-01', '2025-02-01', NOW);
    const b = snapshot();
    const barsB = barsFor(INSTRUMENTS[0].key, '1d', '2025-06-01', '2026-11-26', NOW);
    expect(b).toEqual(a);
    expect(barsB).toEqual(barsA);
  });

  it('values the demo portfolio identically whether Portfolio or Home is opened first', async () => {
    resetMarketCache();
    const first = await mockApi({ freeze: NOW });
    const pf1 = first.backend.ctx.seedRefs.get('finance.instance.portfolio')!;
    const hq1 = first.backend.ctx.seedRefs.get('finance.instance.moneyHq')!;
    await first.api.portfolio.performance({ instanceId: pf1, range: 'all' });
    const portfolioFirst = await first.api.portfolio.summary({ instanceId: pf1 });
    const nwPortfolioFirst = await first.api.finance.overview({ instanceId: hq1, month: '2026-11' });

    resetMarketCache();
    const second = await mockApi({ freeze: NOW });
    const pf2 = second.backend.ctx.seedRefs.get('finance.instance.portfolio')!;
    const hq2 = second.backend.ctx.seedRefs.get('finance.instance.moneyHq')!;
    const nwHomeFirst = await second.api.finance.overview({ instanceId: hq2, month: '2026-11' });
    await second.api.market.quotes({ symbols: INSTRUMENTS.slice(0, 6).map((i) => i.key) });
    const homeFirst = await second.api.portfolio.summary({ instanceId: pf2 });

    expect(homeFirst.totalValue).toEqual(portfolioFirst.totalValue);
    expect(homeFirst.holdings.map((h) => [h.symbol, h.value.amount])).toEqual(portfolioFirst.holdings.map((h) => [h.symbol, h.value.amount]));
    expect(nwHomeFirst.netWorth).toEqual(nwPortfolioFirst.netWorth);
  });
});
