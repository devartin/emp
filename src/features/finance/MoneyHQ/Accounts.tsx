/**
 * Accounts (§16.2): balances computed from transactions, grouped by kind, with 90-day balance sparklines, credit
 * utilisation, APRs and reconciliation against a statement balance. Investment accounts are valued by Portfolio
 * when it is installed (§16.8). Net worth history lives at the foot of this tab (PROGRAMME-v3 K4).
 */
import { CheckCircle2, ExternalLink, Scale } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { api } from "@/backend";
import type { Id } from "@/backend/types";
import { Sparkline } from "@/charts/Sparkline";
import { navigate } from "@/app/router";
import { notify } from "@/stores/toasts";
import { useWorkspace } from "@/stores/workspace";
import { Amount } from "@/ui/Amount";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { Dialog } from "@/ui/Dialog";
import { MoneyField } from "@/ui/MoneyField";
import { Sensitive } from "@/ui/Sensitive";
import { Skeleton } from "@/ui/Skeleton";
import { Tooltip } from "@/ui/Tooltip";
import { daysBetween, dayLabel, fmtMoney, fmtPct, num, toMoney, todayIso, fmtWhole } from "../shared/format";
import { V } from "../shared/hooks";
import { Figure } from "../shared/Figure";
import { baseCurrency } from "../shared/currency";
import { useStatements } from "../shared/statements";
import { Input } from "@/ui/Input";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { ACCOUNT_GLYPH, Glyph, Section } from "../shared/ui";
import { ACCOUNT_TYPE_LABEL, DEBT_TYPES, useLedgerCtx, type Account } from "./ledger";
import { useMoney } from "./MoneyHQ";

const NetWorth = lazy(() => import("./NetWorth"));

const GROUPS: { key: string; title: string; types: string[] }[] = [
  { key: "cash", title: "Cash", types: ["checking", "savings", "cash"] },
  { key: "credit", title: "Credit cards", types: ["credit_card"] },
  { key: "loans", title: "Loans", types: ["student_loan", "auto_loan", "mortgage", "personal_loan", "other_liability"] },
  { key: "invest", title: "Investments & other assets", types: ["investment", "other_asset"] },
];

