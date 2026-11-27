/**
 * App root (§12): MotionConfig + LazyMotion, error boundary, tooltip delay group, toaster, and the phase outlet
 * (booting → onboarding | lock | shell | error). The lock screen and onboarding are in the initial chunk; the shell
 * is lazy and preloaded while the KDF runs.
 *
 * Phase transitions (DESIGN v3 §7):
 *   lock → shell        the tail of the vault unlock (C3): opacity only, 200ms (the moment's exit budget), so the
 *                       lock screen's own beat keeps the headroom; a 150ms crossfade under reduced motion
 *   onboarding → shell  a plain crossfade (C2 dialog timing, 160ms); no blur, no scale
 */
import { AnimatePresence, m } from "motion/react";
import { Suspense, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { reportReady } from "@/app/boot";
import { backendMode } from "@/backend";
import { AppErrorBoundary } from "@/features/shell/ErrorBoundary";
import LockScreen from "@/features/vault/LockScreen";
import Onboarding from "@/features/vault/Onboarding/Onboarding";
import { AppMark } from "@/features/vault/AppMark";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { useVault, type AppPhase } from "@/stores/vault";
import { Button } from "@/ui/Button";
import { Skeleton } from "@/ui/Skeleton";
import { Toaster } from "@/ui/Toast";
import { TooltipProvider } from "@/ui/Tooltip";
import { setCelebrationsEnabled } from "@/ui/motion/Celebrate";
import { MotionProvider } from "@/ui/motion/MotionProvider";
import { REGISTER, motionSeconds } from "@/ui/motion/register";
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
  useEffect(() => {
    // Whichever screen commits first — first run, the lock screen, the shell or the error page — reports ready,
    // which shows the (initially hidden) desktop window (1.0 brief §5).
    if (shown !== "booting") reportReady();
  }, [shown]);
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

/** Longest the shell waits for the hidden desktop window to get its real size (see `useViewportKnown`). */
const VIEWPORT_WAIT_MS = 400;

/**
 * False while the desktop window is still hidden and its viewport is 0 × 0 (WebKitGTK gives a hidden window no
 * size). The shell decides once, at its first render, whether the window is narrow enough to float the sidebar
 * (`(max-width: 899px)`); measured at width 0 it would start without a sidebar, and the media query's change event
 * when the window then appears can be missed (audit #3: no sidebar on 1 relaunch in 8). So the shell's first
 * render waits for the window to have a size: the window is shown by this phase's `app_ready`, and the skeleton
 * (which looks like the shell) is what appears first. Never waits in the browser preview or once the window has a
 * size (unlock, first run), and never longer than VIEWPORT_WAIT_MS.
 */
function useViewportKnown(): boolean {
  const [known, setKnown] = useState(() => backendMode !== "tauri" || window.innerWidth > 0);
  useEffect(() => {
    if (known) return;
    const done = () => {
      if (window.innerWidth > 0) setKnown(true);
    };
    window.addEventListener("resize", done);
    document.addEventListener("visibilitychange", done);
    const poll = window.setInterval(done, 16);
    const cap = window.setTimeout(() => setKnown(true), VIEWPORT_WAIT_MS);
    done();
    return () => {
      window.removeEventListener("resize", done);
      document.removeEventListener("visibilitychange", done);
      window.clearInterval(poll);
      window.clearTimeout(cap);
    };
  }, [known]);
  return known;
}

function ShellPhase({ from }: { from: AppPhase }) {
  const reduced = useReducedMotionPref();
  const sized = useViewportKnown();
  const fromOnboarding = from === "onboarding";
  const fromLock = from === "lock";
  const animated = fromOnboarding || fromLock;
  // Unlock: the shell is the moment's exit (opacity only, ≤ 200ms); first run ends on an ordinary crossfade.
  const dur = fromLock ? (reduced ? motionSeconds("vaultUnlock", true) : REGISTER.vaultUnlock.out / 1000) : motionSeconds("dialog", reduced) || 0.12;
  const ref = useRef<HTMLDivElement>(null);
  return (
    <m.div
      ref={ref}
      className="emp-phase"
      data-phase="shell"
      initial={animated ? { opacity: 0 } : false}
      animate={{ opacity: 1, transition: { duration: dur, ease: ease.out } }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
    >
      <Suspense fallback={<ShellSkeleton />}>{sized ? <Shell /> : <ShellSkeleton />}</Suspense>
    </m.div>
  );
}

/** Shown only if boot takes longer than a frame or two; the window itself paints the theme canvas first, and the
 * splash is the same canvas, so nothing steps in colour before the first screen. */
function BootSplash() {
  return (
    <m.div
      className="emp-phase flex items-center justify-center bg-canvas"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: { delay: 0.35, duration: 0.24 } }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      aria-busy
      aria-label="Starting Ultranote"
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
        <h1 className="mt-5 text-h2 text-primary">Ultranote couldn't open your workspace</h1>
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
  // The sidebar as the shell will show it (brief §2.1): hidden stays hidden, and the remembered width. A hidden
  // desktop window reports width 0; that is "not known yet", not a narrow window, so the sidebar is drawn.
  const sb = useUi.getState();
  const vw = window.innerWidth;
  const width = sb.sidebarCollapsed || (vw > 0 && vw < 900) ? 0 : sb.sidebarWidth;
  return (
    <div className="flex h-screen w-full bg-canvas" aria-busy aria-label="Opening your workspace">
      <div className="flex flex-none flex-col gap-3 border-r border-subtle bg-window px-3 pt-4" style={{ width }} hidden={!width}>
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
