/**
 * Re-auth ("sudo mode", §9.10): sensitive actions ask for the password once and stay confirmed for 5 minutes.
 *
 *   if (!(await ensureReauth("view your recovery key"))) return;
 *   await withReauth("export unencrypted data", () => api.export.everything(...));
 *
 * `withReauth` also recovers when the backend answers REAUTH_REQUIRED (window expired mid-flow). Unencrypted vaults
 * need no re-auth. <ReauthHost/> renders the dialog (mounted by the settings page and its dialogs).
 */
import { LockKeyhole } from "lucide-react";
import { m, useAnimationControls } from "motion/react";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { errorMessage, hasCode } from "@/backend";
import { PasswordField } from "@/features/vault/PasswordField";
import { useVault } from "@/stores/vault";
import { Button } from "@/ui/Button";
import { Dialog } from "@/ui/Dialog";
import { shake } from "@/ui/motion/presets";

interface ReauthState {
  pending: { reason: string; resolve: (ok: boolean) => void } | null;
  ask(reason: string): Promise<boolean>;
  settle(ok: boolean): void;
}

const useReauthStore = create<ReauthState>()((set, get) => ({
  pending: null,
  ask(reason) {
    get().pending?.resolve(false);
    return new Promise<boolean>((resolve) => set({ pending: { reason, resolve } }));
  },
  settle(ok) {
    const p = get().pending;
    set({ pending: null });
    p?.resolve(ok);
  },
}));

export function reauthActive(): boolean {
  return useVault.getState().reauthValid();
}

/** Resolves true when the vault is unencrypted or re-auth is (now) valid. */
export async function ensureReauth(reason: string): Promise<boolean> {
  if (!useVault.getState().status?.encrypted) return true;
  if (useVault.getState().reauthValid()) return true;
  return useReauthStore.getState().ask(reason);
}

/** Runs `fn` with re-auth, asking again once if the backend says the window expired. */
export async function withReauth<T>(reason: string, fn: () => Promise<T>): Promise<T | null> {
  if (!(await ensureReauth(reason))) return null;
  try {
    return await fn();
  } catch (e) {
    if (!hasCode(e, "REAUTH_REQUIRED")) throw e;
    const s = useVault.getState().status;
    if (s) useVault.getState().setStatus({ ...s, reauthValidUntil: undefined });
    if (!(await useReauthStore.getState().ask(reason))) return null;
    return await fn();
  }
}

/** Live "confirmed for m:ss" countdown, or null when not in sudo mode. */
export function useReauthRemaining(): number | null {
  const until = useVault((s) => (s.status?.encrypted ? (s.status.reauthValidUntil ?? null) : null));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [until]);
  if (!until || until <= now) return null;
  return until - now;
}

export function ReauthHost() {
  const pending = useReauthStore((s) => s.pending);
  const settle = useReauthStore((s) => s.settle);
  const [pw, setPw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waitMs, setWaitMs] = useState(0);
  const controls = useAnimationControls();

  useEffect(() => {
    if (pending) {
      setPw("");
      setError(null);
    }
  }, [pending]);

  useEffect(() => {
    if (waitMs <= 0) return;
    const t = window.setTimeout(() => setWaitMs((w) => Math.max(0, w - 1000)), 1000);
    return () => window.clearTimeout(t);
  }, [waitMs]);

  const submit = async () => {
    if (!pw || busy || waitMs > 0) return;
    setBusy(true);
    setError(null);
    try {
      await useVault.getState().reauth(pw);
      setPw("");
      settle(true);
    } catch (e) {
      setPw("");
      if (hasCode(e, "RATE_LIMITED", "BAD_PASSWORD")) {
        const retry = (e as { details?: { retryAfterMs?: number } }).details?.retryAfterMs ?? 0;
        if (retry) setWaitMs(retry);
      }
      setError(hasCode(e, "BAD_PASSWORD") ? "Incorrect password" : errorMessage(e));
      void controls.start(shake);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!pending}
      onOpenChange={(o) => !o && !busy && settle(false)}
      size="sm"
      title="Confirm it’s you"
      description={pending ? `Enter your password to ${pending.reason}. You won’t be asked again for 5 minutes.` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={() => settle(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!pw || waitMs > 0}>
            {waitMs > 0 ? `Try again in ${Math.ceil(waitMs / 1000)} s` : "Confirm"}
          </Button>
        </>
      }
    >
      <m.div animate={controls} className="flex flex-col gap-3">
        <div className="st-reauth-badge" aria-hidden>
          <LockKeyhole size={16} />
          Encrypted workspace
        </div>
        <PasswordField value={pw} onChange={setPw} size="lg" autoFocus purpose="current" placeholder="Password" error={error ?? undefined} onEnter={() => void submit()} aria-label="Password" />
      </m.div>
    </Dialog>
  );
}
