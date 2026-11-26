/**
 * Google setup (§17.1, §9.19): a six-step, honest walkthrough for creating your own Desktop OAuth client, then
 * connect / test, scopes, calendars to sync and disconnect (with revoke). Also exports `GoogleAccountsCard` for
 * Settings → Integrations.
 *
 *   <GoogleSetupSheet open={open} onOpenChange={setOpen} feature="calendar" />
 */
import { Check, Copy, ExternalLink, Info, RefreshCw, ShieldCheck, TriangleAlert, Unplug } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, backendMode, errorMessage, hasCode } from "@/backend";
import type { GoogleAccount, GoogleCalendarInfo, GoogleFeature } from "@/backend/types";
import { cn } from "@/lib/cn";
import { formatRelative } from "@/lib/dates";
import { notify } from "@/stores/toasts";
import { useVault } from "@/stores/vault";
import { Badge } from "@/ui/Badge";
import { Banner } from "@/ui/Banner";
import { Button } from "@/ui/Button";
import { Checkbox } from "@/ui/Checkbox";
import { Dialog } from "@/ui/Dialog";
import { IconButton } from "@/ui/IconButton";
import { Input } from "@/ui/Input";
import { SecretField } from "@/ui/SecretField";
import { Select } from "@/ui/Select";
import { Sheet } from "@/ui/Sheet";
import { Spinner } from "@/ui/Spinner";
import { spring } from "@/ui/motion/tokens";
import "./integrations.css";

const SCOPE_LABEL: Record<string, string> = {
  "https://www.googleapis.com/auth/calendar.readonly": "Calendar (read)",
  "https://www.googleapis.com/auth/documents.readonly": "Docs import",
  "https://www.googleapis.com/auth/spreadsheets.readonly": "Sheets import",
  "https://www.googleapis.com/auth/drive.file": "Export to Drive",
  "https://www.googleapis.com/auth/calendar.events": "Calendar (write)",
};
const FEATURE_LABEL: Record<GoogleFeature, string> = { calendar: "Calendar", docs_import: "Docs import", sheets_import: "Sheets import", export: "Export to Drive" };

function openLink(url: string) {
  api.open.external({ url }).catch(() => window.open(url, "_blank", "noopener,noreferrer"));
}

function CopyChip({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="ig-copy"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setDone(true);
          window.setTimeout(() => setDone(false), 1200);
        });
      }}
      aria-label={`Copy ${value}`}
    >
      <code>{value}</code>
      <AnimatePresence mode="wait" initial={false}>
        <m.span key={done ? "y" : "n"} initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}>
          {done ? <Check size={12} strokeWidth={3} aria-hidden /> : <Copy size={12} aria-hidden />}
        </m.span>
      </AnimatePresence>
    </button>
  );
}

function StepItem({ n, title, done, children }: { n: number; title: string; done?: boolean; children: ReactNode }) {
  return (
    <li className={cn("ig-step", done && "is-done")}>
      <span className="ig-step-n" aria-hidden>
        {done ? <Check size={12} strokeWidth={3} /> : n}
      </span>
      <div className="flex min-w-0 flex-col gap-2">
        <h3 className="text-body font-semibold text-primary">{title}</h3>
        {children}
      </div>
    </li>
  );
}

/** Re-auth prompt for (reauth) commands on encrypted vaults. */
function useReauth() {
  const [pending, setPending] = useState<null | (() => Promise<void>)>(null);
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      if (hasCode(e, "REAUTH_REQUIRED")) {
        setPending(() => fn);
        return;
      }
      throw e;
    }
  }, []);
  const dialog = (
    <Dialog
      open={!!pending}
      onOpenChange={(o) => !o && setPending(null)}
      title="Confirm it’s you"
      description="Connecting a service needs your password."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => setPending(null)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={async () => {
              try {
                await useVault.getState().reauth(pw);
                const fn = pending;
                setPending(null);
                setPw("");
                setErr(null);
                await fn?.();
              } catch (e) {
                setErr(hasCode(e, "BAD_PASSWORD") ? "Incorrect password" : errorMessage(e));
              }
            }}
          >
            Continue
          </Button>
        </>
      }
    >
      <SecretField label="Password" value={pw} onChange={(e) => setPw(e.currentTarget.value)} error={err ?? undefined} autoFocus />
    </Dialog>
  );
  return { run, dialog };
}

export interface GoogleSetupSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The feature that asked for Google (scopes are requested incrementally). */
  feature?: GoogleFeature;
}

