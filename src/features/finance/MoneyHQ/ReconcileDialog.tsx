/**
 * The reconcile dialog for one account (Accounts tab), loaded on demand.
 */
import { CheckCircle2, Scale } from "lucide-react";
import { m } from "motion/react";
import { useEffect, useState } from "react";
import { api } from "@/backend";
import { notify } from "@/stores/toasts";
import { Button } from "@/ui/Button";
import { Dialog } from "@/ui/Dialog";
import { Input } from "@/ui/Input";
import { MoneyField } from "@/ui/MoneyField";
import { motionSeconds } from "@/ui/motion/register";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { Sensitive } from "@/ui/Sensitive";
import { baseCurrency } from "../shared/currency";
import { dayLabel, fmtMoney, num, todayIso } from "../shared/format";
import { V } from "../shared/hooks";
import { loadStatement, useRememberedStatement } from "../shared/statements";
import { DEBT_TYPES, useLedgerCtx, type Account } from "./ledger";
import { clearedAsOf, reconcileCompare, statementFieldFromFile } from "./reconcile";

/**
 * Honest reconcile (PROGRAMME-v3 K5b): the statement balance is the user's to enter — never pre-filled with Ultra
 * Note's own figure. When the last import of this account reported a closing balance (`FinanceImportPreview.
 * statement`), it is offered pre-filled with its source and date. The difference is statement − cleared as of the
 * statement date; finishing locks the cleared rows as reconciled. Cards and loans are entered as the statement prints
 * them, an amount owed (see reconcile.ts for the sign rule). Success is the quiet C3 moment: a check that draws in
 * (≤ 600 ms; a crossfade under reduced motion), then the dialog closes.
 */
export default function ReconcileDialog({ account, onClose, onDone }: { account: Account; onClose: () => void; onDone: () => void }) {
  const l = useLedgerCtx();
  const isDebt = DEBT_TYPES.has(account.type);
  const remembered = useRememberedStatement(account.id);
  useEffect(() => void loadStatement(account.id), [account.id]);
  // Only a statement newer than the last reconcile is worth offering.
  const offer = remembered && (!account.reconciled || (remembered.asOf ?? remembered.importedOn) > account.reconciled) ? remembered : undefined;
  const offered = offer ? statementFieldFromFile(isDebt, offer.balance) : null;
  const currency = account.currency || baseCurrency();
  const [statement, setStatement] = useState<string | null>(offered);
  const [asOf, setAsOf] = useState<string>(offer?.asOf ?? todayIso());
  const [touched, setTouched] = useState(false);
  // The remembered statement loads from the vault: pre-fill once it arrives, unless the user has started typing.
  useEffect(() => {
    if (touched || !offer || offered === null) return;
    setStatement(offered);
    if (offer.asOf) setAsOf(offer.asOf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offered, offer?.asOf]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const reduced = useReducedMotionPref();
  const fromFile = offered !== null && statement === offered;
  const cmp = reconcileCompare(isDebt, statement, clearedAsOf(account, l.txns, asOf));
  useEffect(() => {
    if (!done) return;
    // The C3 moment plays out, then holds for a beat before the dialog closes.
    const t = window.setTimeout(onDone, Math.round(motionSeconds("reconcileSuccess", reduced) * 1000) + 400);
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
  const last = account.reconciled ? `. Last reconciled ${dayLabel(account.reconciled, true)}` : "";
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Reconcile ${account.name}`}
      description={isDebt ? `Enter the amount owed as your statement prints it${last}.` : `Enter the closing balance from your statement${last}.`}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={done}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!cmp.ok || done} loading={busy} onClick={finish}>
            Finish reconciling
          </Button>
        </>
      }
    >
      {done ? (
        <ReconcileSuccess reduced={reduced} label={`Reconciled to ${dayLabel(asOf, true)}`} />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
            <MoneyField
              label={isDebt ? "Amount owed on statement" : "Statement balance"}
              value={statement}
              onChange={(v) => {
                setTouched(true);
                setStatement(v);
              }}
              currency={currency}
              autoFocus
              placeholder="From your statement"
            />
            <Input label="Statement date" type="date" value={asOf} max={todayIso()} onChange={(e) => setAsOf(e.target.value || todayIso())} className="w-[150px]" />
          </div>
          {offer && offered !== null ? (
            <p className="text-caption text-tertiary -mt-2">
              {fromFile ? "From" : "Your last import,"} {offer.fileName ?? "the last import"} ({offer.source === "ofx" ? "OFX closing balance" : "CSV balance column"}
              {offer.asOf ? `, as of ${dayLabel(offer.asOf, true)}` : ""}, imported {dayLabel(offer.importedOn, true)}){fromFile ? "" : `, reported ${fmtMoney(num(offered), offer.currency ?? currency)}${isDebt ? " owed" : ""}`}.
            </p>
          ) : null}
          <div className="fh-recon" data-ok={cmp.ok ? "" : undefined} data-empty={cmp.entered ? undefined : ""}>
            {cmp.ok ? <CheckCircle2 size={18} /> : <Scale size={18} />}
            <div className="flex-1">
              <div className="text-body-sm font-medium tabular">
                {!cmp.entered ? (isDebt ? "Enter the amount owed" : "Enter the statement balance") : cmp.ok ? (isDebt ? "Matches the cleared amount owed" : "Matches the cleared balance") : <>Off by <Sensitive>{fmtMoney(Math.abs(cmp.diff), currency)}</Sensitive></>}
              </div>
              <div className="text-caption text-tertiary tabular font-normal">
                {isDebt ? "Owed (cleared) in Ultra Note" : "Cleared in Ultra Note"} on {dayLabel(asOf, true)}: <Sensitive>{fmtMoney(cmp.clearedShown, currency)}</Sensitive>
                {cmp.hint ? ` · ${cmp.hint}` : ""}
              </div>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/**
 * Reconcile success: the C3 signature moment from the motion register (`reconcileSuccess`, ≤ 600 ms). The ring fades
 * in over the first 40%, then the tick draws; under reduced motion the whole mark crossfades in (150 ms), nothing
 * travels or draws.
 */
function ReconcileSuccess({ reduced, label }: { reduced: boolean; label: string }) {
  const t = motionSeconds("reconcileSuccess", reduced);
  const ease = [0.2, 0, 0, 1] as const;
  return (
    <m.div className="fh-recon-done" role="status" initial={{ opacity: reduced ? 0 : 1 }} animate={{ opacity: 1 }} transition={{ duration: reduced ? t : 0 }}>
      <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden>
        <m.circle cx="22" cy="22" r="20" fill="none" strokeWidth="2" className="fh-recon-ring" initial={{ opacity: reduced ? 0.28 : 0 }} animate={{ opacity: 0.28 }} transition={{ duration: reduced ? 0 : t * 0.4, ease }} />
        <m.path d="M14 22.5l5.5 5.5L30 17" fill="none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="fh-recon-tick" initial={{ pathLength: reduced ? 1 : 0 }} animate={{ pathLength: 1 }} transition={{ duration: reduced ? 0 : t * 0.6, delay: reduced ? 0 : t * 0.4, ease }} />
      </svg>
      <div className="text-body-sm font-medium">{label}</div>
    </m.div>
  );
}
