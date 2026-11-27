/**
 * Lock screen (§6.3, §9.9, §9.10). Full-window aurora with grain; no app content is mounted. A 360px card with the
 * workspace avatar, an xl password field, "Unlock" (xl, full width) and "Use recovery key". Wrong password shakes the
 * card; Caps Lock shows a chip; backoff shows a live countdown inside the disabled button; the KDF shows a shimmer.
 * On success the vault store flips to unlocked and boot.ts enters the shell (App animates the hand-off).
 */
import { ArrowLeft, KeyRound, Lock } from "lucide-react";
import { AnimatePresence, m, useAnimationControls, useIsPresent } from "motion/react";
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
      return "Locked while Ultranote was in the background";
    case "session_max":
      return "Locked at the end of the session limit";
    case "panic":
      return "Locked";
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

/** A row of the lock card rising into place after the slabs land (S2: the password well rises +160ms). */
function rise(reduced: boolean, scaleFrom = 1) {
  return {
    hidden: reduced ? { opacity: 0 } : { opacity: 0, y: 8, scale: scaleFrom },
    show: { opacity: 1, y: 0, scale: 1, transition: reduced ? { duration: 0.12 } : { ...spring.settle, opacity: { duration: 0.24, ease: ease.out } } },
  };
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
  // S2: the slab stack drops in, presses on success, jolts on a wrong password and separates as the vault opens.
  const present = useIsPresent();
  const [markStage, setMarkStage] = useState<"drop" | "rest" | "press" | "jolt">("drop");
  const [markKey, setMarkKey] = useState(0);
  const stage = present ? markStage : "open";

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
      setMarkStage("press");
      setMarkKey((n) => n + 1);
    } catch (e) {
      const retry = isApiError(e) ? e.details?.retryAfterMs : undefined;
      if (retry) setLockoutUntil(Date.now() + retry);
      if (hasCode(e, "BAD_PASSWORD")) {
        setError("Incorrect password");
        setPassword("");
        setMarkStage("jolt");
        setMarkKey((n) => n + 1);
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
  const name = identity.workspaceName || "Ultranote";

  return (
    <m.div
      className="emp-stage emp-vault-stage"
      onScroll={(e) => e.currentTarget.scrollLeft && (e.currentTarget.scrollLeft = 0)}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: { duration: 0.24 } }}
      exit={{ opacity: 0, transition: reduced ? { duration: 0.14 } : { duration: 0.52, delay: 0.3, ease: ease.out } }}
      style={{ pointerEvents: present ? undefined : "none" }}
    >
      <span className="emp-stage-light" aria-hidden />
      <div className="emp-stage-drag drag-region" data-tauri-drag-region />
      <WindowControls className="absolute right-0 top-0" />
      <m.div
        className="emp-vault-card emp-lock-card"
        data-wide={mode === "recovery" ? "" : undefined}
        layout={!reduced}
        transition={spring.gentle}
        initial={{ opacity: 0, scale: reduced ? 1 : 0.97, y: reduced ? 0 : 10 }}
        animate={{ opacity: 1, scale: 1, y: 0, transition: { ...spring.settle, opacity: { duration: 0.3, ease: ease.out } } }}
        exit={reduced ? { opacity: 0, transition: { duration: 0.12 } } : { opacity: 0, scale: 1.035, y: -6, filter: "blur(6px)", transition: { duration: 0.42, delay: 0.24, ease: ease.out } }}
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
                variants={{
                  hidden: { opacity: 0, x: 0 },
                  show: { opacity: 1, x: 0, transition: { duration: 0.2, ease: ease.out, staggerChildren: reduced ? 0 : 0.05, delayChildren: reduced || markStage !== "drop" ? 0 : 0.34 } },
                  leave: { opacity: 0, x: reduced ? 0 : -12, transition: { duration: 0.12, ease: ease.in } },
                }}
                initial="hidden"
                animate="show"
                exit="leave"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
              >
                <div className="emp-lock-hero">
                  <AppMark size={76} stage={stage} stageKey={markKey} />
                  <m.span className="emp-lock-badge" aria-hidden variants={rise(reduced, 0.9)}>
                    <Lock size={11} strokeWidth={2.5} />
                  </m.span>
                </div>
                <m.h1 id="lock-title" className="emp-lock-title" variants={rise(reduced)}>
                  {name}
                </m.h1>
                <m.p className="mt-1 text-body-sm text-tertiary" variants={rise(reduced)}>
                  Enter your password to unlock
                </m.p>
                <m.div className="mt-6 w-full" variants={rise(reduced)}>
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
                </m.div>
                <m.div className="w-full" variants={rise(reduced)}>
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
                </m.div>
                <m.div variants={rise(reduced)}>
                  <Button variant="ghost" size="md" className="mt-2" icon={KeyRound} onClick={() => setMode("recovery")}>
                    Use recovery key
                  </Button>
                </m.div>
                <m.p className="emp-lock-caption" variants={rise(reduced)}>
                  {captionFor(reason, status?.autoLock.idleMinutes ?? 15)}
                </m.p>
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
