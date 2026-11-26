/**
 * Rules editor (§15.2): ordered rules (first match wins unless "continue"), conditions on payee / raw description /
 * memo / amount / account / day of month, actions to categorise, rename or mark as a transfer. Test a rule set
 * with a dry run before applying it to uncategorised (or all) transactions.
 */
import { ArrowDown, ArrowUp, FlaskConical, ListFilter, Plus, Save, Trash2, Wand2, X } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { api, runJob } from "@/backend";
import type { Id, Rule, RuleCondition } from "@/backend/types";
import { cn } from "@/lib/cn";
import { notify } from "@/stores/toasts";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { Input } from "@/ui/Input";
import { Select } from "@/ui/Select";
import { Sheet } from "@/ui/Sheet";
import { Skeleton } from "@/ui/Skeleton";
import { Switch } from "@/ui/Switch";
import { spring } from "@/ui/motion/tokens";
import { useAsync, useFlip } from "../shared/hooks";
import { disclose, Glyph, Quiet } from "../shared/ui";
import { useLedgerCtx } from "../MoneyHQ/ledger";

const FIELDS: { value: RuleCondition["field"]; label: string; kind: "text" | "number" | "account" }[] = [
  { value: "payee", label: "Payee", kind: "text" },
  { value: "raw", label: "Bank description", kind: "text" },
  { value: "memo", label: "Memo", kind: "text" },
  { value: "amount", label: "Amount", kind: "number" },
  { value: "abs_amount", label: "Amount (either sign)", kind: "number" },
  { value: "account", label: "Account", kind: "account" },
  { value: "day_of_month", label: "Day of month", kind: "number" },
];
const OPS: Record<"text" | "number" | "account", { value: RuleCondition["op"]; label: string }[]> = {
  text: [
    { value: "contains", label: "contains" },
    { value: "equals", label: "is" },
    { value: "starts_with", label: "starts with" },
    { value: "regex", label: "matches regex" },
    { value: "in", label: "is one of" },
  ],
  number: [
    { value: "lt", label: "is less than" },
    { value: "gt", label: "is more than" },
    { value: "equals", label: "equals" },
    { value: "between", label: "is between" },
  ],
  account: [{ value: "equals", label: "is" }],
};

type Draft = Omit<Rule, "id" | "timesApplied"> & { id?: Id; timesApplied?: number };

