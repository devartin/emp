/**
 * First run (1.0 brief §2.5): two screens, then Home.
 *
 *   welcome  (optional first name; "What would you like to use it for?" cards)
 *   private  ("Keep it private?": Lock with a password → password + confirm → the recovery key; or Not now)
 *   → Home, where the picked apps build in the background with real progress (setup.ts)
 */
import type { AutoLock } from "@/backend/types";

export type StepId = "welcome" | "private";

/** One "What would you like to use it for?" card. `appId` is the app it builds; Notes is always included. */
export interface UseCard {
  key: string;
  appId: string | null;
  label: string;
  detail: string;
}

/** The cards in order. Display names follow the brief's word table (§1). */
export const USE_CARDS: UseCard[] = [
  { key: "notes", appId: null, label: "Notes and documents", detail: "Write and plan" },
  { key: "tasks", appId: "life-os", label: "Tasks", detail: "To-dos and lists" },
  { key: "habits", appId: "habits", label: "Habits", detail: "Streaks and check-ins" },
  { key: "money", appId: "money-hq", label: "Money", detail: "Budget and spending" },
  { key: "investments", appId: "portfolio", label: "Investments", detail: "Holdings and returns" },
  { key: "taxes", appId: "tax-organizer", label: "Taxes", detail: "Documents and deductions" },
  { key: "spreadsheets", appId: "spreadsheet-studio", label: "Spreadsheets", detail: "Calculators and models" },
];

/** Auto-lock for a new encrypted workspace: 15 idle minutes, sleep and screen lock (changeable in Settings). */
export const DEFAULT_AUTO_LOCK: AutoLock = {
  idleMinutes: 15,
  onSleep: true,
  onScreenLock: true,
  onBlurMinutes: null,
  maxSessionHours: null,
};

export type PrivacyChoice = "password" | "none";

export interface Draft {
  name: string;
  /** App ids to build, in card order. */
  picks: string[];
  privacy: PrivacyChoice | null;
  password: string;
  confirm: string;
  recoveryWords: string[] | null;
  /** "I've saved my recovery key". */
  recoverySaved: boolean;
  vaultCreated: boolean;
}

export const INITIAL_DRAFT: Draft = {
  name: "",
  picks: [],
  privacy: null,
  password: "",
  confirm: "",
  recoveryWords: null,
  recoverySaved: false,
  vaultCreated: false,
};

/** The apps to build, in card order. */
export function appsFor(d: Pick<Draft, "picks">): string[] {
  return USE_CARDS.flatMap((c) => (c.appId && d.picks.includes(c.appId) ? [c.appId] : []));
}

export const STEPS: StepId[] = ["welcome", "private"];
