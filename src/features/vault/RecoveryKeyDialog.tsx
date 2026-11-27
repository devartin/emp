/**
 * "Save your recovery key" from Home (1.0 brief §2.5–§2.6): for an encrypted workspace whose key was never recorded
 * as saved (first run quit on the recovery-key screen, or the key was skipped). The words are shown again only after
 * the password (`vault_reauth`, then `vault_recovery_view`), then the same ceremony as first run.
 */
import { useEffect, useState } from "react";
import { api, errorMessage, hasCode } from "@/backend";
import { notify } from "@/stores/toasts";
import { useVault } from "@/stores/vault";
import { Button } from "@/ui/Button";
import { Dialog } from "@/ui/Dialog";
import { PasswordField } from "./PasswordField";
import { RecoveryCeremony } from "./RecoveryCeremony";

export function RecoveryKeyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [password, setPassword] = useState("");
  const [words, setWords] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    // Nothing of the key stays in memory once the dialog closes.
    setPassword("");
    setWords(null);
    setError(null);
  }, [open]);

  const show = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await useVault.getState().reauth(password);
      setPassword("");
      const res = await api.vault.recoveryView();
      setWords(res.words);
    } catch (e) {
      if (hasCode(e, "BAD_PASSWORD")) setError("That password isn't right. Try again.");
      else if (hasCode(e, "RATE_LIMITED")) setError("Too many tries. Wait a moment, then try again.");
      else if (hasCode(e, "UNSUPPORTED")) setError("This key can't be shown again. Make a new one in Settings, Privacy & security.");
      else setError(errorMessage(e) || "Couldn't show your recovery key");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Save your recovery key"
      description={words ? "If you ever forget your password, these 24 words are the only other way in." : "Enter your password to see your recovery key."}
      footer={
        words ? undefined : (
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} disabled={!password} onClick={() => void show()}>
              Show my recovery key
            </Button>
          </>
        )
      }
    >
      {words ? (
        <RecoveryCeremony
          words={words}
          allowSkip={false}
          continueLabel="Done"
          onDone={() => {
            void useVault.getState().refresh().catch(() => undefined);
            onOpenChange(false);
            // Done only records that the person says it is saved (the checkbox); "Save to a file…" confirms a real
            // file itself, so this must not claim a save that may not have happened.
            notify.success("Marked as saved", { description: "Keep your recovery key somewhere safe, away from this computer." });
          }}
        />
      ) : (
        <PasswordField label="Password" value={password} onChange={setPassword} autoFocus error={error} onEnter={() => void show()} size="lg" />
      )}
    </Dialog>
  );
}

export default RecoveryKeyDialog;
