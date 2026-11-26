/**
 * App root (§12): MotionConfig + LazyMotion, error boundary, tooltip delay group, toaster, and the phase outlet
 * (booting → onboarding | lock | shell | error). The lock screen and onboarding are in the initial chunk; the shell
 * is lazy and preloaded while the KDF runs.
 *
 * Phase transitions (DESIGN v3 §7):
 *   lock → shell        the end of the vault unlock (C3, a signature moment): the shell fades in over 320ms while the
 *                       lock screen leaves; a 150ms crossfade under reduced motion
 *   onboarding → shell  a plain crossfade (C2 dialog timing, 160ms); no blur, no scale
 */
import { AnimatePresence, m } from "motion/react";
import { Suspense, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { markAppReady } from "@/app/boot";
import { AppErrorBoundary } from "@/features/shell/ErrorBoundary";
import LockScreen from "@/features/vault/LockScreen";
import Onboarding from "@/features/vault/Onboarding/Onboarding";
import { AppMark } from "@/features/vault/AppMark";
import { useSettings } from "@/stores/settings";
import { useVault, type AppPhase } from "@/stores/vault";
import { Button } from "@/ui/Button";
import { Skeleton } from "@/ui/Skeleton";
import { Toaster } from "@/ui/Toast";
import { TooltipProvider } from "@/ui/Tooltip";
import { setCelebrationsEnabled } from "@/ui/motion/Celebrate";
import { MotionProvider } from "@/ui/motion/MotionProvider";
import { motionSeconds } from "@/ui/motion/register";
import { ease } from "@/ui/motion/tokens";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { currentRoute } from "./router";
import { preloadRoute, shellEntry } from "./routes";

const Shell = shellEntry.C;

export default function App() {
  return (
    <MotionProvider>
      <TooltipProvider>
        <AppErrorBoundary>
          <PhaseOutlet />
          <Toaster />
          <SettingsMirrors />
        </AppErrorBoundary>
      </TooltipProvider>
    </MotionProvider>
  );
}

function SettingsMirrors() {
  const celebrations = useSettings((s) => s.vault?.celebrations ?? true);
  useEffect(() => setCelebrationsEnabled(celebrations), [celebrations]);
  return null;
}

/** Longest the outgoing phase is held while the shell chunk finishes downloading. */
const SHELL_WAIT_MS = 1500;

/**
 * Resolves true once the shell chunk (and the first route's chunk) are loaded — they're preloaded during the KDF /
 * onboarding, so this is normally instant. Until then the outgoing phase (lock / onboarding / splash) stays up, so
 * unlocking never flashes the Suspense skeleton.
 */
function useShellReady(phase: AppPhase): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (phase !== "shell" || ready) return;
    let alive = true;
    const done = () => {
      if (alive) setReady(true);
    };
    const timer = window.setTimeout(done, SHELL_WAIT_MS);
    preloadRoute(currentRoute());
    shellEntry.load().then(done, done);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [phase, ready]);
  return ready;
}

function PhaseOutlet() {
  const phase = useVault((s) => s.phase);
  const prev = useRef<AppPhase>(phase);
  const from = useRef<AppPhase>(phase);
  if (prev.current !== phase) {
    from.current = prev.current;
    prev.current = phase;
  }
  const shellReady = useShellReady(phase);
  const shown: AppPhase = phase === "shell" && !shellReady ? from.current : phase;
  return (
    <div className="emp-app-root">
      <AnimatePresence initial={false}>
        {shown === "booting" ? <BootSplash key="booting" /> : null}
        {shown === "onboarding" ? <Onboarding key="onboarding" /> : null}
        {shown === "lock" ? <LockScreen key="lock" /> : null}
        {shown === "error" ? <BootError key="error" /> : null}
        {shown === "shell" ? <ShellPhase key="shell" from={from.current} /> : null}
      </AnimatePresence>
    </div>
  );
}

function ShellPhase({ from }: { from: AppPhase }) {
  const reduced = useReducedMotionPref();
  const fromOnboarding = from === "onboarding";
  const fromLock = from === "lock";
  const animated = fromOnboarding || fromLock;
  // Unlock is the vault moment (≤ 600ms); first run ends on an ordinary crossfade.
  const dur = fromLock ? Math.min(0.32, motionSeconds("vaultUnlock", reduced)) : motionSeconds("dialog", reduced) || 0.12;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // First shell frame is on screen: report boot marks (§3.9 app_ready).
    const raf = requestAnimationFrame(() => markAppReady());
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <m.div
      ref={ref}
      className="emp-phase"
      data-phase="shell"
      initial={animated ? { opacity: 0 } : false}
      animate={{ opacity: 1, transition: { duration: dur, ease: ease.out } }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
    >
      <Suspense fallback={<ShellSkeleton />}>
        <Shell />
      </Suspense>
    </m.div>
  );
}

/** Shown only if boot takes longer than a frame or two; the window itself paints the theme background first. */
function BootSplash() {
  return (
    <m.div
      className="emp-phase flex items-center justify-center bg-window"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: { delay: 0.35, duration: 0.24 } }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      aria-busy
      aria-label="Starting Ultra Note"
    >
      <AppMark size={56} animate={false} className="opacity-70" />
    </m.div>
  );
}

function BootError() {
  const message = useVault((s) => s.bootError);
  return (
    <m.div className="emp-phase flex items-start justify-center bg-canvas px-6 pt-[18vh]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} role="alert">
      <div className="w-[420px] max-w-full">
        <AppMark size={40} animate={false} />
        <h1 className="mt-5 text-h2 text-primary">Ultra Note couldn't open your workspace</h1>
        <p className="mt-2 text-body text-secondary">{message || "The app backend didn't respond."}</p>
        <Button className="mt-6" variant="primary" icon={RefreshCw} onClick={() => window.location.reload()}>
          Try again
        </Button>
      </div>
    </m.div>
  );
}

/** Suspense fallback while the shell chunk downloads (normally preloaded during the KDF, so rarely seen). */
function ShellSkeleton() {
  const width = 248;
  return (
    <div className="flex h-screen w-full bg-canvas" aria-busy aria-label="Opening your workspace">
      <div className="flex flex-none flex-col gap-3 border-r border-subtle bg-window px-3 pt-4" style={{ width }}>
        <div className="flex items-center gap-2 px-1">
          <Skeleton width={22} height={22} radius={6} />
          <Skeleton width={110} height={12} />
        </div>
        <div className="mt-3 flex flex-col gap-3 px-1">
          {[70, 52, 58, 64, 48].map((w, i) => (
            <Skeleton key={i} width={`${w}%`} height={10} />
          ))}
        </div>
        <div className="mt-6 flex flex-col gap-3 px-1">
          {[80, 66, 74, 58, 70, 62].map((w, i) => (
            <Skeleton key={i} width={`${w}%`} height={10} />
          ))}
        </div>
      </div>
      <div className="flex-1">
        <div className="h-11 border-b border-subtle" />
      </div>
    </div>
  );
}
