/**
 * Onboarding (§6.2): full-window aurora behind a centred glass panel (560 wide, radius 20, 92% overlay + blur 24,
 * elev-3, padding 40). A stepper sits on top; steps slide x ±24 (160ms out / 240ms in) while the panel height follows
 * on `spring.gentle`. Enter continues, ⌘[ goes back, Esc does nothing; focus moves to each step's heading.
 *
 * Flow: launch → welcome → make it yours → protect → (create password → recovery key) → what should EMP help with?
 *       → connections and updates → building your workspace → into the app (hands off to the life-app gallery).
 */
import { AnimatePresence, m, useIsPresent } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api, errorMessage } from "@/backend";
import { enterShell, preloadShell } from "@/app/boot";
import { WindowControls } from "@/features/shell/WindowControls";
import { isMac } from "@/lib/platform";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { useVault } from "@/stores/vault";
import { ease, spring } from "@/ui/motion/tokens";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import "../vault.css";
import { appsFor, autoLockFor, HELP_OPTIONS, INITIAL_DRAFT, stepsFor, type Draft, type StepId } from "./model";
import {
  BuildingStep,
  ConnectionsStep,
  HelpStep,
  LaunchStep,
  PasswordStep,
  PersonalizeStep,
  ProtectStep,
  RecoveryStep,
  WelcomeStep,
  type BuildTask,
} from "./steps";

const MIN_SECURE_MS = 600;

