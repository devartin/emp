/**
 * Recovery key (1.0 brief §2.5; reused by Settings → Privacy & security and the Home reminder): the 24 words in a
 * 4×6 grid, Copy (sensitive clipboard: clears itself) and Save to a file… (the native save dialog, written by Rust —
 * the webview cannot download files), a plain warning, and one checkbox, "I've saved my recovery key". Continuing
 * with the box ticked records the key as saved (`vault_recovery_confirm` with words the person already holds).
 */
import { AlertTriangle, Check, Copy, Download } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useMemo, useState, type ReactNode } from "react";
import { api, errorMessage } from "@/backend";
import { usePrivacy } from "@/stores/privacy";
import { notify } from "@/stores/toasts";
import { Button } from "@/ui/Button";
import { Checkbox } from "@/ui/Checkbox";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import "./vault.css";

export interface RecoveryCeremonyProps {
  words: string[];
  /** Called after the key is recorded as saved (true) or when the person skips (false). */
  onDone: (confirmed: boolean) => void;
  allowSkip?: boolean;
  /** Extra footer content on the left (e.g. a Back button). */
  footerStart?: ReactNode;
  continueLabel?: string;
  /** The caller is still working after `onDone` (e.g. opening Home): keeps the button spinning. */
  busy?: boolean;
}

/** Three distinct positions (the confirm command checks three words). */
function pickPositions(n: number, count = 3): number[] {
  const out = new Set<number>();
  const buf = new Uint32Array(count * 4);
  crypto.getRandomValues(buf);
  for (const v of buf) {
    out.add(v % n);
    if (out.size === count) break;
  }
  let i = 0;
  while (out.size < count) out.add(i++ % n);
  return Array.from(out).sort((a, b) => a - b);
}

export function RecoveryCeremony({ words, onDone, allowSkip = true, footerStart, continueLabel = "Continue", busy: outerBusy = false }: RecoveryCeremonyProps) {
  const positions = useMemo(() => pickPositions(words.length || 24), [words]);
  const [saved, setSaved] = useState(false);
  const [fileSaved, setFileSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const copySensitive = usePrivacy((s) => s.copySensitive);
  const reduced = useReducedMotionPref();

  const saveToFile = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const res = await api.vault.recoverySaveFile({ words });
      if (res.saved) {
        setFileSaved(res.fileName ?? "the file");
        notify.success("Recovery key saved", {
          description: `Saved as ${res.fileName ?? "a text file"}. Keep it somewhere safe, like a USB drive or a password manager.`,
        });
      }
    } catch (e) {
      notify.fromError(e, "Couldn't save the recovery key");
    } finally {
      setSaving(false);
    }
  };

  const finish = async () => {
    if (!saved || busy) return;
    setError(null);
    setBusy(true);
    try {
      const { confirmed } = await api.vault.recoveryConfirm({ positions, words: positions.map((p) => words[p]) });
      if (!confirmed) {
        setError("Couldn't record the recovery key. Try again.");
        return;
      }
      onDone(true);
    } catch (e) {
      setError(errorMessage(e) || "Couldn't record the recovery key");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col">
      <m.ol
        className="emp-words"
        aria-label="Recovery key, 24 words"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, transition: { duration: reduced ? 0.08 : 0.18 } }}
      >
        {words.map((w, i) => (
          <li key={i} className="emp-word">
            <span className="emp-word-n">{i + 1}</span>
            <span className="emp-word-t">{w}</span>
          </li>
        ))}
      </m.ol>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" icon={Copy} onClick={() => copySensitive(words.join(" "))}>
          Copy
        </Button>
        <Button size="sm" icon={fileSaved ? Check : Download} loading={saving} onClick={() => void saveToFile()}>
          {fileSaved ? "Saved to a file" : "Save to a file…"}
        </Button>
      </div>
      <div className="emp-recovery-warn" role="note">
        <AlertTriangle size={16} className="mt-px flex-none" aria-hidden />
        <span>Store this somewhere safe. If you lose both your password and this key, your data can't be recovered.</span>
      </div>

      <div className="mt-5">
        <Checkbox checked={saved} onCheckedChange={(v) => setSaved(v === true)} label="I've saved my recovery key" />
      </div>
      <AnimatePresence initial={false}>
        {error ? (
          <m.p key="err" className="emp-helper mt-2" data-invalid="" role="alert" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: 0.12 } }} exit={{ opacity: 0 }}>
            <span>{error}</span>
          </m.p>
        ) : null}
      </AnimatePresence>

      <div className="emp-onb-foot">
        {footerStart}
        {allowSkip ? (
          <Button variant="ghost" className="text-tertiary" onClick={() => onDone(false)}>
            Not now
          </Button>
        ) : null}
        <Button variant="primary" className="ml-auto" disabled={!saved} loading={busy || outerBusy} onClick={() => void finish()}>
          {continueLabel}
        </Button>
      </div>
    </div>
  );
}

export default RecoveryCeremony;
