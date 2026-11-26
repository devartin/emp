/**
 * Lock screen (§6.3, §9.9, §9.10). Full-window aurora with grain; no app content is mounted. A 360px card with the
 * workspace avatar, an xl password field, "Unlock" (xl, full width) and "Use recovery key". Wrong password shakes the
 * card; Caps Lock shows a chip; backoff shows a live countdown inside the disabled button; the KDF shows a shimmer.
 * On success the vault store flips to unlocked and boot.ts enters the shell (App animates the hand-off).
 */
import { ArrowLeft, KeyRound, Lock } from "lucide-react";
import { AnimatePresence, m, useAnimationControls } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { hasCode, isApiError, errorMessage } from "@/backend";
import { preloadShell } from "@/app/boot";
import { WindowControls } from "@/features/shell/WindowControls";
import { useVault } from "@/stores/vault";
import { Button } from "@/ui/Button";
import { shake } from "@/ui/motion/presets";
import { ease, spring } from "@/ui/motion/tokens";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { AppMark } from "./AppMark";
import { PasswordField } from "./PasswordField";
import { RecoveryUnlock } from "./RecoveryUnlock";
import { readLockIdentity } from "./identity";
import "./vault.css";

function captionFor(reason: string | null, idleMinutes: number | null): string {
  const idle = idleMinutes === null ? null : idleMinutes >= 60 ? `${idleMinutes / 60} hour${idleMinutes === 60 ? "" : "s"}` : `${idleMinutes} minute${idleMinutes === 1 ? "" : "s"}`;
  switch (reason) {
    case "manual":
      return "Locked by you";
    case "sleep":
      return "Locked when your computer went to sleep";
    case "screen":
      return "Locked when your screen locked";
    case "blur":
      return "Locked while EMP was in the background";
    case "session_max":
      return "Locked at the end of the session limit";
    case "panic":
      return "Locked for your safety";
    default:
      return idle ? `Locked automatically after ${idle}` : "Your workspace is encrypted";
  }
}

function useCountdown(untilMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (untilMs <= Date.now()) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [untilMs]);
  return Math.max(0, Math.ceil((untilMs - now) / 1000));
}

