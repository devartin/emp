/**
 * App root (§12): MotionConfig + LazyMotion, error boundary, tooltip delay group, toaster, and the phase outlet
 * (booting → onboarding | lock | shell | error). The lock screen and onboarding are in the initial chunk; the shell
 * is lazy and preloaded while the KDF runs.
 *
 * Phase transitions (§4.2, §6.2 step 8):
 *   lock → shell        lock card scales 1→0.96 and fades; the shell enters with scale 1.02→1, opacity, blur 12→0 (320ms)
 *   onboarding → shell  the panel scales 1→1.04 and fades; the shell enters with scale 0.98→1, blur 8→0 (480ms)
 */
import { AnimatePresence, m } from "motion/react";
import { Suspense, useEffect, useRef } from "react";
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
import { ease } from "@/ui/motion/tokens";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { shellEntry } from "./routes";

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

function PhaseOutlet() {
  const phase = useVault((s) => s.phase);
  const prev = useRef<AppPhase>(phase);
  const from = useRef<AppPhase>(phase);
  if (prev.current !== phase) {
    from.current = prev.current;
    prev.current = phase;
  }
  return (
    <div className="emp-app-root">
      <AnimatePresence initial={false}>
        {phase === "booting" ? <BootSplash key="booting" /> : null}
        {phase === "onboarding" ? <Onboarding key="onboarding" /> : null}
        {phase === "lock" ? <LockScreen key="lock" /> : null}
        {phase === "error" ? <BootError key="error" /> : null}
        {phase === "shell" ? <ShellPhase key="shell" from={from.current} /> : null}
      </AnimatePresence>
    </div>
  );
}

function ShellPhase({ from }: { from: AppPhase }) {
  const reduced = useReducedMotionPref();
  const fromOnboarding = from === "onboarding";
  const fromLock = from === "lock";
  const animated = (fromOnboarding || fromLock) && !reduced;
  const dur = fromOnboarding ? 0.48 : 0.32;
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
      initial={
        animated
          ? { opacity: 0, scale: fromOnboarding ? 0.98 : 1.02, filter: `blur(${fromOnboarding ? 8 : 12}px)` }
          : reduced && (fromOnboarding || fromLock)
            ? { opacity: 0 }
            : false
      }
      animate={{ opacity: 1, scale: 1, filter: "blur(0px)", transition: { duration: reduced ? 0.12 : dur, ease: ease.out } }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      onAnimationComplete={() => {
        // A resting `filter`/`transform` would create a containing block for fixed descendants (menus, peek).
        const el = ref.current;
        if (el) {
          el.style.filter = "none";
          el.style.transform = "none";
        }
      }}
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
      aria-label="Starting EMP"
    >
      <AppMark size={56} animate={false} className="opacity-70" />
    </m.div>
  );
}

function BootError() {
  const message = useVault((s) => s.bootError);
  return (
    <m.div className="emp-phase emp-aurora flex items-center justify-center p-8" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} role="alert">
      <div className="w-[420px] rounded-[20px] border border-subtle bg-overlay p-8 text-center shadow-elev-3">
        <AppMark size={56} animate={false} className="mx-auto" />
        <h1 className="mt-5 text-title text-primary">EMP couldn't open your workspace</h1>
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
