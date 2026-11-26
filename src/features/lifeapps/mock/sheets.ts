/** Mock-only: Spreadsheet Studio generator (§16.5) — the hub plus a workbook built for the chosen intent. */
import type { Id } from '@/backend/types';
import type { MockCtx } from '@/backend/mock/ctx';
import { createWorkbook } from '@/backend/mock/commands/sheet';
import { SHEET_TITLES } from '../engine/plan';
import { md } from './content';
import { isoDay, lucide, type Env, type InstanceRecord } from './env';
import { buildForIntent } from './workbooks';

const ICONS: Record<string, string> = { loan: 'landmark', budget: 'receipt', decision: 'scale', project_budget: 'hammer', timesheet: 'timer', inventory: 'package', split: 'calculator', savings: 'sprout', blank: 'chart-column' };

export function addWorkbook(ctx: MockCtx, inst: InstanceRecord, intent: string, structure: string[]): Id {
  const res = createWorkbook(ctx, {
    workspaceId: inst.workspaceId,
    parentId: inst.rootPageId,
    title: SHEET_TITLES[intent] ?? 'Workbook',
    icon: lucide(ICONS[intent] ?? 'chart-column'),
    silent: ctx.seeding,
    build: (b) => buildForIntent(b, intent, { structure, today: isoDay(ctx.clock.now()) }),
  });
  ctx.db.table<{ id: Id; appInstanceId?: Id }>('pages').update(res.page.id, (p) => void (p.appInstanceId = inst.id));
  inst.created.push(res.page.id);
  return res.page.id;
}

export async function installSheets(env: Env): Promise<void> {
  const { ctx, answers } = env;
  const intent = String(answers.intent ?? 'blank');
  const structure = Array.isArray(answers.structure) ? (answers.structure as string[]) : ['inputs', 'calculations', 'output', 'checks', 'changelog'];
  await env.step(`Building your ${SHEET_TITLES[intent] ?? 'workbook'}`);
  const id = addWorkbook(ctx, env.inst, intent, structure);
  env.inst.keyMap.workbook = id;
  if (env.on('guide')) {
    await env.step('Writing the build guide');
    env.page('guide', {
      title: 'How these workbooks are built',
      icon: lucide('ruler'),
      blocks: md(`Every Spreadsheet Studio workbook follows the same conventions, so anyone can audit it.
- **Inputs** are tinted with your accent colour. Change these; leave formulas alone.
- **Outputs** are bold.
- Constants live in **named ranges** on the Inputs sheet.
- A **Checks** row turns green when the model is consistent.
- Header rows are frozen and dates are ISO (2026-11-26).
${answers.excel_compat ? '\n> [!info] Excel-compatible mode is on: workbooks avoid functions only Ultra Note has, like STOCK and FX.' : ''}`),
    });
  }
}