export default function Onboarding() {
  const reduced = useReducedMotionPref();
  const [step, setStep] = useState<StepId>("launch");
  const [dir, setDir] = useState<1 | -1>(1);
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

  const go = useCallback((to: StepId, d: 1 | -1) => {
    setDir(d);
    setStep(to);
  }, []);

  /** The earliest step the user can go back to: nothing before vault creation once it exists. */
  const floor = draft.vaultCreated ? steps.indexOf(draft.encrypt ? "recovery" : "help") : 0;
  const back = index > floor && index > 0 && step !== "building" ? () => go(steps[index - 1], -1) : null;
  const forward = useCallback(() => {
    const i = steps.indexOf(step);
    if (i >= 0 && i < steps.length - 1) go(steps[i + 1], 1);
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
        // Vault settings exist now; load them so the name and preferences can be saved.
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
    if (await createVault(undefined)) go("help", 1);
  };
  const onPasswordContinue = async () => {
    if (await createVault(draft.password)) go("recovery", 1);
  };

  // ── building tasks reflect the real work
  const buildTasks = useMemo<BuildTask[]>(() => {
    const apps = appsFor(draft.picks);
    const starters = HELP_OPTIONS.filter((o) => o.starter && draft.picks.includes(o.id));
    const list: BuildTask[] = [
      {
        id: "prefs",
        label: draft.name.trim() ? `Saving your preferences, ${draft.name.trim()}` : "Saving your preferences",
        run: async () => {
          await useSettings.getState().load();
          const s = useSettings.getState();
          if (s.vault) await s.setVault({ profileName: draft.name.trim() });
          await s.setDevice({ updates: draft.updates ? "check" : "off" });
          await api.kv.set({ ns: "ui.onboarding", key: "connections", value: { delayedMarketData: draft.delayedMarketData } });
        },
      },
      {
        id: "workspace",
        label: draft.encrypt ? "Opening your encrypted workspace" : "Opening your workspace",
        run: async () => {
          const list = await api.workspace.list();
          if (!list.length) throw new Error("No workspace was created");
        },
      },
    ];
    if (starters.length) {
      list.push({
        id: "starters",
        label: `Creating ${starters.length} starter ${starters.length === 1 ? "page" : "pages"}`,
        run: async () => {
          const [ws] = await api.workspace.list();
          if (!ws) return;
          const done = ((await api.kv.get({ ns: "ui.onboarding", key: "startersCreated" })) as string[] | null) ?? [];
          for (const o of starters) {
            if (!o.starter || done.includes(o.id)) continue;
            await api.page.create({ workspaceId: ws.id, parentId: null, kind: "doc", title: o.starter.title, icon: { t: "emoji", v: o.starter.emoji } });
            done.push(o.id);
            await api.kv.set({ ns: "ui.onboarding", key: "startersCreated", value: done });
          }
        },
      });
    }
    list.push({
      id: "apps",
      label: apps.length ? `Lining up ${apps.length} life ${apps.length === 1 ? "app" : "apps"} to set up` : "Preparing Getting started",
      run: async () => {
        await api.kv.set({ ns: "ui.onboarding", key: "starterApps", value: apps });
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
    const apps = appsFor(draft.picks);
    try {
      await enterShell({ route: apps.length ? { t: "lifeapps" } : { t: "home" } });
      if (draft.importAfter) window.setTimeout(() => useUi.getState().setImportOpen(true), 520);
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
    if (t.tagName === "BUTTON" || t.tagName === "TEXTAREA" || t.getAttribute("role") === "checkbox" || t.getAttribute("role") === "radio") return;
    if (t.tagName === "INPUT" && step !== "personalize") return; // field-level Enter handlers decide
    e.preventDefault();
    if (step === "welcome" || step === "personalize" || step === "help" || step === "connections") forward();
    else if (step === "protect") void onProtectContinue();
    else if (step === "building" && buildTasks.length) void open();
  };

  const props = { draft, update, next: forward, back };
  const wide = step === "recovery" || step === "help";
  const progress = index < 0 ? 0 : index;

  return (
    <m.div
      className="emp-stage emp-aurora"
      onScroll={(e) => e.currentTarget.scrollLeft && (e.currentTarget.scrollLeft = 0)}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: { duration: 0.32 } }}
      exit={{ opacity: 0, transition: { duration: 0.48, ease: ease.out } }}
      onKeyDown={onKeyDown}
    >
      <div className="emp-stage-drag drag-region" data-tauri-drag-region />
      <WindowControls className="absolute right-0 top-0" />
      <m.div
        className="emp-vault-card emp-onb-panel"
        data-wide={wide ? "" : undefined}
        role="dialog"
        aria-modal="true"
        aria-label="Set up EMP"
        initial={{ opacity: 0, scale: reduced ? 1 : 0.98, y: reduced ? 0 : 8 }}
        animate={{ opacity: 1, scale: 1, y: 0, transition: { duration: 0.48, ease: ease.outExpo } }}
        exit={{ opacity: 0, scale: reduced ? 1 : 1.04, transition: { duration: 0.48, ease: ease.out } }}
        style={{ pointerEvents: isPresent ? undefined : "none" }}
      >
        <AnimatePresence initial={false}>
          {step !== "launch" ? (
            <m.div key="stepper" className="emp-onb-stepper" aria-hidden initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: 0.24, delay: 0.1 } }}>
              {steps.map((s, i) => (
                <span key={s}>
                  <m.i initial={false} animate={{ scaleX: i <= progress ? 1 : 0 }} transition={spring.ui} style={{ originX: 0 }} />
                </span>
              ))}
            </m.div>
          ) : null}
        </AnimatePresence>
        <span className="sr-only" aria-live="polite">
          {index >= 0 ? `Step ${index + 1} of ${steps.length}` : ""}
        </span>
        <AutoHeight>
          <AnimatePresence mode="wait" initial={false} custom={dir}>
            <m.div
              key={step}
              custom={dir}
              variants={{
                enter: (d: number) => ({ opacity: 0, x: reduced ? 0 : 24 * d }),
                center: { opacity: 1, x: 0, transition: { duration: 0.24, ease: ease.outExpo } },
                exit: (d: number) => ({ opacity: 0, x: reduced ? 0 : -24 * d, transition: { duration: 0.16, ease: ease.in } }),
              }}
              initial="enter"
              animate="center"
              exit="exit"
            >
              {step === "launch" ? <LaunchStep onDone={() => go("welcome", 1)} /> : null}
              {step === "welcome" ? <WelcomeStep {...props} /> : null}
              {step === "personalize" ? <PersonalizeStep {...props} /> : null}
              {step === "protect" ? <ProtectStep {...props} next={() => void onProtectContinue()} creating={creating && !draft.encrypt} /> : null}
              {step === "password" ? <PasswordStep {...props} onCreate={() => void onPasswordContinue()} creating={creating} error={createError} /> : null}
              {step === "recovery" ? <RecoveryStep {...props} /> : null}
              {step === "help" ? <HelpStep {...props} /> : null}
              {step === "connections" ? <ConnectionsStep {...props} next={() => go("building", 1)} /> : null}
              {step === "building" ? <BuildingStep tasks={buildTasks} onOpen={() => void open()} opening={opening} /> : null}
            </m.div>
          </AnimatePresence>
        </AutoHeight>
        {createError && step === "protect" ? (
          <p className="emp-helper mt-3" data-invalid="" role="alert">
            <span>{createError}</span>
          </p>
        ) : null}
      </m.div>
    </m.div>
  );
}

/** Animates its height to the content's height on `spring.gentle` (§6.2 "Panel height animates"). */
function AutoHeight({ children }: { children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  const [h, setH] = useState<number | "auto">("auto");
  const reduced = useReducedMotionPref();
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.offsetHeight));
    ro.observe(el);
    setH(el.offsetHeight);
    return () => ro.disconnect();
  }, []);
  return (
    <m.div initial={false} animate={{ height: h }} transition={reduced ? { duration: 0 } : spring.gentle} style={{ overflow: "visible" }}>
      <div ref={inner}>{children}</div>
    </m.div>
  );
}
