/**
 * Insights (§16.1 advisor), ranked critical > warn > tip > info and rendered as plain ruled lines: the fact, then one
 * verb that does something about it (PROGRAMME-v3: no cards, severity bars, lightbulbs, trailing arrows or extra
 * "show math" controls). Dismiss lives in a menu that appears on hover or focus: snooze a week or never again.
 */
import { BellOff, Clock, Ellipsis } from "lucide-react";
import type { Id, Insight } from "@/backend/types";
import { navigate } from "@/app/router";
import { cn } from "@/lib/cn";
import { useWorkspace } from "@/stores/workspace";
import { IconButton } from "@/ui/IconButton";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/Menu";
import { Skeleton } from "@/ui/Skeleton";
import { useInsights } from "./data";
import { identity } from "./identity";

const WEEK = 7 * 86_400_000;

function InsightLine({ i, showApp, compact, onDismiss }: { i: Insight; showApp: boolean; compact?: boolean; onDismiss: (i: Insight, until: number | null) => void }) {
  const appId = useWorkspace((s) => s.lifeapps.find((x) => x.id === i.appInstanceId)?.appId ?? "");
  const action = i.actions[0];
  return (
    <li className={cn("la-insight", compact && "is-compact")} data-sev={i.severity}>
      <div className="min-w-0 flex-1">
        <div className="la-insight-title">
          {showApp && appId ? <span className="la-insight-app">{identity(appId).name} · </span> : null}
          {i.title}
        </div>
        {i.body ? <p className="la-insight-body">{i.body}</p> : null}
        {action ? (
          <button type="button" className="la-insight-act" onClick={() => navigate(action.route)}>
            {action.label}
          </button>
        ) : null}
      </div>
      <Menu>
        <MenuTrigger asChild>
          <IconButton className="la-insight-x" icon={Ellipsis} label="Dismiss" size="xs" />
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
    </li>
  );
}

export function InsightsFeed({ instanceId, limit = 6, showApp, empty, compact }: { instanceId?: Id; limit?: number; showApp?: boolean; empty?: string; compact?: boolean }) {
  const { insights, dismiss } = useInsights(instanceId);
  if (!insights)
    return (
      <div className="flex flex-col gap-2" data-route-busy="">
        <Skeleton height={20} radius={4} />
        <Skeleton height={20} radius={4} />
      </div>
    );
  const shown = insights.slice(0, limit);
  if (!shown.length) return <p className="py-2 text-body-sm text-tertiary">{empty ?? "Nothing to note."}</p>;
  return (
    <ul className="la-insights" aria-live="polite">
      {shown.map((i) => (
        <InsightLine key={i.id} i={i} showApp={showApp ?? !instanceId} compact={compact} onDismiss={dismiss} />
      ))}
    </ul>
  );
}
