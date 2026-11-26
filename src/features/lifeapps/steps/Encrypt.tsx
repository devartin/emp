/**
 * Encryption prompt (§16.1): shown first for sensitive apps when the vault is unencrypted. "Turn on encryption" runs
 * `vault_enable_encryption` and the recovery-key ceremony inline; "Not now" continues the wizard.
 */
import { Lock, LockOpen } from "lucide-react";
import { useState } from "react";
import { api, errorMessage } from "@/backend";
import { useVault } from "@/stores/vault";
import { Button } from "@/ui/Button";
import { ChoiceCard } from "@/ui/ChoiceCard";
import { PasswordField } from "@/features/vault/PasswordField";
import { RecoveryCeremony } from "@/features/vault/RecoveryCeremony";

type Phase = "choose" | "password" | "working" | "ceremony";

export function EncryptStep({ appTitle, choice, onChoice, onDone }: { appTitle: string; choice: "encrypt" | "later"; onChoice: (c: "encrypt" | "later") => void; onDone: () => void }) {
  const [phase, setPhase] = useState<Phase>("choose");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [score, setScore] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [words, setWords] = useState<string[]>([]);

  const start = async () => {
    if (pw.length < 10 || score < 3) return setError("Use at least 10 characters and a stronger mix.");
    if (pw !== confirm) return setError("The passwords don’t match.");
    setError(null);
    setPhase("working");
    try {
      const job = await api.vault.enableEncryption({ password: pw });
      const res = await job.result;
      setWords(res.recoveryWords);
      void useVault.getState().refresh();
      setPhase("ceremony");
    } catch (e) {
      setError(errorMessage(e));
      setPhase("password");
    }
  };

  if (phase === "ceremony") return <RecoveryCeremony words={words} onDone={() => onDone()} continueLabel="Continue setup" />;

  if (phase === "password" || phase === "working") {
    return (
      <div className="flex flex-col gap-4">
        <PasswordField value={pw} onChange={setPw} label="Password" purpose="new" strength onStrength={(s) => setScore(s?.score ?? 0)} size="lg" autoFocus />
        <PasswordField value={confirm} onChange={setConfirm} label="Confirm password" purpose="new" size="lg" error={error ?? undefined} onEnter={start} />
        <div className="flex gap-2">
          <Button variant="primary" loading={phase === "working"} onClick={start}>
            {phase === "working" ? "Securing your workspace…" : "Turn on encryption"}
          </Button>
          <Button variant="ghost" onClick={() => setPhase("choose")} disabled={phase === "working"}>
            Back
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ChoiceCard
        className="la-choice la-choice-row"
        selected={choice === "encrypt"}
        onSelect={() => onChoice("encrypt")}
        icon={Lock}
        recommended
        title="Encrypt with a password"
        description={`Your data is encrypted with XChaCha20-Poly1305. Without your password or recovery key, nobody, including us, can read it.`}
      />
      <ChoiceCard className="la-choice la-choice-row" selected={choice === "later"} onSelect={() => onChoice("later")} icon={LockOpen} title="Not now" description={`Set up ${appTitle} without encryption. You can turn it on later in Settings.`} />
      {choice === "encrypt" ? (
        <div>
          <Button variant="primary" onClick={() => setPhase("password")}>Choose a password</Button>
        </div>
      ) : null}
    </div>
  );
}
