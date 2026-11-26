/**
 * Insights feed (§16.1 advisor): ranked critical > warn > tip > info — panels with an engraved severity groove, each
 * with actions, "Show math" (the card morphs open in place on the `morph` spring, rows stagger in — the S10 behaviour
 * for insight cards) and dismiss (snooze a week / don't show again). Used by app hubs, Life OS Today and Home.
 */
import { ArrowRight, BellOff, Calculator, Clock, Lightbulb, X } from "lucide-react";
import { AnimatePresence, LayoutGroup, m } from "motion/react";
import { useId, useState } from "react";
import type { Id, Insight } from "@/backend/types";
import { navigate } from "@/app/router";
import { useWorkspace } from "@/stores/workspace";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/Menu";
import { Skeleton } from "@/ui/Skeleton";
import { spring } from "@/ui/motion/tokens";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { AppTile } from "./AppTile";
import { useInsights } from "./data";
import { identity } from "./identity";

const WEEK = 7 * 86_400_000;

function InsightCard({ i, showApp, compact, onDismiss }: { i: Insight; showApp: boolean; compact?: boolean; onDismiss: (i: Insight, until: number | null) => void }) {
  const appId = useWorkspace((s) => s.lifeapps.find((x) => x.id === i.appInstanceId)?.appId ?? "");
  const reduced = useReducedMotionPref();
  const [math, setMath] = useState(false);
  const mathId = useId();
  return (
    <m.li
      layout
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0, transition: spring.settle }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, x: 16, transition: { duration: 0.14, ease: [0.4, 0, 1, 1] } }}
      transition={{ layout: spring.morph }}
      className={compact ? "la-insight is-compact panel" : "la-insight panel"}
      data-sev={i.severity}
    >
      <span className="la-insight-sev" aria-hidden />
      {showApp && appId ? (
        <AppTile appId={appId} size="sm" className="mt-px" label={identity(appId).name} />
      ) : (
        <span className="la-insight-glyph" aria-hidden>
          <Lightbulb size={13} />
        </span>
      )}
      <m.div layout="position" transition={spring.morph} className="min-w-0 flex-1">
        <div className="la-insight-title">{i.title}</div>
        <p className="la-insight-body">{i.body}</p>
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pb-0.5">
          {(compact ? i.actions.slice(0, 1) : i.actions).map((a) => (
            <Button key={a.label} size="xs" variant="soft" iconRight={ArrowRight} iconMotion="arrow" onClick={() => navigate(a.route)}>
              {a.label}
            </Button>
          ))}
          {i.math?.length ? (
            <Button size="xs" variant="ghost" icon={Calculator} active={math} aria-expanded={math} aria-controls={mathId} onClick={() => setMath((v) => !v)}>
              {math ? "Hide math" : "Show math"}
            </Button>
          ) : null}
        </div>
        {/* "Show math" morphs the card open in place (S10 behaviour): the rows rise in on a 24ms stagger. */}
        <AnimatePresence initial={false}>
          {math && i.math?.length ? (
            <m.div key="math" id={mathId} className="la-math-panel well" data-static="" initial={reduced ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1, transition: spring.settle }} exit={{ opacity: 0, transition: { duration: 0.1 } }} style={{ originY: 0 }}>
              <dl className="la-math">
                {i.math.map((x, k) => (
                  <m.div key={k} className="contents" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { delay: reduced ? 0 : 0.06 + k * 0.024, duration: 0.18 } }}>
                    <dt>
                      {x.label}
                      {x.source ? <span className="block text-[11px] text-tertiary">{x.source}</span> : null}
                    </dt>
                    <dd>{x.value}</dd>
                  </m.div>
                ))}
              </dl>
              <p className="mt-2.5 text-[11px] text-tertiary">Estimates and common guidelines, not advice.</p>
            </m.div>
          ) : null}
        </AnimatePresence>
      </m.div>
      <Menu>
        <MenuTrigger asChild>
          <IconButton className="la-insight-x" icon={X} label="Dismiss" size="xs" />
        </MenuTrigger>
        <MenuContent align="end" width={200}>
          <MenuItem icon={Clock} onSelect={() => onDismiss(i, Date.now() + WEEK)}>
            Snooze for a week
          </MenuItem>
          <MenuItem icon={BellOff} onSelect={() => onDismiss(i, null)}>
            Don’t show this again
          </MenuItem>
        </MenuContent>
      </Menu>
    </m.li>
  );
}

export function InsightsFeed({ instanceId, limit = 6, showApp, empty, compact }: { instanceId?: Id; limit?: number; showApp?: boolean; empty?: string; compact?: boolean }) {
  const { insights, dismiss } = useInsights(instanceId);
  if (!insights)
    return (
      <div className="flex flex-col gap-2">
        <Skeleton height={76} radius={12} />
        <Skeleton height={76} radius={12} />
      </div>
    );
  const shown = insights.slice(0, limit);
  if (!shown.length) return <p className="well rounded-xl px-4 py-5 text-center text-body-sm text-tertiary" data-static="">{empty ?? "Nothing needs your attention."}</p>;
  return (
    <LayoutGroup>
      <ul className="flex flex-col gap-2.5" aria-live="polite">
        <AnimatePresence initial={false} mode="popLayout">
          {shown.map((i) => (
            <InsightCard key={i.id} i={i} showApp={showApp ?? !instanceId} compact={compact} onDismiss={dismiss} />
          ))}
        </AnimatePresence>
      </ul>
    </LayoutGroup>
  );
}
