/**
 * Mock-only: content for the three finance life apps (§16.2–§16.4). Databases carry the §15.0 roles (`txn.*`,
 * `acct.*`, `inv.*`, `alloc.*` …) so the finance mocks and dashboards can find them by role; sample rows are tagged
 * `sample`. Finance-specific analytics live with the finance feature — these generators only lay down the content.
 */
import type { Id } from '@/backend/types';
import { createReminder } from '@/backend/mock/commands/reminder';
import { FINANCE_DISCLAIMER } from '../engine/manifests';
import { md } from './content';
import { c, DAY, emoji, F, isoDay, lucide, P, prng, sel, type DbHandle, type Env } from './env';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const listOf = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObj) : isObj(v) && Array.isArray(v.items) ? (v.items as unknown[]).filter(isObj) : []);

// ───────────────────────────────────────────────────────────────────────────── delegation to the finance mocks

interface ProvisionOpts {
  instanceId: Id | null;
  parentId: Id | null;
  sample: boolean;
  workspaceId?: Id;
}
type Provision = (o: ProvisionOpts) => { dbs: Record<string, Id> };

/**
 * The finance feature owns the ledger databases (Accounts, Categories, Transactions … read by role by its engines).
 * When its mock is present we let it provision them under our hub and add only the pages and extras around them.
 */
function provisioned(env: Env, service: string, keys: Record<string, string>): boolean {
  const fn = env.ctx.services.get<Provision>(service);
  if (!fn) return false;
  const set = fn({ instanceId: env.inst.id, parentId: env.inst.rootPageId, sample: env.sample, workspaceId: env.inst.workspaceId });
  for (const [theirs, mine] of Object.entries(keys)) {
    const id = set.dbs[theirs];
    if (id) env.keep(mine, id);
  }
  return true;
}

// ───────────────────────────────────────────────────────────────────────────── Money HQ

const ACCOUNT_TYPES = ['Checking', 'Savings', 'Credit card', 'Student loan', 'Auto loan', 'Mortgage', 'Personal loan', 'Investment', 'Cash', 'Other asset', 'Other liability'];
const TYPE_KEY: Record<string, string> = { checking: 'Checking', savings: 'Savings', credit_card: 'Credit card', student_loan: 'Student loan', auto_loan: 'Auto loan', mortgage: 'Mortgage', personal_loan: 'Personal loan', investment: 'Investment', cash: 'Cash', other_asset: 'Other asset', other_liability: 'Other liability' };

const CATEGORIES: { name: string; group: string; fifty: string; essential?: boolean; rollover?: boolean; target?: number; icon: string }[] = [
  { name: 'Salary', group: 'Income', fifty: 'Income', icon: '💼' },
  { name: 'Freelance', group: 'Income', fifty: 'Income', icon: '🧑‍💻' },
  { name: 'Interest', group: 'Income', fifty: 'Income', icon: '🏦' },
  { name: 'Rent', group: 'Bills', fifty: 'Needs', essential: true, target: 2150, icon: '🏠' },
  { name: 'Utilities', group: 'Bills', fifty: 'Needs', essential: true, target: 210, icon: '💡' },
  { name: 'Insurance', group: 'Bills', fifty: 'Needs', essential: true, target: 185, icon: '🛡️' },
  { name: 'Phone & internet', group: 'Bills', fifty: 'Needs', essential: true, target: 110, icon: '📶' },
  { name: 'Groceries', group: 'Everyday', fifty: 'Needs', essential: true, target: 680, icon: '🛒' },
  { name: 'Transport', group: 'Everyday', fifty: 'Needs', essential: true, target: 240, icon: '🚇' },
  { name: 'Health', group: 'Everyday', fifty: 'Needs', essential: true, target: 120, icon: '🩺' },
  { name: 'Dining out', group: 'Fun', fifty: 'Wants', target: 320, icon: '🍜' },
  { name: 'Shopping', group: 'Fun', fifty: 'Wants', target: 300, icon: '🛍️' },
  { name: 'Subscriptions', group: 'Fun', fifty: 'Wants', target: 70, icon: '📺' },
  { name: 'Travel', group: 'Fun', fifty: 'Wants', rollover: true, target: 400, icon: '✈️' },
  { name: 'Gifts & giving', group: 'Fun', fifty: 'Wants', rollover: true, target: 90, icon: '🎁' },
  { name: 'Emergency fund', group: 'Savings & Debt', fifty: 'Savings & Debt', rollover: true, target: 500, icon: '🛟' },
  { name: 'Investing', group: 'Savings & Debt', fifty: 'Savings & Debt', target: 700, icon: '📈' },
  { name: 'Debt payments', group: 'Savings & Debt', fifty: 'Savings & Debt', target: 250, icon: '💳' },
];

