/**
 * The six v1 life-app manifests (§16) as the browser preview serves them. Step ids, kinds and answer shapes follow
 * the Rust manifests in `crates/emp-store/lifeapps/*.json` (object defaults put the chosen option in their first
 * field; list builders take `options` as library chips unless the default is `{ items, <field> }`).
 *
 * Template `spec`s carry what the plan preview shows ({ title, icon }) plus generator hints read by the mock installer.
 */
import type { LifeAppManifest, Step, Template } from '@/backend/types';
import { MONEY_HQ_STEPS } from './moneyHqSteps';

export const FINANCE_DISCLAIMER =
  'EMP provides estimates and common guidelines for education, not financial advice. Check important decisions with a qualified professional.';
const TAX_DISCLAIMER =
  'EMP provides estimates for planning, not tax advice or a filed return. Rules change; check figures with the IRS or a qualified tax professional.';

export interface TemplateSpec {
  title: string;
  /** Emoji or `lucide:<name>`. */
  icon?: string;
  /** Plan count (reminders, rows). Expression in the Metric dialect or a number. */
  count?: number | string;
  /** Short line for the preview. */
  note?: string;
}

const tpl = (key: string, kind: Template['kind'], title: string, extra: Partial<Template> & { icon?: string; count?: number | string; note?: string } = {}): Template => {
  const { icon, count, note, ...rest } = extra;
  const spec: TemplateSpec = { title };
  if (icon) spec.icon = icon;
  if (count !== undefined) spec.count = count;
  if (note) spec.note = note;
  return { key, kind, optional: false, ...rest, spec };
};

const review = (title = 'Review & create'): Step => ({ id: 'review', kind: 'review', title, quick: true, skippable: false });

// ───────────────────────────────────────────────────────────────────────────── Money HQ (§16.2)

const moneyHq: LifeAppManifest = {
  id: 'money-hq',
  version: '1.0.0',
  title: 'Money HQ',
  tagline: 'Budget, accounts, goals and bills — with a plan for every dollar.',
  icon: 'wallet',
  color: 'jade',
  category: 'finance',
  sensitivity: 'high',
  estMinutes: 6,
  disclaimer: FINANCE_DISCLAIMER,
  steps: [...MONEY_HQ_STEPS, review()],
  templates: [
    tpl('hq', 'dashboard', 'Money HQ', { icon: 'lucide:wallet', note: 'KPIs, Sankey, budget vs actual, forecast' }),
    tpl('how', 'page', 'How your budget works', { icon: '📘' }),
    tpl('order', 'page', 'Financial order of operations', { icon: '🪜' }),
    tpl('weekly', 'page', 'Weekly check-in', { icon: '🗓️', optional: true }),
    tpl('monthly', 'page', 'Monthly review', { icon: '📅', optional: true }),
    tpl('accounts', 'database', 'Accounts', { icon: '🏦' }),
    tpl('transactions', 'database', 'Transactions', { icon: '💳' }),
    tpl('categories', 'database', 'Categories', { icon: '🏷️' }),
    tpl('recurring', 'database', 'Recurring', { icon: '🔁' }),
    tpl('goals', 'database', 'Goals', { icon: '🏁' }),
    tpl('subscriptions', 'database', 'Subscriptions', { icon: '📺', optional: true }),
    tpl('rules', 'rule', 'Categorisation rules', { optional: true, count: 6 }),
    tpl('bill_reminders', 'reminder', 'Bill reminders', { optional: true, count: 'max(answers.bills_count, 1)' }),
    tpl('rituals', 'recurring', 'Weekly check-in & monthly review', { optional: true, count: 2 }),
    tpl('ef_goal', 'row', 'Emergency fund goal', { optional: true }),
  ],
  metrics: [
    'net_worth', 'net_worth_delta_30d', 'to_be_assigned', 'left_to_spend', 'savings_rate_3m', 'essential_monthly_spend', 'ef_months',
    'debt_free_date', 'upcoming_bills_7d', 'uncategorized_count', 'utilization_max', 'forecast_min_balance_30d',
  ].map((name) => ({ name, kind: 'rust' as const, fn: `money.${name}`, deps: ['transactions.txn.amount'] })),
  advisor: [
    { id: 'cat-over', when: 'metrics.cat_over_count > 0', severity: 'warn', title: '{{metrics.cat_over_count}} categories are overspent', body: 'Consider moving money from a category with room so the month still balances.', mathMetrics: ['cat_over_count'], actions: [{ label: 'Open budget', route: 'tab:budget' }] },
    { id: 'cat-90pct', when: 'metrics.cat_90pct_count > 0', severity: 'tip', title: '{{metrics.cat_90pct_count}} categories are almost spent', body: 'These categories have used 90% or more of their budget with at least 10 days left.', mathMetrics: ['cat_90pct_count'], actions: [{ label: 'Open budget', route: 'tab:budget' }] },
    { id: 'uncategorized', when: 'metrics.uncategorized_count >= 10', severity: 'info', title: '{{metrics.uncategorized_count}} transactions need a category', body: 'Categorising keeps budgets and reports accurate.', mathMetrics: ['uncategorized_count'], actions: [{ label: 'Review transactions', route: 'tab:transactions' }] },
    { id: 'ef-below-target', when: 'metrics.ef_months < answers.emergency_months', severity: 'tip', title: 'Your emergency fund covers {{fmt_months(metrics.ef_months)}}', body: 'Common guideline: 3–6 months of essential expenses. A small automatic transfer each payday adds up.', mathMetrics: ['ef_months', 'essential_monthly_spend'], actions: [{ label: 'Open goals', route: 'tab:goals' }] },
    { id: 'util-30', when: 'metrics.utilization_max > 0.3', severity: 'tip', title: 'Card utilization is {{fmt_pct(metrics.utilization_max)}}', body: 'Keeping utilization under 30% is a common guideline for credit health.', mathMetrics: ['utilization_max'], actions: [{ label: 'Open accounts', route: 'tab:accounts' }] },
  ],
  checklist: [
    { id: 'import', label: 'Import transactions', autoTick: { event: 'finance.import_committed' } },
    { id: 'categorize', label: 'Categorise last month' },
    { id: 'budget', label: 'Set a budget', autoTick: { event: 'budget.assigned' } },
    { id: 'ef_goal', label: 'Set an emergency-fund goal' },
    { id: 'subscriptions', label: 'Review subscriptions' },
    { id: 'weekly', label: 'Do your first weekly check-in' },
  ],
  migrations: [],
  sample: { generator: 'money_hq', seed: 20261126 },
};

