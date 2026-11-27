/**
 * Privacy & security flows (§9.10, §9.22): turn encryption on (password → re-encryption progress → recovery key
 * ceremony), turn it off (re-auth, typed DECRYPT, progress), change password, view / regenerate the recovery key,
 * and strengthen key derivation. Every flow asks for re-auth where §9.10 requires it.
 */
import { AlertTriangle, KeyRound, Lock, LockOpen, ShieldCheck, Sparkles } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage, hasCode } from "@/backend";
import type { PasswordStrength } from "@/backend/types";
import { PasswordField, passwordAcceptable } from "@/features/vault/PasswordField";
import { RecoveryCeremony } from "@/features/vault/RecoveryCeremony";
import { shortcutLabel } from "@/lib/platform";
import { notify } from "@/stores/toasts";
import { useVault } from "@/stores/vault";
import { Banner } from "@/ui/Banner";
import { Button } from "@/ui/Button";
import { Checkbox } from "@/ui/Checkbox";
import { Dialog } from "@/ui/Dialog";
import { Input } from "@/ui/Input";
import { celebrate } from "@/ui/motion/Celebrate";
import { ease } from "@/ui/motion/tokens";
import { JobProgress, useJob } from "../JobProgress";
import { reauthWith, withReauth } from "../reauth";

const step = {
  initial: { opacity: 0, x: 16 },
  animate: { opacity: 1, x: 0, transition: { duration: 0.24, ease: ease.out } },
  exit: { opacity: 0, x: -16, transition: { duration: 0.16, ease: ease.in } },
};

function NewPassword({ pw, setPw, confirm, setConfirm, onStrength, onEnter, labels = ["New password", "Confirm password"] }: { pw: string; setPw: (v: string) => void; confirm: string; setConfirm: (v: string) => void; onStrength: (s: PasswordStrength | null) => void; onEnter?: () => void; labels?: [string, string] }) {
  const mismatch = confirm.length > 0 && confirm !== pw;
  return (
    <div className="flex flex-col gap-4">
      <PasswordField value={pw} onChange={setPw} label={labels[0]} size="lg" purpose="new" strength onStrength={onStrength} autoFocus />
      <PasswordField value={confirm} onChange={setConfirm} label={labels[1]} size="lg" purpose="new" error={mismatch ? "Passwords don’t match" : undefined} onEnter={onEnter} />
      <GeneratePassphrase
        onGenerate={(p) => {
          setPw(p);
          setConfirm(p);
        }}
      />
    </div>
  );
}