export async function installMoneyHq(env: Env): Promise<void> {
  const { ctx, answers } = env;
  const currency = isObj(answers.currency) ? String(answers.currency.code ?? 'USD') : typeof answers.currency === 'string' ? answers.currency : 'USD';
  const method = String(answers.method ?? 'fifty_thirty_twenty');
  const fifty = method === 'fifty_thirty_twenty';
  const methodLabel: Record<string, string> = { fifty_thirty_twenty: '50/30/20', zero_based: 'Zero-based', pay_yourself_first: 'Pay yourself first', envelopes: 'Envelopes', track_only: 'Track only' };
  const disclaimer = `> [!note] ${FINANCE_DISCLAIMER}`;

  await env.step('Writing “How your budget works”');
  env.page('how', {
    title: 'How your budget works',
    icon: emoji('📘'),
    blocks: md(`> [!info] Method: **${methodLabel[method] ?? method}**. You can change it any time with a tune-up.
## The idea
${fifty ? 'Split take-home pay into three buckets: about **50% for needs**, **30% for wants** and **20% for savings and debt**. It is a common guideline because it is simple enough to keep.' : method === 'zero_based' ? 'Give every dollar a job before the month starts. Income minus everything you assign should equal **zero** — not because you spend it all, but because savings and debt payments get jobs too.' : method === 'pay_yourself_first' ? 'Move savings out on payday, then spend the rest freely. The savings transfer is the budget.' : method === 'envelopes' ? 'Each category is an envelope with a fixed amount. When it is empty, it is empty — or you move money from another envelope.' : 'No targets — just a clear picture of where money goes. Most people start here.'}
## How to use it
- Each category belongs to one group (see **Categories**).
- The Budget tab compares what you assigned with what you spent.
- A weekly check-in of ten minutes keeps it honest.
${disclaimer}`),
  });
  env.page('order', {
    title: 'Financial order of operations',
    icon: emoji('🪜'),
    blocks: md(`A common guideline for where the next dollar goes. Tick steps as you reach them.
- [ ] 1. Budget plus a starter emergency fund (about one month of essentials)
- [ ] 2. Capture any employer retirement match
- [ ] 3. Pay down high-interest debt (above ~10% APR)
- [ ] 4. Build the full emergency fund (3–6 months)
- [ ] 5. Tax-advantaged saving (IRA, HSA, 401(k))
- [ ] 6. Other goals — sinking funds, a home, education
- [ ] 7. Taxable investing
${disclaimer}`),
  });
  if (env.on('weekly')) env.page('weekly', { title: 'Weekly check-in', icon: emoji('🗓️'), blocks: md('- [ ] Categorise new transactions\n- [ ] Check categories close to their limit\n- [ ] Look at bills due in the next 7 days\n- [ ] Move money if something ran over') });
  if (env.on('monthly')) env.page('monthly', { title: 'Monthly review', icon: emoji('📅'), blocks: md('## Last month\n- [ ] Reconcile every account\n- [ ] Compare budget vs actual by group\n- [ ] Snapshot net worth\n## Next month\n- [ ] Assign income to categories\n- [ ] Adjust sinking-fund targets') });

  if (provisioned(env, 'finance.provision', { accounts: 'accounts', categories: 'categories', txns: 'transactions', recurring: 'recurring', goals: 'goals' })) {
    await env.step('Setting up accounts, categories and transactions');
    await env.step('Adding recurring bills and goals');
    if (env.on('subscriptions')) {
      const subs = env.database('subscriptions', {
        title: 'Subscriptions',
        icon: emoji('📺'),
        props: [P.title('Service'), P.money('Amount', 'sub.amount', currency), P.select('Cycle', ['Monthly', 'Yearly', 'Weekly'], 'sub.cycle'), P.date('Next charge', 'sub.next'), P.select('Status', [{ name: 'Active', color: 'green' }, { name: 'Trial', color: 'blue' }, { name: 'Cancelled', color: 'gray' }]), P.rating('Value'), P.url('Cancel URL')],
        firstView: { name: 'Active', layout: 'table' },
      });
      if (env.sample) {
        const list: [string, number, string, number][] = [['Streaming bundle', 22.99, 'Monthly', 3], ['Music', 11.99, 'Monthly', 20], ['Cloud storage', 2.99, 'Monthly', 9], ['Climbing gym', 39, 'Monthly', 18], ['News', 99, 'Yearly', 41], ['Password manager', 36, 'Yearly', 12]];
        for (const [name, amt, cycle, day] of list) env.row(subs, { Service: c.text(name), Amount: c.money(amt, currency), Cycle: sel(cycle), 'Next charge': c.date(cycle === 'Yearly' ? isoDay(env.now + day * DAY) : nextMonthDay(env.now, day)), Status: sel('Active'), Value: c.rating(3 + (day % 3)) });
      }
      if (!ctx.seeding) env.db.emitChanged(ctx, subs.id);
    }
    return;
  }

  await env.step('Creating Accounts');
  const accounts = env.database('accounts', {
    title: 'Accounts',
    icon: emoji('🏦'),
    props: [
      P.title('Name'),
      P.select('Type', ACCOUNT_TYPES, 'acct.type'),
      P.text('Institution'),
      P.select('Currency', [currency], 'acct.currency'),
      P.money('Opening balance', 'acct.opening', currency),
      P.money('Balance', 'acct.balance', currency),
      P.check('On budget', 'acct.on_budget'),
      P.num('APR', 'acct.apr', 'percent'),
      P.money('Min payment', 'acct.min_payment', currency),
      P.money('Credit limit', 'acct.limit', currency),
      P.money('Low-balance threshold', 'acct.low_threshold', currency),
      P.date('Last reconciled'),
      P.check('Closed'),
    ],
    firstView: { name: 'All accounts', layout: 'table' },
  });
  await env.step('Creating Categories');
  const categories = env.database('categories', {
    title: 'Categories',
    icon: emoji('🏷️'),
    props: [
      P.title('Name'),
      P.select('Group', fifty ? ['Needs', 'Wants', 'Savings & Debt', 'Income'] : ['Bills', 'Everyday', 'Savings & Debt', 'Fun', 'Income'], 'cat.group'),
      P.check('Essential', 'cat.essential'),
      P.check('Rollover', 'cat.rollover'),
      P.select('Target type', ['Monthly', 'By date', 'Balance'], 'cat.target_type'),
      P.money('Target', 'cat.target', currency),
    ],
    firstView: { name: 'By group', layout: 'table' },
  });
  const catIds: Record<string, Id> = {};
  for (const cat of CATEGORIES) catIds[cat.name] = env.row(categories, { Name: c.text(cat.name), Group: sel(fifty ? cat.fifty : cat.group), Essential: c.check(!!cat.essential), Rollover: c.check(!!cat.rollover), 'Target type': cat.target ? sel('Monthly') : null, Target: c.money(cat.target ?? null, currency) }, { icon: emoji(cat.icon), sample: false });
  const payees = env.database('payees', { title: 'Payees', icon: emoji('🏪'), props: [P.title('Name'), P.text('Aliases'), P.rel('Default category', categories.id, undefined, 'one')], firstView: { name: 'All payees', layout: 'table' } });

  await env.step('Creating Transactions');
  const txns = env.database('transactions', {
    title: 'Transactions',
    icon: emoji('💳'),
    props: [
      P.title('Description', 'txn.raw'),
      P.date('Date', 'txn.date'),
      P.money('Amount', 'txn.amount', currency),
      P.rel('Account', accounts.id, 'txn.account', 'one'),
      P.rel('Category', categories.id, 'txn.category', 'one'),
      P.rel('Payee', payees.id, 'txn.payee', 'one'),
      P.text('Memo', 'txn.memo'),
      P.status('Cleared', [{ name: 'Uncleared', color: 'gray', group: 'todo' }, { name: 'Cleared', color: 'blue', group: 'in_progress' }, { name: 'Reconciled', color: 'green', group: 'complete' }], 'txn.cleared'),
      P.multi('Tags', ['Reimbursable', 'Tax', 'Shared']),
      P.select('Source', ['Manual', 'Import', 'Rule']),
      P.hidden(P.text('Import ID', 'txn.import_id')),
    ],
    firstView: { name: 'All transactions', layout: 'table' },
  });
  env.ctx.db.table<{ id: Id; sorts: unknown[] }>('db_views').update(txns.views['All transactions'], (v) => void (v.sorts = [F.sort(txns, 'Date', 'desc')]));
  env.view(txns, 'Uncategorised', 'table', { filter: { prop: txns.props.Category.id, op: 'empty' }, sorts: [F.sort(txns, 'Date', 'desc')] });
  env.view(txns, 'Spending by month', 'chart', { chart: { type: 'bar', x: { prop: txns.props.Date.id, bucket: 'month' }, y: [{ agg: 'sum', prop: txns.props.Amount.id }] } });

  let budgets: DbHandle | null = null;
  if (env.on('budgets')) {
    await env.step('Setting up Budgets');
    budgets = env.database('budgets', {
      title: 'Budgets',
      icon: emoji('🎯'),
      props: [P.title('Line'), P.date('Month', 'budget.month'), P.rel('Category', categories.id, 'budget.category', 'one'), P.money('Assigned', 'budget.assigned', currency)],
      firstView: { name: 'This month', layout: 'table' },
    });
  }
  await env.step('Adding Recurring bills');
  const recurring = env.database('recurring', {
    title: 'Recurring',
    icon: emoji('🔁'),
    props: [
      P.title('Name'),
      P.money('Amount', 'rec.amount', currency),
      P.recurrence('Schedule', 'rec.schedule'),
      P.date('Next date', 'rec.next'),
      P.rel('Account', accounts.id, 'rec.account', 'one'),
      P.rel('Category', categories.id, 'rec.category', 'one'),
      P.check('Autopay', 'rec.autopay'),
      P.num('Reminder days', 'rec.reminder_days'),
      P.select('Kind', ['Bill', 'Income', 'Transfer', 'Subscription'], 'rec.kind'),
      P.check('Variable'),
    ],
    firstView: { name: 'Upcoming', layout: 'table' },
  });
  const goals = env.database('goals', {
    title: 'Goals',
    icon: emoji('🏁'),
    props: [
      P.title('Name'),
      P.select('Kind', [{ name: 'Emergency', color: 'red' }, { name: 'Sinking', color: 'blue' }, { name: 'Savings', color: 'green' }], 'goal.kind'),
      P.money('Target', 'goal.target', currency),
      P.date('Target date', 'goal.date'),
      P.money('Saved', 'goal.saved', currency),
      P.select('Priority', ['High', 'Medium', 'Low']),
      P.progress('Progress'),
    ],
    firstView: { name: 'Goals', layout: 'gallery' },
  });
  const networth = env.database('networth', {
    title: 'Net worth snapshots',
    icon: emoji('📈'),
    props: [P.title('Month'), P.date('Date', 'nw.date'), P.money('Assets', 'nw.assets', currency), P.money('Liabilities', 'nw.liabilities', currency), P.money('Net worth', 'nw.net', currency), P.select('Source', ['Auto', 'Manual'])],
    firstView: { name: 'History', layout: 'table' },
  });
  env.view(networth, 'Trend', 'chart', { chart: { type: 'area', x: { prop: networth.props.Date.id, bucket: 'month' }, y: [{ agg: 'sum', prop: networth.props['Net worth'].id }] } });
  let subs: DbHandle | null = null;
  if (env.on('subscriptions')) {
    subs = env.database('subscriptions', {
      title: 'Subscriptions',
      icon: emoji('📺'),
      props: [P.title('Service'), P.money('Amount', 'sub.amount', currency), P.select('Cycle', ['Monthly', 'Yearly', 'Weekly'], 'sub.cycle'), P.date('Next charge', 'sub.next'), P.select('Status', [{ name: 'Active', color: 'green' }, { name: 'Trial', color: 'blue' }, { name: 'Cancelled', color: 'gray' }]), P.rating('Value'), P.url('Cancel URL')],
      firstView: { name: 'Active', layout: 'table' },
    });
  }

  // user answers → rows (accounts, bills, goals)
  const acctIds: Record<string, Id> = {};
  const userAccounts = listOf(answers.accounts);
  const sampleAccounts = env.sample
    ? [
        { name: 'Everyday Checking', type: 'checking', balance: 4250.32, institution: 'Northwind Bank', onBudget: true, low: 500 },
        { name: 'High-yield Savings', type: 'savings', balance: 14800, institution: 'Harbor Savings', onBudget: true },
        { name: 'Rewards Visa', type: 'credit_card', balance: -1287.44, institution: 'Northwind Bank', apr: 0.2199, limit: 6000, min: 35, onBudget: true },
        { name: 'Student loan', type: 'student_loan', balance: -11840, institution: 'Federal Loan Servicing', apr: 0.0455, min: 162, onBudget: false },
      ]
    : [];
  const acctSource = sampleAccounts.length ? sampleAccounts : userAccounts.map((a) => ({ name: String(a.name ?? 'Account'), type: String(a.type ?? 'checking'), balance: Number(a.balance ?? 0), apr: a.apr === undefined ? undefined : Number(a.apr), limit: a.limit === undefined ? undefined : Number(a.limit), min: a.minPayment === undefined ? undefined : Number(a.minPayment), onBudget: a.onBudget !== false, institution: '', low: undefined as number | undefined }));
  for (const a of acctSource) {
    const liability = ['credit_card', 'student_loan', 'auto_loan', 'mortgage', 'personal_loan', 'other_liability'].includes(a.type);
    const bal = liability ? -Math.abs(a.balance) : a.balance;
    acctIds[a.name] = env.row(accounts, {
      Name: c.text(a.name),
      Type: sel(TYPE_KEY[a.type] ?? 'Checking'),
      Institution: c.text(a.institution),
      Currency: sel(currency),
      'Opening balance': c.money(bal, currency),
      Balance: c.money(bal, currency),
      'On budget': c.check(!!a.onBudget),
      APR: c.num(a.apr ?? null),
      'Min payment': c.money(a.min ?? null, currency),
      'Credit limit': c.money(a.limit ?? null, currency),
      'Low-balance threshold': c.money('low' in a ? (a.low ?? null) : null, currency),
      'Last reconciled': env.sample ? c.date(isoDay(env.now - 12 * DAY)) : null,
    }, { sample: false });
  }
  const checking = Object.values(acctIds)[0] ?? null;
  const card = acctIds['Rewards Visa'] ?? checking;

  const bills = listOf(answers.bills);
  const billSource = env.sample && !bills.length
    ? [
        { name: 'Rent — Maple Court', amount: 2150, day: 1, cat: 'Rent', autopay: true },
        { name: 'City Power & Water', amount: 168, day: 12, cat: 'Utilities', autopay: false },
        { name: 'Fiber internet', amount: 54.99, day: 14, cat: 'Phone & internet', autopay: true },
        { name: 'Phone plan', amount: 45, day: 22, cat: 'Phone & internet', autopay: true },
        { name: 'Home & auto insurance', amount: 185, day: 5, cat: 'Insurance', autopay: true },
        { name: 'Student loan payment', amount: 162, day: 28, cat: 'Debt payments', autopay: true },
      ]
    : bills.map((b, i) => ({ name: String(b.name ?? 'Bill'), amount: Number(b.amount ?? 0), day: Number(b.dueDay ?? ((i * 7) % 28) + 1), cat: '', autopay: !!b.autopay }));
  const billDays = isObj(answers.rituals) ? Number(answers.rituals.billDays ?? 3) : 3;
  for (const b of billSource) {
    const next = nextMonthDay(env.now, b.day);
    const id = env.row(recurring, {
      Name: c.text(b.name),
      Amount: c.money(b.amount, currency),
      Schedule: c.recurrence(`FREQ=MONTHLY;BYMONTHDAY=${b.day}`, next),
      'Next date': c.date(next),
      Account: c.rel([checking]),
      Category: c.rel([catIds[b.cat] ?? null]),
      Autopay: c.check(b.autopay),
      'Reminder days': c.num(billDays),
      Kind: sel('Bill'),
    }, { sample: false });
    if (env.on('bill_reminders')) createReminder(ctx, { fireAt: Date.parse(`${next}T09:00:00Z`) - billDays * DAY, targetKind: 'row', targetId: id, text: `${b.name} is due in ${billDays} days`, instanceId: env.inst.id });
  }

  const em = isObj(answers.emergency) ? answers.emergency : {};
  if (env.on('ef_goal') || env.sample) {
    env.row(goals, { Name: c.text('Emergency fund'), Kind: sel('Emergency'), Target: c.money(Number(em.months ?? 6) * 3200, currency), Saved: c.money(env.sample ? 14800 : Number(em.current ?? 0), currency), Priority: sel('High'), Progress: c.progress(env.sample ? 14800 / (Number(em.months ?? 6) * 3200) : 0) }, { icon: emoji('🛟'), sample: false });
  }
  const userGoals = listOf(answers.goals);
  const goalSource = env.sample && !userGoals.length ? [{ name: 'Lisbon trip', target: 3200, saved: 2100, date: 120 }, { name: 'Car replacement', target: 12000, saved: 3400, date: 700 }, { name: 'Holidays & gifts', target: 900, saved: 640, date: 28 }] : userGoals.map((g) => ({ name: String(g.name ?? 'Goal'), target: Number(g.target ?? 0), saved: 0, date: 365 }));
  for (const g of goalSource) env.row(goals, { Name: c.text(g.name), Kind: sel('Sinking'), Target: c.money(g.target, currency), 'Target date': c.date(isoDay(env.now + g.date * DAY)), Saved: c.money(g.saved, currency), Priority: sel('Medium'), Progress: c.progress(g.target ? g.saved / g.target : 0) }, { sample: false });

  if (env.sample) {
    await env.step('Adding 6 months of sample transactions');
    sampleTransactions(env, txns, { catIds, checking, card, currency });
    for (let m = 11; m >= 0; m--) {
      const d = new Date(env.now);
      const month = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - m, 1));
      const assets = 52_000 + (11 - m) * 1_450 + Math.sin(m) * 900;
      const liab = 15_400 - (11 - m) * 210;
      env.row(networth, { Month: c.text(month.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })), Date: c.date(isoDay(month.getTime())), Assets: c.money(Math.round(assets), currency), Liabilities: c.money(Math.round(liab), currency), 'Net worth': c.money(Math.round(assets - liab), currency), Source: sel('Auto') });
    }
    if (budgets) {
      const month = isoDay(Date.UTC(new Date(env.now).getUTCFullYear(), new Date(env.now).getUTCMonth(), 1));
      for (const cat of CATEGORIES) if (cat.target) env.row(budgets, { Line: c.text(`${month.slice(0, 7)} · ${cat.name}`), Month: c.date(month), Category: c.rel([catIds[cat.name]]), Assigned: c.money(cat.target, currency) });
    }
    if (subs) {
      const list: [string, number, string, number][] = [['Streaming bundle', 22.99, 'Monthly', 3], ['Music', 11.99, 'Monthly', 20], ['Cloud storage', 2.99, 'Monthly', 9], ['Climbing gym', 39, 'Monthly', 18], ['News', 99, 'Yearly', 41], ['Password manager', 36, 'Yearly', 12]];
      for (const [name, amt, cycle, day] of list) env.row(subs, { Service: c.text(name), Amount: c.money(amt, currency), Cycle: sel(cycle), 'Next charge': c.date(cycle === 'Yearly' ? isoDay(env.now + day * DAY) : nextMonthDay(env.now, day)), Status: sel('Active'), Value: c.rating(3 + (day % 3)) });
    }
  }
  for (const h of [accounts, categories, payees, txns, recurring, goals, networth, ...(budgets ? [budgets] : []), ...(subs ? [subs] : [])]) if (!ctx.seeding) env.db.emitChanged(ctx, h.id);
  void lucide;
}