// ───────────────────────────────────────────────────────────────────────────── Portfolio (§16.3)

const ASSET_CLASSES = 'US equity, Intl developed, Emerging, Bonds, Inflation-linked, REIT, Cash, Crypto, Other';

const portfolio: LifeAppManifest = {
  id: 'portfolio',
  version: '1.0.0',
  title: 'Portfolio',
  tagline: 'Holdings, allocation, drift and dividends across every account.',
  icon: 'candlestick-chart',
  color: 'ocean',
  category: 'investing',
  sensitivity: 'high',
  estMinutes: 7,
  disclaimer: FINANCE_DISCLAIMER,
  steps: [
    {
      id: 'experience', kind: 'choice_cards', title: 'How familiar are you with investing?', quick: true, skippable: false, default: 'beginner',
      help: 'This only changes which indicators and explanations you see.',
      options: [
        { value: 'beginner', label: 'Beginner', description: 'Plain-language labels and tooltips for jargon.', icon: 'sprout' },
        { value: 'intermediate', label: 'Intermediate', description: 'Allocation, drift and performance views.', icon: 'trending-up' },
        { value: 'advanced', label: 'Advanced', description: 'Adds moving averages and XIRR detail.', icon: 'candlestick-chart' },
      ],
    },
    {
      id: 'accounts', kind: 'list_builder', title: 'Which investment accounts do you have?', quick: true, skippable: false,
      help: 'Account names stay on this device.',
      default: [{ name: 'Brokerage', broker: '', currency: 'USD', type: 'taxable', taxTreatment: 'taxable' }],
      itemSchema: { name: 'text', broker: 'text', currency: 'text', type: 'enum(401k,403b,ira,roth_ira,hsa,taxable,529,crypto)', taxTreatment: 'enum(taxable,deferred,free)' },
      options: [
        { value: '401(k)', label: '401(k)' }, { value: 'Roth IRA', label: 'Roth IRA' }, { value: 'Traditional IRA', label: 'Traditional IRA' },
        { value: 'Brokerage', label: 'Brokerage' }, { value: 'HSA', label: 'HSA' }, { value: 'Crypto', label: 'Crypto' },
      ],
    },
    {
      id: 'depth', kind: 'choice_cards', title: 'How much detail do you want to track?', quick: true, skippable: true, default: 'positions',
      options: [
        { value: 'positions', label: 'Positions only', description: 'Ticker, quantity and cost per position.', icon: 'list' },
        { value: 'history', label: 'Full history', description: 'Every buy, sell and dividend — import a CSV or enter by hand.', icon: 'history' },
      ],
    },
    {
      id: 'basis', kind: 'choice_cards', title: 'How should cost basis be calculated?', quick: false, skippable: true, default: 'fifo',
      why: 'FIFO is the common default for brokerage accounts; average cost is common for mutual funds.',
      options: [
        { value: 'fifo', label: 'FIFO', description: 'First in, first out.' },
        { value: 'average', label: 'Average cost', description: 'One blended cost per share.' },
      ],
    },
    {
      id: 'risk', kind: 'choice_cards', title: 'When will you need this money?', quick: false, skippable: true,
      help: 'Together with how you react to drops, this suggests a stock/bond range — for education only.',
      default: { horizon: 'long', drop: 'hold' },
      itemSchema: { horizon: 'text', drop: 'enum(sell,hold,buy)' },
      options: [
        { value: 'short', label: 'Within 3 years' },
        { value: 'medium', label: 'In 3–10 years' },
        { value: 'long', label: 'More than 10 years' },
      ],
    },
    {
      id: 'targets', kind: 'choice_cards', title: 'Pick a target allocation to start from', quick: true, skippable: true, default: 'three_fund',
      help: `Example starting points, not recommendations. Classes: ${ASSET_CLASSES}.`,
      recommend: 'recommend_allocation',
      options: [
        { value: 'three_fund', label: 'Three-fund style', description: '60% US · 30% Intl · 10% Bonds', icon: 'pie-chart' },
        { value: 'sixty_forty', label: '60/40', description: '60% stocks · 40% bonds', icon: 'scale' },
        { value: 'age_based', label: 'Age-based', description: '110 − age in stocks', icon: 'hourglass' },
        { value: 'all_equity', label: 'All-equity', description: '100% stocks', icon: 'rocket' },
        { value: 'custom', label: 'Custom', description: 'Set your own targets later', icon: 'sliders-horizontal' },
      ],
    },
    {
      id: 'rebalance', kind: 'choice_cards', title: 'When should we flag a rebalance?', quick: false, skippable: true, default: 'hybrid',
      why: 'Common guideline: check on a schedule and act only when drift exceeds a band.',
      options: [
        { value: 'calendar', label: 'Calendar', description: 'Quarterly, semiannual or annual.' },
        { value: 'threshold', label: 'Threshold', description: '5 percentage points or 25% relative drift.' },
        { value: 'hybrid', label: 'Hybrid', description: 'Check quarterly, act on 5 pp drift.' },
      ],
    },
    {
      id: 'contrib', kind: 'money', title: 'How much do you add each month?', quick: false, skippable: true, default: 500,
      help: 'Used for contribution reminders and the value-vs-contributions chart.',
    },
    {
      id: 'market', kind: 'connect', title: 'Prices', quick: true, skippable: true, default: { provider: 'keyless' },
      help: 'Only ticker symbols leave this device — never quantities, cost basis, account names or balances.',
      options: [
        { value: 'keyless', label: 'Keyless (delayed data)', description: 'Stooq end-of-day and CoinGecko. No account needed.' },
        { value: 'keys', label: 'Add provider keys', description: 'Finnhub or Tiingo for fresher quotes.' },
      ],
    },
    {
      id: 'watchlist', kind: 'list_builder', title: 'Anything to watch?', quick: false, skippable: true, default: [],
      itemSchema: { ticker: 'text', alertAbove: 'number', alertBelow: 'number' },
      options: [{ value: 'EMPX', label: 'EMPX' }, { value: 'NOVA', label: 'NOVA' }, { value: 'ORBT', label: 'ORBT' }, { value: 'KITE', label: 'KITE' }],
    },
    {
      id: 'benchmark', kind: 'choice_cards', title: 'Compare performance against…', quick: false, skippable: true, default: 'blend',
      options: [
        { value: 'blend', label: 'Blend of my targets' },
        { value: 'EMPX:XNAS', label: 'EMPX (market index)' },
      ],
    },
    review(),
  ],
  templates: [
    tpl('dashboard', 'dashboard', 'Portfolio', { icon: 'lucide:candlestick-chart', note: 'Value, allocation, drift, dividends' }),
    tpl('ips', 'page', 'Investment Policy Statement', { icon: '📜' }),
    tpl('rebalance', 'page', 'Rebalance planner', { icon: '⚖️' }),
    tpl('annual', 'page', 'Annual investing review', { icon: '🗓️', optional: true }),
    tpl('inv_accounts', 'database', 'Investment accounts', { icon: '🏦' }),
    tpl('securities', 'database', 'Securities', { icon: '🔖' }),
    tpl('inv_txns', 'database', 'Investment transactions', { icon: '🔁' }),
    tpl('targets_db', 'database', 'Target allocation', { icon: '🎯' }),
    tpl('review_rem', 'reminder', 'Rebalance check reminders', { optional: true, count: 4 }),
  ],
  metrics: ['total_value', 'day_change', 'unrealized', 'xirr_ytd', 'xirr_all', 'div_ttm', 'div_fwd_12m', 'max_drift', 'fees_per_year'].map((name) => ({ name, kind: 'rust' as const, fn: `portfolio.${name}`, deps: ['inv_txns.inv.qty'] })),
  advisor: [
    { id: 'drift-band', when: 'metrics.max_drift > 0.05', severity: 'warn', title: 'Allocation drifted {{round(metrics.max_drift * 100, 1)}} points', body: 'One asset class is outside its band. Consider directing new contributions to the underweight class first.', mathMetrics: ['max_drift'], actions: [{ label: 'Open rebalance planner', route: 'page:rebalance' }] },
  ],
  checklist: [
    { id: 'accounts', label: 'Add accounts' },
    { id: 'positions', label: 'Import or enter positions' },
    { id: 'targets', label: 'Set target allocation' },
    { id: 'ips', label: 'Write your IPS' },
    { id: 'rebalance', label: 'Run your first rebalance check' },
  ],
  migrations: [],
  sample: { generator: 'portfolio', seed: 8 },
};