export default function Accounts() {
  const l = useLedgerCtx();
  const { reloadOverview, overview } = useMoney();
  const pfInstance = useWorkspace((s) => s.lifeapps.find((i) => i.appId === "portfolio")?.id);
  const [reconciling, setReconciling] = useState<Account | null>(null);
  const history = useMemo(() => {
    // 90-day daily balances per account, walking back from today's balance.
    const today = todayIso();
    const out = new Map<Id, number[]>();
    for (const a of l.accounts) {
      const days: number[] = [];
      let bal = a.balance;
      const txs = l.txns.filter((t) => t.accountId === a.id);
      let k = 0;
      for (let d = 0; d < 90; d++) {
        const day = shift(today, -d);
        days.push(bal);
        while (k < txs.length && txs[k].date >= day) {
          bal -= txs[k].amount;
          k++;
        }
      }
      out.set(a.id, days.reverse());
    }
    return out;
  }, [l.accounts, l.txns]);
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
      <div className="flex flex-col gap-4">
        {GROUPS.map((g) => {
          const list = l.accounts.filter((a) => g.types.includes(a.type) && !a.closed);
          if (!list.length) return null;
          const total = list.reduce((s, a) => s + (valueOf(a) ?? 0), 0);
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
              <div className="min-w-0 flex-1 text-body font-medium">Portfolio</div>
              <Button size="xs" variant="ghost" iconRight={ExternalLink} onClick={() => pfInstance && navigate({ t: "app", instanceId: pfInstance })}>
                Valued by Portfolio
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
      {reconciling ? (
        <ReconcileDialog
          account={reconciling}
          onClose={() => setReconciling(null)}
          onDone={() => {
            setReconciling(null);
            l.reload();
            reloadOverview();
          }}
        />
      ) : null}
    </div>
  );
}

function shift(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function SummaryTile({ id, label, value, currency, emphasis, inputs, note }: { id: "assets" | "debts" | "networth"; label: string; value: number | null; currency: string; emphasis?: boolean; inputs?: { label: string; value: string }[]; note?: string }) {
  return (
    <div className="fh-card" style={{ padding: "14px 18px" }}>
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
      <div className="fh-acct-spark">{!viaPortfolio && spark.length > 1 ? <Sparkline data={spark} height={28} color={debt ? "accent" : "trend"} aria-label={`${a.name} balance, last 90 days`} /> : null}</div>
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
            Valued by Portfolio
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

/**
 * Cleared balance of an account as of a statement date: the opening balance plus every cleared or reconciled row
 * dated on or before it (the ledger's `account.cleared` definition, cut at the statement date instead of today).
 */
export function clearedAsOf(account: Pick<Account, "id" | "opening">, txns: readonly { accountId: Id | null; date: string; amount: number; cleared: string }[], asOf: string): number {
  let total = account.opening;
  for (const t of txns) if (t.accountId === account.id && t.cleared !== "uncleared" && t.date <= asOf) total += t.amount;
  return total;
}

/**
 * Honest reconcile (PROGRAMME-v3 K5b): the statement balance is the user's to enter — never pre-filled with Ultra
 * Note's own figure. When the last import of this account reported a closing balance (`FinanceImportPreview.
 * statement`), it is offered pre-filled with its source and date. The difference is statement − cleared as of the
 * statement date; finishing locks the cleared rows as reconciled. Success is the quiet C3 moment: a check that draws
 * in (≤ 600 ms; a crossfade under reduced motion), then the dialog closes.
 */
function ReconcileDialog({ account, onClose, onDone }: { account: Account; onClose: () => void; onDone: () => void }) {
  const l = useLedgerCtx();
  const remembered = useStatements((st) => st.byAccount[account.id]);
  // Only a statement newer than the last reconcile is worth offering.
  const offer = remembered && (!account.reconciled || (remembered.asOf ?? remembered.importedOn) > account.reconciled) ? remembered : undefined;
  const currency = account.currency || baseCurrency();
  const [statement, setStatement] = useState<string | null>(offer ? offer.balance : null);
  const [asOf, setAsOf] = useState<string>(offer?.asOf ?? todayIso());
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const reduced = useReducedMotionPref();
  const fromFile = !!offer && statement === offer.balance;
  const cleared = clearedAsOf(account, l.txns, asOf);
  const entered = statement !== null && statement !== "";
  const diff = entered ? num(statement) - cleared : 0;
  const ok = entered && Math.abs(diff) < 0.005;
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(onDone, reduced ? 320 : 600);
    return () => window.clearTimeout(t);
  }, [done, reduced, onDone]);
  const finish = async () => {
    const A = l.schemas.accounts;
    const X = l.schemas.txns;
    if (!A || !X) return;
    setBusy(true);
    try {
      const rows = l.txns.filter((t) => t.accountId === account.id && t.cleared === "cleared" && t.date <= asOf);
      if (rows.length) await api.db.rowsUpdate({ updates: rows.map((t) => ({ id: t.id, values: { [X.database.roles["txn.cleared"]]: V.status("reconciled") } })) });
      const recRole = A.database.roles["acct.reconciled"];
      if (recRole) await api.db.rowsUpdate({ updates: [{ id: account.id, values: { [recRole]: V.date(asOf) } }] });
      notify.success(`${account.name} reconciled`, { description: `${rows.length} cleared ${rows.length === 1 ? "transaction" : "transactions"} locked to ${dayLabel(asOf, true)}.` });
      setDone(true);
    } catch (e) {
      notify.fromError(e, "Couldn't reconcile");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Reconcile ${account.name}`}
      description={`Enter the closing balance from your statement${account.reconciled ? `. Last reconciled ${dayLabel(account.reconciled, true)}` : ""}.`}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={done}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ok || done} loading={busy} onClick={finish}>
            Finish reconciling
          </Button>
        </>
      }
    >
      {done ? (
        <div className="fh-recon-done" data-reduced={reduced ? "" : undefined} role="status">
          <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden>
            <circle cx="22" cy="22" r="20" fill="none" strokeWidth="2" className="fh-recon-ring" />
            <path d="M14 22.5l5.5 5.5L30 17" fill="none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="fh-recon-tick" pathLength={1} />
          </svg>
          <div className="text-body-sm font-medium">Reconciled to {dayLabel(asOf, true)}</div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
            <MoneyField label="Statement balance" value={statement} onChange={setStatement} currency={currency} autoFocus placeholder="From your statement" />
            <Input label="Statement date" type="date" value={asOf} max={todayIso()} onChange={(e) => setAsOf(e.target.value || todayIso())} className="w-[150px]" />
          </div>
          {offer ? (
            <p className="text-caption text-tertiary -mt-2">
              {fromFile ? "From" : "Your last import,"} {offer.fileName ?? "the last import"} ({offer.source === "ofx" ? "OFX closing balance" : "CSV balance column"}
              {offer.asOf ? `, as of ${dayLabel(offer.asOf, true)}` : ""}, imported {dayLabel(offer.importedOn, true)}){fromFile ? "" : `, reported ${fmtMoney(offer.balance, offer.currency ?? currency)}`}.
            </p>
          ) : null}
          <div className="fh-recon" data-ok={ok ? "" : undefined} data-empty={entered ? undefined : ""}>
            {ok ? <CheckCircle2 size={18} /> : <Scale size={18} />}
            <div className="flex-1">
              <div className="text-body-sm font-medium tabular">
                {!entered ? "Enter the statement balance" : ok ? "Matches the cleared balance" : <>Off by <Sensitive>{fmtMoney(Math.abs(diff), currency)}</Sensitive></>}
              </div>
              <div className="text-caption text-tertiary tabular" style={{ fontWeight: 400 }}>
                Cleared in Ultra Note on {dayLabel(asOf, true)}: <Sensitive>{fmtMoney(cleared, currency)}</Sensitive>
                {entered && !ok ? ` · statement ${diff > 0 ? "is higher" : "is lower"}: look for a missing, uncleared or duplicate transaction` : ""}
              </div>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}