function nextMonthDay(now: number, day: number): string {
  const d = new Date(now);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), Math.min(28, Math.max(1, day)));
  if (t < Math.floor(now / DAY) * DAY) t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, Math.min(28, Math.max(1, day)));
  return isoDay(t);
}

function sampleTransactions(env: Env, txns: DbHandle, x: { catIds: Record<string, Id>; checking: Id | null; card: Id | null; currency: string }) {
  const rnd = prng(20261126);
  const amt = (lo: number, hi: number) => Math.round((lo + rnd() * (hi - lo)) * 100) / 100;
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  const today = Math.floor(env.now / DAY) * DAY;
  const add = (daysAgo: number, desc: string, cat: string | null, amount: number, acct: Id | null, cleared = true) => {
    if (daysAgo < 0) return;
    env.row(txns, {
      Description: c.text(desc),
      Date: c.date(isoDay(today - daysAgo * DAY)),
      Amount: c.money(amount, x.currency),
      Account: c.rel([acct]),
      Category: cat ? c.rel([x.catIds[cat]]) : null,
      Cleared: sel(daysAgo < 3 ? 'Uncleared' : cleared ? (daysAgo > 14 ? 'Reconciled' : 'Cleared') : 'Uncleared'),
      Source: sel('Import'),
    });
  };
  for (let m = 5; m >= 0; m--) {
    const base = m * 30;
    add(base + 25, 'Payroll — Northwind Labs', 'Salary', 3425, x.checking);
    add(base + 10, 'Payroll — Northwind Labs', 'Salary', 3425, x.checking);
    add(base + 25, 'Rent — Maple Court Apt 4B', 'Rent', -2150, x.checking);
    add(base + 21, 'Home & auto insurance', 'Insurance', -185, x.checking);
    add(base + 14, 'City Power & Water', 'Utilities', -amt(128, 196), x.checking);
    add(base + 12, 'Fiber internet', 'Phone & internet', -54.99, x.checking);
    add(base + 4, 'Phone plan', 'Phone & internet', -45, x.checking);
    add(base + 23, 'Streaming bundle', 'Subscriptions', -22.99, x.card);
    add(base + 6, 'Music', 'Subscriptions', -11.99, x.card);
    add(base + 8, 'Climbing gym', 'Subscriptions', -39, x.card);
    add(base + 1, 'Transfer to brokerage', 'Investing', -700, x.checking);
    add(base + 2, 'Savings transfer', 'Emergency fund', -400, x.checking);
    add(base + 28, 'Student loan payment', 'Debt payments', -162, x.checking);
    add(base + 3, 'Savings interest', 'Interest', amt(38, 52), x.checking);
    for (let i = 0; i < 7; i++) add(base + Math.floor(rnd() * 30), pick(['Green Basket Market', 'Corner Grocer', 'Farmers market', 'Wholesale Club']), 'Groceries', -amt(32, 128), x.card);
    for (let i = 0; i < 5; i++) add(base + Math.floor(rnd() * 30), pick(['Osteria Lumen', 'Pho 88', 'Blue Door Coffee', 'Taqueria Sol', 'Sushi Kame']), 'Dining out', -amt(12, 86), x.card);
    for (let i = 0; i < 4; i++) add(base + Math.floor(rnd() * 30), pick(['Metro card top-up', 'Fuel — Shell', 'Rideshare', 'Parking']), 'Transport', -amt(14, 68), x.card);
    for (let i = 0; i < 2; i++) add(base + Math.floor(rnd() * 30), pick(['Hardware store', 'Bookshop', 'Outdoor gear', 'Home goods']), 'Shopping', -amt(24, 160), x.card);
    if (rnd() < 0.6) add(base + Math.floor(rnd() * 30), pick(['Pharmacy', 'Dentist co-pay', 'Physio session']), 'Health', -amt(18, 120), x.card);
    if (m % 2 === 0) add(base + 15, 'Logo design — Acme Bakery', 'Freelance', amt(450, 1200), x.checking);
    // a few uncategorised imports near today
    if (m === 0) for (let i = 0; i < 4; i++) add(Math.floor(rnd() * 6), pick(['POS 4471 MKT ST', 'SQ *KIOSK 22', 'AMZN MKTP US*2K', 'PAYPAL *LOCALSHOP']), null, -amt(9, 64), x.card, false);
  }
}

