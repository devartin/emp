/**
 * The update check (1.0 brief §2.4, About): Rust asks GitHub for the latest release through NetGuard
 * (`app_check_update`). One button runs it; the "Check automatically" switch runs it once a day while the app is open
 * (`scheduleUpdateCheck`, started by the settings store). It fails calmly offline and offers the release page when
 * there is a newer version. No other code path triggers a check (D-17).
 */
import { api, errorMessage, hasCode } from "@/backend";
import type { UpdateCheck } from "@/backend/types";
import { notify } from "@/stores/toasts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Let launch settle before the first automatic check. */
const FIRST_DELAY_MS = 20_000;
const KV = { ns: "ui.updates", key: "lastCheck" } as const;

export function openReleasePage(url: string): void {
  void api.open.external({ url }).catch((e) => notify.fromError(e, "Couldn’t open the link"));
}

/** Run the check and say what happened. `quiet` (automatic checks) only speaks up when there is a new version. */
export async function checkForUpdates(opts: { quiet?: boolean } = {}): Promise<UpdateCheck | null> {
  try {
    const r = await api.app.checkUpdate();
    if (r.available) {
      notify.info(`Ultranote ${r.version ?? ""} is available`, {
        description: `You have ${r.current}.`,
        action: r.url ? { label: "Open release page", onClick: () => openReleasePage(r.url as string) } : undefined,
      });
    } else if (!opts.quiet) {
      notify.success(r.version ? "You’re up to date" : "No release is published yet", { description: `You have Ultranote ${r.current}.` });
    }
    return r;
  } catch (e) {
    if (opts.quiet) return null;
    if (hasCode(e, "OFFLINE")) notify.warning("Offline mode is on", { description: "Turn it off in Privacy & security to check for updates." });
    else if (hasCode(e, "NETWORK", "PROVIDER", "RATE_LIMITED", "QUOTA")) notify.warning("Couldn’t reach GitHub", { description: "Check your internet connection and try again later." });
    else if (hasCode(e, "UNSUPPORTED")) notify.info("Updates aren’t checked here", { description: errorMessage(e) });
    else notify.fromError(e, "Couldn’t check for updates");
    return null;
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Automatic checks: at most once a day (the last check time is kept in the workspace, kv `ui.updates/lastCheck`), the
 * first one shortly after launch. `enabled()` is read again before every check, so turning the switch off stops it.
 */
export function scheduleUpdateCheck(enabled: () => boolean): void {
  if (timer || !enabled()) return;
  const run = async () => {
    timer = null;
    if (!enabled()) return;
    let last = 0;
    try {
      const v = await api.kv.get(KV);
      if (typeof v === "number") last = v;
    } catch {
      return; // locked: the next unlock schedules again
    }
    const wait = last + DAY_MS - Date.now();
    if (wait > 0) {
      timer = setTimeout(() => void run(), Math.min(wait, DAY_MS));
      return;
    }
    await api.kv.set({ ...KV, value: Date.now() }).catch(() => undefined);
    await checkForUpdates({ quiet: true });
    timer = setTimeout(() => void run(), DAY_MS);
  };
  timer = setTimeout(() => void run(), FIRST_DELAY_MS);
}

/** Stop pending automatic checks (lock, switch turned off). */
export function cancelUpdateCheck(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
