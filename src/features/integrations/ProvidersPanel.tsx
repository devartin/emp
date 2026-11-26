/**
 * Market data providers (§17.2): keyless providers on by default, keyed ones off until a key is added (stored as a
 * write-only secret via SecretField), health dots, a connection test with latency, reorderable fallback priority and
 * the required disclosure. Settings → Market data and the Portfolio wizard both render this.
 */
import { ArrowDown, ArrowUp, ExternalLink, KeyRound, PlugZap, ShieldCheck } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "@/backend";
import type { ProviderInfo } from "@/backend/types";
import { cn } from "@/lib/cn";
import { notify } from "@/stores/toasts";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { SecretField } from "@/ui/SecretField";
import { Skeleton } from "@/ui/Skeleton";
import { Switch } from "@/ui/Switch";
import { Tooltip } from "@/ui/Tooltip";
import { spring } from "@/ui/motion/tokens";
import "./integrations.css";

const CAP_LABEL: Record<string, string> = { quote: "Quotes", daily: "Daily history", intraday: "Intraday", search: "Search", fx: "FX", crypto: "Crypto", dividends: "Dividends" };
const HEALTH: Record<ProviderInfo["health"], { label: string; cls: string }> = {
  ok: { label: "Healthy", cls: "is-ok" },
  degraded: { label: "Slow or rate-limited", cls: "is-warn" },
  down: { label: "Failing — paused for 5 minutes", cls: "is-down" },
  unknown: { label: "Not checked yet", cls: "is-unknown" },
};

export const PROVIDER_DISCLOSURE = "Providers see which symbols you look up and your IP address. EMP never sends quantities, cost basis, account names or balances.";