function GeneratePassphrase({ onGenerate }: { onGenerate: (p: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ p: string; bits: number } | null>(null);
  return (
    <div className="st-passphrase">
      <Button
        size="sm"
        variant="soft"
        icon={Sparkles}
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await api.password.generate();
            setLast({ p: r.passphrase, bits: r.bits });
            onGenerate(r.passphrase);
          } catch (e) {
            notify.fromError(e, "Couldn’t generate a passphrase");
          } finally {
            setBusy(false);
          }
        }}
      >
        Generate passphrase
      </Button>
      {last ? (
        <span className="st-passphrase-out">
          <code className="st-mono">{last.p}</code> · about {Math.round(last.bits)} bits. Write it down before you continue.
        </span>
      ) : (
        <span className="st-hint">Five random words are easy to remember and very hard to guess.</span>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── turn encryption on

export function EnableEncryptionDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [phase, setPhase] = useState<"password" | "running" | "recovery" | "done">("password");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [strength, setStrength] = useState<PasswordStrength | null>(null);
  const [words, setWords] = useState<string[]>([]);
  const job = useJob<{ recoveryWords: string[] }>();
  const doneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setPhase("password");
      setPw("");
      setConfirm("");
      setWords([]);
      job.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const ok = passwordAcceptable(pw, strength) && pw === confirm;
  const start = async () => {
    if (!ok) return;
    setPhase("running");
    try {
      const res = await job.start((onEvent) => api.vault.enableEncryption({ password: pw, onEvent }));
      setPw("");
      setConfirm("");
      if (res) {
        setWords(res.recoveryWords);
        await useVault.getState().refresh();
        window.setTimeout(() => setPhase("recovery"), 500);
      }
    } catch (e) {
      if (hasCode(e, "CANCELLED")) setPhase("password");
      else notify.fromError(e, "Couldn’t turn on encryption");
    }
  };

  const busy = phase === "running";
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !busy && phase !== "recovery" && onOpenChange(o)}
      dismissible={!busy && phase !== "recovery"}
      closeButton={!busy && phase !== "recovery"}
      size={phase === "recovery" ? "lg" : "md"}
      title={phase === "recovery" ? "Save your recovery key" : phase === "done" ? "Encryption is on" : "Turn on encryption"}
      description={
        phase === "password"
          ? "Everything you write is encrypted on this computer. Only your password, or your recovery key, can open it."
          : phase === "recovery"
            ? "Your password never leaves this device, and we can’t reset it. Your recovery key is the only other way in, so keep it safe."
            : undefined
      }
      footer={
        phase === "password" ? (
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="primary" icon={Lock} disabled={!ok} onClick={() => void start()}>
              Encrypt workspace
            </Button>
          </>
        ) : phase === "done" ? (
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        ) : undefined
      }
    >
      <AnimatePresence mode="wait" initial={false}>
        {phase === "password" ? (
          <m.div key="pw" {...step} className="flex flex-col gap-4">
            <NewPassword pw={pw} setPw={setPw} confirm={confirm} setConfirm={setConfirm} onStrength={setStrength} onEnter={() => void start()} />
            <p className="st-hint">At least 10 characters and a “Strong” rating. Ultranote can’t recover a forgotten password — your recovery key is the only other way in.</p>
          </m.div>
        ) : null}
        {phase === "running" ? (
          <m.div key="run" {...step} className="flex flex-col gap-5 py-2">
            <EncryptingVisual />
            <JobProgress state={job.state} title="Encrypting your workspace" onCancel={job.cancel} doneLabel="Every record is encrypted" />
            <p className="st-hint">Keep Ultranote open. This usually takes under a minute.</p>
          </m.div>
        ) : null}
        {phase === "recovery" ? (
          <m.div key="rk" {...step}>
            <RecoveryCeremony
              words={words}
              continueLabel="Finish"
              onDone={(confirmed) => {
                void useVault.getState().refresh();
                setPhase("done");
                if (!confirmed) notify.warning("Recovery key not confirmed", { description: "You can confirm it later in Settings, Privacy & security." });
                window.setTimeout(() => doneRef.current && celebrate(doneRef.current), 260);
              }}
            />
          </m.div>
        ) : null}
        {phase === "done" ? (
          <m.div key="done" {...step} className="flex flex-col items-center gap-3 py-6 text-center">
            <div ref={doneRef} className="st-done-badge">
              <ShieldCheck size={26} />
            </div>
            <p className="text-title text-primary">Your workspace is encrypted</p>
            <p className="max-w-[380px] text-body-sm text-secondary">{`Ultranote now locks automatically when you step away. Press ${shortcutLabel("mod+shift+l")} any time to lock now.`}</p>
          </m.div>
        ) : null}
      </AnimatePresence>
    </Dialog>
  );
}

/** Rows of ciphertext "settling" into place while the job runs (decorative). */
function EncryptingVisual() {
  const rows = 5;
  return (
    <div className="st-cipher" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="st-cipher-row" style={{ animationDelay: `${i * 140}ms` }}>
          {Array.from({ length: 6 }, (_, k) => (
            <i key={k} style={{ width: `${18 + ((i * 7 + k * 13) % 34)}%` }} />
          ))}
        </span>
      ))}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── turn encryption off