// ───────────────────────────────────────────────────────────────────────────── Portfolio

export const SAMPLE_HOLDINGS: { ticker: string; name: string; cls: string; region: string; type: string; er: number; qty: number; cost: number; price: number }[] = [
  { ticker: 'EMPX:XNAS', name: 'EMP Total Market ETF', cls: 'US equity', region: 'US', type: 'ETF', er: 0.0003, qty: 120, cost: 182.4, price: 214.6 },
  { ticker: 'NOVA:XNAS', name: 'Nova Semiconductors', cls: 'US equity', region: 'US', type: 'Stock', er: 0, qty: 35, cost: 96.1, price: 141.25 },
  { ticker: 'ORBT:XNYS', name: 'Orbit Logistics', cls: 'US equity', region: 'US', type: 'Stock', er: 0, qty: 60, cost: 41.7, price: 38.9 },
  { ticker: 'KITE:XNAS', name: 'Kite International Developed ETF', cls: 'Intl developed', region: 'Developed ex-US', type: 'ETF', er: 0.0007, qty: 210, cost: 48.2, price: 53.4 },
  { ticker: 'LUMA:XNYS', name: 'Luma Emerging Markets ETF', cls: 'Emerging', region: 'Emerging', type: 'ETF', er: 0.0011, qty: 140, cost: 39.9, price: 42.15 },
  { ticker: 'VOLT:XNAS', name: 'Volt Aggregate Bond ETF', cls: 'Bonds', region: 'US', type: 'ETF', er: 0.0004, qty: 260, cost: 72.3, price: 71.1 },
  { ticker: 'BRIX:XNYS', name: 'Brix Real Estate Fund', cls: 'REIT', region: 'US', type: 'Fund', er: 0.0062, qty: 55, cost: 88.4, price: 92.7 },
  { ticker: 'ZENO:CRYPTO', name: 'Zeno', cls: 'Crypto', region: 'Global', type: 'Crypto', er: 0, qty: 0.42, cost: 21_400, price: 27_850 },
];