function fmtWait(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export default function LockScreen() {
  const status = useVault((s) => s.status);
  const unlocking = useVault((s) => s.unlocking);
  const reason = useVault((s) => s.lastLockReason);
  const reduced = useReducedMotionPref();
  const identity = useMemo(readLockIdentity, []);
  const [mode, setMode] = useState<"password" | "recovery">("password");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [lockoutUntil, setLockoutUntil] = useState(() => (status?.retryAfterMs ? Date.now() + status.retryAfterMs : 0));
  const wait = useCountdown(lockoutUntil);
  const controls = useAnimationControls();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Warm the shell while the user types (§12: preload shell chunks during the KDF).
    const t = window.setTimeout(() => void preloadShell(), 400);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    if (status?.retryAfterMs) setLockoutUntil((cur) => Math.max(cur, Date.now() + status.retryAfterMs));
  }, [status?.retryAfterMs]);

  useEffect(() => {
    if (wait === 0 && lockoutUntil) inputRef.current?.focus();
  }, [wait, lockoutUntil]);

  const submit = async () => {
    if (!password || unlocking || wait > 0) return;
    setError(null);
    void preloadShell();
    try {
      await useVault.getState().unlock(password);
    } catch (e) {
      const retry = isApiError(e) ? e.details?.retryAfterMs : undefined;
      if (retry) setLockoutUntil(Date.now() + retry);
      if (hasCode(e, "BAD_PASSWORD")) {
        setError("Incorrect password");
        setPassword("");
        if (!reduced) void controls.start(shake);
      } else if (hasCode(e, "RATE_LIMITED")) {
        setError(null);
      } else {
        setError(errorMessage(e) || "Couldn't unlock");
      }
      window.requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  const attempts = status?.failedAttempts ?? 0;
  const name = identity.workspaceName || "EMP";

  return (
    <m.div className="emp-stage emp-aurora" onScroll={(e) => e.currentTarget.scrollLeft && (e.currentTarget.scrollLeft = 0)} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: 0.24 } }} exit={{ opacity: 0, transition: { duration: 0.32, ease: ease.out } }}>
      <div className="emp-stage-drag drag-region" data-tauri-drag-region />
      <WindowControls className="absolute right-0 top-0" />
      <m.div
        className="emp-vault-card emp-lock-card"
        data-wide={mode === "recovery" ? "" : undefined}
        layout={!reduced}
        transition={spring.gentle}
        initial={{ opacity: 0, scale: reduced ? 1 : 0.98, y: reduced ? 0 : 6 }}
        animate={{ opacity: 1, scale: 1, y: 0, transition: { duration: 0.32, ease: ease.outExpo } }}
        exit={{ opacity: 0, scale: reduced ? 1 : 0.96, transition: { duration: 0.32, ease: ease.out } }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lock-title"
      >
        <m.div animate={controls}>
          <AnimatePresence mode="wait" initial={false}>
            {mode === "password" ? (
              <m.form
                key="pw"
                aria-busy={unlocking || undefined}
                className="flex flex-col items-center"
                initial={{ opacity: 0, x: reduced ? 0 : -12 }}
                animate={{ opacity: 1, x: 0, transition: { duration: 0.22, ease: ease.out } }}
                exit={{ opacity: 0, x: reduced ? 0 : -12, transition: { duration: 0.12, ease: ease.in } }}
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
              >
                <div className="relative">
                  {identity.workspaceName ? (
                    <span className="emp-lock-avatar" role="img" aria-label={identity.workspaceName}>
                      {identity.emoji ?? (identity.workspaceName.trim()[0] ?? "E").toUpperCase()}
                    </span>
                  ) : (
                    <AppMark size={64} animate={false} />
                  )}
                  <span className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full border-2 border-[var(--bg-overlay)] bg-inverse text-on-inverse" aria-hidden>
                    <Lock size={11} strokeWidth={2.5} />
                  </span>
                </div>
                <h1 id="lock-title" className="mt-4 text-title text-primary">
                  {name}
                </h1>
                <p className="mt-0.5 text-body-sm text-tertiary">Enter your password to unlock</p>
                <div className="mt-6 w-full">
                  <PasswordField
                    inputRef={inputRef}
                    value={password}
                    onChange={(v) => {
                      setPassword(v);
                      if (error) setError(null);
                    }}
                    placeholder="Password"
                    aria-label="Password"
                    autoFocus
                    disabled={wait > 0}
                    error={error}
                    helper={!error && attempts >= 3 && wait === 0 ? `${attempts} incorrect attempts. Waits get longer after 5.` : undefined}
                  />
                </div>
                <Button
                  type="submit"
                  variant="primary"
                  size="xl"
                  block
                  className="relative mt-3 overflow-hidden"
                  disabled={wait > 0 || !password}
                  onClick={(e) => {
                    if (unlocking) e.preventDefault();
                  }}
                >
                  {wait > 0 ? <span className="tabular">Try again in {fmtWait(wait)}</span> : unlocking ? "Unlocking…" : "Unlock"}
                  {unlocking ? <span className="emp-kdf-shimmer" aria-hidden /> : null}
                </Button>
                <Button variant="ghost" size="md" className="mt-2" icon={KeyRound} onClick={() => setMode("recovery")}>
                  Use recovery key
                </Button>
                <p className="mt-5 text-caption text-tertiary" style={{ fontWeight: 400 }}>
                  {captionFor(reason, status?.autoLock.idleMinutes ?? 15)}
                </p>
              </m.form>
            ) : (
              <m.div
                key="rec"
                initial={{ opacity: 0, x: reduced ? 0 : 12 }}
                animate={{ opacity: 1, x: 0, transition: { duration: 0.22, ease: ease.out } }}
                exit={{ opacity: 0, x: reduced ? 0 : 12, transition: { duration: 0.12, ease: ease.in } }}
              >
                <Button variant="ghost" size="sm" icon={ArrowLeft} className="-ml-2 mb-3" onClick={() => setMode("password")}>
                  Back
                </Button>
                <RecoveryUnlock lockoutUntil={lockoutUntil} onLockout={(ms) => setLockoutUntil(Date.now() + ms)} />
              </m.div>
            )}
          </AnimatePresence>
        </m.div>
      </m.div>
    </m.div>
  );
}