export function DisableEncryptionDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [typed, setTyped] = useState("");
  const [pw, setPw] = useState("");
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const job = useJob<void>();

  useEffect(() => {
    if (open) {
      setTyped("");
      setPw("");
      setAck(false);
      setError(null);
      job.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const running = job.state.phase === "running";
  const done = job.state.phase === "done";
  const ready = typed === "DECRYPT" && pw.length > 0 && ack;

  const run = async () => {
    setError(null);
    try {
      // The password typed here confirms it's you: no second prompt.
      await reauthWith(pw);
      const r = await withReauth("turn off encryption", () => job.start((onEvent) => api.vault.disableEncryption({ password: pw, confirm: "DECRYPT", onEvent })));
      setPw("");
      if (r === null) return;
      await useVault.getState().refresh();
      notify.info("Encryption is off", { description: "Your workspace is now stored unencrypted on this device." });
    } catch (e) {
      setError(hasCode(e, "BAD_PASSWORD") ? "Incorrect password" : errorMessage(e));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !running && onOpenChange(o)}
      dismissible={!running}
      closeButton={false}
      size="md"
      title="Turn off encryption?"
      icon={
        <span className="st-danger-icon" aria-hidden>
          <LockOpen size={18} />
        </span>
      }
      description="Ultranote will decrypt every page, row and attachment and store them as plain files on this device."
      footer={
        done ? (
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={running} autoFocus>
              Cancel
            </Button>
            <Button variant="destructive" disabled={!ready || running} loading={running} onClick={() => void run()}>
              Decrypt workspace
            </Button>
          </>
        )
      }
    >
      {running || done ? (
        <JobProgress state={job.state} title="Decrypting your workspace" doneLabel="Encryption is off" />
      ) : (
        <div className="flex flex-col gap-4">
          <Banner tone="warning" inline icon={AlertTriangle}>
            Anyone who can open this computer’s files will be able to read your notes, finances and API keys’ labels. Automatic snapshots stop until you set a backup password.
          </Banner>
          <PasswordField value={pw} onChange={setPw} label="Password" size="lg" purpose="current" error={error ?? undefined} autoFocus={false} />
          <Input label={<>Type <b className="st-mono">DECRYPT</b> to confirm</>} value={typed} onChange={(e) => setTyped(e.currentTarget.value)} placeholder="DECRYPT" autoComplete="off" spellCheck={false} className="st-mono" />
          <Checkbox checked={ack} onCheckedChange={setAck} label="I understand my data will be readable by anyone with access to this device" />
        </div>
      )}
    </Dialog>
  );
}

// ───────────────────────────────────────────────────────────────────────────── change password

export function ChangePasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [old, setOld] = useState("");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [strength, setStrength] = useState<PasswordStrength | null>(null);
  const [error, setError] = useState<{ field: string; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setOld("");
      setPw("");
      setConfirm("");
      setError(null);
    }
  }, [open]);

  const ok = old.length > 0 && passwordAcceptable(pw, strength) && pw === confirm && pw !== old;
  const submit = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      await reauthWith(old);
      const status = await withReauth("change your password", () => api.vault.changePassword({ oldPassword: old, newPassword: pw }));
      if (!status) return;
      useVault.getState().setStatus(status);
      setOld("");
      setPw("");
      setConfirm("");
      onOpenChange(false);
      notify.success("Password changed", { description: "Use your new password next time you unlock. Your recovery key still works." });
    } catch (e) {
      if (hasCode(e, "BAD_PASSWORD")) setError({ field: "old", msg: "That’s not your current password" });
      else setError({ field: (e as { details?: { field?: string } }).details?.field ?? "new", msg: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      size="md"
      title="Change password"
      description="Your data stays encrypted with the same key; only the lock on that key changes."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ok} loading={busy} onClick={() => void submit()}>
            Change password
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <PasswordField value={old} onChange={setOld} label="Current password" size="lg" purpose="current" error={error?.field === "old" || error?.field === "oldPassword" ? error.msg : undefined} autoFocus />
        <NewPassword pw={pw} setPw={setPw} confirm={confirm} setConfirm={setConfirm} onStrength={setStrength} onEnter={() => void submit()} />
        {error && error.field !== "old" && error.field !== "oldPassword" ? (
          <Banner tone="danger" inline>
            {error.msg}
          </Banner>
        ) : null}
      </div>
    </Dialog>
  );
}

// ───────────────────────────────────────────────────────────────────────────── recovery key