export default function RulesEditor({ instanceId, open, onOpenChange }: { instanceId: Id; open: boolean; onOpenChange: (o: boolean) => void }) {
  const l = useLedgerCtx();
  const rules = useAsync(() => api.finance.rulesList({ instanceId }), [instanceId]);
  const [sel, setSel] = useState<Id | "new" | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  // adding/removing a condition: the rest of the form glides instead of the row animating its height
  const nConds = draft?.when.all.length ?? 0;
  const condRef = useFlip<HTMLDivElement>(nConds);
  const formRef = useFlip<HTMLDivElement>(nConds);
  const [dry, setDry] = useState<{ changed: number; sample: { rowId: Id; from?: string; to: string }[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const list = useMemo(() => (rules.data ?? []).slice().sort((a, b) => a.priority - b.priority), [rules.data]);

  useEffect(() => {
    if (sel === null && list.length) setSel(list[0].id);
  }, [list, sel]);
  useEffect(() => {
    if (sel === "new") return;
    const r = list.find((x) => x.id === sel);
    setDraft(r ? structuredClone(r) : null);
    setDry(null);
  }, [sel, list]);

  const save = async () => {
    if (!draft) return;
    setBusy("save");
    try {
      const saved = await api.finance.ruleUpsert({ instanceId, rule: draft });
      notify.success("Rule saved");
      rules.reload();
      setSel(saved.id);
    } catch (e) {
      notify.fromError(e, "Couldn't save the rule");
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    if (!draft?.id) return;
    const snapshot = draft;
    try {
      await api.finance.ruleDelete({ instanceId, id: draft.id });
      rules.reload();
      setSel(null);
      notify.undo("Rule deleted", async () => {
        const { id: _i, timesApplied: _t, ...rest } = snapshot;
        await api.finance.ruleUpsert({ instanceId, rule: rest });
        rules.reload();
      });
    } catch (e) {
      notify.fromError(e, "Couldn't delete the rule");
    }
  };
  const move = async (r: Rule, dir: -1 | 1) => {
    const i = list.indexOf(r);
    const other = list[i + dir];
    if (!other) return;
    await api.finance.ruleUpsert({ instanceId, rule: { ...r, priority: other.priority } });
    await api.finance.ruleUpsert({ instanceId, rule: { ...other, priority: r.priority === other.priority ? r.priority + dir : r.priority } });
    rules.reload();
  };
  const test = async () => {
    setBusy("test");
    try {
      if (draft && sel === "new") await save();
      setDry(await runJob(api.finance.rulesApply({ instanceId, scope: "uncategorized", dryRun: true })));
    } catch (e) {
      notify.fromError(e, "Couldn't test the rules");
    } finally {
      setBusy(null);
    }
  };
  const apply = async (scope: "uncategorized" | "all") => {
    setBusy(scope);
    try {
      const r = await runJob(api.finance.rulesApply({ instanceId, scope, dryRun: false }));
      notify.success(r.changed ? `Rules updated ${r.changed} ${r.changed === 1 ? "transaction" : "transactions"}` : "Nothing to change");
      rules.reload();
      l.reload();
      setDry(null);
    } catch (e) {
      notify.fromError(e, "Couldn't apply the rules");
    } finally {
      setBusy(null);
    }
  };

  const newRule = () => {
    setSel("new");
    setDraft({ name: "New rule", priority: (list.at(-1)?.priority ?? 0) + 10, when: { all: [{ field: "payee", op: "contains", value: "" }] }, then: {}, continue: false });
    setDry(null);
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      size="wizard"
      title="Rules"
      description="Rules run in order on every import and when you apply them. The first match wins unless a rule says to keep going."
      footer={
        <div className="flex items-center gap-2 w-full">
          <Button variant="ghost" icon={FlaskConical} loading={busy === "test"} onClick={test}>
            Test on uncategorised
          </Button>
          <span className="flex-1" />
          <Button variant="secondary" loading={busy === "all"} onClick={() => apply("all")}>
            Re-run on everything
          </Button>
          <Button variant="primary" icon={Wand2} loading={busy === "uncategorized"} onClick={() => apply("uncategorized")}>
            Apply to uncategorised
          </Button>
        </div>
      }
    >
      <div className="fh-rules">
        <aside className="fh-rules-list">
          <Button size="sm" variant="secondary" icon={Plus} className="w-full mb-2" onClick={newRule}>
            New rule
          </Button>
          {rules.loading && !rules.data ? (
            <Skeleton height={200} radius={10} />
          ) : (
            <m.ol className="m-0 p-0 list-none flex flex-col gap-1" layout>
              {list.map((r, i) => (
                <m.li key={r.id} layout transition={spring.layout}>
                  <div role="button" tabIndex={0} className={cn("fh-rule-item", sel === r.id && "is-sel")} onClick={() => setSel(r.id)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setSel(r.id))}>
                    <span className="fh-rule-n">{i + 1}</span>
                    <span className="flex-1 min-w-0 text-left">
                      <span className="block truncate text-body-sm font-medium">{r.name}</span>
                      <span className="block text-caption text-tertiary" style={{ fontWeight: 400 }}>
                        Applied {r.timesApplied.toLocaleString()}×{r.continue ? " · continues" : ""}
                      </span>
                    </span>
                    <span className="fh-rule-move">
                      <IconButton icon={ArrowUp} size="xs" label="Move up" disabled={i === 0} onClick={(e) => { e.stopPropagation(); void move(r, -1); }} />
                      <IconButton icon={ArrowDown} size="xs" label="Move down" disabled={i === list.length - 1} onClick={(e) => { e.stopPropagation(); void move(r, 1); }} />
                    </span>
                  </div>
                </m.li>
              ))}
            </m.ol>
          )}
        </aside>
        <section className="fh-rules-edit">
          {!draft ? (
            <Quiet icon={ListFilter} title="No rule selected" body="Pick a rule on the left, or create one." />
          ) : (
            <div className="flex flex-col gap-5" ref={formRef}>
              <Input label="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              <div>
                <div className="fh-rules-h">When all of these match</div>
                <div className="flex flex-col gap-2" ref={condRef}>
                  <AnimatePresence initial={false} mode="popLayout">
                    {draft.when.all.map((c, i) => (
                      <m.div key={i} {...disclose}>
                        <Condition
                          c={c}
                          accounts={l.accounts.map((a) => ({ value: a.id, label: a.name }))}
                          onChange={(nc) => setDraft({ ...draft, when: { all: draft.when.all.map((x, j) => (j === i ? nc : x)) } })}
                          onRemove={draft.when.all.length > 1 ? () => setDraft({ ...draft, when: { all: draft.when.all.filter((_, j) => j !== i) } }) : undefined}
                        />
                      </m.div>
                    ))}
                  </AnimatePresence>
                  <Button size="xs" variant="ghost" icon={Plus} className="self-start" onClick={() => setDraft({ ...draft, when: { all: [...draft.when.all, { field: "amount", op: "lt", value: 0 }] } })}>
                    Add condition
                  </Button>
                </div>
              </div>
              <div>
                <div className="fh-rules-h">Then</div>
                <div className="grid grid-cols-2 gap-3">
                  <Select
                    label="Set category"
                    value={draft.then.categoryId ?? "__none"}
                    onValueChange={(v) => setDraft({ ...draft, then: { ...draft.then, categoryId: v === "__none" ? undefined : v } })}
                    options={[{ value: "__none", label: "Don't change" }, ...l.categories.map((c) => ({ value: c.id, label: c.name, group: c.group, icon: <Glyph name={c.icon} color={c.color} size={18} /> }))]}
                    searchable
                  />
                  <Input label="Rename payee to" value={draft.then.renamePayee ?? ""} placeholder="Keep as is" onChange={(e) => setDraft({ ...draft, then: { ...draft.then, renamePayee: e.target.value || undefined } })} />
                </div>
                <div className="flex flex-col gap-3 mt-4">
                  <Switch size="sm" checked={!!draft.then.markTransfer} onCheckedChange={(v) => setDraft({ ...draft, then: { ...draft.then, markTransfer: v || undefined } })} label="Treat as a transfer (excluded from income and spending)" />
                  <Switch size="sm" checked={draft.continue} onCheckedChange={(v) => setDraft({ ...draft, continue: v })} label="Keep checking later rules after this one matches" />
                </div>
              </div>
              <div className="flex items-center gap-2 pt-2 border-t border-subtle">
                {draft.id ? <Badge tone="outline">Applied {draft.timesApplied?.toLocaleString() ?? 0}×</Badge> : <Badge tone="accent">Unsaved</Badge>}
                <span className="flex-1" />
                {draft.id ? (
                  <Button size="sm" variant="destructive-ghost" icon={Trash2} onClick={remove}>
                    Delete
                  </Button>
                ) : null}
                <Button size="sm" variant="primary" icon={Save} loading={busy === "save"} onClick={save} disabled={!draft.name.trim() || draft.when.all.some((c) => c.value === "" || c.value === undefined)}>
                  Save rule
                </Button>
              </div>
              <AnimatePresence>
                {dry ? (
                  <m.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="fh-dry">
                    <div className="flex items-center gap-2 mb-2">
                      <FlaskConical size={14} />
                      <span className="text-body-sm font-semibold">Dry run: {dry.changed} uncategorised {dry.changed === 1 ? "transaction" : "transactions"} would change</span>
                      <IconButton icon={X} size="xs" label="Close" className="ml-auto" onClick={() => setDry(null)} />
                    </div>
                    {dry.sample.map((s) => (
                      <div key={s.rowId} className="text-caption text-secondary py-0.5" style={{ fontWeight: 400 }}>
                        {s.to}
                      </div>
                    ))}
                  </m.div>
                ) : null}
              </AnimatePresence>
            </div>
          )}
        </section>
      </div>
    </Sheet>
  );
}

function Condition({ c, onChange, onRemove, accounts }: { c: RuleCondition; onChange: (c: RuleCondition) => void; onRemove?: () => void; accounts: { value: string; label: string }[] }) {
  const field = FIELDS.find((f) => f.value === c.field) ?? FIELDS[0];
  const ops = OPS[field.kind];
  const value = c.value;
  return (
    <div className="fh-cond">
      <Select size="sm" value={c.field} onValueChange={(f) => {
        const kind = FIELDS.find((x) => x.value === f)?.kind ?? "text";
        onChange({ field: f, op: OPS[kind][0].value, value: kind === "number" ? 0 : kind === "account" ? accounts[0]?.value ?? "" : "" });
      }} options={FIELDS.map((f) => ({ value: f.value, label: f.label }))} className="flex-1" aria-label="Field" />
      <Select size="sm" value={ops.some((o) => o.value === c.op) ? c.op : ops[0].value} onValueChange={(op) => onChange({ ...c, op, value: op === "between" ? [0, 100] : op === "in" ? [] : value })} options={ops.map((o) => ({ value: o.value, label: o.label }))} className="w-[150px]" aria-label="Operator" />
      {onRemove ? <IconButton icon={X} size="sm" label="Remove condition" onClick={onRemove} /> : null}
      <div className="basis-full flex">
      {field.kind === "account" ? (
        <Select size="sm" value={String(value ?? "")} onValueChange={(v) => onChange({ ...c, value: v })} options={accounts} className="flex-1" aria-label="Account" />
      ) : c.op === "between" ? (
        <div className="flex items-center gap-2 flex-1">
          <Input size="sm" type="number" value={String((value as number[])?.[0] ?? "")} onChange={(e) => onChange({ ...c, value: [Number(e.target.value), (value as number[])?.[1] ?? 0] })} aria-label="From" />
          <span className="text-tertiary text-caption">and</span>
          <Input size="sm" type="number" value={String((value as number[])?.[1] ?? "")} onChange={(e) => onChange({ ...c, value: [(value as number[])?.[0] ?? 0, Number(e.target.value)] })} aria-label="To" />
        </div>
      ) : c.op === "in" ? (
        <Input size="sm" wrapperClassName="flex-1" value={Array.isArray(value) ? value.join(", ") : String(value ?? "")} placeholder="Comma-separated" onChange={(e) => onChange({ ...c, value: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} aria-label="Values" />
      ) : (
        <Input size="sm" wrapperClassName="flex-1" type={field.kind === "number" ? "number" : "text"} value={String(value ?? "")} onChange={(e) => onChange({ ...c, value: field.kind === "number" ? Number(e.target.value) : e.target.value })} aria-label="Value" className={c.op === "regex" ? "font-mono" : undefined} />
      )}
      </div>
    </div>
  );
}
