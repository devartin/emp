/** Mock `fx_rates` (§11.3, §17.2 frankfurter): a fixed ECB-style table, cached per date. */
import type { MockHandlers } from '../ctx';
import { FX_PER_USD, fxRate } from '../market';

export const handlers: MockHandlers = {
  fx_rates: (req, ctx) => {
    const base = String(req.base ?? 'USD').toUpperCase();
    if (!FX_PER_USD[base]) ctx.fail('INVALID', `Unknown currency ${base}`, { field: 'base' });
    const wanted = req.symbols?.length ? req.symbols.map((s) => s.toUpperCase()) : Object.keys(FX_PER_USD);
    const rates: Record<string, number> = {};
    for (const s of wanted) {
      if (s === base) continue;
      const r = fxRate(base, s);
      if (r !== null) rates[s] = Math.round(r * 1e6) / 1e6;
    }
    // ECB publishes on business days; report the last weekday on or before the requested date.
    const d = new Date(`${(req.date ?? ctx.clock.today()).slice(0, 10)}T12:00:00Z`);
    if (!Number.isFinite(d.getTime())) ctx.fail('INVALID', 'Invalid date', { field: 'date' });
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
    return { base, date: d.toISOString().slice(0, 10), rates, source: 'frankfurter', stale: ctx.isOffline() };
  },
};