// ───────────────────────────────────────────────────────────────────────────── Tax Organizer (§16.4)

const taxOrganizer: LifeAppManifest = {
  id: 'tax-organizer',
  version: '1.0.0',
  title: 'Tax Organizer',
  tagline: 'Documents, deductions, deadlines and a running estimate for the year.',
  icon: 'receipt-text',
  color: 'amber',
  category: 'tax',
  sensitivity: 'high',
  estMinutes: 6,
  disclaimer: TAX_DISCLAIMER,
  steps: [
    {
      id: 'jurisdiction', kind: 'jurisdiction', title: 'Where do you file?', quick: true, skippable: false,
      help: 'The v1 estimator covers US federal tax. Other countries get the organizer and checklists.',
      default: { country: 'US', region: 'CA', year: 2026, residency: 'resident' },
      options: [{ value: 'US', label: 'United States', description: 'Federal estimator · pack verified Oct 2026' }, { value: 'GB', label: 'United Kingdom', description: 'Generic organizer' }, { value: 'CA', label: 'Canada', description: 'Generic organizer' }, { value: 'DE', label: 'Germany', description: 'Generic organizer' }, { value: 'OTHER', label: 'Somewhere else', description: 'Generic organizer' }],
    },
    {
      id: 'household', kind: 'choice_cards', title: 'What is your filing status?', quick: true, skippable: false,
      default: { status: 'single', dependents: 0, over65: 0 },
      itemSchema: { status: 'text', dependents: 'number', over65: 'number' },
      options: [
        { value: 'single', label: 'Single' },
        { value: 'mfj', label: 'Married filing jointly' },
        { value: 'mfs', label: 'Married filing separately' },
        { value: 'hoh', label: 'Head of household' },
        { value: 'qss', label: 'Qualifying surviving spouse' },
      ],
    },
    {
      id: 'income', kind: 'multi_chips', title: 'Which kinds of income did you have?', quick: true, skippable: false, default: ['employment'],
      options: ['employment', 'self_employment', 'interest', 'dividends', 'brokerage', 'crypto', 'rental', 'retirement', 'social_security', 'unemployment', 'k1', 'foreign', 'other'].map((v) => ({
        value: v,
        label: ({ employment: 'Employment (W-2)', self_employment: 'Self-employment', interest: 'Interest', dividends: 'Dividends', brokerage: 'Brokerage sales', crypto: 'Crypto', rental: 'Rental', retirement: 'Retirement', social_security: 'Social Security', unemployment: 'Unemployment', k1: 'K-1', foreign: 'Foreign', other: 'Other' } as Record<string, string>)[v],
      })),
    },
    {
      id: 'events', kind: 'multi_chips', title: 'Did anything big happen this year?', quick: false, skippable: true, default: [],
      options: ['married', 'divorced', 'baby', 'moved', 'bought_home', 'sold_home', 'started_business', 'retired', 'education', 'inheritance', 'medical', 'landlord', 'job_loss', 'equity_comp'].map((v) => ({
        value: v,
        label: ({ married: 'Got married', divorced: 'Divorced', baby: 'Baby or adoption', moved: 'Moved', bought_home: 'Bought a home', sold_home: 'Sold a home', started_business: 'Started a business', retired: 'Retired', education: 'Education costs', inheritance: 'Inheritance', medical: 'Large medical bills', landlord: 'Became a landlord', job_loss: 'Lost a job', equity_comp: 'Equity compensation' } as Record<string, string>)[v],
      })),
    },
    {
      id: 'deductions', kind: 'choice_cards', title: 'Standard deduction or itemize?', quick: false, skippable: true, default: 'not_sure',
      options: [
        { value: 'not_sure', label: 'Not sure', description: 'We compare both as you log deductions.' },
        { value: 'standard', label: 'Standard' },
        { value: 'itemized', label: 'Itemized' },
      ],
    },
    {
      id: 'payments', kind: 'money', title: 'What has been paid so far?', quick: false, skippable: true,
      help: 'Year-to-date withholding, expected remaining withholding, estimated payments and last year’s total tax.',
      default: { withheldYtd: 0, withholdingRemaining: 0, estimatesPaid: 0, priorYearTax: 0 },
    },
    {
      id: 'preparer', kind: 'choice_cards', title: 'Who will prepare your return?', quick: false, skippable: true, default: 'software',
      options: [
        { value: 'software', label: 'Me, with software' },
        { value: 'professional', label: 'A professional', description: 'We generate a preparer packet.' },
        { value: 'not_sure', label: 'Not sure yet' },
      ],
    },
    { id: 'documents', kind: 'toggle', title: 'Store original documents encrypted?', quick: false, skippable: true, default: true, help: 'Recommended. Otherwise we only track each document’s status.' },
    { id: 'reminders', kind: 'number', title: 'Remind me before deadlines (days)', quick: false, skippable: true, default: 14, min: 1, max: 60, step: 1 },
    review(),
  ],
  templates: [
    tpl('hub', 'dashboard', 'Tax Year 2026', { icon: 'lucide:receipt-text', note: 'Status ring, countdown, estimate, timeline' }),
    tpl('estimator', 'page', 'Estimator', { icon: '🧮' }),
    tpl('quarterly', 'page', 'Quarterly payments', { icon: '🗓️', when: 'answers.income_self_employment' }),
    tpl('packet', 'page', 'Preparer packet', { icon: '📦', when: 'answers.preparer != "software"' }),
    tpl('yearend', 'page', 'Year-end planning checklist', { icon: '✅' }),
    tpl('retention', 'page', 'Record retention guide', { icon: '🗄️', optional: true }),
    tpl('documents_db', 'database', 'Document checklist', { icon: '📄' }),
    tpl('deductions_db', 'database', 'Deductions & credits', { icon: '🧾' }),
    tpl('estimates_db', 'database', 'Estimated payments', { icon: '💸' }),
    tpl('deadlines_db', 'database', 'Deadlines', { icon: '⏰' }),
    tpl('mileage_db', 'database', 'Mileage log', { icon: '🚗', when: 'answers.income_self_employment' }),
    tpl('deadline_rem', 'reminder', 'Deadline reminders', { optional: true, count: 8 }),
  ],
  metrics: ['docs_received_pct', 'next_deadline', 'est_balance', 'est_effective_rate', 'deductions_total', 'quarterly_next'].map((name) => ({ name, kind: 'rust' as const, fn: `tax.${name}`, deps: ['documents_db'] })),
  advisor: [
    { id: 'deadline-14', when: 'metrics.days_to_deadline <= 14 and metrics.days_to_deadline > 3', severity: 'tip', title: '{{metrics.next_deadline_label}} in {{metrics.days_to_deadline}} days', body: 'Gather what you need now so the deadline is calm.', mathMetrics: ['next_deadline'], actions: [{ label: 'Open deadlines', route: 'db:deadlines_db' }] },
  ],
  checklist: [
    { id: 'status', label: 'Confirm filing status' },
    { id: 'docs', label: 'Add expected documents' },
    { id: 'deduction', label: 'Log your first deduction' },
    { id: 'quarterly', label: 'Review quarterly plan' },
    { id: 'preparer', label: 'Choose a preparer path' },
  ],
  migrations: [],
  sample: { generator: 'tax', seed: 2026 },
};

