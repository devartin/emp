/**
 * Privacy & security (1.0 brief §2.4): a plain status line with at most one next action, then password, recovery key,
 * lock when idle and lock now (all of which come with encryption), hide numbers on launch and offline mode.
 *
 * More options: the security checklist, the other lock triggers, blur when inactive, clipboard clearing, images from
 * the web, key strength, the integrity check, turning encryption off, the security and request logs, and what stays
 * visible on disk. An unencrypted workspace is a choice: the status is neutral, never red, and nothing is scored.
 */
import { CheckCircle2, Circle, Lock, LockOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { navigate } from "@/app/router";
import { api, errorMessage } from "@/backend";
import type { AutoLock, JobEvent, KdfBenchmark, KdfInfo, VaultSettings } from "@/backend/types";
import { NetworkLog } from "@/features/integrations/NetworkLog";
import { formatRelative } from "@/lib/dates";
import { shortcutLabel } from "@/lib/platform";
import { useSettings } from "@/stores/settings";
import { notify } from "@/stores/toasts";
import { useVault } from "@/stores/vault";
import { Button } from "@/ui/Button";
import { Kbd } from "@/ui/Kbd";
import { Ring } from "@/ui/Ring";
import { Select } from "@/ui/Select";
import { Switch } from "@/ui/Switch";
import { Block, Group, MoreOptions, Row, SectionHeader } from "../parts";
import { ensureReauth } from "../reauth";
import { ChangePasswordDialog, DisableEncryptionDialog, EnableEncryptionDialog, RecoveryKeyDialog, StrengthenDialog } from "./dialogs";
import { DiskDisclosure, SecurityLog } from "./panels";
import { useChecklist, useSecurityInfo } from "./score";

const IDLE = [
  { value: "1", label: "After 1 minute" },
  { value: "5", label: "After 5 minutes" },
  { value: "15", label: "After 15 minutes" },
  { value: "30", label: "After 30 minutes" },
  { value: "60", label: "After 1 hour" },
  { value: "240", label: "After 4 hours" },
  { value: "never", label: "Never" },
];
const BLUR = [
  { value: "off", label: "Off" },
  { value: "0", label: "Right away" },
  { value: "1", label: "After 1 minute" },
  { value: "5", label: "After 5 minutes" },
];
const SESSION = [
  { value: "off", label: "No limit" },
  { value: "8", label: "After 8 hours" },
  { value: "24", label: "After 24 hours" },
  { value: "72", label: "After 3 days" },
];
const CLIP = [10, 20, 30, 60, 120];

type DialogId = "enable" | "disable" | "password" | "view" | "regen" | "strengthen" | null;

async function setAutoLock(next: AutoLock): Promise<void> {
  try {
    if (next.idleMinutes === null && !(await ensureReauth("turn off locking when idle"))) return;
    const st = await api.vault.setAutoLock(next);
    useVault.getState().setStatus(st);
  } catch (e) {
    notify.fromError(e, "Couldn’t change auto-lock");
  }
}

export function SecuritySection() {
  const status = useVault((s) => s.status);
  const vault = useSettings((s) => s.vault) as VaultSettings;
  const setVault = useSettings((s) => s.setVault);
  const [dialog, setDialog] = useState<DialogId>(null);

  useEffect(() => {
    void useVault.getState().refresh().catch(() => undefined);
    void useSecurityInfo.getState().load();
  }, []);

  if (!status) return null;
  const enc = status.encrypted;
  const a = status.autoLock;

  // One next action at most: turn on encryption, or confirm the recovery key.
  const next = !enc ? { label: "Turn on encryption", run: () => setDialog("enable") } : !status.recoveryConfirmed ? { label: "Confirm recovery key", run: () => setDialog("view") } : null;

  return (
    <div>
      <SectionHeader title="Privacy & security" description="How your workspace is protected on this computer." />

      <div className="st-status" data-setting="encryption" data-encrypted={enc ? "" : undefined}>
        <span className="st-status-icon" aria-hidden>
          {enc ? <Lock size={18} /> : <LockOpen size={18} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="st-status-title">{enc ? (status.recoveryConfirmed ? "Your workspace is encrypted." : "Your workspace is encrypted. Your recovery key isn’t confirmed yet.") : "Your workspace isn’t encrypted."}</div>
          <div className="st-status-desc">{enc ? "Only your password or your recovery key can open it." : "It’s stored as plain files on this computer. You can turn on encryption at any time."}</div>
        </div>
        {next ? (
          <Button size="sm" variant={enc ? "secondary" : "primary"} icon={enc ? undefined : Lock} onClick={next.run}>
            {next.label}
          </Button>
        ) : null}
      </div>

      {enc ? (
        <Group>
          <Row id="change-password" label="Password" description="It never leaves this computer, and nobody can reset it.">
            <Button size="sm" variant="secondary" onClick={() => setDialog("password")}>
              Change password
            </Button>
          </Row>
          <Row id="recovery-key" label="Recovery key" description={status.recoveryConfirmed ? "24 words that open your workspace if you forget your password." : "24 words that open your workspace if you forget your password. Confirm you saved them."}>
            {!status.recoveryConfirmed ? (
              <Button size="sm" variant="secondary" onClick={() => setDialog("view")}>
                View and confirm
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => setDialog("regen")}>
              Create a new key…
            </Button>
          </Row>
          <Row id="auto-lock" label="Lock when idle" description="Locking wipes the key from memory; you’ll need your password again.">
            <Select size="sm" value={a.idleMinutes === null ? "never" : String(a.idleMinutes)} onValueChange={(v) => void setAutoLock({ ...a, idleMinutes: v === "never" ? null : Number(v) })} options={IDLE} aria-label="Lock when idle" className="w-[180px]" />
            <Button size="sm" variant="secondary" icon={Lock} onClick={() => void useVault.getState().lock().catch((e) => notify.fromError(e, "Couldn’t lock"))}>
              Lock now <Kbd keys="mod+shift+l" size="xs" className="ml-1" />
            </Button>
          </Row>
        </Group>
      ) : (
        <p className="st-hint st-note">A password, a recovery key and locking come with encryption.</p>
      )}

      <Group>
        <Row id="hide-numbers" label="Hide numbers on launch" description={`Start with balances and amounts masked. ${shortcutLabel("mod+shift+h")} shows or hides them any time.`}>
          <Switch checked={vault.hideNumbersOnLaunch} onCheckedChange={(v) => void setVault({ hideNumbersOnLaunch: v })} aria-label="Hide numbers on launch" />
        </Row>
        <OfflineRow />
      </Group>

      <MoreOptions section="security">
        <Checklist onEnable={() => setDialog("enable")} onConfirmKey={() => setDialog("view")} />

        <Group title="Locking and screen">
          {enc ? (
            <>
              <Row id="lock-triggers" label="When your computer sleeps">
                <Switch checked={a.onSleep} onCheckedChange={(v) => void setAutoLock({ ...a, onSleep: v })} aria-label="Lock when your computer sleeps" />
              </Row>
              <Row label="When you lock your screen or switch users">
                <Switch checked={a.onScreenLock} onCheckedChange={(v) => void setAutoLock({ ...a, onScreenLock: v })} aria-label="Lock when you lock your screen" />
              </Row>
              <Row label="When Ultranote is in the background" description="The window is minimised or another app is in front.">
                <Select size="sm" value={a.onBlurMinutes === null ? "off" : String(a.onBlurMinutes)} onValueChange={(v) => void setAutoLock({ ...a, onBlurMinutes: v === "off" ? null : Number(v) })} options={BLUR} aria-label="Lock in the background" className="w-[180px]" />
              </Row>
              <Row label="After a long session" description="Ask for the password again even while you’re working.">
                <Select size="sm" value={a.maxSessionHours === null ? "off" : String(a.maxSessionHours)} onValueChange={(v) => void setAutoLock({ ...a, maxSessionHours: v === "off" ? null : Number(v) })} options={SESSION} aria-label="Longest session" className="w-[180px]" />
              </Row>
            </>
          ) : null}
          <Row id="blur-inactive" label="Blur when inactive" description="Blur Ultranote while another app is in front. Money, Investments and Taxes always blur.">
            <Switch checked={vault.blurWhenInactive} onCheckedChange={(v) => void setVault({ blurWhenInactive: v })} aria-label="Blur when inactive" />
          </Row>
          <Row id="clipboard" label="Clear copied secrets after" description="Recovery words, passwords and revealed keys, only if the clipboard still holds them.">
            <Select
              size="sm"
              value={String(vault.clipboardClearSeconds)}
              onValueChange={(v) => void setVault({ clipboardClearSeconds: Number(v) })}
              options={(CLIP.includes(vault.clipboardClearSeconds) ? CLIP : [...CLIP, vault.clipboardClearSeconds].sort((x, y) => x - y)).map((n) => ({ value: String(n), label: n >= 60 ? `${n / 60} min` : `${n} seconds` }))}
              className="w-[150px]"
              aria-label="Clear copied secrets after"
            />
          </Row>
          <Row id="remote-images" label="Images from the web" description="Loading a web image tells its site when you opened the page. Ask shows a placeholder you can load once.">
            <Select
              size="sm"
              value={vault.remoteImages}
              onValueChange={(v) => void setVault({ remoteImages: v })}
              options={[
                { value: "ask", label: "Ask each time" },
                { value: "allow", label: "Always load" },
                { value: "block", label: "Never load" },
              ]}
              className="w-[170px]"
              aria-label="Images from the web"
            />
          </Row>
        </Group>

        <Group title="Encryption">
          {enc && status.kdf ? <KeyStrengthRow kdf={status.kdf} onStrengthen={() => setDialog("strengthen")} /> : null}
          <IntegrityRow />
          {enc ? (
            <Row label="Turn off encryption" description="Decrypts every page, row and attachment and stores them as plain files.">
              <Button size="sm" variant="destructive-ghost" onClick={() => setDialog("disable")}>
                Turn off…
              </Button>
            </Row>
          ) : (
            <Row label="Turn on encryption" description="Everything you write is encrypted with a key only your password or recovery key opens.">
              <Button size="sm" variant="secondary" onClick={() => setDialog("enable")}>
                Turn on…
              </Button>
            </Row>
          )}
        </Group>

        <SecurityLog />

        <Group id="network-log" title="Request log" description="Every request Ultranote made, newest first. Addresses only; query strings are never recorded.">
          <Block>
            <NetworkLog limit={1000} height={300} />
          </Block>
        </Group>

        <DiskDisclosure />
      </MoreOptions>

      <EnableEncryptionDialog open={dialog === "enable"} onOpenChange={(o) => !o && setDialog(null)} />
      <DisableEncryptionDialog open={dialog === "disable"} onOpenChange={(o) => !o && setDialog(null)} />
      <ChangePasswordDialog open={dialog === "password"} onOpenChange={(o) => !o && setDialog(null)} />
      <RecoveryKeyDialog open={dialog === "view" || dialog === "regen"} mode={dialog === "regen" ? "regenerate" : "view"} onOpenChange={(o) => !o && setDialog(null)} />
      <StrengthenDialog open={dialog === "strengthen"} onOpenChange={(o) => !o && setDialog(null)} />
    </div>
  );
}

function OfflineRow() {
  const offline = useSettings((s) => s.vault?.offline ?? false);
  const [busy, setBusy] = useState(false);
  const set = async (on: boolean) => {
    setBusy(true);
    try {
      await api.network.setOffline({ offline: on });
      const v = useSettings.getState().vault;
      if (v) useSettings.setState({ vault: { ...v, offline: on } });
      notify.info(on ? "Offline mode is on" : "Offline mode is off", { description: on ? "Ultranote won’t make any network requests, including update checks." : undefined });
    } catch (e) {
      notify.fromError(e, "Couldn’t change offline mode");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Row id="offline" label="Offline mode" description={offline ? "Every request is refused: Google, market data and update checks." : "Ultranote only contacts services you’ve connected. Nothing else, and no telemetry."}>
      <Switch checked={offline} disabled={busy} onCheckedChange={(v) => void set(v)} aria-label="Offline mode" />
    </Row>
  );
}

function Checklist({ onEnable, onConfirmKey }: { onEnable: () => void; onConfirmKey: () => void }) {
  const items = useChecklist();
  if (!items) return null;
  const action = (id: string) => {
    if (id === "encryption") return { label: "Turn on", run: onEnable };
    if (id === "recovery") return { label: "Confirm", run: onConfirmKey };
    if (id === "backups") return { label: "Open backups", run: () => navigate({ t: "settings", section: "data:snapshots" }, { replace: true }) };
    return null;
  };
  return (
    <Group id="security-checklist" title="Security checklist" description={`${items.filter((i) => i.done).length} of ${items.length} in place`}>
      <ul className="st-checklist">
        {items.map((it) => {
          const act = !it.done && !(it.needsEncryption && !useVault.getState().status?.encrypted) ? action(it.id) : null;
          return (
            <li key={it.id} className="st-check" data-done={it.done ? "" : undefined}>
              <span className="st-check-mark" aria-hidden>
                {it.done ? <CheckCircle2 size={16} /> : <Circle size={16} />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="st-check-title">{it.title}</div>
                <div className="st-check-detail">{it.detail}</div>
              </div>
              {act ? (
                <Button size="xs" variant="ghost" onClick={act.run}>
                  {act.label}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Group>
  );
}

function KeyStrengthRow({ kdf, onStrengthen }: { kdf: KdfInfo; onStrengthen: () => void }) {
  const [bench, setBench] = useState<KdfBenchmark | null>(null);
  const [busy, setBusy] = useState(false);
  const secs = ((bench?.ms ?? kdf.estMs) / 1000).toFixed(1);
  return (
    <Row id="key-strength" label="Password protection" description={`${kdf.belowStandard ? "Lighter than today’s standard. " : ""}Unlocking takes about ${secs} s on this computer, on purpose: every guess costs an attacker the same.`}>
      <Button
        size="sm"
        variant="ghost"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            setBench(await api.vault.benchmarkKdf());
          } catch (e) {
            notify.fromError(e, "Couldn’t measure it");
          } finally {
            setBusy(false);
          }
        }}
      >
        Measure
      </Button>
      {kdf.belowStandard ? (
        <Button size="sm" variant="secondary" onClick={onStrengthen}>
          Strengthen
        </Button>
      ) : null}
    </Row>
  );
}

function IntegrityRow() {
  const integrity = useVault((s) => s.status?.integrity ?? "unchecked");
  const last = useSecurityInfo((s) => s.lastIntegrity);
  const [progress, setProgress] = useState<number | null>(null);
  const run = async () => {
    setProgress(0);
    try {
      const onEvent = (e: JobEvent) => {
        if (e.kind === "progress" && e.total > 0) setProgress(e.done / e.total);
      };
      const job = await api.vault.integrityCheck({ onEvent } as unknown as Parameters<typeof api.vault.integrityCheck>[0]);
      const r = await job.result;
      useSecurityInfo.getState().markIntegrity(Date.now());
      await useVault.getState().refresh();
      if (r.ok) notify.success("Nothing changed outside Ultranote");
      else notify.error("The check found problems", { description: `${r.damaged.length} damaged ${r.damaged.length === 1 ? "record" : "records"}.` });
    } catch (e) {
      notify.fromError(e, "Couldn’t run the check");
    } finally {
      setProgress(null);
    }
  };
  return (
    <Row
      id="integrity"
      label="Integrity check"
      description={progress !== null ? "Checking…" : integrity === "ok" ? `Nothing changed outside Ultranote${last ? ` · checked ${formatRelative(last)}` : ""}.` : integrity === "warning" ? "Something changed outside Ultranote." : "Checks that nothing was changed outside Ultranote."}
    >
      {progress !== null ? <Ring value={progress} size={24} aria-label="Integrity check progress" /> : null}
      {integrity === "warning" ? (
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            if (!(await ensureReauth("accept these changes"))) return;
            try {
              await api.vault.integrityReseal();
              await useVault.getState().refresh();
              notify.success("Changes accepted");
            } catch (e) {
              notify.error("Couldn’t accept the changes", { description: errorMessage(e) });
            }
          }}
        >
          Accept changes
        </Button>
      ) : null}
      <Button size="sm" variant="secondary" loading={progress !== null} onClick={() => void run()}>
        Run now
      </Button>
    </Row>
  );
}
