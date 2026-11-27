/** Mock-only: Spreadsheet Studio generator (§16.5) — the hub plus a workbook built for the chosen intent. */
import type { Id } from '@/backend/types';
import type { MockCtx } from '@/backend/mock/ctx';
import { createWorkbook } from '@/backend/mock/commands/sheet';
import { SHEET_TITLES } from '../engine/plan';
import { md } from './content';
import { isoDay, lucide, type Env, type InstanceRecord } from './env';
import { buildForIntent } from './workbooks';

const ICONS: Record<string, string> = { loan: 'landmark', budget: 'receipt', decision: 'scale', project: 'hammer', timesheet: 'timer', inventory: 'package', split: 'calculator', compound: 'sprout', blank: 'chart-column' };

export function addWorkbook(ctx: MockCtx, inst: InstanceRecord, intent: string, structure: string[]): Id {
  const res = createWorkbook(ctx, {
    workspaceId: inst.workspaceId,
    parentId: inst.rootPageId,
    title: SHEET_TITLES[intent] ?? 'Spreadsheet',
    icon: lucide(ICONS[intent] ?? 'chart-column'),
    silent: ctx.seeding,
    build: (b) => buildForIntent(b, intent, { structure, today: isoDay(ctx.clock.now()) }),
  });
  ctx.db.table<{ id: Id; appInstanceId?: Id }>('pages').update(res.page.id, (p) => void (p.appInstanceId = inst.id));
  inst.created.push(res.page.id);
  return res.page.id;
}

/**
 * `lifeapp_add_workbook` (Rust `Store::lifeapp_add_workbook`): a new, ordinary spreadsheet from a template, next to
 * the Studio hub (top level, or inside the hub's project). Every call makes a new one ("Loan calculator 2", …).
 */
export function addStudioSpreadsheet(ctx: MockCtx, inst: InstanceRecord, intent: string, structure: string[]): Id {
  const pages = ctx.db.table<{ id: Id; parentId: Id | null; workspaceId: Id; title: string; deletedAt?: number | null }>('pages');
  const hub = pages.get(inst.rootPageId);
  const parentId = hub?.parentId && pages.get(hub.parentId) && !pages.get(hub.parentId)?.deletedAt ? hub.parentId : null;
  const taken = new Set(pages.filter((p) => p.workspaceId === inst.workspaceId && (p.parentId ?? null) === parentId && !p.deletedAt).map((p) => p.title));
  const base = SHEET_TITLES[intent] ?? 'Spreadsheet';
  let title = base;
  for (let n = 2; taken.has(title); n++) title = `${base} ${n}`;
  const res = createWorkbook(ctx, {
    workspaceId: inst.workspaceId,
    parentId,
    title,
    icon: lucide(ICONS[intent] ?? 'chart-column'),
    build: (b) => buildForIntent(b, intent, { structure, today: isoDay(ctx.clock.now()) }),
  });
  return res.page.id;
}

export async function installSheets(env: Env): Promise<void> {
  const { ctx, answers } = env;
  const intent = String(answers.intent ?? 'blank');
  const structure = Array.isArray(answers.structure) ? (answers.structure as string[]) : ['inputs', 'calculations', 'output', 'checks', 'changelog'];
  await env.step(`Building your ${SHEET_TITLES[intent] ?? 'spreadsheet'}`);
  const id = addWorkbook(ctx, env.inst, intent, structure);
  env.inst.keyMap.workbook = id;
  if (env.on('guide')) {
    await env.step('Writing the build guide');
    env.page('guide', {
      title: 'How these spreadsheets are built',
      icon: lucide('ruler'),
      blocks: md(`Every Spreadsheet Studio spreadsheet follows the same conventions, so anyone can audit it.
- **Inputs** are tinted with your accent colour. Change these; leave formulas alone.
- **Outputs** are bold.
- Constants live in **named ranges** on the Inputs sheet.
- A **Checks** row turns green when the model is consistent.
- Header rows are frozen and dates are ISO (2026-11-26).
${answers.excel_compat ? '\n> [!info] Excel-compatible mode is on: workbooks avoid functions only Ultranote has, like STOCK and FX.' : ''}`),
    });
  }
}