// ───────────────────────────────────────────────────────────────────────────── Spreadsheet Studio (§16.5)

export const SHEET_INTENTS: { value: string; label: string; description: string; icon: string }[] = [
  { value: 'loan', label: 'Loan / mortgage', description: 'PMT payment, amortization schedule, extra payments.', icon: 'landmark' },
  { value: 'budget', label: 'Budget sheet', description: 'Transactions → SUMIFS budget vs actual.', icon: 'wallet' },
  { value: 'decision', label: 'Decision matrix', description: 'Weighted scores, ranks and sensitivity.', icon: 'scale' },
  { value: 'project_budget', label: 'Project budget', description: 'Line items, estimates vs actuals, contingency.', icon: 'hammer' },
  { value: 'timesheet', label: 'Timesheet', description: 'Hours with breaks, weekly totals and overtime.', icon: 'clock' },
  { value: 'inventory', label: 'Inventory', description: 'Stock value and reorder alerts.', icon: 'package' },
  { value: 'split', label: 'Split expenses', description: 'Who paid, balances and who pays whom.', icon: 'split' },
  { value: 'savings', label: 'Savings / compound interest', description: 'FV growth with an inflation-adjusted column.', icon: 'sprout' },
  { value: 'blank', label: 'Blank, well-structured', description: 'Inputs, Calculations, Output and Checks sheets.', icon: 'table-2' },
];

