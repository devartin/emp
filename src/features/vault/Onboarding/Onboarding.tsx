/**
 * First run (1.0 brief §2.5): two screens set straight on the paper, then Home. Enter continues, ⌘[ goes back,
 * Esc does nothing; focus moves to each screen's heading.
 *
 *   1 Welcome          optional first name; "What would you like to use it for?" (Notes always included)
 *   2 Keep it private?  Lock with a password (password + confirm → the recovery key) or Not now
 *   → "Start using Ultranote": Home opens at once and the picked apps build there in the background (setup.ts).
 *
 * The workspace is created on screen 2 (with a password, before the recovery key is shown). The plan, the name and the
 * detected region are saved right then, so quitting at any later point leaves a complete workspace that finishes
 * setting itself up on the next launch.
 */
import { AnimatePresence, m, useIsPresent } from "motion/react";
import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import { api, errorMessage } from "@/backend";
import { enterShell, preloadShell } from "@/app/boot";
import { WindowControls } from "@/features/shell/WindowControls";
import { isMac } from "@/lib/platform";
import { useVault } from "@/stores/vault";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import "../vault.css";
import "./onboarding.css";
import { appsFor, DEFAULT_AUTO_LOCK, INITIAL_DRAFT, STEPS, type Draft, type StepId } from "./model";
import { beginSetup, completeFirstRun } from "./setup";
import { PrivateStep, WelcomeStep } from "./steps";

/** The key derivation is real work; the "Encrypting" moment never flashes by faster than this. */
const MIN_SECURE_MS = 600;

export default function Onboarding() {
  const reduced = useReducedMotionPref();
  const [step, setStep] = useState<StepId>("welcome");
  const [draft, setDraft] = useState<Draft>(INITIAL_DRAFT);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const isPresent = useIsPresent();

  const update = useCallback((patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch })), []);
  const index = STEPS.indexOf(step);

  useEffect(() => {
    void preloadShell();
  }, []);

  /** Creates the workspace (encrypted when `password` is given) and saves the plan straight away. */
  const createVault = useCallback(
    async (password?: string): Promise<boolean> => {
      if (draft.vaultCreated) return true;
      if (creating) return false;
      setCreating(true);
      setError(null);
      const started = performance.now();
      try {
        const res = await api.vault.create({ password, profile: "standard", autoLock: DEFAULT_AUTO_LOCK });
        // The plan, name and region are saved the moment the workspace exists, before anything cosmetic: quitting
        // during the "Encrypting" beat must not leave a workspace with no plan (resumeSetup builds from it).
        await beginSetup({ apps: appsFor(draft), name: draft.name }).catch(() => undefined);
        const wait = MIN_SECURE_MS - (performance.now() - started);
        if (password && wait > 0) await new Promise((r) => setTimeout(r, wait));
        useVault.getState().setStatus(res.status);
        update({ vaultCreated: true, recoveryWords: res.recoveryWords ?? null, password: "", confirm: "" });
        return true;
      } catch (e) {
        setError(errorMessage(e) || "Couldn't create your workspace");
        return false;
      } finally {
        setCreating(false);
      }
    },
    [creating, draft, update],
  );

  /** "Start using Ultranote": Home opens now; the apps build there. */
  const start = useCallback(async () => {
    if (opening) return;
    setOpening(true);
    setError(null);
    try {
      if (!draft.vaultCreated && !(await createVault(undefined))) {
        setOpening(false);
        return;
      }
      await completeFirstRun().catch(() => undefined);
      await enterShell({ route: { t: "home" } });
    } catch (e) {
      setOpening(false);
      setError(errorMessage(e) || "Couldn't open your workspace");
    }
  }, [createVault, draft.vaultCreated, opening]);

  const back = index > 0 && !draft.vaultCreated && !creating ? () => setStep(STEPS[index - 1]) : null;
  const next = () => setStep("private");

  // ── keyboard: Enter continues, ⌘[ goes back, Esc does nothing
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (mod && e.code === "BracketLeft") {
      e.preventDefault();
      back?.();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      return;
    }
    if (e.key !== "Enter" || e.defaultPrevented || e.nativeEvent.isComposing) return;
    const t = e.target as HTMLElement;
    if (t.tagName === "BUTTON" || t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.getAttribute("role") === "checkbox" || t.getAttribute("role") === "radio") return;
    e.preventDefault();
    if (step === "welcome") next();
    else if (draft.privacy === "none") void start();
  };

  return (
    <m.div
      className="emp-stage emp-vault-stage onb-stage"
      onScroll={(e) => e.currentTarget.scrollLeft && (e.currentTarget.scrollLeft = 0)}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: { duration: reduced ? 0 : 0.16 } }}
      exit={{ opacity: 0, transition: { duration: reduced ? 0 : 0.16 } }}
      onKeyDown={onKeyDown}
    >
      <div className="emp-stage-drag drag-region" data-tauri-drag-region />
      <WindowControls className="absolute right-0 top-0" />
      <div className="onb-panel" data-wide="" data-inert={isPresent ? undefined : ""} role="dialog" aria-modal="true" aria-label="Set up Ultranote">
        <div className="onb-steps" aria-hidden>
          {STEPS.map((s, i) => (
            <span key={s} className="onb-step" data-on={i <= index ? "" : undefined} />
          ))}
        </div>
        <span className="sr-only" aria-live="polite">
          {`Step ${index + 1} of ${STEPS.length}`}
        </span>
        <AnimatePresence mode="wait" initial={false}>
          <m.div
            key={step}
            initial={{ opacity: 0, x: reduced ? 0 : 8 }}
            animate={{ opacity: 1, x: 0, transition: { duration: reduced ? 0 : 0.18, ease: [0.2, 0, 0, 1] } }}
            exit={{ opacity: 0, transition: { duration: reduced ? 0 : 0.1 } }}
          >
            {step === "welcome" ? <WelcomeStep draft={draft} update={update} next={next} /> : null}
            {step === "private" ? (
              <PrivateStep
                draft={draft}
                update={update}
                back={back}
                creating={creating}
                opening={opening}
                error={error}
                onCreate={() => void createVault(draft.password)}
                onStart={() => void start()}
              />
            ) : null}
          </m.div>
        </AnimatePresence>
      </div>
    </m.div>
  );
}
