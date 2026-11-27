/**
 * Accounts (§16.2): balances computed from transactions, grouped by kind, with 90-day balance sparklines, credit
 * utilisation, APRs and reconciliation against a statement balance. Investment accounts are valued by Portfolio
 * when it is installed (§16.8). Net worth history lives at the foot of this tab (PROGRAMME-v3 K4).
 */
import { appName } from "@/features/lifeapps/identity";
import { ExternalLink, Plus, Scale } from "lucide-react";
import { lazy, Suspense, useMemo, useState } from "react";
import type { Id } from "@/backend/types";
import { Sparkline } from "@/charts/Sparkline";
import { navigate } from "@/app/router";
import { useWorkspace } from "@/stores/workspace";
import { Amount } from "@/ui/Amount";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { Sensitive } from "@/ui/Sensitive";
import { Skeleton } from "@/ui/Skeleton";
import { Tooltip } from "@/ui/Tooltip";
import { daysBetween, fmtMoney, fmtPct, num, toMoney, todayIso, fmtWhole } from "../shared/format";
import { Figure } from "../shared/Figure";
import { baseCurrency } from "../shared/currency";
import { ACCOUNT_GLYPH, Glyph, Section } from "../shared/ui";
import { ACCOUNT_TYPE_LABEL, DEBT_TYPES, sumCents, useLedgerCtx, type Account } from "./ledger";
import { useMoney } from "./MoneyHQ";

const NetWorth = lazy(() => import("./NetWorth"));
const ReconcileDialog = lazy(() => import("./ReconcileDialog"));
const AddAccount = lazy(() => import("./AddAccount"));

const GROUPS: { key: string; title: string; types: string[] }[] = [
  { key: "cash", title: "Cash", types: ["checking", "savings", "cash"] },
  { key: "credit", title: "Credit cards", types: ["credit_card"] },
  { key: "loans", title: "Loans", types: ["student_loan", "auto_loan", "mortgage", "personal_loan", "other_liability"] },
  { key: "invest", title: "Investments & other assets", types: ["investment", "other_asset"] },
];