const spreadsheetStudio: LifeAppManifest = {
  id: 'spreadsheet-studio',
  version: '1.0.0',
  title: 'Spreadsheet Studio',
  tagline: 'Well-built calculators and trackers, with checks you can trust.',
  icon: 'sheet',
  color: 'iris',
  category: 'sheets',
  sensitivity: 'normal',
  estMinutes: 2,
  steps: [
    { id: 'intent', kind: 'choice_cards', title: 'What do you want to build?', quick: true, skippable: false, default: 'loan', options: SHEET_INTENTS },
    { id: 'excel_compat', kind: 'toggle', title: 'Will you share this with Excel users?', quick: false, skippable: true, default: false, help: 'When on, we stick to functions that round-trip to Excel and warn about EMP-only ones (STOCK, FX).' },
    {
      id: 'structure', kind: 'multi_chips', title: 'Which sections should the workbook have?', quick: false, skippable: true, default: ['inputs', 'calculations', 'output', 'checks', 'changelog'],
      why: 'Separating inputs from formulas is a common guideline that makes models easier to audit.',
      options: [
        { value: 'inputs', label: 'Inputs' }, { value: 'calculations', label: 'Calculations' }, { value: 'output', label: 'Output' }, { value: 'checks', label: 'Checks' }, { value: 'changelog', label: 'Changelog' },
      ],
    },
    {
      id: 'chart', kind: 'choice_cards', title: 'Add a chart?', quick: false, skippable: true, default: 'line',
      options: [{ value: 'none', label: 'None', icon: 'ban' }, { value: 'line', label: 'Line', icon: 'chart-line' }, { value: 'bar', label: 'Bar', icon: 'chart-column' }, { value: 'area', label: 'Area', icon: 'chart-area' }, { value: 'donut', label: 'Donut', icon: 'chart-pie' }],
    },
    review(),
  ],
  templates: [
    tpl('studio', 'dashboard', 'Spreadsheet Studio', { icon: 'lucide:sheet', note: 'Templates and recent workbooks' }),
    tpl('workbook', 'workbook', 'Workbook', { icon: '📊' }),
    tpl('guide', 'page', 'How these workbooks are built', { icon: '📐', optional: true }),
  ],
  metrics: [
    { name: 'workbook_count', kind: 'rust', fn: 'sheets.workbook_count', deps: [] },
    { name: 'lint_issues', kind: 'rust', fn: 'sheets.lint_issues', deps: [] },
  ],
  advisor: [],
  checklist: [
    { id: 'inputs', label: 'Fill the inputs' },
    { id: 'checks', label: 'Review the checks sheet' },
    { id: 'export', label: 'Export to Excel' },
  ],
  migrations: [],
  sample: { generator: 'sheets', seed: 5 },
};

