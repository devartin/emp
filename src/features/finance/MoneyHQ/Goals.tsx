/**
 * Goals (§15.5, §16.2): emergency fund and sinking funds as 4px progress bars with the monthly amount each needs
 * (`finance_goal_plan`, annuity form when a yield is set), on-track status, and a quick "add goal".
 */
import { CalendarDays, Check, ExternalLink, Plus, Target } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/backend";
import { navigate } from "@/app/router";
import { notify } from "@/stores/toasts";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { Button } from "@/ui/Button";
import { Dialog } from "@/ui/Dialog";
import { Input } from "@/ui/Input";
import { MoneyField } from "@/ui/MoneyField";
import { RollingNumber } from "@/ui/motion/RollingNumber";
import { spring } from "@/ui/motion/tokens";
import { Sensitive } from "@/ui/Sensitive";
import { Skeleton } from "@/ui/Skeleton";
import { dayLabel, daysBetween, fmtPct, num, todayIso, fmtWhole } from "../shared/format";
import { useAsync, V } from "../shared/hooks";
import { Glyph, Quiet } from "../shared/ui";
import { useLedgerCtx, type GoalRow } from "./ledger";
import { useMoney } from "./MoneyHQ";

export default function Goals() {
  const l = useLedgerCtx();
  const { overview } = useMoney();
  const [adding, setAdding] = useState(false);
  const saved = (g: GoalRow) => (g.accountId ? (l.acct.get(g.accountId)?.balance ?? g.saved) : g.saved);
  const plans = useAsync(
    () =>
      Promise.all(
        l.goals.map((g) => (g.date ? api.finance.goalPlan({ target: g.target.toFixed(2), by: g.date, current: saved(g).toFixed(2), annualYieldPct: g.accountId ? "4.1" : "0" }) : Promise.resolve(null))),
      ),
    [l.goals.map((g) => `${g.id}:${g.target}:${saved(g)}:${g.date}`).join("|")],
  );
  const totalTarget = l.goals.reduce((a, g) => a + g.target, 0);
  const totalSaved = l.goals.reduce((a, g) => a + Math.min(g.target, saved(g)), 0);
  const monthly = (plans.data ?? []).reduce((a, p) => a + (p ? num(p.monthlyRequired) : 0), 0);

  if (l.loading) return <Skeleton height={360} radius={10} />;
  return (
    <div className="flex flex-col gap-4">
      {/* No ring (DESIGN §6.3: zero rings in Money): a labelled figure over one 4px bar. */}
      <section className="fh-card flex items-start gap-6">
        <div className="flex-1 min-w-0">
          <div className="text-caption text-secondary font-medium">Saved toward {l.goals.length} goals</div>
          <div className="flex items-baseline gap-2 mt-1">
            <span data-sensitive="" className="emp-amount" data-role="hero">
              <RollingNumber value={totalSaved} format={(n) => fmtWhole(Math.round(n))} sensitive countUp={false} />
            </span>
            <span className="text-body text-tertiary">
              of <Sensitive>{fmtWhole(totalTarget)}</Sensitive> · {fmtPct(totalTarget ? totalSaved / totalTarget : 0, 0)}
            </span>
          </div>
          <GoalBar ratio={totalTarget ? totalSaved / totalTarget : 0} className="mt-3 max-w-[480px]" />
          <div className="text-body-sm text-tertiary mt-2">
            Needs about <Sensitive>{fmtWhole(monthly)}</Sensitive> a month across dated goals
            {overview ? ` · emergency fund covers ${formatNumber(overview.efMonths, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} months of essentials` : ""}
          </div>
        </div>
        <Button variant="primary" size="sm" icon={Plus} onClick={() => setAdding(true)}>
          New goal
        </Button>
      </section>
      {!l.goals.length ? (
        <section className="fh-card">
          <Quiet icon={Target} title="No goals yet" body="Name something you're saving for and Ultranote works out the monthly amount it needs." action={<Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>New goal</Button>} />
        </section>
      ) : (
        <div className="fh-goals">
          {l.goals.map((g, i) => (
            <GoalCard key={g.id} g={g} saved={saved(g)} plan={plans.data?.[i] ?? null} />
          ))}
        </div>
      )}
      {l.schemas.goals ? (
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" iconRight={ExternalLink} onClick={() => navigate({ t: "db", id: l.schemas.goals!.database.id })}>
            Edit goals in their database
          </Button>
        </div>
      ) : null}
      {adding ? <AddGoal onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

type Plan = Awaited<ReturnType<typeof api.finance.goalPlan>> | null;

/**
 * A goal plate. Unlinked goals take contributions inline ("Add money"); the one that crosses its target gets the S8
 * confirmation: the bar fills, the figure rolls (after your own edit) and a toast follows. No particles.
 */
function GoalCard({ g, saved: s, plan }: { g: GoalRow; saved: number; plan: Plan }) {
  const l = useLedgerCtx();
  const [adding, setAdding] = useState(false);
  const [amount, setAmountState] = useState<string | null>(null);
  // the money field commits on blur/Enter; mirror it in a ref so submit can read the committed value at once
  const amountRef = useRef<string | null>(null);
  const setAmount = (v: string | null) => {
    amountRef.current = v;
    setAmountState(v);
  };
  const [busy, setBusy] = useState(false);
  const [moment, setMoment] = useState(0);
  const ratio = g.target ? s / g.target : 0;
  const left = g.date ? daysBetween(todayIso(), g.date) : null;
  const done = s >= g.target - 0.004;
  const G = l.schemas.goals;
  const canAdd = !done && !g.accountId && !!G?.database.roles["goal.saved"];

  // fire the celebration once the new value has landed (after the ring's settle)
  const prevDone = useRef(done);
  useEffect(() => {
    const was = prevDone.current;
    prevDone.current = done;
    if (!was && done && moment > 0) {
      // A C2 confirmation, not a moment (K3): the check and a toast, no particles.
      notify.success(`${g.name} is fully funded`);
    }
  }, [done, moment, g.name]);

  const contribute = async () => {
    const amt = num(amountRef.current);
    if (!G || amt <= 0) return;
    setBusy(true);
    try {
      const next = (s + amt).toFixed(2);
      await api.db.rowsUpdate({ updates: [{ id: g.id, values: { [G.database.roles["goal.saved"]]: V.money(next) } }] });
      setMoment((n) => n + 1);
      setAdding(false);
      setAmount(null);
      l.reload();
    } catch (e) {
      notify.fromError(e, "Couldn't add to the goal");
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="fh-goal" data-done={done ? "" : undefined}>
      <div className="flex items-start gap-3">
        <span className="flex-none mt-0.5 text-secondary" aria-hidden>
          {done ? <Check size={16} absoluteStrokeWidth strokeWidth={1.25} /> : <Glyph name={g.icon} size={16} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="m-0 truncate text-body font-semibold">{g.name}</h3>
          </div>
          <div className="text-caption text-tertiary">
            {g.kind === "emergency" ? "Emergency fund" : g.kind === "sinking" ? "Sinking fund" : "Savings goal"}
            {g.accountId ? ` · ${l.acct.get(g.accountId)?.name ?? ""}` : ""}
          </div>
          <div className="mt-2 tabular text-kpi">
            <span data-sensitive="">
              <RollingNumber value={Math.min(s, g.target)} format={(n) => fmtWhole(Math.round(n))} countUp={false} sensitive />
            </span>
            <span className="text-tertiary text-body-sm font-normal">
              {" "}
              / <Sensitive>{fmtWhole(g.target)}</Sensitive>
            </span>
          </div>
          <GoalBar ratio={ratio} className="mt-2" />
        </div>
        {done ? (
          <span className="text-caption text-secondary">Funded</span>
        ) : (
          <span className="text-caption text-secondary tabular font-medium">
            <RollingNumber value={Math.round(ratio * 100)} format={(n) => `${Math.round(n)}%`} countUp={false} />
          </span>
        )}
      </div>
      <div className="fh-goal-foot">
        <AnimatePresence mode="popLayout" initial={false}>
          {adding ? (
            <m.form
              key="add"
              className="flex items-center gap-2 w-full"
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 12, transition: { duration: 0.1 } }}
              transition={spring.settle}
              onSubmit={(e) => {
                e.preventDefault();
                (document.activeElement as HTMLElement | null)?.blur();
                window.setTimeout(() => void contribute(), 0);
              }}
            >
              <MoneyField size="sm" value={amount} onChange={setAmount} aria-label={`Amount to add to ${g.name}`} autoFocus placeholder={(g.target - s).toFixed(2)} wrapperClassName="flex-1" />
              <Button size="sm" variant="ghost" type="button" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" type="submit" loading={busy}>
                Add
              </Button>
            </m.form>
          ) : (
            <m.div key="info" className="flex items-center gap-2 w-full" initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12, transition: { duration: 0.1 } }} transition={spring.settle}>
              <span className="inline-flex items-center gap-1.5">
                <CalendarDays size={13} />
                {g.date ? `${dayLabel(g.date, true)}${left !== null && left > 0 ? ` · ${left < 60 ? `${left} days` : `${Math.round(left / 30.44)} months`}` : ""}` : "No date"}
              </span>
              <span className="ml-auto tabular">
                {done ? (
                  "Nothing more needed"
                ) : plan ? (
                  <>
                    <Sensitive>{fmtWhole(plan.monthlyRequired)}</Sensitive>/mo needed
                  </>
                ) : g.kind === "emergency" ? (
                  `${fmtWhole(g.target - s)} to go`
                ) : (
                  "Add a date to plan"
                )}
              </span>
              {canAdd ? (
                <Button size="xs" variant="secondary" icon={Plus} iconMotion="plus" onClick={() => setAdding(true)}>
                  Add money
                </Button>
              ) : null}
            </m.div>
          )}
        </AnimatePresence>
      </div>
    </article>
  );
}

function AddGoal({ onClose }: { onClose: () => void }) {
  const l = useLedgerCtx();
  const [name, setName] = useState("");
  const [target, setTarget] = useState<string | null>(null);
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const G = l.schemas.goals;
  const valid = !!G && name.trim() && num(target) > 0;
  const save = async () => {
    if (!valid || !G) return;
    setBusy(true);
    try {
      const r = G.database.roles;
      await api.db.rowCreate({
        databaseId: G.database.id,
        values: {
          [G.database.primaryPropId]: V.text(name.trim()),
          [r["goal.target"]]: V.money(num(target).toFixed(2)),
          ...(date ? { [r["goal.date"]]: V.date(date) } : {}),
          ...(r["goal.kind"] ? { [r["goal.kind"]]: V.sel("sinking") } : {}),
          ...(r["goal.saved"] ? { [r["goal.saved"]]: V.money("0.00") } : {}),
          ...(r["goal.icon"] ? { [r["goal.icon"]]: V.text("target") } : {}),
        },
      });
      notify.success("Goal added");
      l.reload();
      onClose();
    } catch (e) {
      notify.fromError(e, "Couldn't add the goal");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New goal"
      description="Name, target and an optional date. Ultranote works out the monthly amount."
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid} loading={busy} onClick={save}>
            Add goal
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Winter holiday" autoFocus />
        <div className="grid grid-cols-2 gap-3">
          <MoneyField label="Target" value={target} onChange={setTarget} />
          <Input label="By" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
      </div>
    </Dialog>
  );
}

/** Goal progress: a 4px ink bar on a flat track (no ring). Set, not animated, on arrival. */
function GoalBar({ ratio, className }: { ratio: number; className?: string }) {
  const r = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  return (
    <div className={cn("fh-meter", className)} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(r * 100)} aria-label="Saved toward target">
      <i style={{ transform: `scaleX(${r})` }} />
    </div>
  );
}