export function RecoveryKeyDialog({ open, onOpenChange, mode }: { open: boolean; onOpenChange: (o: boolean) => void; mode: "view" | "regenerate" }) {
  const [words, setWords] = useState<string[] | null>(null);
  const [stage, setStage] = useState<"intro" | "ceremony" | "done">("intro");
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState(false);

  useEffect(() => {
    if (open) {
      setWords(null);
      setStage("intro");
      setAck(false);
    }
  }, [open]);

  const begin = async () => {
    setBusy(true);
    try {
      const res = await withReauth(mode === "view" ? "view your recovery key" : "create a new recovery key", () => (mode === "view" ? api.vault.recoveryView() : api.vault.recoveryRegenerate()));
      if (!res) return;
      setWords(res.words);
      setStage("ceremony");
      await useVault.getState().refresh();
    } catch (e) {
      if (hasCode(e, "UNSUPPORTED") && mode === "view") notify.info("This key can’t be shown again", { description: "Once confirmed, the recovery key is never displayed. Create a new one instead." });
      else notify.fromError(e, "Couldn’t open the recovery key");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !busy && stage !== "ceremony" && onOpenChange(o)}
      dismissible={stage !== "ceremony"}
      closeButton={stage !== "ceremony"}
      size={stage === "ceremony" ? "lg" : "md"}
      title={mode === "view" ? "Your recovery key" : "Create a new recovery key"}
      description={stage === "intro" ? (mode === "view" ? "Write the 24 words down and keep them somewhere safe, away from this computer." : "Your current recovery key stops working immediately. Only do this if you lost it or think someone else has seen it.") : undefined}
      footer={
        stage === "intro" ? (
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant={mode === "regenerate" ? "destructive" : "primary"} icon={KeyRound} loading={busy} disabled={mode === "regenerate" && !ack} onClick={() => void begin()}>
              {mode === "view" ? "Show recovery key" : "Replace recovery key"}
            </Button>
          </>
        ) : stage === "done" ? (
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        ) : undefined
      }
    >
      <AnimatePresence mode="wait" initial={false}>
        {stage === "intro" ? (
          <m.div key="intro" {...step} className="flex flex-col gap-4">
            <div className="st-rk-preview" aria-hidden>
              {Array.from({ length: 24 }, (_, i) => (
                <span key={i}>
                  <b>{i + 1}</b>
                  <i style={{ width: `${40 + ((i * 17) % 40)}%` }} />
                </span>
              ))}
            </div>
            {mode === "regenerate" ? <Checkbox checked={ack} onCheckedChange={setAck} label="I understand my old recovery key will stop working" /> : <p className="st-hint">Make sure nobody can see your screen.</p>}
          </m.div>
        ) : null}
        {stage === "ceremony" && words ? (
          <m.div key="cer" {...step}>
            <RecoveryCeremony
              words={words}
              continueLabel="Done"
              onDone={(confirmed) => {
                void useVault.getState().refresh();
                setStage("done");
                if (confirmed) notify.success("Recovery key confirmed");
              }}
            />
          </m.div>
        ) : null}
        {stage === "done" ? (
          <m.div key="done" {...step} className="flex flex-col items-center gap-2 py-6 text-center">
            <div className="st-done-badge">
              <KeyRound size={24} />
            </div>
            <p className="text-title text-primary">{useVault.getState().status?.recoveryConfirmed ? "Recovery key saved" : "Recovery key not confirmed"}</p>
            <p className="max-w-[380px] text-body-sm text-secondary">If you lose both your password and this key, your data cannot be recovered.</p>
          </m.div>
        ) : null}
      </AnimatePresence>
    </Dialog>
  );
}

// ───────────────────────────────────────────────────────────────────────────── strengthen KDF

export function StrengthenDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setPw("");
      setError(null);
    }
  }, [open]);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const st = await api.vault.strengthenKdf({ password: pw });
      useVault.getState().setStatus(st);
      setPw("");
      onOpenChange(false);
      notify.success("Password protection strengthened", { description: "Guessing your password now takes much longer." });
    } catch (e) {
      setError(hasCode(e, "BAD_PASSWORD") ? "Incorrect password" : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      size="sm"
      title="Strengthen password protection"
      description="Ultranote protects your key with stronger settings, so each password guess costs an attacker more time. Your data isn’t re-encrypted."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!pw} onClick={() => void run()}>
            Strengthen
          </Button>
        </>
      }
    >
      <PasswordField value={pw} onChange={setPw} label="Password" size="lg" purpose="current" autoFocus error={error ?? undefined} onEnter={() => void run()} />
    </Dialog>
  );
}
