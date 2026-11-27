/**
 * Add an account (`finance_account_create`): name, kind and opening balance, plus APR, credit limit and minimum
 * payment for cards and loans. Used from the Accounts tab and from the import wizard's "Import into".
 */
import { useState } from "react";
import { api } from "@/backend";
import type { Id } from "@/backend/types";
import { notify } from "@/stores/toasts";
import { Button } from "@/ui/Button";
import { Dialog } from "@/ui/Dialog";
import { Input } from "@/ui/Input";
import { MoneyField } from "@/ui/MoneyField";
import { Select } from "@/ui/Select";
import { num } from "../shared/format";
import { ACCOUNT_TYPE_LABEL, DEBT_TYPES } from "./ledger";

const TYPES = Object.entries(ACCOUNT_TYPE_LABEL).map(([value, label]) => ({ value, label }));

export default function AddAccount({ instanceId, onClose, onCreated, initialType = "checking", initialName = "" }: { instanceId: Id; onClose: () => void; onCreated?: (id: Id) => void; initialType?: string; initialName?: string }) {
  const [name, setName] = useState(initialName);
  const [type, setType] = useState(initialType);
  const [opening, setOpening] = useState<string | null>(null);
  const [apr, setApr] = useState("");
  const [limit, setLimit] = useState<string | null>(null);
  const [minPayment, setMinPayment] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const debt = DEBT_TYPES.has(type);
  const valid = !!name.trim() && (apr.trim() === "" || Number.isFinite(Number(apr)));
  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const res = await api.finance.accountCreate({
        instanceId,
        name: name.trim(),
        type,
        ...(opening !== null && num(opening) !== 0 ? { opening } : {}),
        ...(debt && apr.trim() !== "" ? { apr: Number(apr) } : {}),
        ...(type === "credit_card" && limit !== null ? { limit } : {}),
        ...(debt && minPayment !== null ? { minPayment } : {}),
      });
      notify.success(`${name.trim()} added`);
      onCreated?.(res.id);
      onClose();
    } catch (e) {
      notify.fromError(e, "Couldn't add the account");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add an account"
      description={debt ? "Enter what you owe today as the opening balance." : "Enter today's balance, or leave it empty and import a statement."}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid} loading={busy} onClick={save} kbd="↵">
            Add account
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
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Everyday checking" autoFocus />
        <Select label="Kind" value={type} onValueChange={setType} options={TYPES} />
        <MoneyField label={debt ? "Amount owed" : "Opening balance"} value={opening} onChange={setOpening} placeholder="Optional" />
        {debt ? (
          <div className="grid grid-cols-2 gap-3">
            <Input label="APR %" type="number" inputMode="decimal" step="any" value={apr} onChange={(e) => setApr(e.target.value)} placeholder="Optional" />
            <MoneyField label="Minimum payment" value={minPayment} onChange={setMinPayment} placeholder="Optional" />
          </div>
        ) : null}
        {type === "credit_card" ? <MoneyField label="Credit limit" value={limit} onChange={setLimit} placeholder="Optional" /> : null}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
