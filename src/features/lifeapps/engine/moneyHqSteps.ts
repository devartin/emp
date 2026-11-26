/** Money HQ wizard steps — mirrored from crates/emp-store/lifeapps/money-hq.json (§16.2) so the browser preview asks exactly what the desktop app asks. */
import type { Step } from '@/backend/types';

export const MONEY_HQ_STEPS: Step[] = [
 {
  "id": "currency",
  "kind": "choice_cards",
  "title": "Which currency do you budget in?",
  "quick": true,
  "skippable": false,
  "help": "Pick your base currency. Net worth and budgets are reported in it.",
  "why": "Budgets work best in the currency you are paid in.",
  "default": {
   "code": "USD",
   "numberFormat": "en-US",
   "monthStartDay": 1
  },
  "options": [
   {
    "value": "USD",
    "label": "US dollar",
    "description": "$"
   },
   {
    "value": "EUR",
    "label": "Euro",
    "description": "€"
   },
   {
    "value": "GBP",
    "label": "British pound",
    "description": "£"
   },
   {
    "value": "CAD",
    "label": "Canadian dollar"
   },
   {
    "value": "AUD",
    "label": "Australian dollar"
   },
   {
    "value": "JPY",
    "label": "Japanese yen"
   },
   {
    "value": "CHF",
    "label": "Swiss franc"
   },
   {
    "value": "INR",
    "label": "Indian rupee"
   }
  ],
  "itemSchema": {
   "code": "text",
   "numberFormat": "text",
   "monthStartDay": "number"
  },
  "min": 1,
  "max": 28,
  "step": 1
 },
 {
  "id": "household",
  "kind": "choice_cards",
  "title": "Who shares this budget?",
  "quick": false,
  "skippable": true,
  "help": "Partners can keep joint, separate or split money; a Shared group is added when it helps.",
  "default": {
   "mode": "single",
   "dependents": 0,
   "splitPct": 50
  },
  "options": [
   {
    "value": "single",
    "label": "Just me",
    "icon": "user"
   },
   {
    "value": "partner_joint",
    "label": "With partner — joint",
    "icon": "users"
   },
   {
    "value": "partner_separate",
    "label": "With partner — separate",
    "icon": "users"
   },
   {
    "value": "partner_split",
    "label": "With partner — split %",
    "icon": "percent"
   }
  ],
  "itemSchema": {
   "mode": "enum",
   "dependents": "number",
   "splitPct": "percent"
  }
 },
 {
  "id": "income",
  "kind": "list_builder",
  "title": "What income comes in?",
  "quick": true,
  "skippable": false,
  "help": "Add each regular paycheck. Use take-home (net) pay if you can.",
  "why": "Knowing when money arrives lets us plan bills around paydays.",
  "default": {
   "items": [
    {
     "name": "Salary",
     "amount": 0,
     "frequency": "biweekly",
     "net": true,
     "nextPayDate": null
    }
   ],
   "stability": "stable"
  },
  "itemSchema": {
   "name": "text",
   "amount": "money",
   "frequency": "enum(weekly,biweekly,semimonthly,monthly,irregular)",
   "net": "bool",
   "nextPayDate": "date"
  },
  "options": [
   {
    "value": "stable",
    "label": "Stable"
   },
   {
    "value": "variable",
    "label": "Variable"
   },
   {
    "value": "irregular",
    "label": "Irregular"
   }
  ]
 },
 {
  "id": "method",
  "kind": "choice_cards",
  "title": "How do you want to budget?",
  "quick": true,
  "skippable": false,
  "help": "You can switch methods later with a tune-up.",
  "recommend": "recommend_budget_method",
  "default": "fifty_thirty_twenty",
  "options": [
   {
    "value": "fifty_thirty_twenty",
    "label": "50/30/20",
    "description": "About 50% needs, 30% wants, 20% savings and debt.",
    "icon": "pie-chart"
   },
   {
    "value": "zero_based",
    "label": "Zero-based",
    "description": "Assign all income to categories before the month starts.",
    "icon": "target"
   },
   {
    "value": "pay_yourself_first",
    "label": "Pay yourself first",
    "description": "Automate savings first, spend the rest freely.",
    "icon": "piggy-bank"
   },
   {
    "value": "envelopes",
    "label": "Envelopes",
    "description": "Fill category envelopes from each paycheck.",
    "icon": "mail"
   },
   {
    "value": "track_only",
    "label": "Track only",
    "description": "No budget — just see where money goes.",
    "icon": "eye"
   }
  ]
 },
 {
  "id": "bills",
  "kind": "list_builder",
  "title": "Which bills do you pay?",
  "quick": false,
  "skippable": true,
  "help": "Add your regular bills. Each becomes a recurring item with a reminder before it is due.",
  "default": [],
  "options": [
   {
    "value": "Rent / Mortgage",
    "label": "Rent / Mortgage"
   },
   {
    "value": "Utilities",
    "label": "Utilities"
   },
   {
    "value": "Phone",
    "label": "Phone"
   },
   {
    "value": "Internet",
    "label": "Internet"
   },
   {
    "value": "Health insurance",
    "label": "Health insurance"
   },
   {
    "value": "Auto insurance",
    "label": "Auto insurance"
   },
   {
    "value": "Home insurance",
    "label": "Home insurance"
   },
   {
    "value": "Renters insurance",
    "label": "Renters insurance"
   },
   {
    "value": "Life insurance",
    "label": "Life insurance"
   },
   {
    "value": "Childcare",
    "label": "Childcare"
   },
   {
    "value": "Transit",
    "label": "Transit"
   },
   {
    "value": "Loans",
    "label": "Loans"
   },
   {
    "value": "Subscriptions",
    "label": "Subscriptions"
   }
  ],
  "itemSchema": {
   "name": "text",
   "amount": "money",
   "schedule": "recurrence",
   "dueDay": "number",
   "autopay": "bool",
   "account": "text"
  }
 },
 {
  "id": "accounts",
  "kind": "list_builder",
  "title": "Which accounts do you have?",
  "quick": true,
  "skippable": false,
  "help": "Add checking, savings, cards and loans with their current balances. Card and loan balances are what you owe.",
  "default": [
   {
    "name": "Checking",
    "type": "checking",
    "balance": 0,
    "onBudget": true
   }
  ],
  "itemSchema": {
   "name": "text",
   "type": "enum(checking,savings,credit_card,student_loan,auto_loan,mortgage,personal_loan,investment,cash,other_asset,other_liability)",
   "balance": "money",
   "apr": "percent",
   "minPayment": "money",
   "limit": "money",
   "onBudget": "bool"
  }
 },
 {
  "id": "debt",
  "kind": "choice_cards",
  "title": "How do you want to pay down debt?",
  "quick": false,
  "skippable": true,
  "when": "answers.accounts_type_credit_card or answers.accounts_type_student_loan or answers.accounts_type_auto_loan or answers.accounts_type_mortgage or answers.accounts_type_personal_loan or answers.accounts_type_other_liability",
  "help": "Choose a payoff order and how much extra you can put toward debt each month.",
  "why": "Avalanche saves the most interest; snowball builds momentum with quick wins.",
  "recommend": "recommend_debt_strategy",
  "default": {
   "strategy": "avalanche",
   "extra": 100
  },
  "options": [
   {
    "value": "avalanche",
    "label": "Avalanche",
    "description": "Highest APR first — least interest.",
    "icon": "trending-down"
   },
   {
    "value": "snowball",
    "label": "Snowball",
    "description": "Smallest balance first — quickest wins.",
    "icon": "snowflake"
   },
   {
    "value": "hybrid",
    "label": "Hybrid",
    "description": "Two smallest first, then highest APR."
   },
   {
    "value": "custom",
    "label": "Custom",
    "description": "Your own order."
   }
  ],
  "min": 0,
  "max": 2000,
  "step": 25
 },
 {
  "id": "emergency",
  "kind": "money",
  "title": "How big should your emergency fund be?",
  "quick": false,
  "skippable": true,
  "help": "Tell us what you have saved for emergencies and pick a target.",
  "why": "3–6 months of essential expenses; 9–12 if income is irregular.",
  "recommend": "recommend_ef_months",
  "default": {
   "current": 0,
   "months": 6,
   "starter": 1000
  },
  "options": [
   {
    "value": "3",
    "label": "3 months"
   },
   {
    "value": "6",
    "label": "6 months"
   },
   {
    "value": "9",
    "label": "9–12 months"
   }
  ]
 },
 {
  "id": "goals",
  "kind": "list_builder",
  "title": "What are you saving for?",
  "quick": false,
  "skippable": true,
  "help": "Sinking funds turn big, predictable costs into small monthly amounts.",
  "default": [],
  "options": [
   {
    "value": "Car replacement",
    "label": "Car replacement"
   },
   {
    "value": "Holidays and gifts",
    "label": "Holidays and gifts"
   },
   {
    "value": "Annual insurance",
    "label": "Annual insurance"
   },
   {
    "value": "Vacation",
    "label": "Vacation"
   },
   {
    "value": "Home repair",
    "label": "Home repair"
   },
   {
    "value": "Medical deductible",
    "label": "Medical deductible"
   },
   {
    "value": "Down payment",
    "label": "Down payment"
   }
  ],
  "itemSchema": {
   "name": "text",
   "target": "money",
   "date": "date",
   "priority": "enum(high,medium,low)"
  }
 },
 {
  "id": "data",
  "kind": "file_import",
  "title": "Bring in your transactions",
  "quick": true,
  "skippable": true,
  "help": "Import CSV, OFX, QFX or QIF files from your bank, start blank, or explore with sample data.",
  "default": {
   "source": "blank"
  },
  "options": [
   {
    "value": "import",
    "label": "Import files",
    "description": "CSV / OFX / QFX / QIF",
    "icon": "upload"
   },
   {
    "value": "blank",
    "label": "Start blank",
    "icon": "file"
   },
   {
    "value": "sample",
    "label": "Use sample data",
    "icon": "sparkles"
   }
  ]
 },
 {
  "id": "privacy",
  "kind": "toggle",
  "title": "Privacy",
  "quick": false,
  "skippable": true,
  "help": "Financial data is sensitive. Encryption protects it if someone gets your files.",
  "default": {
   "encrypt": false,
   "hideAmounts": false
  }
 },
 {
  "id": "rituals",
  "kind": "recurrence",
  "title": "Money rituals",
  "quick": false,
  "skippable": true,
  "help": "A short weekly check-in and a monthly review keep the budget honest.",
  "why": "Ten minutes a week keeps it current.",
  "default": {
   "weekly": {
    "rrule": "FREQ=WEEKLY;BYDAY=SU",
    "time": "10:00"
   },
   "monthly": {
    "rrule": "FREQ=MONTHLY;BYDAY=1SA",
    "time": "10:00"
   },
   "billDays": 3
  },
  "itemSchema": {
   "weekly": "recurrence",
   "monthly": "recurrence",
   "billDays": "number"
  }
 }
];