export function GoogleSetupSheet({ open, onOpenChange, feature = "calendar" }: GoogleSetupSheetProps) {
  const [status, setStatus] = useState<{ clientConfigured: boolean; accounts: GoogleAccount[] } | null>(null);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [fieldErr, setFieldErr] = useState<{ field?: string; message: string } | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [tested, setTested] = useState(false);
  const { run, dialog } = useReauth();

  const refresh = useCallback(() => {
    api.google.status().then(setStatus).catch(() => setStatus({ clientConfigured: false, accounts: [] }));
  }, []);
  useEffect(() => {
    if (open) {
      refresh();
      setTested(false);
      setTesting(null);
      setFieldErr(null);
    }
  }, [open, refresh]);

  const save = () =>
    run(async () => {
      setSaving(true);
      setFieldErr(null);
      try {
        await api.google.setClient({ clientId: clientId.trim(), clientSecret: secret.trim() || undefined });
        setSecret("");
        refresh();
        notify.success("Google client saved", { description: "Stored encrypted on this device." });
      } catch (e) {
        const d = (e as { details?: { field?: string } }).details;
        setFieldErr({ field: d?.field, message: errorMessage(e) });
      } finally {
        setSaving(false);
      }
    });

  const test = () =>
    run(async () => {
      setTesting("Starting…");
      setTested(false);
      try {
        const account = status?.accounts[0];
        const job = await api.google.connect({ feature, accountId: account?.id, onEvent: (e) => e.kind === "progress" && e.label && setTesting(e.label) });
        await job.result;
        setTested(true);
        refresh();
        if (feature === "calendar") void api.gcal.syncNow({}).then((j) => j.result).catch(() => undefined);
      } catch (e) {
        notify.fromError(e, "Couldn’t connect to Google");
      } finally {
        setTesting(null);
      }
    });

  const configured = !!status?.clientConfigured;
  const connected = !!status?.accounts.length;
  const preview = backendMode === "mock";

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Connect Google"
      description={`Use your own Google client so EMP talks to Google directly from this device — no EMP servers in between.`}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {connected ? "Done" : "Close"}
          </Button>
          <Button variant="primary" onClick={test} disabled={!configured || !!testing} loading={!!testing} success={tested}>
            {connected ? `Test ${FEATURE_LABEL[feature]} access` : "Test connection"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {preview ? (
          <Banner tone="info" inline icon={Info}>
            Browser preview: Google is simulated here — nothing leaves this tab. The desktop app runs the real flow.
          </Banner>
        ) : null}
        {connected ? <GoogleAccountsCard compact onChange={refresh} /> : null}
        <Banner tone="warning" inline icon={TriangleAlert}>
          In Testing mode Google expires access every 7 days. Publishing for personal use is fine: Google will show an “unverified app” screen you can continue past.
        </Banner>
        <ol className="ig-steps">
          <StepItem n={1} title="Create a Google Cloud project" done={configured}>
            <p className="ig-p">Any name works. It’s yours — EMP never sees it.</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" iconRight={ExternalLink} onClick={() => openLink("https://console.cloud.google.com/projectcreate")}>
                Open Cloud Console
              </Button>
              <CopyChip value="EMP personal" />
            </div>
          </StepItem>
          <StepItem n={2} title="Enable the APIs" done={configured}>
            <p className="ig-p">Turn on the ones for the features you’ll use.</p>
            <div className="flex flex-wrap gap-1.5">
              {[
                ["Calendar", "calendar-json.googleapis.com"],
                ["Docs", "docs.googleapis.com"],
                ["Sheets", "sheets.googleapis.com"],
                ["Drive", "drive.googleapis.com"],
              ].map(([n, id]) => (
                <Button key={id} size="xs" variant="soft" iconRight={ExternalLink} onClick={() => openLink(`https://console.cloud.google.com/apis/library/${id}`)}>
                  {n} API
                </Button>
              ))}
            </div>
          </StepItem>
          <StepItem n={3} title="Configure the OAuth consent screen" done={configured}>
            <p className="ig-p">
              Choose user type <strong>External</strong>. App name and your email are all that’s required.
            </p>
            <Button size="sm" variant="secondary" iconRight={ExternalLink} onClick={() => openLink("https://console.cloud.google.com/apis/credentials/consent")}>
              Consent screen
            </Button>
          </StepItem>
          <StepItem n={4} title="Add yourself as a test user, then publish" done={configured}>
            <p className="ig-p">
              Add your Google address under <strong>Test users</strong>. Then choose <strong>Publish app → In production</strong> so access doesn’t expire after 7 days.
            </p>
          </StepItem>
          <StepItem n={5} title="Create an OAuth client of type Desktop app" done={configured}>
            <p className="ig-p">
              Credentials → Create credentials → OAuth client ID → <strong>Desktop app</strong>. There’s no redirect URI to set: EMP picks a random <code className="ig-code">http://127.0.0.1:&lt;port&gt;</code> each time.
            </p>
            <Button size="sm" variant="secondary" iconRight={ExternalLink} onClick={() => openLink("https://console.cloud.google.com/apis/credentials/oauthclient")}>
              Create client
            </Button>
          </StepItem>
          <StepItem n={6} title="Paste the Client ID and secret" done={configured}>
            <Input
              label="Client ID"
              placeholder="1234567890-abc….apps.googleusercontent.com"
              value={clientId}
              onChange={(e) => setClientId(e.currentTarget.value)}
              error={fieldErr?.field === "clientId" ? fieldErr.message : undefined}
              spellCheck={false}
              className="slashed"
            />
            <SecretField
              label="Client secret"
              placeholder={configured ? "Saved — paste to replace" : "GOCSPX-…"}
              value={secret}
              onChange={(e) => setSecret(e.currentTarget.value)}
              error={fieldErr?.field === "clientSecret" ? fieldErr.message : undefined}
              helper="Stored encrypted. Desktop clients can’t keep secrets from their own user, which is fine — it’s your client."
            />
            {fieldErr && !fieldErr.field ? <p className="text-caption text-loss-text">{fieldErr.message}</p> : null}
            <div className="flex items-center gap-2">
              <Button size="sm" variant={configured ? "secondary" : "primary"} onClick={save} loading={saving} disabled={!clientId.trim()}>
                {configured ? "Replace client" : "Save client"}
              </Button>
              {configured ? (
                <span className="flex items-center gap-1 text-caption text-gain-text">
                  <ShieldCheck size={13} aria-hidden /> Client saved
                </span>
              ) : null}
            </div>
          </StepItem>
        </ol>
        <AnimatePresence>
          {testing || tested ? (
            <m.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0, transition: spring.gentle }} exit={{ opacity: 0 }} className={cn("ig-test", tested && "is-ok")} role="status">
              {tested ? (
                <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
                  <circle cx="12" cy="12" r="11" fill="var(--gain)" />
                  <m.path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.28, ease: [0.2, 0, 0, 1] }} />
                </svg>
              ) : (
                <Spinner size={16} />
              )}
              <span className="text-body-sm">{tested ? `Connected — ${FEATURE_LABEL[feature]} access granted.` : testing}</span>
            </m.div>
          ) : null}
        </AnimatePresence>
        <p className="flex items-start gap-2 text-caption text-tertiary">
          <ShieldCheck size={14} className="mt-px flex-none" aria-hidden />
          EMP asks only for the scopes a feature needs, when you first use it. Tokens stay encrypted on this device; you can revoke them here or at myaccount.google.com.
        </p>
      </div>
      {dialog}
    </Sheet>
  );
}

