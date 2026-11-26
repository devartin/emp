/**
 * First run (PROGRAMME-v3 K4, Flow r2 §2.6): three screens set straight on the paper, no card. Enter continues, ⌘[ goes
 * back, Esc does nothing; focus moves to each step's heading.
 *
 *   1 Welcome  (name, how you start)
 *   2 Track    (which life apps to build)
 *   3 Protect  (encrypt or not; with encryption: password, then the recovery key, still step 3)
 *   → the build: the picked life apps are installed for real with their defaults (quick mode, no personal data)
 *   → Home. Starting with pages or a bank file opens the import dialog over Home.
 */
import { AnimatePresence, m, useIsPresent } from "motion/react";
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { api, errorMessage } from "@/backend";
import { enterShell, preloadShell } from "@/app/boot";
import { WindowControls } from "@/features/shell/WindowControls";
import { isMac } from "@/lib/platform";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { useVault } from "@/stores/vault";
import { useWorkspace } from "@/stores/workspace";
import { openFinanceImport } from "@/features/finance/ImportWizard/request";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import "../vault.css";
import "./onboarding.css";
import { appsFor, autoLockFor, INITIAL_DRAFT, SCREENS, screenOf, stepsFor, TRACK_OPTIONS, type Draft, type StepId } from "./model";
import { BuildingStep, PasswordStep, ProtectStep, RecoveryStep, TrackStep, WelcomeStep, type BuildTask } from "./steps";

const MIN_SECURE_MS = 600;

