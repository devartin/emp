/**
 * Budget (§15.3): per-month envelopes grouped by category group. Assigned is edited inline (MoneyField with `=`
 * expressions); Available = rollover + assigned + activity; To be assigned updates live from `finance_budget_assign`.
 */
import { Check, ChevronRight, RotateCcw, Sparkles, Target } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/backend";
import type { BudgetMonth } from "@/backend/types";
import { cn } from "@/lib/cn";
import { notify } from "@/stores/toasts";
import { Amount } from "@/ui/Amount";
import { Button } from "@/ui/Button";
import { MoneyField } from "@/ui/MoneyField";
import { BudgetProgress } from "@/ui/Progress";
import { burst } from "@/ui/motion/Celebrate";
import { RollingNumber } from "@/ui/motion/RollingNumber";
import { spring } from "@/ui/motion/tokens";
import { Skeleton } from "@/ui/Skeleton";
import { Tooltip } from "@/ui/Tooltip";
import { fmtMoney, monthLabel, num, toMoney, todayIso } from "../shared/format";
import { useAsync, useDbChanged, useFlip } from "../shared/hooks";
import { disclose, Glyph } from "../shared/ui";
import { useLedgerCtx } from "./ledger";
import { useMoney } from "./MoneyHQ";
import { HeroMoney } from "./widgets";

