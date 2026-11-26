/**
 * Sheets seed. demo: "Household budget 2026" (transactions → SUMIFS budget → overview with spilled top categories,
 * checks, data bars and colour scales) and "Mortgage calculator" (named inputs, a 360-row amortization schedule with
 * extra payments, and a rate × term scenario grid). perf: a 200k-cell sheet (10,000 rows × 20 columns).
 * Refs: 'sheets.page.budget', 'sheets.page.mortgage', 'sheets.page.perf'.
 */
import type { MockCtx } from '../ctx';
import { createWorkbook } from '../commands/sheet';
import { buildBudget, buildLoan } from '@/features/sheets/engine/templates';

export const order = 40;

const DAY = 86_400_000;

export function seed(ctx: MockCtx): void {
  const ws = ctx.db.table<{ id: string }>('workspaces').all()[0]?.id;
  if (!ws) return;
  const now = ctx.clock.now();
  if (ctx.seedKind === 'demo') {
    const budget = createWorkbook(ctx, {
      workspaceId: ws,
      parentId: null,
      title: 'Household budget 2026',
      icon: { t: 'lucide', v: 'receipt' },
      createdAt: now - 40 * DAY,
      silent: true,
      build: (b) => buildBudget(b),
    });
    const loan = createWorkbook(ctx, {
      workspaceId: ws,
      parentId: null,
      title: 'Mortgage calculator',
      icon: { t: 'lucide', v: 'house' },
      createdAt: now - 12 * DAY,
      silent: true,
      build: (b) => buildLoan(b),
    });
    ctx.seedRefs.set('sheets.page.budget', budget.page.id);
    ctx.seedRefs.set('sheets.page.mortgage', loan.page.id);
    ctx.pages.emitTree(ws, [budget.page.id, loan.page.id]);
    return;
  }
  if (ctx.seedKind === 'perf') {
    const perf = createWorkbook(ctx, {
      workspaceId: ws,
      parentId: null,
      title: 'Large sheet (200k cells)',
      icon: { t: 'lucide', v: 'trending-up' },
      silent: true,
      build: (b) => {
        const sh = b.sheet('Data');
        const header = ['Date', 'Region', 'Product', 'Units', 'Price', 'Revenue', 'Cost', 'Margin', 'Margin %', 'Rep', 'Channel', 'Q', 'Week', 'Target', 'vs Target', 'Returns', 'Net', 'Rating', 'Flag', 'Notes'];
        header.forEach((h, c) => sh.at(0, c, h, { font: { b: true }, fill: '#F1F1F0' }));
        const regions = ['North', 'South', 'East', 'West', 'Central'];
        const products = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
        const reps = ['Ava', 'Ben', 'Chen', 'Dara', 'Eli', 'Fatima', 'Gus', 'Hana'];
        const channels = ['Online', 'Retail', 'Partner'];
        let seedN = 7;
        const rnd = () => ((seedN = (seedN * 1103515245 + 12345) >>> 0) / 0x1_0000_0000);
        for (let r = 1; r <= 9_999; r++) {
          const d = new Date(Date.UTC(2024, 0, 1) + (r % 730) * DAY);
          sh.at(r, 0, d.toISOString().slice(0, 10), { numFmt: 'yyyy-mm-dd' });
          sh.at(r, 1, regions[r % regions.length]);
          sh.at(r, 2, products[Math.floor(rnd() * products.length)]);
          sh.at(r, 3, String(1 + Math.floor(rnd() * 40)));
          sh.at(r, 4, (5 + rnd() * 95).toFixed(2), { numFmt: '$#,##0.00' });
          sh.at(r, 5, `=D${r + 1}*E${r + 1}`, { numFmt: '$#,##0.00' });
          sh.at(r, 6, `=F${r + 1}*${(0.48 + rnd() * 0.34).toFixed(2)}`, { numFmt: "$#,##0.00" });
          sh.at(r, 7, `=F${r + 1}-G${r + 1}`, { numFmt: '$#,##0.00' });
          sh.at(r, 8, `=IFERROR(H${r + 1}/F${r + 1}, 0)`, { numFmt: '0.0%' });
          sh.at(r, 9, reps[r % reps.length]);
          sh.at(r, 10, channels[Math.floor(rnd() * 3)]);
          sh.at(r, 11, `Q${1 + Math.floor((r % 365) / 92)}`);
          sh.at(r, 12, String(1 + Math.floor((r % 365) / 7)));
          sh.at(r, 13, String(Math.round(400 + rnd() * 1200)), { numFmt: '$#,##0' });
          sh.at(r, 14, `=F${r + 1}-N${r + 1}`, { numFmt: '$#,##0;[Red]-$#,##0' });
          sh.at(r, 15, String(Math.floor(rnd() * 3)));
          sh.at(r, 16, `=F${r + 1}-P${r + 1}*E${r + 1}`, { numFmt: '$#,##0.00' });
          sh.at(r, 17, String(1 + Math.floor(rnd() * 5)));
          sh.at(r, 18, rnd() < 0.08 ? 'TRUE' : 'FALSE');
          if (rnd() < 0.1) sh.at(r, 19, 'Follow up next week');
        }
        sh.freeze(1, 1).width('A', 104).width('T', 200);
        sh.cf('I2:I10000', { kind: 'color_scale', colors: ['#FBE3E4', '#FBF3D9', '#DCF2E3'] });
      },
    });
    ctx.seedRefs.set('sheets.page.perf', perf.page.id);
    ctx.pages.emitTree(ws, [perf.page.id]);
  }
}
