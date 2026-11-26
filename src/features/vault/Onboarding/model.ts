/**
 * First run (PROGRAMME-v3 K4; Flow r2 §2.6): three screens, five with encryption, then the picked life apps are built
 * for real and the app opens on Home.
 *
 *   welcome (name, how you start) → track (pick life apps) → protect → [password → recovery] → building → Home
 */
import { CandlestickChart, HeartPulse, Kanban, ReceiptText, Sheet, Wallet, type LucideIcon } from "lucide-react";
import type { AutoLock } from "@/backend/types";

export type StepId = "welcome" | "track" | "protect" | "password" | "recovery" | "building";

/** How the person starts: from nothing, with pages from another app, or with a bank file. */
export type StartWith = "fresh" | "pages" | "money";

export interface TrackOption {
  appId: string;
  label: string;
  detail: string;
  icon: LucideIcon;
}

/** The six v1 life apps (§16), in the order people usually start with them. Each one is built with defaults. */
export const TRACK_OPTIONS: TrackOption[] = [
  { appId: "life-os", label: "Tasks and projects", detail: "Life OS", icon: Kanban },
  { appId: "habits", label: "Habits and routines", detail: "Habits", icon: HeartPulse },
  { appId: "money-hq", label: "Spending and budget", detail: "Money HQ", icon: Wallet },
  { appId: "portfolio", label: "Investments", detail: "Portfolio", icon: CandlestickChart },
  { appId: "tax-organizer", label: "Taxes", detail: "Tax Organizer", icon: ReceiptText },
  { appId: "spreadsheet-studio", label: "Spreadsheets", detail: "Spreadsheet Studio", icon: Sheet },
];

export const DEFAULT_PICKS = ["life-os"];

export type AutoLockChoice = "5" | "15" | "30" | "60" | "sleep";

export function autoLockFor(choice: AutoLockChoice): AutoLock {
  return {
    idleMinutes: choice === "sleep" ? null : Number(choice),
    onSleep: true,
    onScreenLock: true,
    onBlurMinutes: null,
    maxSessionHours: null,
  };
}

export interface Draft {
  name: string;
  start: StartWith;
  encrypt: boolean | null;
  password: string;
  confirm: string;
  autoLock: AutoLockChoice;
  recoveryWords: string[] | null;
  recoveryConfirmed: boolean;
  vaultCreated: boolean;
  /** Life app ids to build. */
  picks: string[];
}

export const INITIAL_DRAFT: Draft = {
  name: "",
  start: "fresh",
  encrypt: true,
  password: "",
  confirm: "",
  autoLock: "15",
  recoveryWords: null,
  recoveryConfirmed: false,
  vaultCreated: false,
  picks: DEFAULT_PICKS,
};

/** The apps to build: the picks, plus Money HQ when the person starts with a bank file (it imports into Money HQ). */
export function appsFor(d: Pick<Draft, "picks" | "start">): string[] {
  const out = TRACK_OPTIONS.map((o) => o.appId).filter((id) => d.picks.includes(id));
  if (d.start === "money" && !out.includes("money-hq")) out.unshift("money-hq");
  return out;
}

/** Visible steps for the current draft (building is the progress screen, not a question). */
export function stepsFor(d: Draft): StepId[] {
  const s: StepId[] = ["welcome", "track", "protect"];
  if (d.encrypt) s.push("password", "recovery");
  s.push("building");
  return s;
}