export default function Budget() {
  const { instanceId, month, reloadOverview } = useMoney();
  const l = useLedgerCtx();
  const bm = useAsync(() => api.finance.budgetMonth({ instanceId, month }), [instanceId, month]);
  useDbChanged([l.schemas.txns?.database.id, l.schemas.categories?.database.id], bm.reload, 300);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // groups below a collapsing/expanding group glide on the compositor (no height animation)
  const tableRef = useFlip<HTMLElement>(collapsed);
  const rows = useMemo(() => {
    const byCat = new Map((bm.data?.categories ?? []).map((c) => [c.categoryId, c]));
    const groups = new Map<string, { id: string; name: string; icon: string; color: string; target: number; rollover: boolean; assigned: number; activity: number; available: number; carry: number }[]>();
    for (const c of l.categories) {
      if (c.group === "Income") continue;
      const b = byCat.get(c.id);
      const list = groups.get(c.group) ?? [];
      list.push({ id: c.id, name: c.name, icon: c.icon, color: c.color, target: c.target, rollover: c.rollover, assigned: num(b?.assigned), activity: num(b?.activity), available: num(b?.available), carry: num(b?.rollover) });
      groups.set(c.group, list);
    }
    return [...groups.entries()];
  }, [bm.data, l.categories]);

  const tba = num(bm.data?.toBeAssigned);
  const totals = rows.flatMap(([, cs]) => cs).reduce((a, c) => ({ assigned: a.assigned + c.assigned, spent: a.spent - c.activity, available: a.available + c.available }), { assigned: 0, spent: 0, available: 0 });
  const isPast = month < todayIso().slice(0, 7);
  const pace = isPast ? 1 : month > todayIso().slice(0, 7) ? 0 : Number(todayIso().slice(8, 10)) / new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();

  const assign = async (categoryId: string, amount: string) => {
    bm.set((prev) => (prev ? patchLocal(prev, categoryId, amount) : prev));
    try {
      const res = await api.finance.budgetAssign({ instanceId, month, categoryId, amount });
      bm.set((prev) => (prev ? { ...prev, toBeAssigned: res.toBeAssigned, categories: prev.categories.map((c) => (c.categoryId === categoryId ? { ...c, available: res.available } : c)) } : prev));
      reloadOverview();
    } catch (e) {
      notify.fromError(e, "Couldn't assign");
      bm.reload();
    }
  };

  const fillTargets = async () => {
    const todo = rows.flatMap(([, cs]) => cs).filter((c) => c.target > 0 && Math.abs(c.assigned - c.target) > 0.004);
    if (!todo.length) {
      notify.info("Every category already matches its target");
      return;
    }
    for (const c of todo) await api.finance.budgetAssign({ instanceId, month, categoryId: c.id, amount: c.target.toFixed(2) });
    bm.reload();
    reloadOverview();
    notify.success(`Assigned ${todo.length} ${todo.length === 1 ? "category" : "categories"} to target`);
  };

  const coverOverspending = async () => {
    const over = rows.flatMap(([, cs]) => cs).filter((c) => c.available < -0.004);
    for (const c of over) await api.finance.budgetAssign({ instanceId, month, categoryId: c.id, amount: (c.assigned - c.available).toFixed(2) });
    bm.reload();
    reloadOverview();
    if (over.length) notify.success(`Covered ${over.length} overspent ${over.length === 1 ? "category" : "categories"}`);
  };
  const overCount = rows.flatMap(([, cs]) => cs).filter((c) => c.available < -0.004).length;

  // "Balanced" moment: when To be assigned reaches exactly zero, the hero figure gets an 8-ray burst (S13 rays).
  const heroRef = useRef<HTMLDivElement>(null);
  const prevTba = useRef<number | null>(null);
  useEffect(() => {
    if (!bm.data) return;
    const was = prevTba.current;
    prevTba.current = tba;
    if (was !== null && Math.abs(was) > 0.004 && Math.abs(tba) <= 0.004 && heroRef.current) burst(heroRef.current, { rays: 10, radius: 34 });
  }, [tba, bm.data]);
  let rowIndex = 0;

  return (
    <div className="flex flex-col gap-4">
      <section className="fh-card fh-budget-hero">
        <div className="min-w-0">
          <div className="text-caption text-secondary" style={{ fontWeight: 500 }}>
            To be assigned · {monthLabel(month)}
          </div>
          <div className="mt-1 flex items-baseline gap-3" ref={heroRef}>
            {bm.data ? <HeroMoney value={tba} /> : <Skeleton width={180} height={36} radius={8} />}
            {bm.data && Math.abs(tba) <= 0.004 ? (
              <m.span className="fh-balanced" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={spring.pop}>
                <Check size={12} strokeWidth={3} /> Balanced
              </m.span>
            ) : null}
          </div>
          <div className={cn("mt-1 text-body-sm", tba < -0.004 ? "text-warning-text" : "text-tertiary")}>
            {tba > 0.004 ? "Give these dollars a job — assign them to a category or a goal." : tba < -0.004 ? "You've assigned more than you have. Lower an assignment to rebalance." : "Every dollar has a job. Zero-based and balanced."}
          </div>
        </div>
        <div className="fh-budget-figs">
          <Fig label="Assigned" value={totals.assigned} />
          <Fig label="Spent" value={totals.spent} />
          <Fig label="Available" value={totals.available} />
        </div>
        <div className="flex flex-col gap-1.5 flex-none">
          <Button size="sm" variant="primary" icon={Target} onClick={fillTargets}>
            Assign to targets
          </Button>
          <Button size="sm" variant="ghost" icon={Sparkles} disabled={!overCount} onClick={coverOverspending}>
            {overCount ? `Cover ${overCount} overspent` : "No overspending"}
          </Button>
        </div>
      </section>

      <section className="fh-card fh-card-flush" ref={tableRef}>
        <div className="fh-bud-row fh-bud-head">
          <span className="flex-1">Category</span>
          <span className="fh-bud-num">Assigned</span>
          <span className="fh-bud-num">Activity</span>
          <span className="fh-bud-bar">Progress</span>
          <span className="fh-bud-num">Available</span>
        </div>
        {!bm.data
          ? Array.from({ length: 10 }, (_, k) => (
              <div key={k} className="fh-bud-row">
                <Skeleton width={160} height={12} />
              </div>
            ))
          : rows.map(([group, cs]) => {
              const open = !collapsed.has(group);
              const g = cs.reduce((a, c) => ({ assigned: a.assigned + c.assigned, activity: a.activity + c.activity, available: a.available + c.available }), { assigned: 0, activity: 0, available: 0 });
              const savings = group === "Savings & Debt";
              return (
                <div key={group}>
                  <button
                    type="button"
                    className="fh-bud-row fh-bud-group w-full"
                    onClick={() =>
                      setCollapsed((s) => {
                        const n = new Set(s);
                        if (n.has(group)) n.delete(group);
                        else n.add(group);
                        return n;
                      })
                    }
                    aria-expanded={open}
                  >
                    <span className="flex-1 flex items-center gap-1.5 text-left">
                      <ChevronRight size={14} className="text-tertiary" style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform var(--dur-release) var(--spring-release)" }} />
                      {group}
                    </span>
                    <span className="fh-bud-num">
                      <Amount value={toMoney(g.assigned)} align="end" />
                    </span>
                    <span className="fh-bud-num">
                      <Amount value={toMoney(g.activity)} align="end" />
                    </span>
                    <span className="fh-bud-bar" />
                    <span className="fh-bud-num">
                      <Amount value={toMoney(g.available)} align="end" />
                    </span>
                  </button>
                  <AnimatePresence initial={false} mode="popLayout">
                    {open ? (
                      <m.div key="rows" {...disclose}>
                        {cs.map((c) => (
                          <div key={c.id} className="fh-bud-row fh-cascade" style={{ ["--i" as string]: Math.min(12, rowIndex++) }}>
                            <span className="flex-1 min-w-0 flex items-center gap-2.5">
                              <Glyph name={c.icon} color={c.color} size={24} />
                              <span className="truncate text-body-sm font-medium">{c.name}</span>
                              {c.rollover ? (
                                <Tooltip content={c.carry ? `${fmtMoney(c.carry)} rolled over from last month` : "Leftover money rolls into next month"}>
                                  <span className="fh-roll" tabIndex={0}>
                                    <RotateCcw size={11} />
                                  </span>
                                </Tooltip>
                              ) : null}
                              {c.target > 0 && Math.abs(c.assigned - c.target) > 0.004 ? (
                                <Tooltip content={`Target ${fmtMoney(c.target)} a month`}>
                                  <button type="button" className="fh-target-hint" onClick={() => void assign(c.id, c.target.toFixed(2))}>
                                    Target {fmtMoney(c.target, "USD", { noCents: true })}
                                  </button>
                                </Tooltip>
                              ) : null}
                            </span>
                            <span className="fh-bud-num">
                              <MoneyField size="sm" value={c.assigned.toFixed(2)} onChange={(v) => v !== null && Math.abs(num(v) - c.assigned) > 0.004 && void assign(c.id, v)} aria-label={`Assigned to ${c.name}`} wrapperClassName="fh-bud-input" />
                            </span>
                            <span className="fh-bud-num text-secondary">
                              <Amount value={toMoney(c.activity)} align="end" />
                            </span>
                            <span className="fh-bud-bar">{savings ? <BudgetProgress spent={Math.max(0, c.available)} budget={Math.max(c.target * 12, 1)} pace={null} size={4} /> : <BudgetProgress spent={-c.activity} budget={c.assigned + Math.max(0, c.carry)} pace={pace} size={4} />}</span>
                            <span className="fh-bud-num">
                              <span className="fh-avail" data-tone={c.available < -0.004 ? "over" : c.available < 0.004 ? "zero" : savings ? "saved" : "ok"} data-sensitive="">
                                <RollingNumber value={c.available} format={(n) => fmtMoney(n)} countUp={false} sensitive />
                              </span>
                            </span>
                          </div>
                        ))}
                      </m.div>
                    ) : null}
                  </AnimatePresence>
                </div>
              );
            })}
      </section>
    </div>
  );
}

function Fig({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col">
      <span className="text-caption text-tertiary" style={{ fontWeight: 500 }}>
        {label}
      </span>
      <span className="text-title tabular" style={{ fontWeight: 620 }} data-sensitive="">
        <RollingNumber value={value} format={(n) => fmtMoney(Math.round(n), "USD", { noCents: true })} countUp={false} sensitive />
      </span>
    </div>
  );
}

function patchLocal(prev: BudgetMonth, categoryId: string, amount: string): BudgetMonth {
  const before = prev.categories.find((c) => c.categoryId === categoryId);
  if (!before) return prev;
  const d = num(amount) - num(before.assigned);
  return {
    ...prev,
    toBeAssigned: (num(prev.toBeAssigned) - d).toFixed(2),
    categories: prev.categories.map((c) => (c.categoryId === categoryId ? { ...c, assigned: num(amount).toFixed(2), available: (num(c.available) + d).toFixed(2) } : c)),
  };
}