const TARGETS: Record<string, [string, number][]> = {
  three_fund: [['US equity', 0.6], ['Intl developed', 0.25], ['Emerging', 0.05], ['Bonds', 0.1]],
  sixty_forty: [['US equity', 0.42], ['Intl developed', 0.18], ['Bonds', 0.4]],
  age_based: [['US equity', 0.55], ['Intl developed', 0.17], ['Emerging', 0.05], ['Bonds', 0.23]],
  all_equity: [['US equity', 0.7], ['Intl developed', 0.2], ['Emerging', 0.1]],
  custom: [],
};

export async function installPortfolio(env: Env): Promise<void> {
  const { ctx, answers } = env;
  await env.step('Writing your Investment Policy Statement');
  const target = String(answers.targets ?? 'three_fund');
  const tg = TARGETS[target] ?? TARGETS.three_fund;
  const rebalance = String(answers.rebalance ?? 'hybrid');
  env.page('ips', {
    title: 'Investment Policy Statement',
    icon: emoji('📜'),
    blocks: md(`> [!note] Written by you, for you. ${FINANCE_DISCLAIMER}
## Purpose
Long-term growth for retirement and big goals, with risk I can live with.
## Target allocation (example starting point, not a recommendation)
| Asset class | Target |
|---|---|
${tg.map(([k, v]) => `| ${k} | ${Math.round(v * 100)}% |`).join('\n') || '| (set your targets) | |'}
## Rebalancing
${rebalance === 'calendar' ? 'Check once a quarter and rebalance back to targets.' : rebalance === 'threshold' ? 'Rebalance when any class drifts 5 percentage points (or 25% relative) from target.' : 'Check quarterly; act only when a class drifts more than 5 percentage points.'} New money goes to the most underweight class first; avoid selling in taxable accounts where possible.
## Rules I follow when markets fall
- [ ] I don’t sell because prices dropped
- [ ] I re-read this page before any change
- [ ] I keep contributing on schedule
## Signature
Signed ____________________  Date ____________`),
  });
  env.page('rebalance', { title: 'Rebalance planner', icon: emoji('⚖️'), blocks: md('Compare current weights with targets. Cash-flow first: direct contributions to underweight classes before selling anything.\n- [ ] Check drift\n- [ ] Plan contributions\n- [ ] Only then consider trades (minimum trade: $50)') });
  if (env.on('annual')) env.page('annual', { title: 'Annual investing review', icon: emoji('🗓️'), blocks: md('- [ ] Re-read the IPS\n- [ ] Update targets for age and goals\n- [ ] Review fees and expense ratios\n- [ ] Check beneficiaries\n- [ ] Tax-loss harvesting review (December)') });

  if (provisioned(env, 'portfolio.provision', { accounts: 'inv_accounts', securities: 'securities', txns: 'inv_txns', targets: 'targets_db' })) {
    await env.step('Setting up accounts, securities and targets');
    await env.step('Adding holdings and dividends');
    if (env.on('review_rem')) {
      for (let q = 1; q <= 4; q++) {
        const fire = env.now + q * 91 * DAY;
        createReminder(ctx, { fireAt: Math.floor(fire / DAY) * DAY + 10 * 3_600_000, targetKind: 'page', targetId: env.inst.keyMap.rebalance ?? env.inst.rootPageId, text: 'Quarterly rebalance check', instanceId: env.inst.id });
      }
    }
    return;
  }

  await env.step('Creating Investment accounts');
  const accts = env.database('inv_accounts', {
    title: 'Investment accounts',
    icon: emoji('🏦'),
    props: [P.title('Name'), P.text('Broker'), P.select('Type', ['401k', '403b', 'IRA', 'Roth IRA', 'HSA', 'Taxable', '529', 'Crypto'], 'acct.type'), P.select('Tax treatment', ['Taxable', 'Tax-deferred', 'Tax-free']), P.select('Currency', ['USD'], 'acct.currency')],
    firstView: { name: 'Accounts', layout: 'table' },
  });
  const typeLabel: Record<string, string> = { '401k': '401k', '403b': '403b', ira: 'IRA', roth_ira: 'Roth IRA', hsa: 'HSA', taxable: 'Taxable', '529': '529', crypto: 'Crypto' };
  const taxLabel: Record<string, string> = { taxable: 'Taxable', deferred: 'Tax-deferred', free: 'Tax-free' };
  const acctList = env.sample
    ? [{ name: 'Brokerage', broker: 'Harbor Invest', type: 'taxable', tax: 'taxable' }, { name: 'Roth IRA', broker: 'Harbor Invest', type: 'roth_ira', tax: 'free' }, { name: 'Crypto wallet', broker: 'Self-custody', type: 'crypto', tax: 'taxable' }]
    : listOf(answers.accounts).map((a) => ({ name: String(a.name ?? 'Account'), broker: String(a.broker ?? ''), type: String(a.type ?? 'taxable'), tax: String(a.taxTreatment ?? 'taxable') }));
  const acctIds = acctList.map((a) => env.row(accts, { Name: c.text(a.name), Broker: c.text(a.broker), Type: sel(typeLabel[a.type] ?? 'Taxable'), 'Tax treatment': sel(taxLabel[a.tax] ?? 'Taxable'), Currency: sel('USD') }, { sample: false }));

  await env.step('Creating Securities and transactions');
  const secs = env.database('securities', {
    title: 'Securities',
    icon: emoji('🔖'),
    props: [P.title('Name'), P.ticker('Ticker', 'sec.ticker'), P.select('Asset class', ['US equity', 'Intl developed', 'Emerging', 'Bonds', 'Inflation-linked', 'REIT', 'Cash', 'Crypto', 'Other'], 'sec.class'), P.text('Region'), P.select('Type', ['Stock', 'ETF', 'Fund', 'Crypto', 'Bond']), P.num('Expense ratio', 'sec.expense_ratio', 'percent'), P.money('Last price', 'sec.price'), P.date('Price as-of')],
    firstView: { name: 'All securities', layout: 'table' },
  });
  const tx = env.database('inv_txns', {
    title: 'Investment transactions',
    icon: emoji('🔁'),
    props: [P.title('Memo'), P.date('Date', 'inv.date'), P.select('Type', [{ name: 'Buy', color: 'green' }, { name: 'Sell', color: 'red' }, { name: 'Dividend', color: 'blue' }, { name: 'Contribution', color: 'purple' }, { name: 'Fee', color: 'gray' }], 'inv.type'), P.rel('Security', secs.id, 'inv.security', 'one'), P.rel('Account', accts.id, 'inv.account', 'one'), P.num('Quantity', 'inv.qty'), P.money('Price', 'inv.price'), P.money('Amount', 'inv.amount'), P.money('Fees', 'inv.fees')],
    firstView: { name: 'All transactions', layout: 'table' },
  });
  const targets = env.database('targets_db', {
    title: 'Target allocation',
    icon: emoji('🎯'),
    props: [P.title('Asset class', 'alloc.class'), P.num('Target', 'alloc.target', 'percent'), P.num('Band (abs)', 'alloc.band_abs', 'percent'), P.num('Band (rel)', 'alloc.band_rel', 'percent'), P.num('Current', 'alloc.current', 'percent'), P.num('Drift', 'alloc.drift', 'percent'), P.select('Status', [{ name: 'In band', color: 'green' }, { name: 'Outside band', color: 'orange' }])],
    firstView: { name: 'Targets', layout: 'table' },
  });
  const divs = env.database('dividends', {
    title: 'Dividends',
    icon: emoji('💧'),
    props: [P.title('Memo'), P.date('Date', 'div.date'), P.rel('Security', secs.id, 'div.security', 'one'), P.money('Amount', 'div.amount'), P.rel('Account', accts.id, undefined, 'one')],
    firstView: { name: 'All dividends', layout: 'table' },
  });
  env.view(divs, 'By month', 'chart', { chart: { type: 'bar', x: { prop: divs.props.Date.id, bucket: 'month' }, y: [{ agg: 'sum', prop: divs.props.Amount.id }] } });

  // current weights for the sample (to compute drift)
  const total = env.sample ? SAMPLE_HOLDINGS.reduce((s, h) => s + h.qty * h.price, 0) : 0;
  const byClass: Record<string, number> = {};
  if (env.sample) for (const h of SAMPLE_HOLDINGS) byClass[h.cls] = (byClass[h.cls] ?? 0) + (h.qty * h.price) / total;
  for (const [cls, t] of tg) {
    const cur = byClass[cls] ?? 0;
    const drift = env.sample ? cur - t : 0;
    env.row(targets, { 'Asset class': c.text(cls), Target: c.num(t), 'Band (abs)': c.num(0.05), 'Band (rel)': c.num(0.25), Current: env.sample ? c.num(Math.round(cur * 1000) / 1000) : null, Drift: env.sample ? c.num(Math.round(drift * 1000) / 1000) : null, Status: sel(Math.abs(drift) > 0.05 ? 'Outside band' : 'In band') }, { sample: false });
  }

  if (env.sample) {
    await env.step('Adding 8 sample holdings');
    const rnd = prng(8);
    SAMPLE_HOLDINGS.forEach((h, i) => {
      const sid = env.row(secs, { Name: c.text(h.name), Ticker: c.ticker(h.ticker), 'Asset class': sel(h.cls), Region: c.text(h.region), Type: sel(h.type), 'Expense ratio': c.num(h.er), 'Last price': c.money(h.price), 'Price as-of': c.date(isoDay(env.now)) });
      const acct = h.cls === 'Crypto' ? acctIds[2] : i % 3 === 1 ? acctIds[1] : acctIds[0];
      const lots = h.cls === 'Crypto' ? 1 : 2;
      for (let l = 0; l < lots; l++) {
        const q = lots === 1 ? h.qty : l === 0 ? Math.round(h.qty * 0.6 * 100) / 100 : Math.round(h.qty * 0.4 * 100) / 100;
        const price = Math.round(h.cost * (l === 0 ? 0.94 : 1.06) * 100) / 100;
        const days = 400 - l * 160 - Math.floor(rnd() * 60);
        env.row(tx, { Memo: c.text(`Buy ${h.ticker.split(':')[0]}`), Date: c.date(isoDay(env.now - days * DAY)), Type: sel('Buy'), Security: c.rel([sid]), Account: c.rel([acct]), Quantity: c.num(q), Price: c.money(price), Amount: c.money(-q * price), Fees: c.money(0) });
      }
      if (h.type === 'ETF' || h.cls === 'REIT') {
        for (let q = 0; q < 4; q++) {
          const amount = Math.round(h.qty * h.price * (h.cls === 'Bonds' ? 0.009 : h.cls === 'REIT' ? 0.011 : 0.0042) * 100) / 100;
          const date = isoDay(env.now - (20 + q * 91) * DAY);
          env.row(divs, { Memo: c.text(`${h.ticker.split(':')[0]} dividend`), Date: c.date(date), Security: c.rel([sid]), Amount: c.money(amount), Account: c.rel([acct]) });
          env.row(tx, { Memo: c.text(`${h.ticker.split(':')[0]} dividend`), Date: c.date(date), Type: sel('Dividend'), Security: c.rel([sid]), Account: c.rel([acct]), Amount: c.money(amount) });
        }
      }
    });
  }
  if (env.on('review_rem')) {
    for (let q = 1; q <= 4; q++) {
      const fire = env.now + q * 91 * DAY;
      createReminder(ctx, { fireAt: Math.floor(fire / DAY) * DAY + 10 * 3_600_000, targetKind: 'page', targetId: env.inst.keyMap.rebalance ?? env.inst.rootPageId, text: 'Quarterly rebalance check', instanceId: env.inst.id });
    }
  }
  for (const h of [accts, secs, tx, targets, divs]) if (!ctx.seeding) env.db.emitChanged(ctx, h.id);
}