// ───────────────────────────────────────────────────────────────────────────── Life OS (§16.6)

export const LIFE_AREAS = ['Work', 'Health', 'Money', 'Home', 'Relationships', 'Learning', 'Fun', 'Side project', 'Family', 'Community'];

const lifeOs: LifeAppManifest = {
  id: 'life-os',
  version: '1.0.0',
  title: 'Life OS',
  tagline: 'Tasks, projects and goals with a calm daily plan.',
  icon: 'kanban',
  color: 'blue',
  category: 'planning',
  sensitivity: 'normal',
  estMinutes: 4,
  steps: [
    {
      id: 'style', kind: 'choice_cards', title: 'How do you like to plan?', quick: true, skippable: false, default: 'simple',
      options: [
        { value: 'simple', label: 'Simple', description: 'Today and Upcoming. Nothing more.', icon: 'sun' },
        { value: 'gtd', label: 'GTD', description: 'Inbox, next actions, waiting, someday.', icon: 'inbox' },
        { value: 'timeblock', label: 'Time-blocking', description: 'Schedule tasks into your calendar.', icon: 'calendar-clock' },
        { value: 'para', label: 'PARA', description: 'Projects, Areas, Resources, Archive.', icon: 'folders' },
        { value: 'mix', label: 'Mix', description: 'A bit of each — recommended if unsure.', icon: 'shuffle' },
      ],
    },
    {
      id: 'areas', kind: 'multi_chips', title: 'Which areas of life should it cover?', quick: true, skippable: false, default: ['Work', 'Health', 'Home'],
      help: 'Each one becomes an Area you can file projects and tasks under.',
      options: LIFE_AREAS.map((a) => ({ value: a, label: a })),
    },
    {
      id: 'priority', kind: 'choice_cards', title: 'How do you prioritise?', quick: false, skippable: true, default: 'p1p4',
      options: [
        { value: 'p1p4', label: 'P1–P4', description: 'Four simple levels.' },
        { value: 'eisenhower', label: 'Eisenhower', description: 'Urgent × important quadrants.' },
        { value: 'top3', label: 'Top 3 per day', description: 'Pick three things that matter today.' },
      ],
    },
    {
      id: 'hours', kind: 'recurrence', title: 'When do you work?', quick: false, skippable: true,
      default: { days: 'weekdays', start: '09:00', end: '17:30', focusStart: '09:00', focusEnd: '11:30', maxFocusBlocks: 2 },
      itemSchema: { days: 'enum(weekdays,everyday,custom)', start: 'time', end: 'time', focusStart: 'time', focusEnd: 'time', maxFocusBlocks: 'number' },
    },
    {
      id: 'calendar', kind: 'connect', title: 'Show your Google Calendar on Today?', quick: false, skippable: true, default: { provider: 'none' },
      help: 'Read-only. Events are cached on this device; nothing is sent back.',
      options: [{ value: 'google', label: 'Connect Google Calendar' }, { value: 'none', label: 'Not now' }],
    },
    {
      id: 'rituals', kind: 'recurrence', title: 'Your planning rituals', quick: true, skippable: true,
      default: { daily: { rrule: 'FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR', time: '08:30' }, shutdown: { rrule: 'FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR', time: '17:30' }, weekly: { rrule: 'FREQ=WEEKLY;BYDAY=FR', time: '16:00' }, monthly: { rrule: 'FREQ=MONTHLY;BYMONTHDAY=1', time: '09:00' } },
      itemSchema: { daily: 'recurrence', shutdown: 'recurrence', weekly: 'recurrence', monthly: 'recurrence' },
      why: 'A short daily plan and a weekly review are common guidelines for keeping lists trustworthy.',
    },
    { id: 'capture', kind: 'toggle', title: 'Understand dates as you type?', quick: false, skippable: true, default: true, help: '“Call mom tomorrow 6pm !high #home” becomes a task with a due date, priority and tag.' },
    review(),
  ],
  templates: [
    tpl('os', 'dashboard', 'Life OS', { icon: 'lucide:kanban', note: 'Today, projects and goals' }),
    tpl('today', 'dashboard', 'Today', { icon: 'lucide:sun', note: 'Agenda, Top 3, due and overdue' }),
    tpl('tasks', 'database', 'Tasks', { icon: '✅', note: 'Inbox, Today, Upcoming, Board, Someday, Waiting, Completed' }),
    tpl('projects', 'database', 'Projects', { icon: '🎯' }),
    tpl('areas_db', 'database', 'Areas', { icon: '🧭', count: 'answers.areas_count' }),
    tpl('resources', 'database', 'Resources', { icon: '📚', when: 'answers.style == "para" or answers.style == "mix"' }),
    tpl('daily', 'database', 'Daily notes', { icon: '📓' }),
    tpl('eisenhower', 'view', 'Eisenhower board', { when: 'answers.priority == "eisenhower"' }),
    tpl('weekly', 'page', 'Weekly review', { icon: '🔁' }),
    tpl('goals', 'database', 'Goals', { icon: '🏔️', optional: true }),
    tpl('ritual_rem', 'reminder', 'Planning & shutdown reminders', { optional: true, count: 4 }),
  ],
  metrics: [
    { name: 'inbox_count', kind: 'rust', fn: 'lifeos.inbox_count', deps: ['tasks.task.status'] },
    { name: 'overdue_count', kind: 'rust', fn: 'lifeos.overdue_count', deps: ['tasks.task.due'] },
    { name: 'today_scheduled_min', kind: 'rust', fn: 'lifeos.today_scheduled_min', deps: ['tasks.task.scheduled', 'tasks.task.estimate'] },
    { name: 'projects_without_next', kind: 'rust', fn: 'lifeos.projects_without_next', deps: ['projects'] },
    { name: 'last_review_date', kind: 'rust', fn: 'lifeos.last_review_date', deps: [] },
    { name: 'done_7d', kind: 'rust', fn: 'lifeos.done_7d', deps: ['tasks.task.completed'] },
    { name: 'due_today', kind: 'rust', fn: 'lifeos.due_today', deps: ['tasks.task.due'] },
  ],
  advisor: [
    { id: 'overdue-5', when: 'metrics.overdue_count > 5', severity: 'warn', title: '{{metrics.overdue_count}} tasks are overdue', body: 'Consider rescheduling, delegating or dropping a few — a shorter list you trust beats a long one you avoid.', mathMetrics: ['overdue_count'], actions: [{ label: 'Review overdue', route: 'tab:tasks' }] },
    { id: 'overbooked', when: 'metrics.today_scheduled_min > metrics.working_min', severity: 'warn', title: 'Today is overbooked', body: 'You have scheduled {{metrics.today_scheduled_min}} minutes of tasks into {{metrics.working_min}} working minutes.', mathMetrics: ['today_scheduled_min', 'working_min'], actions: [{ label: 'Open Today', route: 'tab:today' }] },
    { id: 'inbox-20', when: 'metrics.inbox_count > 20', severity: 'tip', title: 'Your inbox has {{metrics.inbox_count}} items', body: 'A quick pass to sort each one into Next, Someday or Done keeps the list trustworthy.', mathMetrics: ['inbox_count'], actions: [{ label: 'Process inbox', route: 'tab:tasks' }] },
    { id: 'project-no-next', when: 'metrics.projects_without_next > 0', severity: 'tip', title: '{{metrics.projects_without_next}} projects have no next action', body: 'Projects move when the next physical step is written down.', mathMetrics: ['projects_without_next'], actions: [{ label: 'Open projects', route: 'tab:projects' }] },
    { id: 'review-missed', when: 'metrics.days_since_review > 8', severity: 'tip', title: 'Weekly review is due', body: 'It has been {{metrics.days_since_review}} days since your last review.', mathMetrics: ['last_review_date'], actions: [{ label: 'Start review', route: 'page:weekly' }] },
  ],
  checklist: [
    { id: 'capture5', label: 'Capture 5 tasks' },
    { id: 'inbox', label: 'Process your inbox' },
    { id: 'project', label: 'Create a project with a next action' },
    { id: 'review', label: 'Do your first weekly review' },
  ],
  migrations: [],
  sample: { generator: 'life_os', seed: 6 },
};