function ProviderRow({ p, index, count, onChange, onMove }: { p: ProviderInfo; index: number; count: number; onChange: (p: ProviderInfo) => void; onMove: (dir: -1 | 1) => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; latencyMs: number; error?: string } | null>(null);
  const configure = async (patch: { enabled: boolean; apiKey?: string | null }) => {
    setBusy(true);
    try {
      const next = await api.market.providerConfigure({ id: p.id, ...patch });
      onChange(next);
      if (patch.apiKey) {
        setKey("");
        setEditing(false);
        notify.success(`${p.name} key saved`, { description: "Stored encrypted. Only sent to " + p.name + "." });
      }
    } catch (e) {
      notify.fromError(e, `Couldn’t update ${p.name}`);
    } finally {
      setBusy(false);
    }
  };
  const runTest = async () => {
    setTest(null);
    setBusy(true);
    try {
      setTest(await api.market.providerTest({ id: p.id }));
    } catch (e) {
      setTest({ ok: false, latencyMs: 0, error: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const h = HEALTH[p.health];
  return (
    <m.li layout transition={spring.layout} className="ig-prov">
      <div className="flex items-center gap-3">
        <div className="flex flex-col">
          <IconButton size="xs" icon={ArrowUp} label="Higher priority" disabled={index === 0} onClick={() => onMove(-1)} />
          <IconButton size="xs" icon={ArrowDown} label="Lower priority" disabled={index === count - 1} onClick={() => onMove(1)} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Tooltip content={h.label}>
              <span className={cn("ig-health", h.cls)} aria-label={h.label} />
            </Tooltip>
            <span className="text-body font-semibold text-primary">{p.name}</span>
            {p.needsKey ? <Badge tone="outline" icon={KeyRound}>Key</Badge> : <Badge tone="neutral">Keyless</Badge>}
            {p.community ? <Badge tone="warning">Community source</Badge> : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-tertiary">
            <span>{p.caps.map((c) => CAP_LABEL[c] ?? c).join(" · ")}</span>
            <span aria-hidden>·</span>
            <span>{p.rateLimit}</span>
            <button type="button" className="ig-terms" onClick={() => api.open.external({ url: p.termsUrl }).catch(() => undefined)}>
              Terms <ExternalLink size={10} aria-hidden />
            </button>
          </div>
        </div>
        <Switch
          checked={p.enabled}
          disabled={busy || (p.needsKey && !p.configured)}
          onCheckedChange={(on) => void configure({ enabled: on })}
          aria-label={`Use ${p.name}`}
        />
      </div>
      {p.needsKey ? (
        <div className="mt-3 flex flex-col gap-2 pl-[38px]">
          {p.configured && !editing ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex items-center gap-1.5 text-caption text-gain-text">
                <ShieldCheck size={13} aria-hidden /> Key saved
              </span>
              <Button size="xs" variant="ghost" onClick={() => setEditing(true)}>
                Replace
              </Button>
              <Button size="xs" variant="ghost" onClick={() => void configure({ enabled: false, apiKey: null })}>
                Remove
              </Button>
              <Button size="xs" variant="soft" icon={PlugZap} loading={busy && !test} onClick={runTest}>
                Test
              </Button>
            </div>
          ) : (
            <div className="flex items-end gap-2">
              <SecretField size="sm" placeholder={`${p.name} API key`} value={key} onChange={(e) => setKey(e.currentTarget.value)} wrapperClassName="flex-1" aria-label={`${p.name} API key`} />
              <Button size="sm" variant="primary" disabled={!key.trim() || busy} loading={busy} onClick={() => void configure({ enabled: true, apiKey: key.trim() })}>
                Save key
              </Button>
              {editing ? (
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              ) : null}
            </div>
          )}
        </div>
      ) : (
        <div className="mt-2 pl-[38px]">
          <Button size="xs" variant="ghost" icon={PlugZap} loading={busy && !test} onClick={runTest}>
            Test connection
          </Button>
        </div>
      )}
      <AnimatePresence>
        {test ? (
          <m.p initial={{ opacity: 0, y: -2 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className={cn("mt-2 pl-[38px] text-caption", test.ok ? "text-gain-text" : "text-loss-text")} role="status">
            {test.ok ? `Reached ${p.name} in ${test.latencyMs} ms.` : test.error ?? "The provider didn’t respond."}
          </m.p>
        ) : null}
      </AnimatePresence>
    </m.li>
  );
}

export function ProvidersPanel({ compact }: { compact?: boolean }) {
  const [list, setList] = useState<ProviderInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.market
      .providers()
      .then((l) => {
        setList(l);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(() => load(), [load]);

  const move = async (i: number, dir: -1 | 1) => {
    if (!list) return;
    const next = [...list];
    const [x] = next.splice(i, 1);
    next.splice(i + dir, 0, x);
    setList(next);
    try {
      await Promise.all(next.map((p, idx) => api.market.providerConfigure({ id: p.id, enabled: p.enabled, priority: idx })));
    } catch (e) {
      notify.fromError(e, "Couldn’t reorder providers");
      load();
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {!compact ? (
        <div>
          <h2 className="text-title text-primary">Market data</h2>
          <p className="mt-1 text-body-sm text-secondary">Quotes, history and FX come from these providers, tried in order. Keyless sources work out of the box; keys unlock fresher quotes.</p>
        </div>
      ) : null}
      {error ? <p className="text-body-sm text-loss-text">{error}</p> : null}
      {!list && !error ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} height={64} radius={12} />
          ))}
        </div>
      ) : null}
      {list ? (
        <ul className="flex flex-col gap-2">
          {list.map((p, i) => (
            <ProviderRow key={p.id} p={p} index={i} count={list.length} onChange={(np) => setList((l) => l?.map((x) => (x.id === np.id ? np : x)) ?? l)} onMove={(d) => void move(i, d)} />
          ))}
        </ul>
      ) : null}
      <p className="flex items-start gap-2 text-caption text-tertiary">
        <ShieldCheck size={14} className="mt-px flex-none" aria-hidden />
        {PROVIDER_DISCLOSURE}
      </p>
    </div>
  );
}

export default ProvidersPanel;
