/**
 * Money HQ (§16.2): the personal-finance hub. Tabs: Overview · Transactions · Budget · Accounts · Recurring · Debt ·
 * Forecast · Goals · Net worth. The import wizard and rules editor open as sheets from the header.
 */
import { ChevronLeft, ChevronRight, FileUp, ListFilter, Wallet } from "lucide-react";
import { createContext, lazy, Suspense, useCallback, useContext, useMemo, useState } from "react";
import { api } from "@/backend";
import type { FinanceOverview, Id } from "@/backend/types";
import { navigate } from "@/app/router";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { Skeleton } from "@/ui/Skeleton";
import type { TabItem } from "@/ui/Tabs";
import { addMonths, monthLabel, todayIso } from "../shared/format";
import { useAsync, useDbChanged } from "../shared/hooks";
import { Disclaimer, HubPage, Quiet } from "../shared/ui";
import { LedgerContext, useLedger } from "./ledger";
import { Overview } from "./Overview";

const Transactions = lazy(() => import("./Transactions"));
const Budget = lazy(() => import("./Budget"));
const Accounts = lazy(() => import("./Accounts"));
const Recurring = lazy(() => import("./Recurring"));
const DebtPlanner = lazy(() => import("../DebtPlanner"));
const Forecast = lazy(() => import("../Forecast"));
const Goals = lazy(() => import("./Goals"));
const NetWorth = lazy(() => import("./NetWorth"));
const ImportWizard = lazy(() => import("../ImportWizard/ImportWizard"));
const RulesEditor = lazy(() => import("../Rules/RulesEditor"));

export interface MoneyHQProps {
  instanceId: Id;
  tab?: string;
}

export type MoneyTab = "overview" | "transactions" | "budget" | "accounts" | "recurring" | "debt" | "forecast" | "goals" | "networth";

const TABS: MoneyTab[] = ["overview", "transactions", "budget", "accounts", "recurring", "debt", "forecast", "goals", "networth"];

interface MoneyCtx {
  instanceId: Id;
  month: string;
  setMonth: (m: string) => void;
  overview: FinanceOverview | undefined;
  overviewLoading: boolean;
  reloadOverview: () => void;
  go: (tab: MoneyTab, opts?: { filter?: string }) => void;
  openImport: () => void;
  openRules: () => void;
  /** One-shot filter handed to the Transactions tab (e.g. 'uncategorized'). */
  txnFilter: string | null;
  clearTxnFilter: () => void;
}

const Ctx = createContext<MoneyCtx | null>(null);
export function useMoney(): MoneyCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("Money HQ context missing");
  return c;
}

export default function MoneyHQ({ instanceId, tab }: MoneyHQProps) {
  const current = (TABS.includes(tab as MoneyTab) ? tab : "overview") as MoneyTab;
  const [month, setMonth] = useState(() => todayIso().slice(0, 7));
  const [importOpen, setImportOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [txnFilter, setTxnFilter] = useState<string | null>(null);
  const ledger = useLedger(instanceId);
  const overview = useAsync(() => api.finance.overview({ instanceId, month }), [instanceId, month]);
  useDbChanged([ledger.schemas.txns?.database.id, ledger.schemas.recurring?.database.id, ledger.schemas.goals?.database.id, ledger.schemas.accounts?.database.id], overview.reload, 260);

  const go = useCallback(
    (t: MoneyTab, opts?: { filter?: string }) => {
      if (opts?.filter) setTxnFilter(opts.filter);
      navigate({ t: "app", instanceId, tab: t === "overview" ? undefined : t });
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
      openImport: () => setImportOpen(true),
      openRules: () => setRulesOpen(true),
      txnFilter,
      clearTxnFilter: () => setTxnFilter(null),
    }),
    [instanceId, month, overview.data, overview.loading, overview.reload, go, txnFilter],
  );

  const uncategorized = overview.data?.uncategorized ?? 0;
  const tabs: TabItem<MoneyTab>[] = [
    { value: "overview", label: "Overview" },
    { value: "transactions", label: "Transactions", count: uncategorized || undefined },
    { value: "budget", label: "Budget" },
    { value: "accounts", label: "Accounts" },
    { value: "recurring", label: "Recurring" },
    { value: "debt", label: "Debt" },
    { value: "forecast", label: "Forecast" },
    { value: "goals", label: "Goals" },
    { value: "networth", label: "Net worth" },
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

  if (ledger.error && !ledger.loading && !ledger.schemas.txns) {
    return (
      <HubPage icon={Wallet} tone="jade" title="Money HQ">
        <Quiet title="Money HQ's databases are missing" body="Restore them from Trash, or run the setup again from Life apps." action={<Button variant="primary" onClick={() => navigate({ t: "lifeapps", appId: "money-hq" })}>Open Life apps</Button>} />
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
              <span className="text-tertiary">{uncategorized ? `${uncategorized} to categorise` : "All caught up"}</span>
            </>
          }
          actions={
            <>
              <Button variant="ghost" size="sm" icon={ListFilter} onClick={() => setRulesOpen(true)}>
                Rules
              </Button>
              <Button variant="secondary" size="sm" icon={FileUp} onClick={() => setImportOpen(true)}>
                Import
              </Button>
            </>
          }
          tabs={tabs}
          tab={current}
          onTab={(t) => go(t)}
          footer={<Disclaimer />}
        >
          <Suspense fallback={<TabSkeleton />}>
            {current === "overview" ? <Overview /> : null}
            {current === "transactions" ? <Transactions /> : null}
            {current === "budget" ? <Budget /> : null}
            {current === "accounts" ? <Accounts /> : null}
            {current === "recurring" ? <Recurring /> : null}
            {current === "debt" ? <DebtPlanner /> : null}
            {current === "forecast" ? <Forecast instanceId={instanceId} /> : null}
            {current === "goals" ? <Goals /> : null}
            {current === "networth" ? <NetWorth /> : null}
          </Suspense>
        </HubPage>
        <Suspense fallback={null}>
          {importOpen ? <ImportWizard instanceId={instanceId} open={importOpen} onOpenChange={setImportOpen} /> : null}
          {rulesOpen ? <RulesEditor instanceId={instanceId} open={rulesOpen} onOpenChange={setRulesOpen} /> : null}
        </Suspense>
      </LedgerContext.Provider>
    </Ctx.Provider>
  );
}

function TabSkeleton() {
  return (
    <div className="fh-grid" aria-busy>
      <Skeleton height={280} radius={14} className="fh-span-8" />
      <Skeleton height={280} radius={14} className="fh-span-4" />
      <Skeleton height={220} radius={14} className="fh-span-12" />
    </div>
  );
}
