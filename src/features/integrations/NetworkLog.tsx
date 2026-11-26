/**
 * Network log (§9.18 / §6.6 Network card): the offline switch and the last 1,000 requests EMP made — connector,
 * method, host, path template (never query strings), status and size — virtualised, filterable, live-updating on
 * `net:activity`. No telemetry, ever: this table is the whole story.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { CloudOff, Globe, RefreshCw, ShieldCheck } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, listen } from "@/backend";
import type { NetworkLogEntry } from "@/backend/types";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { useSettings } from "@/stores/settings";
import { notify } from "@/stores/toasts";
import { Button } from "@/ui/Button";
import { SearchField } from "@/ui/SearchField";
import { Select } from "@/ui/Select";
import { Switch } from "@/ui/Switch";
import "./integrations.css";

const CONNECTOR_LABEL: Record<string, string> = { google: "Google", frankfurter: "Frankfurter", stooq: "Stooq", coingecko: "CoinGecko", finnhub: "Finnhub", tiingo: "Tiingo", yahoo: "Yahoo", updater: "Updates", "remote-image": "Images" };

function time(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function OfflineSwitch() {
  const offline = useSettings((s) => s.vault?.offline ?? false);
  const [busy, setBusy] = useState(false);
  const set = async (on: boolean) => {
    setBusy(true);
    try {
      await api.network.setOffline({ offline: on });
      await useSettings.getState().load();
      notify.info(on ? "Offline mode is on" : "Offline mode is off", { description: on ? "EMP won’t make any network requests, including update checks." : undefined });
    } catch (e) {
      notify.fromError(e, "Couldn’t change offline mode");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cn("ig-offline", offline && "is-on")}>
      <span className="ig-offline-ico" aria-hidden>
        {offline ? <CloudOff size={16} /> : <Globe size={16} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-body font-semibold text-primary">Offline mode</div>
        <div className="text-caption text-secondary">{offline ? "Every request is refused — Google, market data and updates." : "EMP only contacts services you’ve connected."}</div>
      </div>
      <Switch checked={offline} disabled={busy} onCheckedChange={(v) => void set(v)} aria-label="Offline mode" />
    </div>
  );
}

export function NetworkLog({ limit = 1000, height = 420 }: { limit?: number; height?: number }) {
  const [rows, setRows] = useState<NetworkLogEntry[] | null>(null);
  const [q, setQ] = useState("");
  const [connector, setConnector] = useState("all");
  const [fresh, setFresh] = useState<number>(0);
  const load = useCallback(() => {
    api.network.activity({ limit }).then(setRows).catch(() => setRows([]));
  }, [limit]);
  useEffect(() => load(), [load]);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = listen("net:activity", () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        load();
        setFresh(Date.now());
      }, 250);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  }, [load]);

  const connectors = useMemo(() => ["all", ...new Set((rows ?? []).map((r) => r.connector))], [rows]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (rows ?? []).filter((r) => (connector === "all" || r.connector === connector) && (!needle || `${r.host} ${r.path} ${r.method} ${r.status}`.toLowerCase().includes(needle)));
  }, [rows, q, connector]);
  const totals = useMemo(() => ({ n: shown.length, bytes: shown.reduce((s, r) => s + r.bytes, 0), failed: shown.filter((r) => r.status >= 400 || r.status === 0).length }), [shown]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: shown.length, getScrollElement: () => scrollRef.current, estimateSize: () => 36, overscan: 8 });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchField size="sm" placeholder="Filter by host, path or status" value={q} onChange={(e) => setQ(e.currentTarget.value)} shortcut={null} wrapperClassName="min-w-[220px] flex-1" />
        <Select size="sm" value={connector} onValueChange={setConnector} options={connectors.map((c) => ({ value: c, label: c === "all" ? "All services" : CONNECTOR_LABEL[c] ?? c }))} aria-label="Service" />
        <Button size="sm" variant="ghost" icon={RefreshCw} onClick={load}>
          Refresh
        </Button>
      </div>
      <div className="ig-log" role="table" aria-label="Network requests" aria-rowcount={shown.length}>
        <div className="ig-log-head" role="row">
          <span role="columnheader">Time</span>
          <span role="columnheader">Service</span>
          <span role="columnheader">Request</span>
          <span role="columnheader" className="text-right">Status</span>
          <span role="columnheader" className="text-right">Size</span>
        </div>
        <div ref={scrollRef} className="ig-log-body" style={{ height }}>
          {rows && !shown.length ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <ShieldCheck size={20} className="text-tertiary" aria-hidden />
              <p className="text-body-sm text-secondary">{rows.length ? "No requests match." : "No network requests yet."}</p>
            </div>
          ) : null}
          <div style={{ height: v.getTotalSize(), position: "relative" }}>
            {v.getVirtualItems().map((it) => {
              const r = shown[it.index];
              const failed = r.status >= 400 || r.status === 0;
              const isNew = fresh && it.index === 0 && Date.now() - fresh < 1500;
              return (
                <div key={it.key} role="row" className={cn("ig-log-row", isNew && "is-new")} style={{ position: "absolute", top: 0, left: 0, right: 0, height: it.size, transform: `translateY(${it.start}px)` }}>
                  <span role="cell" className="tabular text-tertiary">{time(r.at)}</span>
                  <span role="cell" className="truncate">{CONNECTOR_LABEL[r.connector] ?? r.connector}</span>
                  <span role="cell" className="min-w-0 truncate" title={`${r.method} ${r.host}${r.path}`}>
                    <span className="ig-method">{r.method}</span>
                    <span className="text-secondary">{r.host}</span>
                    <span className="text-tertiary">{r.path}</span>
                  </span>
                  <span role="cell" className="text-right">
                    <span className={cn("ig-status", failed ? "is-bad" : "is-ok")}>{r.status || "—"}</span>
                  </span>
                  <span role="cell" className="tabular text-right text-tertiary">{r.bytes ? formatBytes(r.bytes) : "—"}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <AnimatePresence initial={false}>
        {rows ? (
          <m.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-2 text-caption text-tertiary">
            <span className="tabular">
              {totals.n.toLocaleString()} requests · {formatBytes(totals.bytes)}
              {totals.failed ? ` · ${totals.failed} failed` : ""}
            </span>
            <span aria-hidden>·</span>
            Query strings are never logged. EMP sends no telemetry.
          </m.p>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export default NetworkLog;
