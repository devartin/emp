/**
 * Insights feed (§16.1 advisor): ranked critical > warn > tip > info, each with "Show math", actions and dismiss
 * (snooze a week / don't show again). Used by app hubs, Life OS Today and Home (all apps).
 */
import { BellOff, Calculator, Clock, Lightbulb, X } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import type { Id, Insight } from "@/backend/types";
import { navigate } from "@/app/router";
import { useWorkspace } from "@/stores/workspace";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/Menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/Popover";
import { Skeleton } from "@/ui/Skeleton";
import { spring } from "@/ui/motion/tokens";
import { useInsights } from "./data";
import { identity } from "./identity";

const WEEK = 7 * 86_400_000;

function InsightCard({ i, showApp, compact, onDismiss }: { i: Insight; showApp: boolean; compact?: boolean; onDismiss: (i: Insight, until: number | null) => void }) {
  const appId = useWorkspace((s) => s.lifeapps.find((x) => x.id === i.appInstanceId)?.appId ?? "");
  const id = identity(appId);
  const Icon = id.icon;
  return (
    <m.li layout="position" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0, transition: spring.gentle }} exit={{ opacity: 0, x: 16, transition: { duration: 0.16 } }} className={compact ? "la-insight is-compact" : "la-insight"} data-sev={i.severity}>
      {showApp ? (
        <span className="la-tile la-tile-sm mt-0.5" style={{ background: id.color }} title={id.name}>
          <Icon size={12} strokeWidth={2.25} aria-hidden />
        </span>
      ) : (
        <Lightbulb size={16} className="mt-0.5 flex-none text-tertiary" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <div className="la-insight-title">{i.title}</div>
        <p className="la-insight-body">{i.body}</p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {(compact ? i.actions.slice(0, 1) : i.actions).map((a) => (
            <Button key={a.label} size="xs" variant="soft" onClick={() => navigate(a.route)}>
              {a.label}
            </Button>
          ))}
          {i.math?.length ? (
            <Popover>
              <PopoverTrigger asChild>
                <Button size="xs" variant="ghost" icon={Calculator}>
                  Show math
                </Button>
              </PopoverTrigger>
              <PopoverContent side="bottom" align="start" className="w-[280px]">
                <dl className="la-math">
                  {i.math.map((x, k) => (
                    <div key={k} className="contents">
                      <dt>
                        {x.label}
                        {x.source ? <span className="block text-[11px] text-tertiary">{x.source}</span> : null}
                      </dt>
                      <dd>{x.value}</dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-3 text-[11px] text-tertiary">Estimates and common guidelines, not advice.</p>
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
      </div>
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
  if (!shown.length) return <p className="rounded-xl bg-surface-2 px-4 py-5 text-center text-body-sm text-tertiary">{empty ?? "Nothing needs your attention."}</p>;
  return (
    <ul className="flex flex-col gap-2" aria-live="polite">
      <AnimatePresence initial={false}>
        {shown.map((i) => (
          <InsightCard key={i.id} i={i} showApp={showApp ?? !instanceId} compact={compact} onDismiss={dismiss} />
        ))}
      </AnimatePresence>
    </ul>
  );
}
