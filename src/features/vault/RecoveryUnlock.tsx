/**
 * Recovery-key unlock (§6.3 "Use recovery key", §11.3 vault_unlock_recovery): 24 words + a new password. Paste the
 * whole key into any box and it spreads across the grid; Space/Enter advances, Backspace on an empty box goes back.
 */
import { KeyRound } from "lucide-react";
import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { errorMessage, hasCode, isApiError } from "@/backend";
import type { PasswordStrength } from "@/backend/types";
import { useVault } from "@/stores/vault";
import { Banner } from "@/ui/Banner";
import { Button } from "@/ui/Button";
import { PasswordField, passwordAcceptable } from "./PasswordField";

const N = 24;

export function RecoveryUnlock({ lockoutUntil, onLockout }: { lockoutUntil: number; onLockout: (ms: number) => void }) {
  const [words, setWords] = useState<string[]>(() => Array(N).fill(""));
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [strength, setStrength] = useState<PasswordStrength | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wordsError, setWordsError] = useState(false);
  const busy = useVault((s) => s.unlocking);
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  const filled = words.filter((w) => w.trim()).length;
  const locked = lockoutUntil > Date.now();
  const canSubmit = filled === N && passwordAcceptable(pw, strength) && pw === confirm && !busy && !locked;

  const setAt = (i: number, v: string) => {
    setWordsError(false);
    setWords((cur) => {
      const next = cur.slice();
      next[i] = v.toLowerCase().replace(/[^a-z]/g, "");
      return next;
    });
  };

  const spread = (start: number, text: string) => {
    const parts = text
      .toLowerCase()
      .split(/[\s,;]+/)
      .map((w) => w.replace(/^\d+[.)]?/, "").replace(/[^a-z]/g, ""))
      .filter(Boolean);
    if (parts.length <= 1) return false;
    setWords((cur) => {
      const next = cur.slice();
      const from = parts.length >= N ? 0 : start;
      parts.slice(0, N - from).forEach((w, k) => (next[from + k] = w));
      return next;
    });
    const last = Math.min(N - 1, (parts.length >= N ? 0 : start) + parts.length);
    window.requestAnimationFrame(() => refs.current[last]?.focus());
    return true;
  };

  const onKey = (i: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === " " || e.key === "Enter") && words[i]) {
      e.preventDefault();
      refs.current[Math.min(N - 1, i + 1)]?.focus();
    } else if (e.key === "Backspace" && !words[i] && i > 0) {
      e.preventDefault();
      refs.current[i - 1]?.focus();
    }
  };

  const onPaste = (i: number) => (e: ClipboardEvent<HTMLInputElement>) => {
    if (spread(i, e.clipboardData.getData("text"))) e.preventDefault();
  };

  const submit = async () => {
    if (!canSubmit) return;
    setError(null);
    try {
      await useVault.getState().unlockWithRecovery(words.map((w) => w.trim()), pw);
    } catch (e) {
      const retry = isApiError(e) ? e.details?.retryAfterMs : undefined;
      if (retry) onLockout(retry);
      const field = isApiError(e) ? e.details?.field : undefined;
      if (hasCode(e, "CRYPTO", "BAD_PASSWORD") || (hasCode(e, "INVALID") && field !== "newPassword")) {
        // Wrong words, or the words of a key that was replaced since ("stale" words): the same plain answer.
        setWordsError(true);
        setError("Those words don't match this workspace's current recovery key. Check the order and spelling. If you made a new key, use the newest one.");
      } else if (hasCode(e, "RATE_LIMITED")) setError("Too many tries. Wait a moment, then try again.");
      else if (hasCode(e, "INVALID")) setError(errorMessage(e) || "Choose a stronger new password");
      else {
        const msg = errorMessage(e);
        setError(msg ? msg.charAt(0).toUpperCase() + msg.slice(1) : "Couldn't unlock with the recovery key");
      }
    }
  };

  return (
    <form
      className="flex flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-accent-soft text-accent">
          <KeyRound size={18} aria-hidden />
        </span>
        <div>
          <h1 id="lock-title" className="text-title text-primary">
            Unlock with your recovery key
          </h1>
          <p className="text-body-sm text-tertiary">Enter the 24 words in order, then choose a new password.</p>
        </div>
      </div>
      <div className="emp-word-inputs mt-5" role="group" aria-label="Recovery key words" aria-invalid={wordsError || undefined}>
        {words.map((w, i) => (
          <label key={i} className="emp-word-input" data-filled={w ? "" : undefined} style={wordsError ? { borderColor: "var(--loss)" } : undefined}>
            <span aria-hidden>{i + 1}</span>
            <input
              ref={(el) => {
                refs.current[i] = el;
              }}
              value={w}
              aria-label={`Word ${i + 1}`}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              autoFocus={i === 0}
              onChange={(e) => {
                const v = e.currentTarget.value;
                if (/\s/.test(v.trim()) && spread(i, v)) return;
                setAt(i, v);
              }}
              onKeyDown={onKey(i)}
              onPaste={onPaste(i)}
            />
          </label>
        ))}
      </div>
      <p className="mt-2 text-caption text-tertiary tabular" style={{ fontWeight: 400 }}>
        {filled} of 24 words · Tip: paste the whole key into the first box.
      </p>
      <div className="mt-5 flex flex-col gap-3">
        <PasswordField size="lg" purpose="new" label="New password" value={pw} onChange={setPw} strength onStrength={setStrength} />
        <PasswordField
          size="lg"
          purpose="new"
          label="Confirm new password"
          value={confirm}
          onChange={setConfirm}
          error={confirm && pw !== confirm ? "Passwords don't match" : undefined}
          onEnter={() => void submit()}
        />
      </div>
      {error ? (
        <Banner tone="danger" inline className="mt-4">
          {error}
        </Banner>
      ) : null}
      <Button type="submit" variant="primary" size="lg" block className="relative mt-5 overflow-hidden" disabled={!canSubmit}>
        {busy ? "Unlocking…" : "Unlock and set new password"}
        {busy ? <span className="emp-kdf-shimmer" aria-hidden /> : null}
      </Button>
    </form>
  );
}

export default RecoveryUnlock;