// ───────────────────────────────────────────────────────────────────────────── Tax Organizer

const DOCS: { doc: string; issuer: string; for: string; by: string; when?: string }[] = [
  { doc: 'W-2', issuer: 'Northwind Labs', for: 'Wages', by: '01-31', when: 'employment' },
  { doc: '1099-NEC', issuer: 'Acme Bakery', for: 'Self-employment income', by: '01-31', when: 'self_employment' },
  { doc: '1099-INT', issuer: 'Harbor Savings', for: 'Interest', by: '01-31', when: 'interest' },
  { doc: '1099-DIV', issuer: 'Harbor Invest', for: 'Dividends', by: '02-15', when: 'dividends' },
  { doc: '1099-B', issuer: 'Harbor Invest', for: 'Brokerage sales', by: '02-15', when: 'brokerage' },
  { doc: '1099-DA', issuer: 'Exchange', for: 'Crypto sales', by: '02-15', when: 'crypto' },
  { doc: '1098', issuer: 'Mortgage lender', for: 'Mortgage interest', by: '01-31' },
  { doc: '1098-E', issuer: 'Federal Loan Servicing', for: 'Student loan interest', by: '01-31' },
  { doc: '5498', issuer: 'Harbor Invest', for: 'IRA contributions', by: '05-31' },
  { doc: 'Property tax statement', issuer: 'County assessor', for: 'Itemized deductions', by: '01-31' },
];

