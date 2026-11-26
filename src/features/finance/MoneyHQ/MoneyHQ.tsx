/**
 * Money HQ (§16.2; PROGRAMME-v3 K4): the personal-finance hub. Five tabs — Overview · Transactions · Budget ·
 * Accounts (net worth inside) · Plan (Recurring, Debt, Forecast, Goals). It always lands on Overview; the old tab
 * routes still work: `recurring`, `debt`, `forecast` and `goals` open Plan at that section, `networth` redirects to
 * Accounts. The import wizard (the one finance import entry, see ImportWizard/request.ts) and the rules editor open
 * as sheets from the header.
 */
import { ChevronLeft, ChevronRight, FileUp, ListFilter, Wallet } from "lucide-react";
import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "@/backend";
import type { FinanceOverview, Id } from "@/backend/types";
import { navigate } from "@/app/router";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import type { TabItem } from "@/ui/Tabs";
import { addMonths, monthLabel, todayIso } from "../shared/format";
import { useAsync, useDbChanged } from "../shared/hooks";
import { Disclaimer, HubPage, Quiet } from "../shared/ui";
import { useFinanceImportRequest, type FinanceImportFile } from "../ImportWizard/request";
import { LedgerContext, useLedger } from "./ledger";
import { Overview } from "./Overview";

const loadTransactions = () => import("./Transactions");
const loadBudget = () => import("./Budget");
const loadAccounts = () => import("./Accounts");
const loadPlan = () => import("./Plan");
const Transactions = lazy(loadTransactions);
const Budget = lazy(loadBudget);
const Accounts = lazy(loadAccounts);
const Plan = lazy(loadPlan);
const ImportWizard = lazy(() => import("../ImportWizard/ImportWizard"));
const RulesEditor = lazy(() => import("../Rules/RulesEditor"));

export interface MoneyHQProps {
  instanceId: Id;
  tab?: string;
}

export type MoneyTab = "overview" | "transactions" | "budget" | "accounts" | "plan";
export type PlanSection = "recurring" | "debt" | "forecast" | "goals";
/** Anything `go()` accepts: a tab, a Plan section, or the old Net worth tab (now inside Accounts). */
export type MoneyDest = MoneyTab | PlanSection | "networth";

const TABS: MoneyTab[] = ["overview", "transactions", "budget", "accounts", "plan"];
export const PLAN_SECTIONS: PlanSection[] = ["recurring", "debt", "forecast", "goals"];

/** Where a route's `tab` lands: old tabs map to their new homes. Unknown tabs land on Overview. */
export function resolveMoneyTab(tab: string | undefined): { tab: MoneyTab; section: PlanSection; redirect?: MoneyTab } {
  if (tab === "networth") return { tab: "accounts", section: "recurring", redirect: "accounts" };
  if (PLAN_SECTIONS.includes(tab as PlanSection)) return { tab: "plan", section: tab as PlanSection };
  if (tab === "plan") return { tab: "plan", section: "recurring" };
  return { tab: TABS.includes(tab as MoneyTab) ? (tab as MoneyTab) : "overview", section: "recurring" };
}

interface MoneyCtx {
  instanceId: Id;
  month: string;
  setMonth: (m: string) => void;
  overview: FinanceOverview | undefined;
  overviewLoading: boolean;
  reloadOverview: () => void;
  go: (tab: MoneyDest, opts?: { filter?: string }) => void;
  openImport: () => void;
  openRules: () => void;
  /** One-shot filter handed to the Transactions tab (e.g. 'uncategorized', 'review'). */
  txnFilter: string | null;
  clearTxnFilter: () => void;
  /** The Plan tab's open section. */
  planSection: PlanSection;
}

const Ctx = createContext<MoneyCtx | null>(null);
export function useMoney(): MoneyCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("Money HQ context missing");
  return c;
}