export default function Accounts() {
  const l = useLedgerCtx();
  const { reloadOverview, overview, instanceId } = useMoney();
  const pfInstance = useWorkspace((s) => s.lifeapps.find((i) => i.appId === "portfolio")?.id);
  const [reconciling, setReconciling] = useState<Account | null>(null);
  const [adding, setAdding] = useState(false);
  // 90-day daily balances per account, computed by the backend (`finance_ledger`).
  const history = useMemo(() => new Map<Id, number[]>(l.accounts.map((a) => [a.id, a.history])), [l.accounts]);
  // One source of truth: the tiles are the backend's net-worth figures (`finance_overview`), never re-derived here.
  // Investment accounts are replaced by Portfolio's market value when the backend counted it (`investments`), shown
  // once on the first open investment account — the same rule the backend applies (see FinanceOverview.netWorth).
  const pfValue = overview?.investments ? num(overview.investments.amount) : null;
  const firstInvestment = l.accounts.find((a) => a.type === "investment" && !a.closed)?.id;
  const valueOf = (a: Account): number | null => (a.type === "investment" && pfValue !== null ? (a.id === firstInvestment ? pfValue : null) : a.balance);
  const assets = overview ? num(overview.assets.amount) : null;
  const liabilities = overview ? num(overview.liabilities.amount) : null;
  const netWorth = overview ? num(overview.netWorth.amount) : null;
  // Foreign-currency accounts are not in net worth (no FX conversion yet): say so rather than drop them silently.
  const base = overview?.netWorth.currency ?? baseCurrency();
  const foreign = l.accounts.filter((a) => !a.closed && a.currency && a.currency !== base);
  const foreignNote = foreign.length ? `Not in net worth: ${foreign.map((a) => `${a.name} ${fmtMoney(a.balance, a.currency)}`).join(", ")}.` : undefined;
  const nwInputs = overview
    ? [
        { label: "Assets", value: fmtWhole(overview.assets.amount, { currency: overview.assets.currency }) },
        { label: "Debts", value: fmtWhole(overview.liabilities.amount, { currency: overview.liabilities.currency }) },
        ...(overview.investments ? [{ label: "of which Portfolio", value: fmtWhole(overview.investments.amount, { currency: overview.investments.currency }) }] : []),
      ]
    : undefined;
  return (
    <div className="flex flex-col gap-4">
      <div className="fh-kpis" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        <SummaryTile id="assets" label="Assets" value={assets} currency={base} />
        <SummaryTile id="debts" label="Debts" value={liabilities} currency={base} />
        <SummaryTile id="networth" label="Net worth" value={netWorth} currency={base} emphasis inputs={nwInputs} note={foreignNote} />
      </div>
      {foreignNote ? <p className="text-caption text-tertiary -mt-2">{foreignNote}</p> : null}
      <div className="flex items-center justify-end -mb-2">
        <Button size="sm" variant="secondary" icon={Plus} onClick={() => setAdding(true)}>
          Add account
        </Button>
      </div>
      <div className="flex flex-col gap-4">
        {GROUPS.map((g) => {
          const list = l.accounts.filter((a) => g.types.includes(a.type) && !a.closed);
          if (!list.length) return null;
          const total = sumCents(list.map((a) => valueOf(a) ?? 0));
          return (
            <Section key={g.key} title={g.title} actions={<span className="text-body-sm font-semibold tabular"><Sensitive>{fmtMoney(total)}</Sensitive></span>} pad={false}>
              <div className="pb-2">
                {list.map((a) => (
                  <AccountRow key={a.id} a={a} value={valueOf(a)} spark={history.get(a.id) ?? []} viaPortfolio={a.type === "investment" && pfValue !== null} pfInstance={pfInstance} onReconcile={() => setReconciling(a)} />
                ))}
              </div>
            </Section>
          );
        })}
        {pfValue !== null && !firstInvestment ? (
          // Portfolio counts in net worth even without an investment account in Money HQ: show where it went.
          <Section title="Investments" actions={<span className="text-body-sm font-semibold tabular"><Sensitive>{fmtMoney(pfValue)}</Sensitive></span>} pad={false}>
            <div className="fh-acct">
              <Glyph name={ACCOUNT_GLYPH.investment} color="blue" size={36} />
              <div className="min-w-0 flex-1 text-body font-medium">{appName("portfolio")}</div>
              <Button size="xs" variant="ghost" iconRight={ExternalLink} onClick={() => pfInstance && navigate({ t: "app", instanceId: pfInstance })}>
                Valued by {appName("portfolio")}
              </Button>
              <Amount value={toMoney(pfValue)} className="text-body font-semibold w-[130px]" align="end" />
            </div>
          </Section>
        ) : null}
      </div>
      <div id="networth">
        <Suspense fallback={null}>
          <NetWorth />
        </Suspense>
      </div>
      {adding ? (
        <Suspense fallback={null}>
          <AddAccount instanceId={instanceId} onClose={() => setAdding(false)} onCreated={() => { l.reload(); reloadOverview(); }} />
        </Suspense>
      ) : null}
      {reconciling ? (
        <Suspense fallback={null}>
          <ReconcileDialog
            account={reconciling}
            onClose={() => setReconciling(null)}
            onDone={() => {
              setReconciling(null);
              l.reload();
              reloadOverview();
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

function SummaryTile({ id, label, value, currency, emphasis, inputs, note }: { id: "assets" | "debts" | "networth"; label: string; value: number | null; currency: string; emphasis?: boolean; inputs?: { label: string; value: string }[]; note?: string }) {
  return (
    <div className="fh-card">
      <div className="text-caption text-secondary" style={{ fontWeight: 500 }}>
        {label}
      </div>
      <div className="tabular mt-1" style={{ fontSize: emphasis ? 24 : 20, lineHeight: "30px", fontWeight: emphasis ? 600 : 500, letterSpacing: "-0.018em" }}>
        {value === null ? (
          <Skeleton width={120} height={22} radius={6} />
        ) : (
          <Figure id={id} inputs={inputs} note={note}>
            <Sensitive>{fmtWhole(value, { currency })}</Sensitive>
          </Figure>
        )}
      </div>
    </div>
  );
}

function AccountRow({ a, value, spark, viaPortfolio, pfInstance, onReconcile }: { a: Account; value: number | null; spark: number[]; viaPortfolio: boolean; pfInstance?: Id; onReconcile: () => void }) {
  const debt = DEBT_TYPES.has(a.type);
  const util = a.type === "credit_card" && a.limit ? Math.max(0, -a.balance) / a.limit : null;
  const reconciledAgo = a.reconciled ? daysBetween(a.reconciled, todayIso()) : null;
  return (
    <div className="fh-acct">
      <Glyph name={ACCOUNT_GLYPH[a.type]} color={debt ? "orange" : a.type === "investment" ? "blue" : "green"} size={36} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-body font-medium">{a.name}</span>
          {a.onBudget ? <Badge tone="outline">On budget</Badge> : null}
        </div>
        <div className="text-caption text-tertiary truncate" style={{ fontWeight: 400 }}>
          {[a.institution, ACCOUNT_TYPE_LABEL[a.type], a.apr !== null ? `${a.apr.toFixed(2)}% APR` : null, debt && a.minPayment ? `min ${fmtWhole(a.minPayment)}/mo` : null].filter(Boolean).join(" · ")}
        </div>
      </div>
      <div className="fh-acct-spark">{!viaPortfolio && spark.length > 1 ? <Sparkline data={spark} height={28} color="ink" aria-label={`${a.name} balance, last 90 days`} /> : null}</div>
      <div className="fh-acct-mid">
        {util !== null ? (
          <Tooltip content={`${fmtPct(util, 0)} of ${fmtWhole(a.limit ?? 0)} limit`}>
            <div className="w-full" tabIndex={0}>
              <div className="flex justify-between text-caption mb-1">
                <span className="text-tertiary" style={{ fontWeight: 500 }}>
                  Utilisation
                </span>
                <span className="tabular" style={{ color: util > 0.3 ? "var(--warning-text)" : "var(--text-secondary)", fontWeight: 600 }}>
                  {fmtPct(util, 0)}
                </span>
              </div>
              <div className="fh-meter">
                <i style={{ transform: `scaleX(${Math.min(1, util)})`, background: util > 0.3 ? "var(--warning)" : "var(--accent-solid)" }} />
              </div>
            </div>
          </Tooltip>
        ) : viaPortfolio ? (
          <Button size="xs" variant="ghost" iconRight={ExternalLink} onClick={() => pfInstance && navigate({ t: "app", instanceId: pfInstance })}>
            Valued by {appName("portfolio")}
          </Button>
        ) : a.onBudget ? (
          <span className="text-caption text-tertiary" style={{ fontWeight: 400 }}>
            {reconciledAgo === null ? "Never reconciled" : reconciledAgo === 0 ? "Reconciled today" : `Reconciled ${reconciledAgo} days ago`}
          </span>
        ) : null}
      </div>
      <div className="flex flex-col items-end w-[130px] flex-none">
        {value === null ? (
          <span className="text-caption text-tertiary" style={{ fontWeight: 400 }}>
            In the Portfolio value
          </span>
        ) : (
          <Amount value={toMoney(value)} className="text-body font-semibold" align="end" />
        )}
        {!viaPortfolio && Math.abs(a.cleared - a.balance) > 0.004 ? (
          <span className="text-caption text-tertiary tabular" style={{ fontWeight: 400 }}>
            <Sensitive>{fmtMoney(a.cleared)}</Sensitive> cleared
          </span>
        ) : null}
      </div>
      <div className="w-[96px] flex justify-end flex-none">
        {a.onBudget ? (
          <Button size="xs" variant="secondary" icon={Scale} onClick={onReconcile}>
            Reconcile
          </Button>
        ) : null}
      </div>
    </div>
  );
}
