/**
 * Pure life-app planning (§16.1 "Generation"): answer resolution for quick / guided mode, recommendations with their
 * rationale, visible steps, and the `GenerationPlan` the wizard previews. Mirrors emp-store `lifeapps::{answers,plan,
 * recommend}`; the browser mock uses it directly and the wizard uses `visibleSteps` to decide what to ask.
 */
import type { GenerationItemKind, GenerationPlan, GenerationPlanItem, LifeAppManifest, LifeAppMode, Step, Template } from '@/backend/types';
import { evalExpr, test, type Scope } from './expr';
import type { TemplateSpec } from './manifests';

export interface Recommendation {
  value: unknown;
  why: string;
  source: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function list(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v.filter(isObj);
  if (isObj(v) && Array.isArray(v.items)) return (v.items as unknown[]).filter(isObj);
  return [];
}

/** Recommenders (`Step.recommend` ids). Each sees the user's answers merged over step defaults. */
const RECOMMENDERS: Record<string, (a: Record<string, unknown>) => Recommendation | null> = {
  recommend_budget_method(a) {
    const income = isObj(a.income) ? a.income : {};
    const stability = String(income.stability ?? 'stable');
    const accounts = list(a.accounts);
    const highApr = accounts.some((x) => ['credit_card', 'personal_loan'].includes(String(x.type)) && Number(x.apr ?? 0) >= 0.1 && Number(x.balance ?? 0) > 0);
    if (stability === 'irregular' || stability === 'variable')
      return { value: 'zero_based', why: 'Your income varies, so each dollar is assigned as it arrives, with a small buffer.', source: 'Irregular income' };
    if (highApr)
      return { value: 'zero_based', why: 'You carry high-interest debt. Assigning every dollar makes room for extra payments.', source: 'Debt above about 10% APR' };
    if (a.simple === true) return { value: 'fifty_thirty_twenty', why: 'You asked for something simple: three buckets, no line items.', source: 'Your answer' };
    return { value: 'fifty_thirty_twenty', why: 'Stable income and no high-interest debt: three buckets are easy to keep up with.', source: '50% needs, 30% wants, 20% savings' };
  },
  recommend_debt_strategy() {
    return { value: { strategy: 'avalanche' }, why: 'Paying the highest APR first minimises total interest.', source: 'Debt avalanche (mathematically optimal)' };
  },
  recommend_ef_months(a) {
    const income = isObj(a.income) ? a.income : {};
    const household = isObj(a.household) ? a.household : {};
    const stability = String(income.stability ?? 'stable');
    const dependents = Number(household.dependents ?? 0);
    const dual = String(household.mode ?? 'single').startsWith('partner');
    if (stability !== 'stable') return { value: { months: 9 }, why: 'Irregular or self-employed income needs a deeper cushion.', source: '9–12 months of essential expenses' };
    if (dual && dependents === 0) return { value: { months: 3 }, why: 'Two stable incomes and no dependents: a shorter cushion is usually enough.', source: '3–6 months of essential expenses' };
    return { value: { months: 6 }, why: 'One income or dependents relying on you: six months gives more room.', source: '3–6 months of essential expenses' };
  },
  recommend_allocation(a) {
    const risk = isObj(a.risk) ? a.risk : {};
    const horizon = String(risk.horizon ?? 'long');
    if (horizon === 'short') return { value: 'sixty_forty', why: 'Money needed within 3 years usually holds more bonds to soften drops.', source: 'Education only — example starting point' };
    if (risk.drop === 'sell') return { value: 'sixty_forty', why: 'You said you would sell after a 30% drop; a steadier mix may be easier to hold.', source: 'Education only — example starting point' };
    return { value: 'three_fund', why: 'A long horizon can ride out drops; a broad three-fund mix is a common starting point.', source: 'Education only — example starting point' };
  },
};

export function recommend(m: LifeAppManifest, stepId: string, answers: Record<string, unknown>): Recommendation | null {
  const step = m.steps.find((s) => s.id === stepId);
  if (!step?.recommend) return null;
  const fn = RECOMMENDERS[step.recommend];
  if (!fn) return null;
  const base: Record<string, unknown> = {};
  for (const s of m.steps) if (s.default !== undefined) base[s.id] = s.default;
  return fn({ ...base, ...answers });
}

function mergeRec(def: unknown, rec: unknown): unknown {
  if (isObj(def) && isObj(rec)) return { ...def, ...rec };
  return rec;
}

/** Steps shown for `mode` given the answers so far (`when` honoured, review always last). */
export function visibleSteps(m: LifeAppManifest, answers: Record<string, unknown>, mode: LifeAppMode, today?: string): Step[] {
  const resolved = resolveAnswers(m, answers, mode, today).answers;
  return m.steps.filter((s) => (mode === 'guided' || s.quick || s.kind === 'review') && test(s.when, { answers: resolved, today }));
}

/** User answers win; other steps take their recommendation, else their default. */
export function resolveAnswers(m: LifeAppManifest, user: Record<string, unknown>, _mode: LifeAppMode, today?: string): { answers: Record<string, unknown>; recommendations: GenerationPlan['recommendations'] } {
  const out: Record<string, unknown> = {};
  const recs: GenerationPlan['recommendations'] = [];
  for (const step of m.steps) {
    if (step.kind === 'review') continue;
    if (!test(step.when, { answers: out, today })) continue;
    const given = user[step.id];
    const rec = recommend(m, step.id, user);
    if (rec) recs.push({ stepId: step.id, value: rec.value, why: rec.why, source: rec.source });
    const value = given !== undefined && given !== null ? given : rec ? mergeRec(step.default, rec.value) : step.default;
    if (value !== undefined) out[step.id] = structuredCloneSafe(value);
  }
  for (const [k, v] of Object.entries(user)) if (!(k in out)) out[k] = v;
  return { answers: out, recommendations: recs };
}

function structuredCloneSafe<T>(v: T): T {
  try {
    return structuredClone(v);
  } catch {
    return v;
  }
}

const KIND_MAP: Record<Template['kind'], GenerationItemKind> = {
  page: 'page',
  database: 'database',
  view: 'view',
  dashboard: 'dashboard',
  workbook: 'sheet',
  reminder: 'reminder',
  recurring: 'recurring',
  rule: 'rule',
  row: 'goal',
};

const PLURAL: Record<GenerationItemKind, string> = {
  page: 'pages',
  database: 'databases',
  view: 'views',
  dashboard: 'dashboards',
  reminder: 'reminders',
  recurring: 'recurring',
  sheet: 'sheets',
  rule: 'rules',
  goal: 'goals',
};

export const SHEET_TITLES: Record<string, string> = {
  loan: 'Loan calculator',
  budget: 'Budget sheet',
  decision: 'Decision matrix',
  project_budget: 'Project budget',
  timesheet: 'Timesheet',
  inventory: 'Inventory',
  split: 'Split expenses',
  savings: 'Savings growth',
  blank: 'Workbook',
};

export function templateTitle(m: LifeAppManifest, t: Template, answers: Record<string, unknown>, today?: string): string {
  const spec = (t.spec ?? {}) as TemplateSpec;
  if (m.id === 'spreadsheet-studio' && t.key === 'workbook') return SHEET_TITLES[String(answers.intent ?? 'blank')] ?? 'Workbook';
  if (m.id === 'tax-organizer' && t.key === 'hub') {
    const j = isObj(answers.jurisdiction) ? answers.jurisdiction : {};
    return `Tax year ${Number(j.year ?? (today ? Number(today.slice(0, 4)) : 2026))}`;
  }
  return spec.title ?? t.key;
}

function templateCount(t: Template, scope: Scope): number | undefined {
  const c = ((t.spec ?? {}) as TemplateSpec).count;
  if (c === undefined) return undefined;
  if (typeof c === 'number') return c;
  const v = evalExpr(c, scope);
  const n = typeof v === 'number' ? v : typeof v === 'boolean' ? Number(v) : Number(v ?? 0);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : undefined;
}

/** Plan items with `when` filtering, counts and opt-outs (`disabledKeys`). Non-optional items can't be disabled. */
export function buildPlan(m: LifeAppManifest, user: Record<string, unknown>, mode: LifeAppMode, disabledKeys: string[], today?: string): GenerationPlan {
  const { answers, recommendations } = resolveAnswers(m, user, mode, today);
  const scope: Scope = { answers, today };
  const items: GenerationPlanItem[] = [];
  const counts: Record<string, number> = {};
  for (const t of m.templates) {
    if (!test(t.when, scope)) continue;
    const kind = KIND_MAP[t.kind];
    const enabled = !(t.optional && disabledKeys.includes(t.key));
    const item: GenerationPlanItem = { key: t.key, kind, title: templateTitle(m, t, answers, today), optional: t.optional, enabled };
    if (t.parentKey) item.parentKey = t.parentKey;
    const n = templateCount(t, scope);
    if (n !== undefined) item.count = n;
    items.push(item);
    if (enabled) counts[PLURAL[kind]] = (counts[PLURAL[kind]] ?? 0) + (kind === 'reminder' || kind === 'rule' || kind === 'recurring' ? (n ?? 1) : 1);
  }
  const warnings: string[] = [];
  if (m.sensitivity === 'high') warnings.push('This app holds sensitive data. Encryption is recommended.');
  if (m.id === 'portfolio' && answers.targets === 'custom') warnings.push('Custom targets start empty — set them on the Target allocation page.');
  if (m.id === 'tax-organizer') {
    const j = isObj(answers.jurisdiction) ? answers.jurisdiction : {};
    if (j.country && j.country !== 'US') warnings.push('The estimator covers US federal tax in v1. Your organizer, documents and deadlines still work.');
  }
  return { items, counts, recommendations, warnings };
}

/** "6 pages · 9 databases · 2 dashboards · 14 reminders" */
export function describeCounts(counts: Record<string, number>): string {
  const order = ['pages', 'databases', 'dashboards', 'sheets', 'views', 'reminders', 'recurring', 'rules', 'goals'];
  return order
    .filter((k) => counts[k])
    .map((k) => {
      const n = counts[k];
      const label = n === 1 ? k.replace(/s$/, '').replace('recurring', 'recurring item') : k === 'recurring' ? 'recurring items' : k;
      return `${n} ${label}`;
    })
    .join(' · ');
}