export async function installTax(env: Env): Promise<void> {
  const { ctx, answers } = env;
  const j = isObj(answers.jurisdiction) ? answers.jurisdiction : {};
  const year = Number(j.year ?? new Date(env.now).getUTCFullYear());
  const income = Array.isArray(answers.income) ? (answers.income as string[]) : ['employment'];
  const se = income.includes('self_employment');
  const remindDays = Number(answers.reminders ?? 14);
  const disclaimer = '> [!note] EMP provides estimates for planning, not tax advice or a filed return. Check figures with the IRS or a qualified tax professional.';

  await env.step('Creating the estimator');
  env.page('estimator', { title: 'Estimator', icon: emoji('🧮'), blocks: md(`Pulls figures from Money HQ and Portfolio when installed; each pulled figure needs your confirmation.\n## Show math\nEvery line of the estimate is listed with its source.\n## Scenarios\n- +$5,000 self-employment income\n- +$X retirement contribution\n${disclaimer}`) });
  if (env.on('quarterly')) env.page('quarterly', { title: 'Quarterly payments', icon: emoji('🗓️'), blocks: md(`Estimated payments for tax year ${year}: April 15 · June 15 · September 15 · January 15.\n- [ ] Q1 paid\n- [ ] Q2 paid\n- [ ] Q3 paid\n- [ ] Q4 paid\n${disclaimer}`) });
  if (env.on('packet')) env.page('packet', { title: 'Preparer packet', icon: emoji('📦'), blocks: md('Everything your preparer needs, in one place. Export to PDF from the page menu.\n## Documents received\n## Income summary\n## Deductions & credits\n## Estimated payments\n## Questions for my preparer') });
  env.page('yearend', { title: 'Year-end planning checklist', icon: emoji('✅'), blocks: md(`- [ ] Max out retirement contributions you planned\n- [ ] Use HSA / FSA balances\n- [ ] Bunch charitable gifts if close to itemizing\n- [ ] Review unrealized losses (December)\n- [ ] Confirm Q4 estimated payment\n${disclaimer}`) });
  if (env.on('retention')) env.page('retention', { title: 'Record retention guide', icon: emoji('🗄️'), blocks: md('| Record | Keep for |\n|---|---|\n| Returns and supporting documents | 3 years after filing (common guideline) |\n| Records for unreported income > 25% | 6 years |\n| Property and investment basis records | Until 3 years after you sell |\n| Employment tax records | 4 years |') });

  const delegated = provisioned(env, 'tax.provision', { documents: 'documents_db', deductions: 'deductions_db', payments: 'estimates_db' });
  if (delegated) {
    await env.step('Building your document checklist');
    await env.step('Setting up deductions and estimated payments');
    taxDeadlines(env, year, remindDays);
    if (env.on('mileage_db')) {
      const mileage = env.database('mileage_db', { title: 'Mileage log', icon: emoji('🚗'), props: [P.title('Trip'), P.date('Date'), P.num('Miles'), P.text('Purpose')], firstView: { name: 'Trips', layout: 'table' } });
      if (env.sample) for (let i = 0; i < 5; i++) env.row(mileage, { Trip: c.text(['Client meeting — Acme', 'Supplier pickup', 'Workshop venue', 'Client meeting — Northside', 'Post office'][i]), Date: c.date(isoDay(env.now - (6 + i * 9) * DAY)), Miles: c.num([18.4, 7.2, 22, 12.5, 3.1][i]), Purpose: c.text('Business') });
    }
    return;
  }

  await env.step('Building your document checklist');
  const docs = env.database('documents_db', {
    title: 'Document checklist',
    icon: emoji('📄'),
    props: [P.title('Document'), P.text('Issuer'), P.text('For'), P.date('Expected by', 'doc.expected'), P.status('Status', [{ name: 'Expected', color: 'gray', group: 'todo' }, { name: 'Received', color: 'blue', group: 'in_progress' }, { name: 'Reviewed', color: 'purple', group: 'in_progress' }, { name: 'Sent to preparer', color: 'green', group: 'complete' }, { name: 'N/A', color: 'brown', group: 'complete' }], 'doc.status'), P.files('File'), P.money('Amount summary'), P.text('Notes'), P.date('Keep until')],
    firstView: { name: 'Checklist', layout: 'table' },
  });
  env.view(docs, 'By status', 'board', { groupBy: { prop: docs.props.Status.id } });
  const relevant = DOCS.filter((d) => !d.when || income.includes(d.when));
  relevant.forEach((d, i) => {
    const status = env.sample ? (i < 3 ? 'Received' : i < 4 ? 'Reviewed' : 'Expected') : 'Expected';
    env.row(docs, { Document: c.text(d.doc), Issuer: c.text(d.issuer), For: c.text(d.for), 'Expected by': c.date(`${year + 1}-${d.by}`), Status: sel(status), 'Keep until': c.date(`${year + 4}-04-15`) }, { sample: false });
  });

  const deductions = env.database('deductions_db', {
    title: 'Deductions & credits',
    icon: emoji('🧾'),
    props: [P.title('Description'), P.date('Date'), P.select('Category', ['Charitable', 'Medical', 'State & local tax', 'Mortgage interest', 'Education', 'Home office', 'Business expense', 'Retirement contribution']), P.money('Amount', 'ded.amount'), P.num('Deductible %', undefined, 'percent'), P.files('Receipt'), P.text('Payee'), P.num('Tax year')],
    firstView: { name: 'All deductions', layout: 'table' },
  });
  const estimates = env.database('estimates_db', {
    title: 'Estimated payments',
    icon: emoji('💸'),
    props: [P.title('Period'), P.date('Due date', 'est.due'), P.money('Suggested', 'est.suggested'), P.money('Paid amount', 'est.paid'), P.date('Paid date'), P.select('Method', ['IRS Direct Pay', 'EFTPS', 'Check', 'Card']), P.select('Status', [{ name: 'Upcoming', color: 'gray' }, { name: 'Due soon', color: 'orange' }, { name: 'Paid', color: 'green' }, { name: 'Late', color: 'red' }])],
    firstView: { name: 'Schedule', layout: 'table' },
  });
  const deadlines = taxDeadlines(env, year, remindDays);
  const quarters: [string, string][] = [['Q1', `${year}-04-15`], ['Q2', `${year}-06-15`], ['Q3', `${year}-09-15`], ['Q4', `${year + 1}-01-15`]];
  if (se || env.sample)
    quarters.forEach(([q, d], i) => {
      const past = Date.parse(`${d}T00:00:00Z`) < env.now;
      env.row(estimates, { Period: c.text(`${q} ${year}`), 'Due date': c.date(d), Suggested: c.money(1450), 'Paid amount': past ? c.money(1450) : null, 'Paid date': past ? c.date(isoDay(Date.parse(`${d}T00:00:00Z`) - 3 * DAY)) : null, Method: past ? sel('IRS Direct Pay') : null, Status: sel(past ? 'Paid' : i === 3 ? 'Upcoming' : 'Due soon') }, { sample: false });
    });
  let mileage: DbHandle | null = null;
  if (env.on('mileage_db')) {
    mileage = env.database('mileage_db', { title: 'Mileage log', icon: emoji('🚗'), props: [P.title('Trip'), P.date('Date'), P.num('Miles'), P.text('Purpose')], firstView: { name: 'Trips', layout: 'table' } });
  }
  if (env.sample) {
    await env.step('Adding sample deductions');
    const list: [string, string, number, number][] = [['Food bank donation', 'Charitable', 250, 40], ['Dental crown', 'Medical', 1180, 95], ['Home office chair', 'Home office', 329, 120], ['Design software', 'Business expense', 54.99, 30], ['Roth IRA contribution', 'Retirement contribution', 3000, 200], ['Animal shelter', 'Charitable', 120, 60]];
    for (const [d, cat, amt, ago] of list) env.row(deductions, { Description: c.text(d), Date: c.date(isoDay(env.now - ago * DAY)), Category: sel(cat), Amount: c.money(amt), 'Deductible %': c.num(1), 'Tax year': c.num(year) });
    if (mileage) for (let i = 0; i < 5; i++) env.row(mileage, { Trip: c.text(['Client meeting — Acme', 'Supplier pickup', 'Workshop venue', 'Client meeting — Northside', 'Post office'][i]), Date: c.date(isoDay(env.now - (6 + i * 9) * DAY)), Miles: c.num([18.4, 7.2, 22, 12.5, 3.1][i]), Purpose: c.text('Business') });
  }
  for (const h of [docs, deductions, estimates, deadlines, ...(mileage ? [mileage] : [])]) if (!ctx.seeding) env.db.emitChanged(ctx, h.id);
}