// ───────────────────────────────────────────────────────────────────────────── Habits (§16.7)

export const HABIT_LIBRARY: { value: string; label: string; description: string; icon: string }[] = [
  { value: 'sleep', label: 'Sleep 7–9 h', description: 'duration · daily', icon: '😴' },
  { value: 'walk', label: 'Walk 8k steps', description: 'count · daily', icon: '🚶' },
  { value: 'strength', label: 'Strength train', description: 'yes/no · 3× week', icon: '🏋️' },
  { value: 'water', label: 'Water', description: '8 glasses · daily', icon: '💧' },
  { value: 'read', label: 'Read 20 min', description: 'duration · daily', icon: '📖' },
  { value: 'meditate', label: 'Meditate', description: '10 min · daily', icon: '🧘' },
  { value: 'journal', label: 'Journal', description: 'yes/no · daily', icon: '✍️' },
  { value: 'nophone', label: 'No phone first hour', description: 'avoid · daily', icon: '📵' },
  { value: 'inbox', label: 'Inbox zero', description: 'yes/no · weekdays', icon: '📥' },
  { value: 'language', label: 'Language practice', description: '15 min · daily', icon: '🗣️' },
  { value: 'floss', label: 'Floss', description: 'yes/no · daily', icon: '🦷' },
  { value: 'budget', label: 'Budget check-in', description: 'yes/no · weekly', icon: '💰' },
  { value: 'stretch', label: 'Stretch', description: '5 min · daily', icon: '🤸' },
];

