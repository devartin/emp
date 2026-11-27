/**
 * Add a trade (`portfolio_trade`): a buy, sell or dividend in an investment account. A new ticker becomes a security
 * (with its asset class); the first trade without an account opens a "Brokerage" account. Lots, holdings and the
 * summary are rebuilt by the backend from the transaction.
 */
import { useMemo, useState } from "react";
import { api } from "@/backend";
import type { Id, PortfolioTradeType } from "@/backend/types";
import { notify } from "@/stores/toasts";
import { Button } from "@/ui/Button";
import { Dialog } from "@/ui/Dialog";
import { Input } from "@/ui/Input";
import { MoneyField } from "@/ui/MoneyField";
import { Segmented } from "@/ui/Segmented";
import { Select } from "@/ui/Select";
import { fmtMoney, num, todayIso } from "../finance/shared/format";
import { ticker } from "../markets/data";
import { ASSET_CLASS_OPTIONS, type PortfolioBook } from "./data";

type Kind = Extract<PortfolioTradeType, "buy" | "sell" | "dividend">;

export default function TradeDialog({ instanceId, book, onClose, onDone, initialSymbol }: { instanceId: Id; book: PortfolioBook; onClose: () => void; onDone: () => void; initialSymbol?: string }) {
  const [kind, setKind] = useState<Kind>("buy");
  const [symbol, setSymbol] = useState(initialSymbol ? ticker(initialSymbol) : "");
  const [name, setName] = useState("");
  const [assetClass, setAssetClass] = useState("us_equity");
  const [accountId, setAccountId] = useState<Id | null>(book.accountList[0]?.id ?? null);
  const [date, setDate] = useState(todayIso());
  const [qty, setQty] = useState("");
  const [price, setPrice] = useState<string | null>(null);
  const [fees, setFees] = useState<string | null>(null);
  const [amount, setAmount] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sym = symbol.trim().toUpperCase();
  const known = useMemo(() => [...book.secByKey.entries()].find(([k]) => ticker(k).toUpperCase() === sym || k.toUpperCase() === sym), [book.secByKey, sym]);
  const isTrade = kind !== "dividend";
  const qtyN = Number(qty);
  const total = isTrade && qtyN > 0 && price ? qtyN * num(price) + (kind === "buy" ? 1 : -1) * num(fees ?? "0") : null;
  const valid = !!sym && /^\d{4}-\d{2}-\d{2}$/.test(date) && (isTrade ? qtyN > 0 && price !== null && num(price) >= 0 : num(amount ?? "0") > 0) && (kind !== "sell" || !!known);
  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.portfolio.trade({
        instanceId,
        date,
        type: kind,
        symbol: sym,
        ...(known ? {} : { name: name.trim() || undefined, assetClass }),
        ...(accountId ? { accountId } : {}),
        ...(isTrade ? { qty: String(qtyN), price: price ?? "0", ...(fees && num(fees) > 0 ? { fees } : {}) } : { amount: amount ?? "0" }),
      });
      notify.success(kind === "buy" ? `Bought ${qty} ${sym}` : kind === "sell" ? `Sold ${qty} ${sym}` : `${sym} dividend recorded`);
      onDone();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't record the trade");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add a trade"
      description="Record a buy, a sale or a dividend. Holdings, lots and returns update from it."
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid} loading={busy} onClick={save} kbd="↵">
            {kind === "buy" ? "Add buy" : kind === "sell" ? "Add sale" : "Add dividend"}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Segmented block value={kind} onValueChange={(v) => setKind(v as Kind)} options={[{ value: "buy", label: "Buy" }, { value: "sell", label: "Sell" }, { value: "dividend", label: "Dividend" }]} aria-label="Kind" />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Ticker" value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="e.g. VTI" autoFocus aria-label="Ticker" />
          <Input label="Date" type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} />
        </div>
        {sym && !known ? (
          kind === "sell" ? (
            <p className="text-caption text-warning-text">You don't hold {sym} yet.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" />
              <Select label="Asset class" value={assetClass} onValueChange={setAssetClass} options={ASSET_CLASS_OPTIONS} />
            </div>
          )
        ) : null}
        {book.accountList.length ? (
          <Select label="Account" value={accountId} onValueChange={setAccountId} options={book.accountList.map((a) => ({ value: a.id, label: a.name }))} />
        ) : (
          <p className="text-caption text-tertiary">This goes into a new taxable account called Brokerage. You can rename it in the Investment accounts database.</p>
        )}
        {isTrade ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Input label="Shares" type="number" inputMode="decimal" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} aria-label="Shares" />
              <MoneyField label="Price per share" value={price} onChange={setPrice} />
            </div>
            <MoneyField label="Fees" value={fees} onChange={setFees} placeholder="Optional" />
            {total !== null ? <p className="text-body-sm text-secondary tabular">{kind === "buy" ? "Total cost" : "Proceeds after fees"} {fmtMoney(total)}</p> : null}
          </>
        ) : (
          <MoneyField label="Amount paid" value={amount} onChange={setAmount} />
        )}
        {error ? <p className="text-caption text-loss-text">{error}</p> : null}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