function taxDeadlines(env: Env, year: number, remindDays: number): DbHandle {
  const { ctx } = env;
  const deadlines = env.database('deadlines_db', {
    title: 'Deadlines',
    icon: emoji('⏰'),
    props: [P.title('Deadline'), P.date('Date', 'deadline.date'), P.select('Kind', ['Filing', 'Estimated payment', 'Document', 'Contribution']), P.check('Done')],
    firstView: { name: 'Upcoming', layout: 'table' },
  });
  const due: [string, string, string][] = [
    [`Q3 estimated payment`, `${year}-09-15`, 'Estimated payment'],
    [`Q4 estimated payment`, `${year + 1}-01-15`, 'Estimated payment'],
    ['W-2 and 1099s arrive', `${year + 1}-01-31`, 'Document'],
    ['Brokerage 1099s arrive', `${year + 1}-02-15`, 'Document'],
    [`File ${year} return or extension`, `${year + 1}-04-15`, 'Filing'],
    [`${year} IRA / HSA contributions`, `${year + 1}-04-15`, 'Contribution'],
    [`Q1 ${year + 1} estimated payment`, `${year + 1}-04-15`, 'Estimated payment'],
    [`Year-end planning (${year})`, `${year}-12-15`, 'Contribution'],
  ];
  for (const [name, date, kind] of due) {
    const id = env.row(deadlines, { Deadline: c.text(name), Date: c.date(date), Kind: sel(kind), Done: c.check(Date.parse(`${date}T00:00:00Z`) < env.now) }, { sample: false });
    const t = Date.parse(`${date}T09:00:00Z`);
    if (env.on('deadline_rem') && t > env.now) createReminder(ctx, { fireAt: Math.max(env.now + 60_000, t - remindDays * DAY), targetKind: 'row', targetId: id, text: `${name} in ${remindDays} days`, instanceId: env.inst.id });
  }
  return deadlines;
}
