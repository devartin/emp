/**
 * The race: avalanche vs snowball, month by month. Two runners (the icon's mini-slab) cross recessed tracks on one
 * shared clock; each notch lights as that lane clears a debt, the lit fill follows the runner and the interest ticker
 * counts what each lane has paid so far. At the line the lane with less interest takes the trophy (pop + gain glow).
 * Click or any key skips to the end; reduced motion shows the finished race.
 */
import { RotateCcw, Trophy } from "lucide-react";
import { animate, m, useMotionValue, useMotionValueEvent, useTransform, type MotionValue } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DebtPlan } from "@/backend/types";
import { Button } from "@/ui/Button";
import { spring } from "@/ui/motion/tokens";
import { isReducedMotion, usePrivacy } from "@/ui/motion/useReducedEffects";
import { monthLabel, num, fmtWhole } from "./shared/format";

interface DebtIn {
  name: string;
  balance: string;
}

interface Lane {
  id: "avalanche" | "snowball";
  title: string;
  months: number;
  payoff: string;
  interest: number[];
  checkpoints: { name: string; at: number }[];
}

function buildLane(id: Lane["id"], title: string, plan: DebtPlan, debts: DebtIn[]): Lane {
  const sched = plan.schedule;
  const interest: number[] = [0];
  let prev = debts.reduce((a, d) => a + num(d.balance), 0);
  let cum = 0;
  for (const row of sched) {
    const bal = Object.values(row.balances).reduce((a, v) => a + num(v), 0);
    const paid = Object.values(row.payments).reduce((a, v) => a + num(v), 0);
    cum += Math.max(0, paid - (prev - bal));
    interest.push(cum);
    prev = bal;
  }
  // The ticker must land on the plan's own total (the figure the strategy cards quote): scale the derived curve to it.
  const s = plan.strategies.find((x) => x.strategy === id);
  const total = s ? num(s.totalInterest) : cum;
  if (cum > 0 && Math.abs(total - cum) > 0.005) for (let k = 0; k < interest.length; k++) interest[k] = (interest[k] * total) / cum;
  else if (cum === 0 && total > 0) for (let k = 0; k < interest.length; k++) interest[k] = (total * k) / Math.max(1, interest.length - 1);
  const checkpoints = debts
    .map((d) => ({ name: d.name, at: sched.findIndex((r) => num(r.balances[d.name]) <= 0.004) + 1 }))
    .filter((c) => c.at > 0)
    .sort((a, b) => a.at - b.at);
  return { id, title, months: sched.length, payoff: s?.payoffDate ?? sched[sched.length - 1]?.month ?? "", interest, checkpoints };
}

export function DebtRace({ plans, debts, minimumLabel }: { plans: Record<string, DebtPlan>; debts: DebtIn[]; minimumLabel?: string }) {
  const lanes = useMemo<Lane[]>(() => [buildLane("avalanche", "Avalanche", plans.avalanche, debts), buildLane("snowball", "Snowball", plans.snowball, debts)], [plans, debts]);
  const maxMonths = Math.max(1, ...lanes.map((l) => l.months));
  const clock = useMotionValue(0);
  const [done, setDone] = useState(false);
  const [run, setRun] = useState(0);
  const ctl = useRef<ReturnType<typeof animate> | null>(null);
  const key = lanes.map((l) => `${l.months}:${Math.round(l.interest[l.interest.length - 1] ?? 0)}`).join("|");

  const finish = useCallback(() => {
    ctl.current?.stop();
    clock.set(maxMonths);
    setDone(true);
  }, [clock, maxMonths]);

  useEffect(() => {
    ctl.current?.stop();
    if (isReducedMotion()) {
      clock.set(maxMonths);
      setDone(true);
      return;
    }
    setDone(false);
    clock.set(0);
    // the race runs on one clock: ~2.6s for the full field, eased so the start and the finish read
    ctl.current = animate(clock, maxMonths, { duration: Math.min(3.2, 1.6 + maxMonths / 40), ease: [0.45, 0, 0.25, 1], delay: 0.25 });
    ctl.current.then(() => setDone(true));
    return () => ctl.current?.stop();
  }, [key, run, clock, maxMonths]);

  useEffect(() => {
    if (done) return;
    const onKey = () => finish();
    window.addEventListener("keydown", onKey, { once: true });
    return () => window.removeEventListener("keydown", onKey);
  }, [done, finish]);

  const totals = lanes.map((l) => l.interest[l.interest.length - 1] ?? 0);
  const winner = totals[0] === totals[1] ? (lanes[0].months <= lanes[1].months ? 0 : 1) : totals[0] < totals[1] ? 0 : 1;
  const diff = Math.abs(totals[0] - totals[1]);

  return (
    <div className="fh-race" onClick={done ? undefined : finish} data-done={done ? "" : undefined}>
      <div className="fh-race-scale" aria-hidden>
        <span>Today</span>
        <span>{monthLabel(lanes[winner].payoff)}</span>
      </div>
      {lanes.map((l, i) => (
        <RaceLane key={l.id} lane={l} clock={clock} maxMonths={maxMonths} won={done && i === winner} lost={done && i !== winner} />
      ))}
      <div className="fh-race-foot">
        <span className="text-caption text-tertiary" style={{ fontWeight: 400 }}>
          {done ? (
            <>
              <b className="text-primary" style={{ fontWeight: 600 }}>
                {lanes[winner].title}
              </b>{" "}
              saves <span data-sensitive="">{fmtWhole(diff)}</span> in interest
              {lanes[0].months !== lanes[1].months ? ` and finishes ${Math.abs(lanes[0].months - lanes[1].months)} months ${lanes[winner].months < lanes[1 - winner].months ? "sooner" : "later"}` : ", same finish month"}
              {minimumLabel ? ` · minimums alone: ${minimumLabel}` : ""}
            </>
          ) : (
            "Click to skip"
          )}
        </span>
        <Button
          size="xs"
          variant="ghost"
          icon={RotateCcw}
          iconMotion="refresh"
          onClick={(e) => {
            e.stopPropagation();
            setRun((n) => n + 1);
          }}
        >
          Replay
        </Button>
      </div>
    </div>
  );
}

