/**
 * Security Center (§6.6, §9): score ring + actionable checklist, encryption, password & recovery, auto-lock,
 * integrity, backups/network/integrations summaries, the security log timeline, "what's visible on disk",
 * password-strength estimates and the approved FAQ copy (§9.22).
 */
import {
  Archive, Cable, CheckCircle2, ChevronRight, Circle, Clock, Cpu, Fingerprint, Gauge, HardDrive, KeyRound,
  Lock, LockOpen, ScanSearch, ShieldAlert, ShieldCheck, Timer, Wifi,
} from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { navigate } from "@/app/router";
import { api, errorMessage } from "@/backend";
import type { AutoLock, JobEvent, KdfBenchmark, KdfInfo } from "@/backend/types";
import { formatRelative } from "@/lib/dates";
import { formatBytes } from "@/lib/format";
import { useSettings } from "@/stores/settings";
import { notify } from "@/stores/toasts";
import { useVault } from "@/stores/vault";
import { Banner } from "@/ui/Banner";
import { Button } from "@/ui/Button";
import { Kbd } from "@/ui/Kbd";
import { Ring } from "@/ui/Ring";
import { Select } from "@/ui/Select";
import { Switch } from "@/ui/Switch";
import { SlabGlyph } from "@/ui/SlabGlyph";
import { RollingNumber } from "@/ui/motion/RollingNumber";
import { ease, spring } from "@/ui/motion/tokens";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { Group, Row, SectionHeader, StatusChip } from "../parts";
import { ensureReauth, useReauthRemaining } from "../reauth";
import { ChangePasswordDialog, DisableEncryptionDialog, EnableEncryptionDialog, RecoveryKeyDialog, StrengthenDialog } from "./dialogs";
import { DiskDisclosure, Faq, SecurityLog, StrengthTable } from "./panels";
import { useSecurityInfo, useSecurityScore, type CheckId, type CheckItem } from "./score";

const IDLE: { value: string; label: string }[] = [
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
  { value: "0", label: "Immediately" },
  { value: "1", label: "After 1 minute" },
  { value: "5", label: "After 5 minutes" },
];
const SESSION = [
  { value: "off", label: "No limit" },
  { value: "8", label: "After 8 hours" },
  { value: "24", label: "After 24 hours" },
  { value: "72", label: "After 3 days" },
];

function idleLabel(m: number | null): string {
  if (m === null) return "Never locks when idle";
  return m >= 60 ? `Locks after ${m / 60} h idle` : `Locks after ${m} min idle`;
}

