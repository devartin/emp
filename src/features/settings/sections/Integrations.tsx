/** Integrations (§17): Google, market data providers and saved keys, embedding the integrations feature panels. */
import { Cable, KeyRound, Plus, Trash2 } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { navigate } from "@/app/router";
import { api } from "@/backend";
import type { SecretInfo } from "@/backend/types";
import { GoogleAccountsCard, GoogleSetupSheet } from "@/features/integrations/GoogleSetupSheet";
import { ProvidersPanel } from "@/features/integrations/ProvidersPanel";
import { formatRelative } from "@/lib/dates";
import { notify } from "@/stores/toasts";
import { AlertDialog } from "@/ui/AlertDialog";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { Skeleton } from "@/ui/Skeleton";
import { spring } from "@/ui/motion/tokens";
import { Group, Row, SectionHeader } from "../parts";

const KIND: Record<SecretInfo["kind"], string> = { api_key: "API key", oauth: "Account connection", client: "OAuth client", field: "Secret field" };

export function IntegrationsSection() {
  const [googleOpen, setGoogleOpen] = useState(false);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [rev, setRev] = useState(0);
  const loadGoogle = useCallback(() => {
    api.google
      .status()
      .then((s) => setConnected(s.accounts.length > 0))
      .catch(() => setConnected(false));
  }, []);
  useEffect(() => loadGoogle(), [loadGoogle, rev]);

  return (
    <div>
      <SectionHeader icon={Cable} title="Integrations" description="Connections are optional and run only while EMP is unlocked. API keys and account connections are always stored encrypted." />

      <Group
        id="google"
        title="Google"
        description="Calendar sync, and importing Docs and Sheets by link. You bring your own OAuth client; EMP talks to Google directly."
        actions={
          connected ? (
            <Button size="sm" variant="secondary" icon={Plus} onClick={() => setGoogleOpen(true)}>
              Add access
            </Button>
          ) : null
        }
        flush
        bare={!!connected}
      >
        {connected === null ? (
          <div className="st-block">
            <Skeleton height={44} radius={10} />
          </div>
        ) : connected ? (
          <GoogleAccountsCard key={rev} onChange={() => setRev((r) => r + 1)} />
        ) : (
          <Row icon={<span className="st-g">G</span>} label="Not connected" description="Connect to see your Google Calendar next to your tasks and import Docs and Sheets.">
            <Button size="sm" variant="primary" onClick={() => setGoogleOpen(true)}>
              Connect Google…
            </Button>
          </Row>
        )}
      </Group>

      <Group id="market-data" title="Market data" description="Quotes, history and FX come from these providers, tried in order. Keyless sources work out of the box." bare>
        <ProvidersPanel compact />
      </Group>

      <SavedKeys />

      <Group title="Network">
        <Row label="See every request" description="Each integration may only contact its own hosts. Review the log or go offline in Privacy & network.">
          <Button size="sm" variant="ghost" onClick={() => navigate({ t: "settings", section: "privacy:network-log" }, { replace: true })}>
            Open request log
          </Button>
        </Row>
      </Group>

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
    <Group id="api-keys" title="Saved keys and connections" description="Write-only: EMP never shows a key again after you save it, only the last four characters if you allowed it." flush>
      {!list ? (
        <div className="st-block">
          <Skeleton height={40} radius={10} />
        </div>
      ) : !list.length ? (
        <Row icon={<KeyRound size={16} />} label="No keys saved" description="Keys you add for market data or Google appear here." />
      ) : (
        <AnimatePresence initial={false}>
          {list.map((s) => (
            <m.div key={s.id} layout="position" transition={spring.layout} exit={{ opacity: 0, transition: { duration: 0.12 } }}>
              <Row
                icon={<KeyRound size={16} />}
                label={s.label || s.provider}
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
            </m.div>
          ))}
        </AnimatePresence>
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
