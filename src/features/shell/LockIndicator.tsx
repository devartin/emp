/**
 * Lock button (§6.1, §9.9), in the sidebar footer beside the status (Flow IA: one place per job). Tooltip:
 * "Encrypted · Locks in 12 min · ⌘⇧L to lock now". During the last 60 s (`vault:autolock-soon`) it becomes a ring
 * countdown. Click locks now. An unencrypted vault has nothing to lock: the footer status leads to Security instead.
 */
import { Lock } from "lucide-react";
import { m } from "motion/react";
import { useEffect, useState } from "react";
import { runCommand } from "@/app/commands";
import { shortcutLabel } from "@/lib/platform";
import { useVault } from "@/stores/vault";
import { IconButton } from "@/ui/IconButton";

let lastInput = Date.now();
let tracking = false;
function trackInput() {
  if (tracking || typeof window === "undefined") return;
  tracking = true;
  const on = () => {
    lastInput = Date.now();
  };
  for (const ev of ["pointerdown", "keydown", "wheel"] as const) window.addEventListener(ev, on, { passive: true, capture: true });
}

function useMinutesLeft(idleMinutes: number | null): number | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    trackInput();
    const t = window.setInterval(() => setTick((n) => n + 1), 15_000);
    return () => window.clearInterval(t);
  }, []);
  if (idleMinutes === null) return null;
  return Math.max(1, Math.ceil(idleMinutes - (Date.now() - lastInput) / 60_000));
}

export function LockIndicator({ size = "sm" }: { size?: "xs" | "sm" }) {
  const encrypted = useVault((s) => !!s.status?.encrypted);
  const idle = useVault((s) => s.status?.autoLock.idleMinutes ?? null);
  const secondsLeft = useVault((s) => s.autoLockSecondsLeft);
  const minutes = useMinutesLeft(idle);

  if (!encrypted) return null;

  const tip = `Encrypted · ${idle === null ? "Locks when your computer sleeps" : secondsLeft !== null ? `Locks in ${secondsLeft}s` : `Locks in ${minutes} min`} · ${shortcutLabel("mod+shift+l")} to lock now`;

  if (secondsLeft !== null) {
    const r = 11;
    const c = 2 * Math.PI * r;
    const frac = Math.max(0, Math.min(1, secondsLeft / 60));
    return (
      <IconButton
        size={size}
        label={tip}
        className="no-drag"
        onClick={() => runCommand("vault.lock")}
        icon={
          <span className="emp-lock-ring" aria-hidden>
            <svg className="ring" width="24" height="24" viewBox="0 0 28 28">
              <circle cx="14" cy="14" r={r} fill="none" stroke="var(--groove-dark)" strokeWidth="2.5" />
              <m.circle
                cx="14"
                cy="14"
                r={r}
                fill="none"
                stroke="var(--warning)"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeDasharray={c}
                initial={false}
                animate={{ strokeDashoffset: c * (1 - frac) }}
                transition={{ duration: 0.9, ease: "linear" }}
              />
            </svg>
            <span className="tabular text-[10px] font-semibold text-warning-text">{secondsLeft}</span>
          </span>
        }
      />
    );
  }

  return <IconButton icon={Lock} size={size} label={tip} onClick={() => runCommand("vault.lock")} />;
}

export default LockIndicator;
