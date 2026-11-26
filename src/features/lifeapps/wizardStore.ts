/**
 * Life-app wizard launcher (§6.5 entry points). Any feature can open the wizard:
 *
 *   openWizard('money-hq')                         // fresh install
 *   openWizard('life-os', { tuneup: instanceId })  // tune-up with stored answers pre-filled
 *
 * Routes work too: `navigate({ t: 'lifeapps', appId: 'tax-organizer' })` opens the gallery with that wizard open,
 * which is how the palette ("Set up taxes") and onboarding hand over.
 */
import { create } from "zustand";
import type { Id, LifeAppMode } from "@/backend/types";

interface WizardState {
  open: boolean;
  appId: string | null;
  mode: LifeAppMode;
  /** Tune-up of an installed instance. */
  tuneup: Id | null;
  /** Answers to pre-fill (tune-up, onboarding hand-off). */
  seed: Record<string, unknown> | null;
  openWizard(appId: string, opts?: { mode?: LifeAppMode; tuneup?: Id; answers?: Record<string, unknown> }): void;
  close(): void;
}

export const useWizard = create<WizardState>()((set) => ({
  open: false,
  appId: null,
  mode: "quick",
  tuneup: null,
  seed: null,
  openWizard: (appId, opts) => set({ open: true, appId, mode: opts?.mode ?? (opts?.tuneup ? "guided" : "quick"), tuneup: opts?.tuneup ?? null, seed: opts?.answers ?? null }),
  close: () => set({ open: false }),
}));

export const openWizard = (appId: string, opts?: Parameters<WizardState["openWizard"]>[1]) => useWizard.getState().openWizard(appId, opts);