/** Connected accounts: scopes, calendars to sync, interval, sync now, disconnect. */
export function GoogleAccountsCard({ compact, onChange }: { compact?: boolean; onChange?: () => void }) {
  const [accounts, setAccounts] = useState<GoogleAccount[] | null>(null);
  const [cals, setCals] = useState<Record<string, GoogleCalendarInfo[]>>({});
  const [interval, setIntervalMin] = useState<5 | 15 | 30 | 60>(5);
  const [syncing, setSyncing] = useState(false);
  const [disc, setDisc] = useState<GoogleAccount | null>(null);
  const [revoke, setRevoke] = useState(true);
  const [delCache, setDelCache] = useState(false);
  const load = useCallback(() => {
    api.google
      .status()
      .then(async (s) => {
        setAccounts(s.accounts);
        const next: Record<string, GoogleCalendarInfo[]> = {};
        for (const a of s.accounts) next[a.id] = await api.gcal.calendars({ accountId: a.id }).catch(() => []);
        setCals(next);
      })
      .catch(() => setAccounts([]));
  }, []);
  useEffect(() => load(), [load]);

  const toggleCal = async (accountId: string, id: string, on: boolean) => {
    const list = cals[accountId] ?? [];
    const ids = list.filter((c) => (c.id === id ? on : c.selected)).map((c) => c.id);
    setCals((m2) => ({ ...m2, [accountId]: list.map((c) => (c.id === id ? { ...c, selected: on } : c)) }));
    try {
      await api.gcal.setSync({ accountId, calendarIds: ids, intervalMin: interval });
    } catch (e) {
      notify.fromError(e, "Couldn’t update calendars");
      load();
    }
  };
  const syncNow = async () => {
    setSyncing(true);
    try {
      const job = await api.gcal.syncNow({});
      const r = await job.result;
      notify.success("Calendar synced", { description: r.added ? `${r.added} new events` : "Everything was up to date." });
    } catch (e) {
      notify.fromError(e, "Couldn’t sync");
    } finally {
      setSyncing(false);
    }
  };
  const disconnect = async () => {
    if (!disc) return;
    try {
      await api.google.disconnect({ accountId: disc.id, revoke, deleteCache: delCache });
      notify.success("Google disconnected", { description: revoke ? "Access was revoked at Google." : undefined });
      setDisc(null);
      load();
      onChange?.();
    } catch (e) {
      notify.fromError(e, "Couldn’t disconnect");
    }
  };

  if (!accounts) return <div className="ig-card"><Spinner size={16} /></div>;
  if (!accounts.length) return null;
  return (
    <div className="flex flex-col gap-3">
      {accounts.map((a) => (
        <div key={a.id} className="ig-card">
          <div className="flex items-center gap-3">
            <span className="ig-g" aria-hidden>G</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-body font-semibold text-primary">{a.email}</div>
              <div className="text-caption text-tertiary">Connected {formatRelative(a.connectedAt)}</div>
            </div>
            {a.status === "ok" ? <Badge tone="success" dot>Connected</Badge> : <Badge tone="warning" dot>Reconnect</Badge>}
            <IconButton icon={Unplug} label="Disconnect" size="sm" onClick={() => setDisc(a)} />
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {a.scopes.filter((s) => SCOPE_LABEL[s]).map((s) => (
              <Badge key={s} tone="outline">{SCOPE_LABEL[s]}</Badge>
            ))}
          </div>
          {(cals[a.id] ?? []).length && !compact ? (
            <div className="mt-4 flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span className="text-micro uppercase text-tertiary">Calendars to show</span>
                <div className="flex items-center gap-2">
                  <Select<string>
                    size="sm"
                    value={String(interval)}
                    onValueChange={(v) => {
                      const n = Number(v) as 5 | 15 | 30 | 60;
                      setIntervalMin(n);
                      void api.gcal.setSync({ accountId: a.id, calendarIds: (cals[a.id] ?? []).filter((c) => c.selected).map((c) => c.id), intervalMin: n });
                    }}
                    options={[{ value: "5", label: "Every 5 min" }, { value: "15", label: "Every 15 min" }, { value: "30", label: "Every 30 min" }, { value: "60", label: "Hourly" }]}
                    aria-label="Sync interval"
                  />
                  <Button size="sm" variant="ghost" icon={RefreshCw} loading={syncing} onClick={syncNow}>
                    Sync now
                  </Button>
                </div>
              </div>
              {(cals[a.id] ?? []).map((c) => (
                <label key={c.id} className="ig-cal">
                  <Checkbox checked={c.selected} onCheckedChange={(v) => void toggleCal(a.id, c.id, v)} aria-label={c.summary} />
                  <span className="ig-dot" style={{ background: `var(--block-${c.color}-text, var(--accent-solid))` }} />
                  <span className="flex-1 truncate text-body-sm">{c.summary}</span>
                  {c.primary ? <span className="text-caption text-tertiary">Primary</span> : null}
                </label>
              ))}
            </div>
          ) : null}
        </div>
      ))}
      <Dialog
        open={!!disc}
        onOpenChange={(o) => !o && setDisc(null)}
        title={`Disconnect ${disc?.email ?? "Google"}?`}
        description="EMP stops syncing. Pages you imported stay."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDisc(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={disconnect}>
              Disconnect
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Checkbox checked={revoke} onCheckedChange={setRevoke} label="Also revoke access at Google" description="Calls Google’s revoke endpoint so the token stops working everywhere." />
          <Checkbox checked={delCache} onCheckedChange={setDelCache} label="Delete cached calendar events" />
        </div>
      </Dialog>
    </div>
  );
}

export default GoogleSetupSheet;
