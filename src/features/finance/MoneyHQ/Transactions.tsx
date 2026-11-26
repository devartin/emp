/**
 * Transactions (§16.2): virtualised ledger (overscan 8, §4.4), search + filters, inline categorisation with the
 * "Always categorise {payee} as {category}?" suggestion after the second identical change (§15.2), splits,
 * multi-select bulk actions and quick add.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowLeftRight, Check, ChevronDown, CornerDownRight, MoreHorizontal, Plus, Search, Split, Trash2, Wand2, X } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, runJob } from "@/backend";
import type { Id } from "@/backend/types";
import { cn } from "@/lib/cn";
import { notify } from "@/stores/toasts";
import { Amount } from "@/ui/Amount";
import { Button } from "@/ui/Button";
import { Checkbox } from "@/ui/Checkbox";
import { Dialog } from "@/ui/Dialog";
import { IconButton } from "@/ui/IconButton";
import { Input } from "@/ui/Input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/ui/Menu";
import { MoneyField } from "@/ui/MoneyField";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/Popover";
import { Segmented } from "@/ui/Segmented";
import { Select } from "@/ui/Select";
import { Skeleton } from "@/ui/Skeleton";
import { Tooltip } from "@/ui/Tooltip";
import { dayLabel, fmtMoney, num, toMoney, todayIso, weekdayLabel } from "../shared/format";
import { Glyph, Quiet } from "../shared/ui";
import { useLedgerCtx, type Category, type Txn } from "./ledger";
import { useMoney } from "./MoneyHQ";

type Filter = "all" | "uncategorized" | "transfers" | "income";

export default function Transactions() {
  const l = useLedgerCtx();
  const { instanceId, txnFilter, clearTxnFilter, reloadOverview } = useMoney();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>(() => (txnFilter === "uncategorized" ? "uncategorized" : "all"));
  const [account, setAccount] = useState<string>("all");
  const [selected, setSelected] = useState<Set<Id>>(new Set());
  const [splitting, setSplitting] = useState<Txn | null>(null);
  const [adding, setAdding] = useState(false);
  const [suggest, setSuggest] = useState<{ payee: string; categoryId: Id } | null>(null);
  const history = useRef(new Map<string, { categoryId: Id; n: number }>());
  useEffect(() => {
    if (txnFilter) clearTxnFilter();
  }, [txnFilter, clearTxnFilter]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return l.txns.filter((t) => {
      if (account !== "all" && t.accountId !== account) return false;
      if (filter === "uncategorized" && (t.categoryId || t.transferId || t.splits.length)) return false;
      if (filter === "transfers" && !t.transferId) return false;
      if (filter === "income" && !(t.amount > 0 && !t.transferId)) return false;
      if (!needle) return true;
      const cat = t.categoryId ? l.cat.get(t.categoryId)?.name ?? "" : "";
      return t.payee.toLowerCase().includes(needle) || t.raw.toLowerCase().includes(needle) || t.memo.toLowerCase().includes(needle) || cat.toLowerCase().includes(needle) || String(Math.abs(t.amount).toFixed(2)).includes(needle);
    });
  }, [l.txns, l.cat, q, filter, account]);

  const totals = useMemo(() => {
    let inflow = 0;
    let outflow = 0;
    for (const t of rows) {
      if (t.transferId) continue;
      if (t.amount > 0) inflow += t.amount;
      else outflow += t.amount;
    }
    return { inflow, outflow };
  }, [rows]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => 52, overscan: 8 });

  const categorize = (t: Txn, categoryId: Id | null) => {
    void l.updateTxn(t.id, { categoryId }).then(reloadOverview);
    if (!categoryId) return;
    const key = t.payee.toLowerCase();
    const prev = history.current.get(key);
    const n = prev && prev.categoryId === categoryId ? prev.n + 1 : 1;
    history.current.set(key, { categoryId, n });
    if (n >= 2) setSuggest({ payee: t.payee, categoryId });
  };

  const createRule = async () => {
    if (!suggest) return;
    const cat = l.cat.get(suggest.categoryId);
    try {
      await api.finance.ruleUpsert({ instanceId, rule: { name: `${suggest.payee} → ${cat?.name ?? "category"}`, priority: 5, when: { all: [{ field: "payee", op: "equals", value: suggest.payee }] }, then: { categoryId: suggest.categoryId }, continue: false } });
      const res = await runJob(api.finance.rulesApply({ instanceId, scope: "uncategorized", dryRun: false }));
      notify.success(`Rule created`, { description: res.changed ? `Categorised ${res.changed} more ${res.changed === 1 ? "transaction" : "transactions"}.` : undefined });
      setSuggest(null);
      l.reload();
      reloadOverview();
    } catch (e) {
      notify.fromError(e, "Couldn't create the rule");
    }
  };

  const applyRules = async () => {
    try {
      const res = await runJob(api.finance.rulesApply({ instanceId, scope: "uncategorized", dryRun: false }));
      notify.success(res.changed ? `Rules categorised ${res.changed} ${res.changed === 1 ? "transaction" : "transactions"}` : "No rule matched the uncategorised transactions");
      l.reload();
      reloadOverview();
    } catch (e) {
      notify.fromError(e, "Couldn't apply rules");
    }
  };

  const toggle = (id: Id) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const uncategorizedCount = l.txns.filter((t) => !t.categoryId && !t.transferId && !t.splits.length).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Input size="sm" icon={Search} placeholder="Search payee, memo, category or amount" value={q} onChange={(e) => setQ(e.target.value)} clearable onClear={() => setQ("")} wrapperClassName="w-[230px]" aria-label="Search transactions" />
        <Segmented
          size="sm"
          value={filter}
          onValueChange={setFilter}
          aria-label="Filter"
          options={[
            { value: "all", label: "All" },
            { value: "uncategorized", label: uncategorizedCount ? `Uncategorised · ${uncategorizedCount}` : "Uncategorised" },
            { value: "income", label: "Income" },
            { value: "transfers", label: "Transfers" },
          ]}
        />
        <Select size="sm" value={account} onValueChange={setAccount} options={[{ value: "all", label: "All accounts" }, ...l.accounts.map((a) => ({ value: a.id, label: a.name }))]} className="w-[170px]" aria-label="Account" />
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="ghost" icon={Wand2} onClick={applyRules} disabled={!uncategorizedCount}>
            Apply rules
          </Button>
          <Button size="sm" variant="primary" icon={Plus} onClick={() => setAdding(true)} kbd="N">
            Add
          </Button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {suggest ? (
          <m.div key="suggest" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }} className="overflow-hidden">
            <div className="fh-suggest">
              <Wand2 size={15} className="text-accent-text flex-none" />
              <span className="flex-1 text-body-sm">
                Always categorise <b>{suggest.payee}</b> as <b>{l.cat.get(suggest.categoryId)?.name}</b>?
              </span>
              <Button size="xs" variant="primary" onClick={createRule}>
                Create rule
              </Button>
              <IconButton size="xs" icon={X} label="Not now" onClick={() => setSuggest(null)} />
            </div>
          </m.div>
        ) : null}
        {selected.size ? (
          <m.div key="bulk" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.16 }} className="fh-bulk">
            <span className="text-body-sm font-medium">{selected.size} selected</span>
            <CategoryPicker
              categories={l.categories}
              value={null}
              onChange={(c) => {
                for (const id of selected) void l.updateTxn(id, { categoryId: c });
                setSelected(new Set());
                setTimeout(reloadOverview, 300);
              }}
              trigger={
                <Button size="xs" variant="secondary" iconRight={ChevronDown}>
                  Categorise
                </Button>
              }
            />
            <Button size="xs" variant="destructive-ghost" icon={Trash2} onClick={() => void l.deleteTxns([...selected]).then(() => setSelected(new Set()))}>
              Delete
            </Button>
            <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          </m.div>
        ) : null}
      </AnimatePresence>

      <section className="fh-card fh-card-flush">
        <div className="fh-txn-head" role="row">
          <span className="w-6" />
          <span className="fh-txn-date">Date</span>
          <span className="flex-1 min-w-0">Payee</span>
          <span className="fh-txn-cat">Category</span>
          <span className="fh-txn-acct">Account</span>
          <span className="fh-txn-amt">Amount</span>
          <span className="w-8" />
        </div>
        <div ref={scrollRef} className="fh-txn-scroll" role="grid" aria-rowcount={rows.length} aria-label="Transactions">
          {l.loading && !l.txns.length ? (
            <div className="p-4 flex flex-col gap-4">
              {Array.from({ length: 10 }, (_, k) => (
                <Skeleton key={k} height={14} width={`${70 + ((k * 13) % 30)}%`} />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <Quiet icon={Check} title={filter === "uncategorized" ? "Everything is categorised" : "No transactions match"} body={filter === "uncategorized" ? "Nice work — your reports are up to date." : "Try a different search or filter."} />
          ) : (
            <div style={{ height: virt.getTotalSize(), position: "relative" }}>
              {virt.getVirtualItems().map((vi) => {
                const t = rows[vi.index];
                const prev = rows[vi.index - 1];
                const newDay = !prev || prev.date !== t.date;
                return (
                  <div key={t.id} data-index={vi.index} ref={virt.measureElement} className="absolute left-0 right-0" style={{ transform: `translateY(${vi.start}px)` }}>
                    <TxnRow
                      t={t}
                      newDay={newDay}
                      selected={selected.has(t.id)}
                      onToggle={() => toggle(t.id)}
                      onCategorize={(c) => categorize(t, c)}
                      onSplit={() => setSplitting(t)}
                      onDelete={() => void l.deleteTxns([t.id])}
                      onCleared={() => void l.updateTxn(t.id, { cleared: t.cleared === "uncleared" ? "cleared" : "uncleared" })}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="fh-txn-foot">
          <span className="text-tertiary">
            {rows.length.toLocaleString()} {rows.length === 1 ? "transaction" : "transactions"}
          </span>
          <span className="ml-auto inline-flex items-center gap-4 tabular">
            <span>
              <span className="text-tertiary">In </span>
              <Amount value={toMoney(totals.inflow)} className="text-gain-text font-medium" />
            </span>
            <span>
              <span className="text-tertiary">Out </span>
              <Amount value={toMoney(-totals.outflow)} className="font-medium" />
            </span>
          </span>
        </div>
      </section>

      {splitting ? <SplitDialog txn={splitting} onClose={() => setSplitting(null)} /> : null}
      {adding ? <AddDialog onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

function TxnRow({ t, newDay, selected, onToggle, onCategorize, onSplit, onDelete, onCleared }: { t: Txn; newDay: boolean; selected: boolean; onToggle: () => void; onCategorize: (c: Id | null) => void; onSplit: () => void; onDelete: () => void; onCleared: () => void }) {
  const l = useLedgerCtx();
  const [open, setOpen] = useState(false);
  const cat = t.categoryId ? l.cat.get(t.categoryId) : undefined;
  const acct = t.accountId ? l.acct.get(t.accountId) : undefined;
  const transferTo = t.transferId ? l.txns.find((x) => x.id === t.transferId) ?? null : null;
  const twinAcct = transferTo?.accountId ? l.acct.get(transferTo.accountId) : undefined;
  return (
    <div className={cn("fh-txn", selected && "is-selected", newDay && "is-newday")} role="row" aria-selected={selected}>
      <div className="fh-txn-main">
        <span className="w-6 flex items-center">
          <Checkbox checked={selected} onCheckedChange={onToggle} aria-label={`Select ${t.payee}`} />
        </span>
        <span className="fh-txn-date tabular">{newDay ? <><span className="text-primary">{dayLabel(t.date)}</span> <span className="text-tertiary">{weekdayLabel(t.date)}</span></> : null}</span>
        <span className="flex-1 min-w-0">
          <span className="block truncate text-body-sm font-medium text-primary">{t.payee || "Unknown payee"}</span>
          <span className="block truncate text-caption text-tertiary" style={{ fontWeight: 400 }}>
            {t.memo || t.raw}
          </span>
        </span>
        <span className="fh-txn-cat">
          {t.transferId ? (
            <span className="fh-chip" data-kind="transfer">
              <ArrowLeftRight size={12} />
              <span className="truncate">{twinAcct ? `${t.amount < 0 ? "To" : "From"} ${twinAcct.name}` : "Transfer"}</span>
            </span>
          ) : t.splits.length ? (
            <button type="button" className="fh-chip" data-kind="split" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
              <Split size={12} />
              Split · {t.splits.length}
              <ChevronDown size={12} style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform 160ms" }} />
            </button>
          ) : (
            <CategoryPicker
              categories={l.categories}
              value={t.categoryId}
              onChange={onCategorize}
              trigger={
                <button type="button" className="fh-chip" data-kind={cat ? "cat" : "none"} style={cat ? { color: `var(--block-${cat.color}-text)`, background: `var(--block-${cat.color}-bg)` } : undefined}>
                  {cat ? <span className="truncate">{cat.name}</span> : <span>Categorise</span>}
                  <ChevronDown size={12} className="opacity-60 flex-none" />
                </button>
              }
            />
          )}
        </span>
        <span className="fh-txn-acct truncate text-caption text-secondary" style={{ fontWeight: 400 }}>
          {acct?.name ?? "—"}
        </span>
        <span className="fh-txn-amt">
          <Amount value={toMoney(t.amount)} colored={t.amount > 0} signed={t.amount > 0} dimCents className="text-body-sm font-medium" align="end" />
        </span>
        <span className="w-8 flex items-center justify-end gap-0.5">
          <Menu>
            <MenuTrigger asChild>
              <IconButton icon={MoreHorizontal} size="xs" label="More" className="fh-txn-more" />
            </MenuTrigger>
            <MenuContent align="end" width={220}>
              <MenuItem icon={Split} onSelect={onSplit} disabled={!!t.transferId}>
                {t.splits.length ? "Edit split…" : "Split…"}
              </MenuItem>
              <MenuItem icon={Check} onSelect={onCleared}>
                {t.cleared === "uncleared" ? "Mark cleared" : "Mark uncleared"}
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={Trash2} destructive onSelect={onDelete}>
                Delete
              </MenuItem>
            </MenuContent>
          </Menu>
        </span>
      </div>
      <AnimatePresence initial={false}>
        {open && t.splits.length ? (
          <m.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }} className="overflow-hidden">
            {t.splits.map((s) => {
              const sc = s.categoryId ? l.cat.get(s.categoryId) : undefined;
              return (
                <div key={s.id} className="fh-txn-split">
                  <CornerDownRight size={13} className="text-tertiary" />
                  <Glyph name={sc?.icon} color={sc?.color} size={20} />
                  <span className="flex-1 text-caption text-secondary">{sc?.name ?? "Uncategorised"}</span>
                  <Amount value={toMoney(s.amount)} className="text-caption font-medium" align="end" />
                </div>
              );
            })}
          </m.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** Searchable, grouped category picker (popover). */
