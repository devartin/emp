/** Shared fetchers for Home widgets (each widget loads its own slice; db:changed refreshes). */
import { useCallback, useEffect, useState } from "react";
import { api, listen } from "@/backend";
import type { CalendarEvent, FinanceOverview, NetWorthSeries, PortfolioSummary } from "@/backend/types";
import { useWorkspace } from "@/stores/workspace";
import { localDay } from "@/features/lifeapps/cells";

export function useAppInstance(appId: string) {
  return useWorkspace((s) => s.lifeapps.find((i) => i.appId === appId && !i.detached));
}

function useRefetch(fn: () => void, deps: unknown[]) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cb = useCallback(fn, deps);
  useEffect(() => {
    cb();
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = listen("db:changed", () => {
      if (t) clearTimeout(t);
      t = setTimeout(cb, 400);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  }, [cb]);
}

export function useMoney() {
  const money = useAppInstance("money-hq");
  const pf = useAppInstance("portfolio");
  const [overview, setOverview] = useState<FinanceOverview | null | undefined>(undefined);
  const [series, setSeries] = useState<NetWorthSeries | null>(null);
  const [portfolio, setPortfolio] = useState<PortfolioSummary | null | undefined>(undefined);
  useRefetch(() => {
    if (!money) {
      setOverview(null);
      return;
    }
    const month = localDay().slice(0, 7);
    api.finance.overview({ instanceId: money.id, month }).then(setOverview).catch(() => setOverview(null));
    api.finance.networthSeries({ instanceId: money.id, range: "1y" }).then(setSeries).catch(() => setSeries(null));
  }, [money?.id]);
  useRefetch(() => {
    if (!pf) {
      setPortfolio(null);
      return;
    }
    api.portfolio.summary({ instanceId: pf.id }).then(setPortfolio).catch(() => setPortfolio(null));
  }, [pf?.id]);
  return { money, pf, overview, series, portfolio };
}

export function useUpcomingEvents(days = 2) {
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  useRefetch(() => {
    const from = localDay();
    const d = new Date();
    d.setDate(d.getDate() + days);
    api.calendar.events({ from, to: localDay(d) }).then(setEvents).catch(() => setEvents([]));
  }, [days]);
  return events;
}
