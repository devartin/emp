/**
 * Connections (1.0 brief §2.4): Google (set up with your own OAuth client, then calendars and Docs/Sheets import) and
 * market data. Most people need nothing here: free sources give live prices without a key. More options: the
 * provider list (order, on/off, keys, test) and every saved key.
 */
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/backend";
import type { ProviderInfo, SecretInfo } from "@/backend/types";
import { GoogleAccountsCard, GoogleSetupSheet } from "@/features/integrations/GoogleSetupSheet";
import { PROVIDER_DISCLOSURE, ProvidersPanel } from "@/features/integrations/ProvidersPanel";
import { formatRelative } from "@/lib/dates";
import { notify } from "@/stores/toasts";
import { AlertDialog } from "@/ui/AlertDialog";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { Skeleton } from "@/ui/Skeleton";
import { Block, Group, MoreOptions, Row, SectionHeader, useSettingsUi } from "../parts";

const KIND: Record<SecretInfo["kind"], string> = { api_key: "API key", oauth: "Account connection", client: "OAuth client", field: "Secret field" };

export function ConnectionsSection() {
  const [googleOpen, setGoogleOpen] = useState(false);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [rev, setRev] = useState(0);
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const loadGoogle = useCallback(() => {
    api.google
      .status()
      .then((s) => setConnected(s.accounts.length > 0))
      .catch(() => setConnected(false));
  }, []);
  useEffect(() => loadGoogle(), [loadGoogle, rev]);
  useEffect(() => {
    api.market
      .providers()
      .then(setProviders)
      .catch(() => setProviders([]));
  }, [rev]);

  const on = providers?.filter((p) => p.enabled) ?? [];
  const keyed = on.filter((p) => p.needsKey);
  const marketLine = !providers
    ? "Checking…"
    : on.length
      ? `${on.map((p) => p.name).join(", ")}. ${keyed.length ? "" : "Free sources, no key needed. "}Delayed quotes unless your plan says otherwise.`
      : "All providers are off, so prices don’t update.";

  return (
    <div>
      <SectionHeader title="Connections" description="Optional. They run only while Ultranote is unlocked, and keys are stored encrypted." />

      <Group>
        {connected === null ? (
          <Block>
            <Skeleton height={40} radius={10} />
          </Block>
        ) : connected ? (
          <>
            <Row id="google" label="Google" description="Connected. Calendars sync next to your tasks; Docs and Sheets import by link.">
              <Button size="sm" variant="secondary" icon={Plus} onClick={() => setGoogleOpen(true)}>
                Add access
              </Button>
            </Row>
            <Block>
              <GoogleAccountsCard key={rev} compact onChange={() => setRev((r) => r + 1)} />
            </Block>
          </>
        ) : (
          <Row id="google" label="Google" description="See your Google Calendar next to your tasks and import Docs and Sheets. You set it up once with your own Google Cloud project; the guide walks you through it.">
            <Button size="sm" variant="secondary" onClick={() => setGoogleOpen(true)}>
              Set up Google…
            </Button>
          </Row>
        )}
        <Row id="market-data" label="Market data" description={marketLine}>
          <Button size="sm" variant="ghost" onClick={() => useSettingsUi.getState().setMore("connections", true)}>
            Providers and keys
          </Button>
        </Row>
      </Group>

      <MoreOptions section="connections">
        <Group id="market-providers" title="Market data providers" description={`Tried in order until one answers. ${PROVIDER_DISCLOSURE}`}>
          <Block>
            <ProvidersPanel compact />
          </Block>
        </Group>
        <SavedKeys />
      </MoreOptions>

      <GoogleSetupSheet
        open={googleOpen}
        onOpenChange={(o) => {
          setGoogleOpen(o);
          if (!o) setRev((r) => r + 1);
        }}
      />
    </div>
  );
}

function SavedKeys() {
  const [list, setList] = useState<SecretInfo[] | null>(null);
  const [confirm, setConfirm] = useState<SecretInfo | null>(null);
  const load = useCallback(() => {
    api.secret
      .list()
      .then(setList)
      .catch(() => setList([]));
  }, []);
  useEffect(() => load(), [load]);
  return (
    <Group id="api-keys" title="Saved keys and connections" description="Write-only: a saved key is never shown again, only its last four characters if you allowed it.">
      {!list ? (
        <Block>
          <Skeleton height={40} radius={10} />
        </Block>
      ) : !list.length ? (
        <Row label="No keys saved" description="Keys you add for market data or Google show here." />
      ) : (
        list.map((s) => (
          <Row
            key={s.id}
            label={
              <span className="inline-flex items-center gap-2">
                <KeyRound size={14} className="text-tertiary" aria-hidden />
                {s.label || s.provider}
              </span>
            }
            badge={<span className="st-tag">{KIND[s.kind]}</span>}
            description={
              <>
                <span className="capitalize">{s.provider.replace(/-/g, " ")}</span>
                {s.last4 ? <span className="st-mono"> · ••••{s.last4}</span> : null} · added {formatRelative(s.createdAt)}
                {s.lastUsedAt ? ` · used ${formatRelative(s.lastUsedAt)}` : " · never used"}
              </>
            }
          >
            <IconButton icon={Trash2} label="Delete key" size="sm" variant="destructive-ghost" onClick={() => setConfirm(s)} />
          </Row>
        ))
      )}
      <AlertDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        tone="danger"
        title={`Delete “${confirm?.label || confirm?.provider}”?`}
        description="Anything using this key stops working until you add it again."
        confirmLabel="Delete key"
        onConfirm={async () => {
          if (!confirm) return;
          try {
            await api.secret.delete({ id: confirm.id });
            notify.success("Key deleted");
            load();
          } catch (e) {
            notify.fromError(e, "Couldn’t delete the key");
          }
        }}
      />
    </Group>
  );
}