export default function Onboarding() {
  const reduced = useReducedMotionPref();
  const [step, setStep] = useState<StepId>("welcome");
  const [draft, setDraft] = useState<Draft>(INITIAL_DRAFT);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const isPresent = useIsPresent();

  const update = useCallback((patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch })), []);
  const steps = useMemo(() => stepsFor(draft), [draft]);
  const index = steps.indexOf(step);

  useEffect(() => {
    void preloadShell();
  }, []);

  const go = useCallback((to: StepId) => setStep(to), []);

  /** Nothing before vault creation can be revisited once the vault exists. */
  const floor = draft.vaultCreated ? steps.indexOf(draft.encrypt ? "recovery" : "building") : 0;
  const back = index > floor && index > 0 && step !== "building" ? () => go(steps[index - 1]) : null;
  const forward = useCallback(() => {
    const i = steps.indexOf(step);
    if (i >= 0 && i < steps.length - 1) go(steps[i + 1]);
  }, [go, step, steps]);

  // ── vault creation (protect → plain, or password → encrypted)
  const createVault = useCallback(
    async (password?: string) => {
      if (draft.vaultCreated || creating) return true;
      setCreating(true);
      setCreateError(null);
      const started = performance.now();
      try {
        const res = await api.vault.create({ password, profile: "standard", autoLock: autoLockFor(draft.autoLock) });
        const wait = MIN_SECURE_MS - (performance.now() - started);
        if (password && wait > 0) await new Promise((r) => setTimeout(r, wait));
        useVault.getState().setStatus(res.status);
        update({ vaultCreated: true, recoveryWords: res.recoveryWords ?? null, password: "", confirm: "" });
        void useSettings.getState().load().catch(() => undefined);
        return true;
      } catch (e) {
        setCreateError(errorMessage(e) || "Couldn't create your workspace");
        return false;
      } finally {
        setCreating(false);
      }
    },
    [creating, draft.autoLock, draft.vaultCreated, update],
  );

  const onProtectContinue = async () => {
    if (draft.encrypt) return forward();
    if (await createVault(undefined)) go("building");
  };
  const onPasswordContinue = async () => {
    if (await createVault(draft.password)) go("recovery");
  };

  // ── the build: real work, one row per piece
  const buildTasks = useMemo<BuildTask[]>(() => {
    const apps = appsFor(draft);
    const list: BuildTask[] = [
      {
        id: "workspace",
        label: draft.encrypt ? "Opening your encrypted workspace" : "Opening your workspace",
        run: async () => {
          await useSettings.getState().load();
          const s = useSettings.getState();
          if (s.vault && draft.name.trim()) await s.setVault({ profileName: draft.name.trim() });
          const ws = await api.workspace.list();
          if (!ws.length) throw new Error("No workspace was created");
        },
      },
    ];
    for (const appId of apps) {
      const opt = TRACK_OPTIONS.find((o) => o.appId === appId);
      const name = opt?.detail ?? appId;
      list.push({
        id: `app:${appId}`,
        label: `Building ${name}`,
        run: async (progress) => {
          const [ws] = await api.workspace.list();
          if (!ws) throw new Error("No workspace was created");
          const built = ((await api.kv.get({ ns: "ui.onboarding", key: "built" })) as string[] | null) ?? [];
          if (built.includes(appId)) return;
          const job = await api.lifeapp.install({
            appId,
            answers: {},
            mode: "quick",
            disabledKeys: [],
            workspaceId: ws.id,
            sampleData: false,
            onEvent: (e: { kind: string; done?: number; total?: number }) => {
              if (e.kind === "progress" && e.total) progress((e.done ?? 0) / e.total);
            },
          });
          await job.result;
          await api.kv.set({ ns: "ui.onboarding", key: "built", value: [...built, appId] });
        },
      });
    }
    list.push({
      id: "finish",
      label: "Finishing up",
      run: async () => {
        await api.kv.set({ ns: "ui.onboarding", key: "completedAt", value: Date.now() });
        await preloadShell();
      },
    });
    return list;
    // Tasks are fixed once the building step starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step === "building"]);

  const open = async () => {
    if (opening) return;
    setOpening(true);
    try {
      await enterShell({ route: { t: "home" } });
      // "Bring in money" goes straight to Money HQ's statement import (Money HQ is built when that start is picked);
      // "Bring in pages" opens the page import dialog.
      if (draft.start === "money")
        window.setTimeout(() => {
          void useWorkspace
            .getState()
            .refreshLifeapps()
            .catch(() => undefined)
            .then(() => openFinanceImport());
        }, 120);
      else if (draft.start === "pages") window.setTimeout(() => useUi.getState().setImportOpen(true), 120);
    } catch (e) {
      setOpening(false);
      setCreateError(errorMessage(e));
    }
  };

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
    if (step === "welcome" || step === "track") forward();
    else if (step === "protect") void onProtectContinue();
  };

  const props = { draft, update, next: forward, back };
  const wide = step === "recovery";
  const screen = screenOf(step);

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
      <div
        className="onb-panel"
        data-wide={wide ? "" : undefined}
        data-inert={isPresent ? undefined : ""}
        role="dialog"
        aria-modal="true"
        aria-label="Set up Ultra Note"
      >
        {screen >= 0 ? (
          <ol className="onb-steps" aria-label={`Step ${screen + 1} of ${SCREENS.length}`}>
            {SCREENS.map((label, i) => (
              <li key={label} aria-current={i === screen ? "step" : undefined} data-done={i < screen ? "" : undefined}>
                {label}
              </li>
            ))}
          </ol>
        ) : (
          <div className="onb-steps" aria-hidden />
        )}
        <span className="sr-only" aria-live="polite">
          {step === "building" ? "Setting up your workspace" : screen >= 0 ? `Step ${screen + 1} of ${SCREENS.length}, ${SCREENS[screen]}` : ""}
        </span>
        <AnimatePresence mode="wait" initial={false}>
          <m.div key={step} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: reduced ? 0 : 0.12 } }} exit={{ opacity: 0, transition: { duration: reduced ? 0 : 0.06 } }}>
            {step === "welcome" ? <WelcomeStep {...props} /> : null}
            {step === "track" ? <TrackStep {...props} /> : null}
            {step === "protect" ? <ProtectStep {...props} next={() => void onProtectContinue()} creating={creating && !draft.encrypt} /> : null}
            {step === "password" ? <PasswordStep {...props} onCreate={() => void onPasswordContinue()} creating={creating} error={createError} /> : null}
            {step === "recovery" ? <RecoveryStep {...props} next={() => go("building")} /> : null}
            {step === "building" ? <BuildingStep tasks={buildTasks} onOpen={() => void open()} opening={opening} /> : null}
          </m.div>
        </AnimatePresence>
        {createError && (step === "protect" || step === "building") ? (
          <p className="emp-helper mt-4" data-invalid="" role="alert">
            <span>{createError}</span>
          </p>
        ) : null}
      </div>
    </m.div>
  );
}
