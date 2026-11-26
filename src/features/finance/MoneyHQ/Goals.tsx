/**
 * Goals (§15.5, §16.2): emergency fund and sinking funds as progress rings with the monthly amount each needs
 * (`finance_goal_plan`, annuity form when a yield is set), on-track status, and a quick "add goal".
 */
import { CalendarDays, CheckCircle2, ExternalLink, Plus, Target } from "lucide-react";
import { m } from "motion/react";
import { useState } from "react";
import { api } from "@/backend";
import { navigate } from "@/app/router";
import { notify } from "@/stores/toasts";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { Dialog } from "@/ui/Dialog";
import { Input } from "@/ui/Input";
import { MoneyField } from "@/ui/MoneyField";
import { staggerItem, staggerList } from "@/ui/motion/presets";
import { Sensitive } from "@/ui/Sensitive";
import { Skeleton } from "@/ui/Skeleton";
import { dayLabel, daysBetween, fmtMoney, fmtPct, num, todayIso } from "../shared/format";
import { useAsync, V } from "../shared/hooks";
import { Glyph, Quiet } from "../shared/ui";
import { useLedgerCtx, type GoalRow } from "./ledger";
import { useMoney } from "./MoneyHQ";
import { BudgetRing } from "./widgets";

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

  if (l.loading) return <Skeleton height={360} radius={14} />;
  return (
    <div className="flex flex-col gap-4">
      <section className="fh-card flex items-center gap-6" style={{ padding: "18px 22px" }}>
        <BudgetRing ratio={totalTarget ? totalSaved / totalTarget : 0} size={72} stroke={7} color="var(--accent-solid)">
          <span className="text-body-sm font-semibold tabular">{totalTarget ? fmtPct(totalSaved / totalTarget, 0) : "0%"}</span>
        </BudgetRing>
        <div className="flex-1">
          <div className="text-caption text-secondary" style={{ fontWeight: 500 }}>
            Saved toward {l.goals.length} goals
          </div>
          <div className="tabular" style={{ fontSize: 26, lineHeight: "32px", fontWeight: 640, letterSpacing: "-0.022em" }}>
            <Sensitive>{fmtMoney(totalSaved, "USD", { noCents: true })}</Sensitive>
            <span className="text-tertiary" style={{ fontSize: 16, fontWeight: 500 }}>
              {" "}
              of <Sensitive>{fmtMoney(totalTarget, "USD", { noCents: true })}</Sensitive>
            </span>
          </div>
          <div className="text-body-sm text-tertiary">
            Needs about <Sensitive>{fmtMoney(monthly, "USD", { noCents: true })}</Sensitive> a month across dated goals
            {overview ? ` · emergency fund covers ${overview.efMonths.toFixed(1)} months of essentials` : ""}
          </div>
        </div>
        <Button variant="primary" size="sm" icon={Plus} onClick={() => setAdding(true)}>
          New goal
        </Button>
      </section>
      {!l.goals.length ? (
        <section className="fh-card">
          <Quiet icon={Target} title="No goals yet" body="Name something you're saving for and EMP works out the monthly amount it needs." action={<Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>New goal</Button>} />
        </section>
      ) : (
        <m.div className="fh-goals" variants={staggerList(0.05)} initial="hidden" animate="show">
          {l.goals.map((g, i) => {
            const s = saved(g);
            const ratio = g.target ? s / g.target : 0;
            const plan = plans.data?.[i];
            const left = g.date ? daysBetween(todayIso(), g.date) : null;
            const done = s >= g.target;
            return (
              <m.article key={g.id} variants={staggerItem} className="fh-goal">
                <div className="flex items-start gap-3">
                  <BudgetRing ratio={ratio} size={64} stroke={6} color={done ? "var(--gain)" : "var(--accent-solid)"}>
                    <Glyph name={g.icon} color={g.kind === "emergency" ? "green" : g.kind === "sinking" ? "blue" : "purple"} size={32} />
                  </BudgetRing>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <h3 className="m-0 truncate text-body font-semibold">{g.name}</h3>
                    </div>
                    <div className="text-caption text-tertiary" style={{ fontWeight: 400 }}>
                      {g.kind === "emergency" ? "Emergency fund" : g.kind === "sinking" ? "Sinking fund" : "Savings goal"}
                      {g.accountId ? ` · ${l.acct.get(g.accountId)?.name ?? ""}` : ""}
                    </div>
                    <div className="mt-2 tabular text-title" style={{ fontWeight: 620 }}>
                      <Sensitive>{fmtMoney(Math.min(s, g.target), "USD", { noCents: true })}</Sensitive>
                      <span className="text-tertiary text-body-sm font-normal">
                        {" "}
                        / <Sensitive>{fmtMoney(g.target, "USD", { noCents: true })}</Sensitive>
                      </span>
                    </div>
                  </div>
                  {done ? (
                    <Badge tone="gain" icon={CheckCircle2}>
                      Funded
                    </Badge>
                  ) : (
                    <span className="text-caption text-secondary tabular" style={{ fontWeight: 600 }}>
                      {fmtPct(ratio, 0)}
                    </span>
                  )}
                </div>
                <div className="fh-goal-foot">
                  <span className="inline-flex items-center gap-1.5">
                    <CalendarDays size={13} />
                    {g.date ? `${dayLabel(g.date, true)}${left !== null && left > 0 ? ` · ${left < 60 ? `${left} days` : `${Math.round(left / 30.44)} months`}` : ""}` : "No date"}
                  </span>
                  <span className="ml-auto tabular">
                    {done ? "Nothing more needed" : plan ? (
                      <>
                        <Sensitive>{fmtMoney(plan.monthlyRequired, "USD", { noCents: true })}</Sensitive>/mo needed
                      </>
                    ) : g.kind === "emergency" ? (
                      `${fmtMoney(g.target - s, "USD", { noCents: true })} to go`
                    ) : (
                      "Add a date to plan"
                    )}
                  </span>
                </div>
              </m.article>
            );
          })}
        </m.div>
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
      description="Name it, set a target and (optionally) a date — EMP works out the monthly amount."
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