export default function MoneyHQ({ instanceId, tab }: MoneyHQProps) {
  const resolved = resolveMoneyTab(tab);
  const current = resolved.tab;
  const [month, setMonth] = useState(() => todayIso().slice(0, 7));
  const [importOpen, setImportOpen] = useState<{ file?: FinanceImportFile } | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [txnFilter, setTxnFilter] = useState<string | null>(null);
  const ledger = useLedger(instanceId);
  const overview = useAsync(() => api.finance.overview({ instanceId, month }), [instanceId, month]);
  useDbChanged([ledger.schemas.txns?.database.id, ledger.schemas.recurring?.database.id, ledger.schemas.goals?.database.id, ledger.schemas.accounts?.database.id], overview.reload, 260);

  // Old routes: the Net worth tab now lives in Accounts.
  useEffect(() => {
    if (resolved.redirect) navigate({ t: "app", instanceId, tab: resolved.redirect }, { replace: true });
  }, [resolved.redirect, instanceId]);
  // Tab panels are code-split; fetch them with the hub so switching tabs never shows a placeholder.
  useEffect(() => {
    void Promise.all([loadTransactions(), loadBudget(), loadAccounts(), loadPlan()]).catch(() => undefined);
  }, []);
  // A finance import requested from elsewhere (shell Import, ⌘K, first run) opens the wizard here.
  const pendingImport = useFinanceImportRequest((s) => (s.pending?.instanceId === instanceId ? s.pending : null));
  useEffect(() => {
    if (!pendingImport) return;
    const req = useFinanceImportRequest.getState().take(instanceId);
    if (req) setImportOpen({ file: req.file });
  }, [pendingImport, instanceId]);

  const go = useCallback(
    (t: MoneyDest, opts?: { filter?: string }) => {
      if (opts?.filter) setTxnFilter(opts.filter);
      const dest = t === "networth" ? "accounts" : t;
      navigate({ t: "app", instanceId, tab: dest === "overview" ? undefined : dest });
    },
    [instanceId],
  );
  const ctx = useMemo<MoneyCtx>(
    () => ({
      instanceId,
      month,
      setMonth,
      overview: overview.data,
      overviewLoading: overview.loading && !overview.data,
      reloadOverview: overview.reload,
      go,
      openImport: () => setImportOpen({}),
      openRules: () => setRulesOpen(true),
      txnFilter,
      clearTxnFilter: () => setTxnFilter(null),
      planSection: resolved.section,
    }),
    [instanceId, month, overview.data, overview.loading, overview.reload, go, txnFilter, resolved.section],
  );

  // `review.count` when the Reviewed property exists, else `uncat.count` (definitions.ts). Unknown until loaded.
  const loaded = !ledger.loading;
  const toReview = ledger.hasReviewed ? ledger.txns.filter((t) => t.reviewed === false).length : null;
  const uncategorized = overview.data?.uncategorized ?? null;
  const tabCount = toReview ?? uncategorized ?? 0;
  const tabs: TabItem<MoneyTab>[] = [
    { value: "overview", label: "Overview" },
    { value: "transactions", label: "Transactions", count: loaded && tabCount ? tabCount : undefined },
    { value: "budget", label: "Budget" },
    { value: "accounts", label: "Accounts" },
    { value: "plan", label: "Plan" },
  ];
  const isThisMonth = month === todayIso().slice(0, 7);
  const monthSwitcher = (
    <div className="inline-flex items-center gap-0.5 rounded-lg" style={{ background: "var(--bg-surface-2)", padding: 2 }}>
      <IconButton icon={ChevronLeft} size="xs" label="Previous month" onClick={() => setMonth((m) => addMonths(m, -1))} />
      <button type="button" className="h-6 px-2 rounded-md text-body-sm font-medium tabular text-primary" style={{ minWidth: 76 }} onClick={() => setMonth(todayIso().slice(0, 7))} title="Back to this month">
        {monthLabel(month)}
      </button>
      <IconButton icon={ChevronRight} size="xs" label="Next month" disabled={isThisMonth} onClick={() => setMonth((m) => addMonths(m, 1))} />
    </div>
  );
  // Facts only, and only once known: zero parts are omitted (never "All caught up" before the data arrives).
  const status = [toReview ? `${toReview} to review` : null, uncategorized ? `${uncategorized} uncategorised` : null].filter(Boolean).join(" · ");

  if (ledger.error && !ledger.loading && !ledger.schemas.txns) {
    return (
      <HubPage icon={Wallet} tone="jade" title="Money HQ">
        <Quiet title="Money HQ's databases are missing" body="Restore them from Trash, or run the setup again from Life apps." action={<Button variant="primary" onClick={() => navigate({ t: "lifeapps", appId: "money-hq" })}>Open life apps</Button>} />
      </HubPage>
    );
  }

  return (
    <Ctx.Provider value={ctx}>
      <LedgerContext.Provider value={ledger}>
        <HubPage
          icon={Wallet}
          tone="jade"
          title="Money HQ"
          subtitle={
            <>
              {monthSwitcher}
              {status ? <span className="text-tertiary">{status}</span> : null}
            </>
          }
          actions={
            <>
              <Button variant="ghost" size="sm" icon={ListFilter} onClick={() => setRulesOpen(true)}>
                Rules
              </Button>
              <Button variant="secondary" size="sm" icon={FileUp} onClick={() => setImportOpen({})}>
                Import
              </Button>
            </>
          }
          tabs={tabs}
          tab={current}
          onTab={(t) => go(t)}
          footer={<Disclaimer />}
        >
          {/* Panels are preloaded above; a null fallback never paints placeholder content over real data. */}
          <Suspense fallback={null}>
            {current === "overview" ? <Overview /> : null}
            {current === "transactions" ? <Transactions /> : null}
            {current === "budget" ? <Budget /> : null}
            {current === "accounts" ? <Accounts /> : null}
            {current === "plan" ? <Plan /> : null}
          </Suspense>
        </HubPage>
        <Suspense fallback={null}>
          {importOpen ? <ImportWizard instanceId={instanceId} open onOpenChange={(o) => !o && setImportOpen(null)} initialFile={importOpen.file} /> : null}
          {rulesOpen ? <RulesEditor instanceId={instanceId} open={rulesOpen} onOpenChange={setRulesOpen} /> : null}
        </Suspense>
      </LedgerContext.Provider>
    </Ctx.Provider>
  );
}
