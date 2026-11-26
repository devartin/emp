/** Onboarding model (§6.2): step order, the "What should EMP help with?" catalogue and the draft state. */
import {
  Briefcase,
  CalendarDays,
  FileText,
  GraduationCap,
  HeartPulse,
  House,
  ListTodo,
  Plane,
  ReceiptText,
  Sheet,
  TrendingUp,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import type { AutoLock } from "@/backend/types";

export type StepId = "launch" | "welcome" | "personalize" | "protect" | "password" | "recovery" | "help" | "connections" | "building";

export interface HelpOption {
  id: string;
  label: string;
  icon: LucideIcon;
  /** The v1 life app this installs (§16), if any. */
  appId?: string;
  /** Non-app picks create a starter page instead. */
  starter?: { title: string; emoji: string };
}

/** 3×4 grid, in SPEC order. Only the six v1 apps produce installs; the rest create a starter page ("More coming"). */
export const HELP_OPTIONS: HelpOption[] = [
  { id: "notes", label: "Notes & docs", icon: FileText },
  { id: "tasks", label: "Tasks & projects", icon: ListTodo, appId: "life-os" },
  { id: "finance", label: "Personal finance", icon: Wallet, appId: "money-hq" },
  { id: "investing", label: "Investing", icon: TrendingUp, appId: "portfolio" },
  { id: "taxes", label: "Taxes", icon: ReceiptText, appId: "tax-organizer" },
  { id: "calendar", label: "Calendar & planning", icon: CalendarDays, appId: "life-os" },
  { id: "habits", label: "Health & habits", icon: HeartPulse, appId: "habits" },
  { id: "home", label: "Home & life admin", icon: House, starter: { title: "Home & life admin", emoji: "🏠" } },
  { id: "learning", label: "Learning", icon: GraduationCap, starter: { title: "Learning", emoji: "🎓" } },
  { id: "travel", label: "Travel", icon: Plane, starter: { title: "Travel", emoji: "✈️" } },
  { id: "career", label: "Career", icon: Briefcase, starter: { title: "Career", emoji: "💼" } },
  { id: "sheets", label: "Spreadsheets", icon: Sheet, appId: "spreadsheet-studio" },
];

export const DEFAULT_PICKS = ["notes", "tasks"];

export function appsFor(picks: Iterable<string>): string[] {
  const out: string[] = [];
  for (const id of picks) {
    const app = HELP_OPTIONS.find((o) => o.id === id)?.appId;
    if (app && !out.includes(app)) out.push(app);
  }
  return out;
}

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
  encrypt: boolean | null;
  password: string;
  confirm: string;
  autoLock: AutoLockChoice;
  recoveryWords: string[] | null;
  recoveryConfirmed: boolean;
  vaultCreated: boolean;
  picks: string[];
  updates: boolean;
  delayedMarketData: boolean;
  importAfter: boolean;
}

export const INITIAL_DRAFT: Draft = {
  name: "",
  encrypt: true,
  password: "",
  confirm: "",
  autoLock: "15",
  recoveryWords: null,
  recoveryConfirmed: false,
  vaultCreated: false,
  picks: DEFAULT_PICKS,
  updates: false,
  delayedMarketData: true,
  importAfter: false,
};

/** Visible steps for the current draft (the launch beat is not part of the stepper). */
export function stepsFor(d: Draft): StepId[] {
  const s: StepId[] = ["welcome", "personalize", "protect"];
  if (d.encrypt) s.push("password", "recovery");
  s.push("help", "connections", "building");
  return s;
}