export function CategoryPicker({ categories, value, onChange, trigger }: { categories: Category[]; value: Id | null; onChange: (id: Id | null) => void; trigger: React.ReactElement }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const list = useMemo(() => {
    const n = q.trim().toLowerCase();
    return categories.filter((c) => !n || c.name.toLowerCase().includes(n) || c.group.toLowerCase().includes(n));
  }, [categories, q]);
  const groups = useMemo(() => {
    const m = new Map<string, Category[]>();
    for (const c of list) {
      const g = m.get(c.group) ?? [];
      g.push(c);
      m.set(c.group, g);
    }
    return [...m.entries()];
  }, [list]);
  const pick = (id: Id | null) => {
    onChange(id);
    setOpen(false);
    setQ("");
  };
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQ(""); setHi(0); }}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="fh-catpick" align="start">
        <div className="fh-catpick-search">
          <Search size={14} className="text-tertiary" />
          <input
            autoFocus
            value={q}
            placeholder="Find a category"
            onChange={(e) => {
              setQ(e.target.value);
              setHi(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHi((h) => Math.min(list.length - 1, h + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHi((h) => Math.max(0, h - 1));
              } else if (e.key === "Enter" && list[hi]) {
                e.preventDefault();
                pick(list[hi].id);
              }
            }}
            aria-label="Find a category"
          />
        </div>
        <div className="fh-catpick-list" role="listbox">
          {groups.map(([g, cs]) => (
            <div key={g}>
              <div className="fh-catpick-group">{g}</div>
              {cs.map((c) => {
                const i = list.indexOf(c);
                return (
                  <button key={c.id} type="button" role="option" aria-selected={c.id === value} className="fh-catpick-item" data-hi={i === hi ? "" : undefined} onMouseEnter={() => setHi(i)} onClick={() => pick(c.id)}>
                    <Glyph name={c.icon} color={c.color} size={20} />
                    <span className="flex-1 truncate">{c.name}</span>
                    {c.id === value ? <Check size={14} className="text-accent-text" /> : null}
                  </button>
                );
              })}
            </div>
          ))}
          {!list.length ? <div className="px-3 py-6 text-center text-caption text-tertiary">No category matches</div> : null}
        </div>
        {value ? (
          <button type="button" className="fh-catpick-clear" onClick={() => pick(null)}>
            Clear category
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function SplitDialog({ txn, onClose }: { txn: Txn; onClose: () => void }) {
  const l = useLedgerCtx();
  const { reloadOverview } = useMoney();
  const initial = txn.splits.length
    ? txn.splits.map((s) => ({ categoryId: s.categoryId ?? "", amount: Math.abs(s.amount).toFixed(2) }))
    : [
        { categoryId: txn.categoryId ?? "", amount: Math.abs(txn.amount).toFixed(2) },
        { categoryId: "", amount: "0.00" },
      ];
  const [parts, setParts] = useState(initial);
  const sign = txn.amount < 0 ? -1 : 1;
  const total = Math.abs(txn.amount);
  const used = parts.reduce((a, p) => a + num(p.amount), 0);
  const remaining = Math.round((total - used) * 100) / 100;
  const valid = Math.abs(remaining) < 0.005 && parts.every((p) => p.categoryId && num(p.amount) > 0);
  const options = l.categories.map((c) => ({ value: c.id, label: c.name, group: c.group, icon: <Glyph name={c.icon} color={c.color} size={18} /> }));
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Split ${txn.payee}`}
      description={`${fmtMoney(txn.amount)} on ${dayLabel(txn.date, true)}. Each part needs a category; the parts must add up to the total.`}
      size="md"
      footer={
        <>
          {txn.splits.length ? (
            <Button variant="ghost" className="mr-auto" onClick={() => void l.setSplits(txn, []).then(() => { reloadOverview(); onClose(); })}>
              Remove split
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid} onClick={() => void l.setSplits(txn, parts.map((p) => ({ categoryId: p.categoryId, amount: sign * num(p.amount) }))).then(() => { reloadOverview(); onClose(); })}>
            Save split
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        {parts.map((p, i) => (
          <div key={i} className="flex items-center gap-2">
            <Select value={p.categoryId || null} onValueChange={(v) => setParts((ps) => ps.map((x, j) => (j === i ? { ...x, categoryId: v } : x)))} options={options} searchable placeholder="Category" className="flex-1" aria-label={`Category for part ${i + 1}`} />
            <MoneyField value={p.amount} onChange={(v) => setParts((ps) => ps.map((x, j) => (j === i ? { ...x, amount: v ?? "0" } : x)))} wrapperClassName="w-[140px]" aria-label={`Amount for part ${i + 1}`} />
            <IconButton icon={X} size="sm" label="Remove part" disabled={parts.length <= 2} onClick={() => setParts((ps) => ps.filter((_, j) => j !== i))} />
          </div>
        ))}
        <div className="flex items-center gap-2 mt-1">
          <Button size="sm" variant="ghost" icon={Plus} onClick={() => setParts((ps) => [...ps, { categoryId: "", amount: Math.max(0, remaining).toFixed(2) }])}>
            Add part
          </Button>
          <span className={cn("ml-auto text-body-sm tabular", Math.abs(remaining) < 0.005 ? "text-gain-text" : "text-warning-text")}>
            {Math.abs(remaining) < 0.005 ? (
              <span className="inline-flex items-center gap-1">
                <Check size={14} /> Balanced
              </span>
            ) : remaining > 0 ? (
              `${fmtMoney(remaining)} left to assign`
            ) : (
              `${fmtMoney(-remaining)} over`
            )}
          </span>
          {remaining > 0.005 ? (
            <Tooltip content="Put the remainder on the last part">
              <Button size="xs" variant="soft" onClick={() => setParts((ps) => ps.map((x, j) => (j === ps.length - 1 ? { ...x, amount: (num(x.amount) + remaining).toFixed(2) } : x)))}>
                Fill
              </Button>
            </Tooltip>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

function AddDialog({ onClose }: { onClose: () => void }) {
  const l = useLedgerCtx();
  const { reloadOverview } = useMoney();
  const [date, setDate] = useState(todayIso());
  const [payee, setPayee] = useState("");
  const [amount, setAmount] = useState<string | null>(null);
  const [outflow, setOutflow] = useState(true);
  const [account, setAccount] = useState<string | null>(l.accounts.find((a) => a.type === "checking")?.id ?? l.accounts[0]?.id ?? null);
  const [category, setCategory] = useState<string | null>(null);
  const valid = payee.trim() && amount && num(amount) > 0 && account && /^\d{4}-\d{2}-\d{2}$/.test(date);
  const save = async () => {
    if (!valid) return;
    await l.addTxn({ date, payee: payee.trim(), amount: (outflow ? -1 : 1) * num(amount), accountId: account!, categoryId: category });
    reloadOverview();
    notify.success("Transaction added");
    onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add a transaction"
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid} onClick={save} kbd="↵">
            Add
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
        <Segmented block value={outflow ? "out" : "in"} onValueChange={(v) => setOutflow(v === "out")} options={[{ value: "out", label: "Money out" }, { value: "in", label: "Money in" }]} aria-label="Direction" />
        <Input label="Payee" value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="Who was it?" autoFocus />
        <div className="grid grid-cols-2 gap-3">
          <MoneyField label="Amount" value={amount} onChange={setAmount} />
          <Input label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <Select label="Account" value={account} onValueChange={setAccount} options={l.accounts.map((a) => ({ value: a.id, label: a.name }))} />
        <Select label="Category" value={category} onValueChange={setCategory} options={l.categories.map((c) => ({ value: c.id, label: c.name, group: c.group }))} searchable placeholder="Optional" />
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
