/**
 * Top-bar lock indicator (§6.1, §9.9). Tooltip: "Encrypted · Locks in 12 min · ⌘⇧L to lock now". During the last
 * 60 s (`vault:autolock-soon`) it becomes a ring countdown. Click locks now. Unencrypted vaults show an open lock
 * that leads to Security Center.
 */
import { Lock, LockOpen } from "lucide-react";
import { m } from "motion/react";
import { useEffect, useState } from "react";
import { runCommand } from "@/app/commands";
import { navigate } from "@/app/router";
import { shortcutLabel } from "@/lib/platform";
import { useVault } from "@/stores/vault";
import { IconButton } from "@/ui/IconButton";
import { Tooltip } from "@/ui/Tooltip";

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

export function LockIndicator() {
  const encrypted = useVault((s) => !!s.status?.encrypted);
  const idle = useVault((s) => s.status?.autoLock.idleMinutes ?? null);
  const secondsLeft = useVault((s) => s.autoLockSecondsLeft);
  const minutes = useMinutesLeft(idle);

  if (!encrypted) {
    return (
      <IconButton
        icon={LockOpen}
        size="sm"
        label="Not encrypted · Turn on encryption in Settings → Security"
        onClick={() => navigate({ t: "settings", section: "security" })}
      />
    );
  }

  const tip = `Encrypted · ${idle === null ? "Locks when your computer sleeps" : secondsLeft !== null ? `Locks in ${secondsLeft}s` : `Locks in ${minutes} min`} · ${shortcutLabel("mod+shift+l")} to lock now`;

  if (secondsLeft !== null) {
    const r = 11;
    const c = 2 * Math.PI * r;
    const frac = Math.max(0, Math.min(1, secondsLeft / 60));
    return (
      <Tooltip content={tip}>
        <button type="button" className="emp-btn emp-lock-ring no-drag" data-variant="ghost" data-size="sm" data-icon-only="" aria-label={tip} onClick={() => runCommand("vault.lock")}>
          <svg className="ring" width="28" height="28" viewBox="0 0 28 28" aria-hidden>
            <circle cx="14" cy="14" r={r} fill="none" stroke="var(--border)" strokeWidth="2" />
            <m.circle
              cx="14"
              cy="14"
              r={r}
              fill="none"
              stroke="var(--warning)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={c}
              initial={false}
              animate={{ strokeDashoffset: c * (1 - frac) }}
              transition={{ duration: 0.9, ease: "linear" }}
            />
          </svg>
          <span className="tabular text-[10px] font-semibold text-warning-text">{secondsLeft}</span>
        </button>
      </Tooltip>
    );
  }

  return <IconButton icon={Lock} size="sm" label={tip} onClick={() => runCommand("vault.lock")} />;
}

export default LockIndicator;