function RaceLane({ lane, clock, maxMonths, won, lost }: { lane: Lane; clock: MotionValue<number>; maxMonths: number; won: boolean; lost: boolean }) {
  const privacy = usePrivacy();
  const end = lane.months / maxMonths;
  const t = useTransform(clock, (c) => Math.min(c, lane.months));
  const x = useTransform(t, (v) => `${(v / maxMonths) * 100}%`);
  const fill = useTransform(t, (v) => v / maxMonths);
  const interest = useTransform(t, (v) => {
    const i = Math.min(lane.interest.length - 1, Math.max(0, Math.floor(v)));
    const a = lane.interest[i] ?? 0;
    const b = lane.interest[Math.min(lane.interest.length - 1, i + 1)] ?? a;
    return privacy ? "•••" : fmtWhole(a + (b - a) * (v - Math.floor(v)));
  });
  const [passed, setPassed] = useState(0);
  useMotionValueEvent(t, "change", (v) => {
    const n = lane.checkpoints.filter((c) => c.at <= v + 0.001).length;
    if (n !== passed) setPassed(n);
  });
  useEffect(() => {
    setPassed(lane.checkpoints.filter((c) => c.at <= t.get() + 0.001).length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lane]);
  return (
    <div className="fh-race-lane" data-won={won ? "" : undefined} data-lost={lost ? "" : undefined}>
      <div className="fh-race-name">
        <span className="text-body-sm font-semibold">{lane.title}</span>
        <span className="fh-race-interest tabular" data-sensitive="">
          <m.span>{interest}</m.span> interest
        </span>
      </div>
      <div className="fh-race-track">
        <m.i className="fh-race-fill" style={{ scaleX: fill, originX: 0 }} />
        {lane.checkpoints.map((c, k) => (
          <span key={c.name} className="fh-race-cp" style={{ left: `${(c.at / maxMonths) * 100}%` }} data-passed={k < passed ? "" : undefined} data-end={c.at / maxMonths > 0.9 ? "" : undefined} title={`${c.name} cleared · month ${c.at}`}>
            <span className="fh-race-cp-label">{shortName(c.name)}</span>
          </span>
        ))}
        <span className="fh-race-flag" style={{ left: `${end * 100}%` }} aria-hidden />
        <m.span className="fh-race-runner-rail" style={{ x }} aria-hidden>
          <span className="fh-race-runner">
            <RunnerSlab />
          </span>
        </m.span>
      </div>
      <div className="fh-race-result tabular">
        <span>{monthLabel(lane.payoff)}</span>
        {won ? (
          <m.span className="fh-race-trophy" initial={{ scale: 0.2, opacity: 0, rotate: -20 }} animate={{ scale: 1, opacity: 1, rotate: 0 }} transition={spring.pop}>
            <Trophy size={12} strokeWidth={2.4} />
          </m.span>
        ) : null}
      </div>
    </div>
  );
}

function shortName(name: string): string {
  const w = name.split(/\s+/).filter(Boolean)[0] ?? name;
  return w.length > 10 ? `${w.slice(0, 9)}…` : w;
}

/** The icon's slab geometry: top rhombus + two side faces, ink-toned. */
function RunnerSlab() {
  return (
    <svg width="22" height="22" viewBox="0 0 20 20" aria-hidden>
      <path d="M10 3 18 7.2 10 11.4 2 7.2Z" style={{ fill: "var(--chart-line)" }} />
      <path d="M2 7.2 10 11.4V15.4L2 11.2Z" style={{ fill: "color-mix(in oklab, var(--chart-line) 62%, var(--bg-canvas))" }} />
      <path d="M18 7.2 10 11.4V15.4L18 11.2Z" style={{ fill: "color-mix(in oklab, var(--chart-line) 40%, var(--bg-canvas))" }} />
    </svg>
  );
}