function fmtCountdown(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

type DialogId = "enable" | "disable" | "password" | "view" | "regen" | "strengthen" | null;

export function SecurityCenter() {
  const status = useVault((s) => s.status);
  const vault = useSettings((s) => s.vault);
  const score = useSecurityScore();
  const snapshots = useSecurityInfo((s) => s.snapshots);
  const [dialog, setDialog] = useState<DialogId>(null);
  const sudo = useReauthRemaining();

  useEffect(() => {
    void useVault.getState().refresh().catch(() => undefined);
    void useSecurityInfo.getState().refreshSnapshots();
  }, []);

  if (!status) return null;
  const enc = status.encrypted;
  const lastSnap = snapshots?.[0];

  const act = async (id: CheckId) => {
    switch (id) {
      case "encryption":
        return setDialog("enable");
      case "recovery":
        return setDialog(status.recoveryConfirmed ? "view" : "regen");
      case "autolock":
        return void setAutoLock({ ...status.autoLock, idleMinutes: 15 });
      case "sleep":
        return void setAutoLock({ ...status.autoLock, onSleep: true, onScreenLock: true });
      case "snapshots":
        if (!vault?.snapshots.enabled) await useSettings.getState().setVault({ snapshots: { ...vault!.snapshots, enabled: true } });
        return navigate({ t: "settings", section: "backups:snapshots" }, { replace: true });
      case "kdf":
        return setDialog("strengthen");
      case "integrity":
        return document.querySelector<HTMLButtonElement>("[data-run-integrity]")?.click();
      case "clipboard":
        return void useSettings.getState().setVault({ clipboardClearSeconds: 30 });
      case "keys":
        return setDialog("enable");
      case "fde":
        return document.querySelector<HTMLElement>('[data-setting="disk-visibility"]')?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  return (
    <div>
      <SectionHeader
        icon={ShieldCheck}
        title="Security Center"
        description="How your workspace is protected, and what to tighten."
        actions={
          <AnimatePresence>
            {sudo ? (
              <m.span key="sudo" initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1, transition: spring.ui }} exit={{ opacity: 0 }} className="st-sudo" title="You confirmed your password recently. Sensitive actions won’t ask again until this runs out.">
                <Fingerprint size={13} aria-hidden /> Confirmed · {fmtCountdown(sudo)}
              </m.span>
            ) : null}
          </AnimatePresence>
        }
      />

      {score ? <Hero score={score.score} tone={score.tone} /> : null}

      <div className="st-chips" data-setting="security-chips">
        <StatusChip tone={enc ? "ok" : "warn"} icon={enc ? Lock : LockOpen}>
          {enc ? "Encrypted" : "Not encrypted"}
        </StatusChip>
        {enc ? <StatusChip tone={status.autoLock.idleMinutes !== null && status.autoLock.idleMinutes <= 15 ? "ok" : "warn"} icon={Timer}>{idleLabel(status.autoLock.idleMinutes)}</StatusChip> : null}
        {enc ? <StatusChip tone={status.recoveryConfirmed ? "ok" : "warn"} icon={KeyRound}>{status.recoveryConfirmed ? "Recovery key confirmed" : "Recovery key not confirmed"}</StatusChip> : null}
        <StatusChip tone={lastSnap && Date.now() - lastSnap.at < 48 * 3600_000 ? "ok" : "warn"} icon={Archive}>
          {lastSnap ? `Last snapshot ${formatRelative(lastSnap.at)}` : enc ? "No snapshot yet" : "Automatic backups off"}
        </StatusChip>
        <StatusChip tone={status.integrity === "ok" ? "ok" : status.integrity === "warning" ? "bad" : "neutral"} icon={ScanSearch}>
          {status.integrity === "ok" ? "Integrity OK" : status.integrity === "warning" ? "Integrity warning" : "Integrity not checked"}
        </StatusChip>
      </div>

      {score ? <Checklist items={score.items} onAct={(id) => void act(id)} /> : null}

      {/* Encryption */}
      <Group id="encryption" title="Encryption" description="Optional encryption at rest. Turning it on or off re-writes every record.">
        <VaultVisual encrypted={enc} kdf={status.kdf} recovery={status.recoveryConfirmed} />
        <Row
          icon={enc ? <Lock size={16} /> : <LockOpen size={16} />}
          label={enc ? "Encryption is on" : "Encryption is off"}
          badge={<span className="st-tag">Encryption: v1 (unaudited)</span>}
          description={enc ? "Everything you write is encrypted on your device with 256-bit XChaCha20-Poly1305, under a key protected by your password using Argon2id." : "Your pages, rows and attachments are stored as plain data on this device. Anyone with access to your files can read them."}
        >
          {enc ? (
            <Button variant="destructive-ghost" size="sm" onClick={() => setDialog("disable")}>
              Turn off…
            </Button>
          ) : (
            <Button variant="primary" size="sm" icon={Lock} onClick={() => setDialog("enable")}>
              Turn on encryption
            </Button>
          )}
        </Row>
        {enc && status.kdf ? <KdfRow kdf={status.kdf} onStrengthen={() => setDialog("strengthen")} /> : null}
        {!status.keychainAvailable && !enc ? (
          <div className="st-block">
            <Banner tone="warning" inline>
              Your API keys are obfuscated, not protected. Turn on vault encryption to protect them.
            </Banner>
          </div>
        ) : null}
      </Group>

      {/* Password & recovery */}
      <Group id="change-password" title="Password & recovery key" description="Both need your password again (valid for 5 minutes).">
        <Row icon={<KeyRound size={16} />} label="Password" description={enc ? "Your password never leaves this device, and we can’t reset it." : "Set a password by turning on encryption."}>
          <Button size="sm" variant="secondary" disabled={!enc} disabledReason="Turn on encryption first" onClick={() => setDialog("password")}>
            Change password
          </Button>
        </Row>
        <Row
          id="recovery-key"
          icon={<Fingerprint size={16} />}
          label="Recovery key"
          badge={enc ? <span className="st-tag" data-tone={status.recoveryConfirmed ? "ok" : "warn"}>{status.recoveryConfirmed ? "Confirmed" : "Not confirmed"}</span> : null}
          description={enc ? "24 words that unlock your workspace if you forget your password. Your recovery key is the only other way in, so keep it safe." : "Created when you turn on encryption."}
        >
          {enc && !status.recoveryConfirmed ? (
            <Button size="sm" variant="secondary" onClick={() => setDialog("view")}>
              View & confirm
            </Button>
          ) : null}
          <Button size="sm" variant={enc && !status.recoveryConfirmed ? "ghost" : "secondary"} disabled={!enc} disabledReason="Turn on encryption first" onClick={() => setDialog("regen")}>
            Create new key…
          </Button>
        </Row>
      </Group>

      <AutoLockCard />
      <IntegrityCard />

      {/* Summaries */}
      <Group title="Backups, network & connections">
        <LinkRow icon={<Archive size={16} />} label="Backups & snapshots" detail={lastSnap ? `${snapshots?.length ?? 0} snapshots · last ${formatRelative(lastSnap.at)} · ${formatBytes(lastSnap.bytes)}` : enc ? "No snapshot yet" : "Automatic backups are off: set a backup password."} to="backups" tone={lastSnap ? "ok" : "warn"} />
        <LinkRow icon={<Wifi size={16} />} label="Network" detail={vault?.offline ? "Offline mode is on — every request is refused." : "Nothing connects to the internet unless you turn on an integration. You can see every request EMP makes."} to="privacy:network-log" tone={vault?.offline ? "ok" : "neutral"} />
        <LinkRow icon={<Cable size={16} />} label="Integrations" detail="API keys and account connections are always stored encrypted." to="integrations" tone="neutral" />
      </Group>

      <SecurityLog />
      <DiskDisclosure />
      <StrengthTable />
      <Faq />

      <EnableEncryptionDialog open={dialog === "enable"} onOpenChange={(o) => !o && setDialog(null)} />
      <DisableEncryptionDialog open={dialog === "disable"} onOpenChange={(o) => !o && setDialog(null)} />
      <ChangePasswordDialog open={dialog === "password"} onOpenChange={(o) => !o && setDialog(null)} />
      <RecoveryKeyDialog open={dialog === "view" || dialog === "regen"} mode={dialog === "regen" ? "regenerate" : "view"} onOpenChange={(o) => !o && setDialog(null)} />
      <StrengthenDialog open={dialog === "strengthen"} onOpenChange={(o) => !o && setDialog(null)} />
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── hero

/**
 * Encryption status as the icon's three slabs: data (bottom), key (middle), recovery (top). Encrypted, the stack
 * closes and a lit seal rings it; off, the slabs float apart and dim. Each slab maps to a layer row with a lit LED.
 */
function VaultVisual({ encrypted, kdf, recovery }: { encrypted: boolean; kdf?: KdfInfo; recovery: boolean }) {
  const layers = [
    { name: "Data", detail: encrypted ? "XChaCha20-Poly1305 · 256-bit, on this device" : "Stored as plain data on this device", on: encrypted, state: encrypted ? "Sealed" : "Open" },
    { name: "Key", detail: encrypted ? `Wrapped by your password · Argon2id${kdf ? ` ${Math.round(kdf.mKiB / 1024)} MiB, t=${kdf.t}` : ""}` : "No password yet", on: encrypted && !kdf?.belowStandard, state: encrypted ? (kdf?.belowStandard ? "Weak" : "Strong") : "None" },
    { name: "Recovery", detail: encrypted ? (recovery ? "24-word key confirmed" : "24-word key not confirmed yet") : "Created when you turn encryption on", on: encrypted && recovery, state: encrypted ? (recovery ? "Ready" : "Confirm") : "—" },
  ];
  return (
    <div className="st-vault" data-enc={encrypted ? "1" : "0"} data-setting="vault">
      <div className="st-vault-art" data-l0={layers[0].on ? "1" : "0"} data-l1={layers[1].on ? "1" : "0"} data-l2={layers[2].on ? "1" : "0"} aria-hidden>
        <span className="st-vault-seal" />
        <SlabGlyph size={84} animate exploded={!encrypted} />
        <span className="st-vault-lock">{encrypted ? <Lock size={16} strokeWidth={2.2} /> : <LockOpen size={16} strokeWidth={2.2} />}</span>
      </div>
      <div className="min-w-0">
        <div className="st-vault-eyebrow">
          {encrypted ? <ShieldCheck size={13} aria-hidden /> : <ShieldAlert size={13} aria-hidden />}
          {encrypted ? "Encrypted at rest" : "Not encrypted"}
        </div>
        <div className="st-vault-title">{encrypted ? "Your vault is sealed" : "Your vault is open on disk"}</div>
        <ul className="st-layers" aria-label="Protection layers">
          {layers.map((l, i) => (
            <li key={l.name} className="st-layer" data-on={l.on ? "" : undefined} style={{ ["--i" as string]: i }}>
              <span className="st-layer-led" aria-hidden />
              <span className="st-layer-name">{l.name}</span>
              <span className="st-layer-detail" title={l.detail}>{l.detail}</span>
              <span className="st-layer-state">{l.state}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Hero({ score, tone }: { score: number; tone: "ok" | "warn" | "bad" }) {
  const reduced = useReducedMotionPref();
  const size = 132;
  const sw = 10;
  const r = (size - sw) / 2;
  const c = 2 * Math.PI * r;
  const color = tone === "ok" ? "var(--gain)" : tone === "warn" ? "var(--warning)" : "var(--loss)";
  const headline = score >= 90 ? "Your workspace is well protected" : score >= 70 ? "Good — a few things to tighten" : score >= 40 ? "Some protections are missing" : "Your workspace isn’t protected yet";
  const sub =
    score >= 90
      ? "Encrypted, locking when you step away, and backed up. Keep your recovery key somewhere safe."
      : "Work through the checklist below. Each item explains what it protects against.";
  return (
    <div className="st-hero" data-tone={tone}>
      <div className="st-hero-ring" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden style={{ transform: "rotate(-90deg)" }}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={sw} className="st-hero-track" />
          {/* faint tick marks every 10 points */}
          {Array.from({ length: 10 }, (_, i) => (
            <line key={i} x1={size / 2 + (r - sw / 2 - 6) * Math.cos((i / 10) * 2 * Math.PI)} y1={size / 2 + (r - sw / 2 - 6) * Math.sin((i / 10) * 2 * Math.PI)} x2={size / 2 + (r - sw / 2 - 2) * Math.cos((i / 10) * 2 * Math.PI)} y2={size / 2 + (r - sw / 2 - 2) * Math.sin((i / 10) * 2 * Math.PI)} className="st-hero-tick" />
          ))}
          <m.circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={sw}
            strokeLinecap="round"
            strokeDasharray={c}
            initial={{ strokeDashoffset: reduced ? c * (1 - score / 100) : c }}
            animate={{ strokeDashoffset: c * (1 - score / 100) }}
            transition={reduced ? { duration: 0 } : { duration: 0.9, ease: ease.outExpo, delay: 0.08 }}
            style={{ transition: "stroke 240ms var(--ease-out)" }}
          />
        </svg>
        <div className="st-hero-value">
          <RollingNumber value={score} countUp className="st-hero-num" aria-label={`Security score ${score} of 100`} />
          <span className="st-hero-of">of 100</span>
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="st-hero-eyebrow">
          {tone === "ok" ? <ShieldCheck size={14} aria-hidden /> : <ShieldAlert size={14} aria-hidden />}
          Security score
        </div>
        <h2 className="st-hero-title">{headline}</h2>
        <p className="st-hero-sub">{sub}</p>
      </div>
    </div>
  );
}

function Checklist({ items, onAct }: { items: CheckItem[]; onAct: (id: CheckId) => void }) {
  const reduced = useReducedMotionPref();
  const done = items.filter((i) => i.done).length;
  const ordered = useMemo(() => [...items].sort((a, b) => Number(a.done) - Number(b.done) || b.weight - a.weight), [items]);
  const ACTION: Record<CheckId, string> = {
    encryption: "Turn on",
    recovery: "Confirm",
    autolock: "Set 15 min",
    sleep: "Turn on",
    snapshots: "Set up",
    kdf: "Strengthen",
    integrity: "Run check",
    clipboard: "Set 30 s",
    keys: "Encrypt",
    fde: "Learn more",
  };
  return (
    <Group id="security-score" title="Checklist" description={`${done} of ${items.length} done`} flush>
      <ul className="st-checklist">
        {ordered.map((it) => (
          <m.li key={it.id} layout={reduced ? false : "position"} transition={spring.layout} className="st-check" data-done={it.done ? "" : undefined}>
            <span className="st-check-mark" aria-hidden>
              <AnimatePresence initial={false} mode="wait">
                {it.done ? (
                  <m.span key="y" initial={reduced ? { opacity: 0 } : { scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={spring.bouncy}>
                    <CheckCircle2 size={18} />
                  </m.span>
                ) : (
                  <m.span key="n" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                    <Circle size={18} />
                  </m.span>
                )}
              </AnimatePresence>
            </span>
            <div className="min-w-0 flex-1">
              <div className="st-check-title">{it.title}</div>
              <div className="st-check-detail">{it.detail}</div>
            </div>
            <span className="st-check-weight tabular">+{it.weight}</span>
            {!it.done ? (
              <Button size="xs" variant={it.id === "encryption" ? "primary" : "secondary"} disabled={!!it.blocked} disabledReason={it.blocked} onClick={() => onAct(it.id)}>
                {it.blocked ?? ACTION[it.id]}
              </Button>
            ) : null}
          </m.li>
        ))}
      </ul>
    </Group>
  );
}

function KdfRow({ kdf, onStrengthen }: { kdf: KdfInfo; onStrengthen: () => void }) {
  const [bench, setBench] = useState<KdfBenchmark | null>(null);
  const [busy, setBusy] = useState(false);
  const mib = Math.round(kdf.mKiB / 1024);
  const secs = ((bench?.ms ?? kdf.estMs) / 1000).toFixed(1);
  return (
    <Row
      icon={<Cpu size={16} />}
      label="Key derivation"
      badge={kdf.belowStandard ? <span className="st-tag" data-tone="warn">Below Standard</span> : null}
      description={
        <>
          <span className="st-mono">
            Argon2id · {mib >= 1024 ? `${mib / 1024} GiB` : `${mib} MiB`} · {kdf.t} passes · ~{secs} s on this device
          </span>
          <br />
          Slow on purpose: every password guess costs an attacker the same time and memory.
        </>
      }
    >
      <Button
        size="sm"
        variant="ghost"
        icon={Gauge}
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            setBench(await api.vault.benchmarkKdf());
          } catch (e) {
            notify.fromError(e, "Couldn’t run the benchmark");
          } finally {
            setBusy(false);
          }
        }}
      >
        Benchmark
      </Button>
      {kdf.belowStandard ? (
        <Button size="sm" variant="secondary" onClick={onStrengthen}>
          Strengthen
        </Button>
      ) : null}
    </Row>
  );
}

function LinkRow({ icon, label, detail, to, tone }: { icon: React.ReactNode; label: string; detail: string; to: string; tone: "ok" | "warn" | "neutral" }) {
  return (
    <button type="button" className="st-linkrow" onClick={() => navigate({ t: "settings", section: to }, { replace: true })}>
      <span className="st-row-icon" data-tone={tone}>
        {icon}
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="st-row-label">{label}</span>
        <span className="st-row-desc block">{detail}</span>
      </span>
      <ChevronRight size={16} className="st-linkrow-chev" aria-hidden />
    </button>
  );
}

// ───────────────────────────────────────────────────────────────────────────── auto-lock

async function setAutoLock(next: AutoLock): Promise<void> {
  try {
    if (next.idleMinutes === null && !(await ensureReauth("turn off auto-lock"))) return;
    const st = await api.vault.setAutoLock(next);
    useVault.getState().setStatus(st);
  } catch (e) {
    notify.fromError(e, "Couldn’t change auto-lock");
  }
}

function AutoLockCard() {
  const status = useVault((s) => s.status);
  if (!status) return null;
  const a = status.autoLock;
  const enc = status.encrypted;
  return (
    <Group id="auto-lock" title="Auto-lock" description="When EMP locks, keys are wiped from memory and you’ll need your password again.">
      {!enc ? (
        <div className="st-block">
          <Banner tone="info" inline action={<Button size="xs" variant="secondary" onClick={() => document.querySelector<HTMLElement>('[data-setting="encryption"] button')?.click()}>Turn on encryption</Button>}>
            Locking needs encryption. Without a password there is nothing to lock.
          </Banner>
        </div>
      ) : null}
      <Row icon={<Clock size={16} />} label="When idle" description="No keyboard or mouse input in EMP." badge={a.idleMinutes === null && enc ? <span className="st-tag" data-tone="warn">Never locks</span> : null}>
        <Select
          size="sm"
          disabled={!enc}
          value={a.idleMinutes === null ? "never" : String(a.idleMinutes)}
          onValueChange={(v) => void setAutoLock({ ...a, idleMinutes: v === "never" ? null : Number(v) })}
          options={IDLE}
          aria-label="Lock when idle"
          className="w-[180px]"
        />
      </Row>
      <Row icon={<Timer size={16} />} label="When your computer sleeps">
        <Switch disabled={!enc} checked={a.onSleep} onCheckedChange={(v) => void setAutoLock({ ...a, onSleep: v })} aria-label="Lock on sleep" />
      </Row>
      <Row icon={<Lock size={16} />} label="When you lock your screen or switch users">
        <Switch disabled={!enc} checked={a.onScreenLock} onCheckedChange={(v) => void setAutoLock({ ...a, onScreenLock: v })} aria-label="Lock on screen lock" />
      </Row>
      <Row icon={<HardDrive size={16} />} label="When EMP is in the background" description="The window is minimised or another app is focused.">
        <Select size="sm" disabled={!enc} value={a.onBlurMinutes === null ? "off" : String(a.onBlurMinutes)} onValueChange={(v) => void setAutoLock({ ...a, onBlurMinutes: v === "off" ? null : Number(v) })} options={BLUR} aria-label="Lock in background" className="w-[180px]" />
      </Row>
      <Row icon={<Clock size={16} />} label="After a long session" description="Ask for the password again even while you’re active.">
        <Select size="sm" disabled={!enc} value={a.maxSessionHours === null ? "off" : String(a.maxSessionHours)} onValueChange={(v) => void setAutoLock({ ...a, maxSessionHours: v === "off" ? null : Number(v) })} options={SESSION} aria-label="Maximum session" className="w-[180px]" />
      </Row>
      <Row icon={<Lock size={16} />} label="Lock now" description="Also from the top bar lock icon or the command palette.">
        <Button size="sm" variant="secondary" icon={Lock} disabled={!enc} disabledReason="Turn on encryption first" onClick={() => void useVault.getState().lock().catch((e) => notify.fromError(e, "Couldn’t lock"))}>
          Lock <Kbd keys="mod+shift+l" size="xs" className="ml-1" />
        </Button>
      </Row>
    </Group>
  );
}

// ───────────────────────────────────────────────────────────────────────────── integrity

function IntegrityCard() {
  const integrity = useVault((s) => s.status?.integrity ?? "unchecked");
  const last = useSecurityInfo((s) => s.lastIntegrity);
  const [progress, setProgress] = useState<number | null>(null);
  const [label, setLabel] = useState<string>("");
  const run = async () => {
    setProgress(0);
    try {
      const onEvent = (e: JobEvent) => {
        if (e.kind === "progress" && e.total > 0) {
          setProgress(e.done / e.total);
          if (e.label) setLabel(e.label);
        }
      };
      // Empty-request job: the facade still accepts the progress listener.
      const job = await api.vault.integrityCheck({ onEvent } as unknown as Parameters<typeof api.vault.integrityCheck>[0]);
      const r = await job.result;
      useSecurityInfo.getState().markIntegrity(Date.now());
      await useVault.getState().refresh();
      if (r.ok) notify.success("No tampering detected", { description: "Every encrypted record matches its seal." });
      else notify.error("Integrity check found problems", { description: `${r.damaged.length} damaged records${r.msetMismatch ? " · the manifest doesn’t match" : ""}.` });
    } catch (e) {
      notify.fromError(e, "Couldn’t run the integrity check");
    } finally {
      setProgress(null);
      setLabel("");
    }
  };
  return (
    <Group id="integrity" title="Integrity" description="Tamper-evident: EMP detects if encrypted items are modified outside the app.">
      <Row
        icon={progress !== null ? <Ring value={progress} size={24} aria-label="Integrity check progress" /> : <ScanSearch size={16} />}
        label={integrity === "ok" ? "No tampering detected" : integrity === "warning" ? "Something changed outside EMP" : "Not checked yet"}
        description={progress !== null ? label || "Checking…" : last ? `Last checked ${formatRelative(last)}` : "Checks every record’s seal and the vault manifest."}
      >
        {integrity === "warning" ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={async () => {
              if (!(await ensureReauth("accept these changes"))) return;
              try {
                await api.vault.integrityReseal();
                await useVault.getState().refresh();
                notify.success("Manifest re-sealed");
              } catch (e) {
                notify.error("Couldn’t re-seal", { description: errorMessage(e) });
              }
            }}
          >
            Accept & re-seal
          </Button>
        ) : null}
        <Button size="sm" variant="secondary" data-run-integrity="" loading={progress !== null} onClick={() => void run()}>
          Run now
        </Button>
      </Row>
    </Group>
  );
}