const habits: LifeAppManifest = {
  id: 'habits',
  version: '1.0.0',
  title: 'Habits',
  tagline: 'Small daily wins, streaks and a weekly reflection.',
  icon: 'heart-pulse',
  color: 'ruby',
  category: 'health',
  sensitivity: 'normal',
  estMinutes: 3,
  steps: [
    {
      id: 'pick', kind: 'list_builder', title: 'Which habits do you want to build?', quick: true, skippable: false,
      help: 'Start with two or three. Tap a chip or add your own; open a habit to set its schedule, cue and two-minute version.',
      why: 'Common guideline: start small and stack new habits onto existing routines.',
      default: [
        { name: 'Read 20 min', type: 'duration', schedule: 'daily', target: 20, unit: 'min', twoMinute: 'Read one page', cue: 'After dinner', timeOfDay: 'evening' },
        { name: 'Walk 8k steps', type: 'count', schedule: 'daily', target: 8000, unit: 'steps', twoMinute: 'Walk around the block', cue: 'After lunch', timeOfDay: 'afternoon' },
      ],
      itemSchema: { name: 'text', type: 'enum(yes_no,count,duration,quantity,avoid)', schedule: 'enum(daily,x_per_week,weekdays,every_n_days)', target: 'number', unit: 'text', twoMinute: 'text', cue: 'text', timeOfDay: 'enum(morning,afternoon,evening,anytime)' },
      options: HABIT_LIBRARY.map(({ value, label, description }) => ({ value, label, description })),
    },
    { id: 'identity', kind: 'text', title: 'I’m becoming someone who…', quick: false, skippable: true, default: '', help: 'Optional. Identity statements make habits stickier — “…moves every day”.' },
    {
      id: 'grace', kind: 'choice_cards', title: 'How strict should streaks be?', quick: true, skippable: false, default: 'never_miss_twice',
      options: [
        { value: 'strict', label: 'Strict', description: 'Any miss resets the streak.', icon: 'lock' },
        { value: 'never_miss_twice', label: 'Never miss twice', description: 'One miss is fine; two in a row resets.', icon: 'shield-check' },
        { value: 'skip_days', label: 'Skip days', description: 'Freeze days you plan to skip.', icon: 'snowflake' },
      ],
    },
    { id: 'review', kind: 'toggle', title: 'Weekly reflection', quick: false, skippable: true, default: true, help: 'A five-minute look back every Sunday.' },
    review(),
  ],
  templates: [
    tpl('dash', 'dashboard', 'Habits', { icon: 'lucide:heart-pulse', note: 'Heatmaps, streaks, weekly score' }),
    tpl('habits_db', 'database', 'Habits', { icon: '🌱', count: 'answers.pick_count' }),
    tpl('log', 'database', 'Habit log', { icon: '🗒️' }),
    tpl('weekly', 'page', 'Weekly habit review', { icon: '🪞', when: 'answers.review' }),
    tpl('habit_rem', 'reminder', 'Habit reminders', { optional: true, count: 'answers.pick_count' }),
  ],
  metrics: [
    { name: 'active_count', kind: 'rust', fn: 'habits.active_count', deps: ['habits_db'] },
    { name: 'today_done_pct', kind: 'rust', fn: 'habits.today_done_pct', deps: ['log'] },
    { name: 'best_streak', kind: 'rust', fn: 'habits.best_streak', deps: ['log'] },
    { name: 'rate_30d_avg', kind: 'rust', fn: 'habits.rate_30d_avg', deps: ['log'] },
  ],
  advisor: [
    { id: 'dont-miss-twice', when: 'metrics.missed_yesterday > 0', severity: 'tip', title: 'Don’t miss twice', body: '{{metrics.missed_yesterday_names}} slipped yesterday. Doing even the two-minute version today keeps the streak alive.', mathMetrics: ['missed_yesterday'], actions: [{ label: 'Check in', route: 'tab:today' }] },
    { id: 'make-smaller', when: 'metrics.struggling_count > 0', severity: 'tip', title: 'Make {{metrics.struggling_name}} smaller', body: 'It has been under 40% for three weeks. Consider shrinking it to its two-minute version for a while.', mathMetrics: ['rate_30d_avg'], actions: [{ label: 'Edit habit', route: 'db:habits_db' }] },
    { id: 'level-up', when: 'metrics.thriving_count > 0', severity: 'info', title: 'Ready to level up {{metrics.thriving_name}}?', body: '90% or better for 21 days. Consider raising the target a little.', mathMetrics: ['best_streak'], actions: [{ label: 'Edit habit', route: 'db:habits_db' }] },
    { id: 'too-many', when: 'metrics.recent_started > 6', severity: 'tip', title: 'That’s a lot of new habits', body: 'More than six started in two weeks. Common guideline: add one at a time.', mathMetrics: ['active_count'], actions: [] },
  ],
  checklist: [
    { id: 'checkin', label: 'Check in today' },
    { id: 'streak3', label: 'Hit a 3-day streak' },
    { id: 'reflect', label: 'Do a weekly reflection' },
  ],
  migrations: [],
  sample: { generator: 'habits', seed: 42 },
};

export const MANIFESTS: LifeAppManifest[] = [moneyHq, portfolio, taxOrganizer, spreadsheetStudio, lifeOs, habits];

export function manifestById(id: string): LifeAppManifest | undefined {
  return MANIFESTS.find((m) => m.id === id);
}
