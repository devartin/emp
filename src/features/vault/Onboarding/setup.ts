/**
 * First-run setup that outlives the first-run screens (1.0 brief §2.5): the plan is saved the moment the workspace
 * exists, the picked apps build in the background with real progress on Home, and a build cut short by quitting
 * resumes on the next launch. Nothing is half-built: each app installs in one Rust transaction, and an app that is
 * already installed counts as built.
 *
 *   kv ui.onboarding/plan         { apps, name, at }   written right after vault_create
 *   kv ui.onboarding/built        app ids that finished building
 *   kv ui.onboarding/completedAt  first run reached Home (Start here and the checklist key off it)
 */
import { create } from "zustand";
import { api, errorMessage, hasCode } from "@/backend";
import type { Id, LifeAppInstance } from "@/backend/types";
import { useSettings } from "@/stores/settings";
import { useWorkspace } from "@/stores/workspace";
import { writeLockIdentity } from "../identity";
import { detectRegion } from "./region";

const NS = "ui.onboarding" as const;

export interface SetupPlan {
  apps: string[];
  name: string;
  at: number;
}

export type SetupRowState = "pending" | "running" | "done" | "error";

/** One app being built. Its display name comes from the app identity map at render (`appName`, Home). */
export interface SetupRow {
  appId: string;
  state: SetupRowState;
  /** 0..1 while running. */
  progress: number;
  error?: string;
  instanceId?: Id;
}

interface SetupState {
  rows: SetupRow[];
  running: boolean;
  /** The workspace the rows belong to. */
  workspaceId: Id | null;
  /** True when this session built (or is building) something: Home shows the progress section. */
  active: boolean;
  dismiss(): void;
}

export const useSetup = create<SetupState>()((set) => ({
  rows: [],
  running: false,
  workspaceId: null,
  active: false,
  dismiss: () => set({ active: false }),
}));

function patchRow(appId: string, patch: Partial<SetupRow>) {
  useSetup.setState((s) => ({ rows: s.rows.map((r) => (r.appId === appId ? { ...r, ...patch } : r)) }));
}

async function kvGet<T>(key: string): Promise<T | null> {
  return ((await api.kv.get({ ns: NS, key }).catch(() => null)) as T | null) ?? null;
}

/**
 * Save the plan and the person's details as soon as the workspace exists (both first-run paths). The region
 * (locale, time zone, first day of the week, clock) is detected from the OS here.
 */
export async function beginSetup(plan: { apps: string[]; name: string }): Promise<void> {
  const value: SetupPlan = { apps: plan.apps, name: plan.name.trim(), at: Date.now() };
  await api.kv.set({ ns: NS, key: "plan", value });
  // The first name names the workspace ("Sam’s workspace" in the sidebar and on the lock screen).
  if (value.name) {
    const [ws] = await api.workspace.list().catch(() => []);
    const named = ws ? await api.workspace.update({ id: ws.id, patch: { name: workspaceNameFor(value.name) } }).catch(() => null) : null;
    // The lock screen shows it even if Ultranote quits before the workspace first opens.
    if (named) writeLockIdentity(named);
  }
  const patch = { ...detectRegion(), ...(value.name ? { profileName: value.name } : {}) };
  await useSettings
    .getState()
    .load()
    .catch(() => undefined);
  await useSettings
    .getState()
    .setVault(patch)
    .catch(() => api.settings.setVault({ patch }).catch(() => undefined));
}

/** First run reached Home. */
export async function completeFirstRun(): Promise<void> {
  if (await kvGet<number>("completedAt")) return;
  await api.kv.set({ ns: NS, key: "completedAt", value: Date.now() });
}

/** "Sam" → "Sam’s workspace". */
export function workspaceNameFor(name: string): string {
  return `${name.trim().slice(0, 60)}’s workspace`;
}

let runningFor: Id | null = null;

/**
 * Build whatever the saved plan still lacks. Safe to call on every shell entry: it returns at once when there is
 * nothing to do, and never runs twice at the same time.
 */
export async function resumeSetup(workspaceId: Id): Promise<void> {
  if (runningFor) return;
  const plan = await kvGet<SetupPlan>("plan");
  if (!plan) return;
  // Quitting on the recovery-key screen still left a usable workspace: first run counts as done from here on.
  void completeFirstRun().catch(() => undefined);
  if (!plan.apps?.length) return;
  const built = new Set((await kvGet<string[]>("built")) ?? []);
  const instances: LifeAppInstance[] = await api.lifeapp.instances({ workspaceId }).catch(() => []);
  const installed = new Map(instances.filter((i) => !i.detached).map((i) => [i.appId, i.id]));
  const todo = plan.apps.filter((a) => !built.has(a) && !installed.has(a));
  if (!todo.length) return;
  runningFor = workspaceId;
  useSetup.setState({
    workspaceId,
    active: true,
    running: true,
    rows: plan.apps.map((appId) => ({
      appId,
      state: todo.includes(appId) ? "pending" : "done",
      progress: todo.includes(appId) ? 0 : 1,
      instanceId: installed.get(appId),
    })),
  });
  try {
    for (const appId of todo) await buildOne(workspaceId, appId, built);
  } finally {
    runningFor = null;
    useSetup.setState({ running: false });
    void useWorkspace
      .getState()
      .refreshLifeapps()
      .catch(() => undefined);
  }
}

async function buildOne(workspaceId: Id, appId: string, built: Set<string>): Promise<void> {
  patchRow(appId, { state: "running", progress: 0.02, error: undefined });
  try {
    const job = await api.lifeapp.install({
      appId,
      answers: {},
      mode: "quick",
      disabledKeys: [],
      workspaceId,
      sampleData: false,
      onEvent: (e: { kind: string; done?: number; total?: number }) => {
        if (e.kind === "progress" && e.total) patchRow(appId, { progress: Math.max(0.02, Math.min(0.98, (e.done ?? 0) / e.total)) });
      },
    });
    const res = await job.result;
    patchRow(appId, { state: "done", progress: 1, instanceId: res.instanceId });
  } catch (e) {
    // Already set up (another window, or a build that finished just before quitting): that is success.
    if (!hasCode(e, "CONFLICT")) {
      patchRow(appId, { state: "error", error: errorMessage(e) || "Something went wrong" });
      return;
    }
    const inst = (await api.lifeapp.instances({ workspaceId }).catch(() => [])).find((i) => i.appId === appId && !i.detached);
    patchRow(appId, { state: "done", progress: 1, instanceId: inst?.id });
  }
  built.add(appId);
  await api.kv.set({ ns: NS, key: "built", value: [...built] }).catch(() => undefined);
  await useWorkspace
    .getState()
    .refreshLifeapps()
    .catch(() => undefined);
}

/** Try the apps that failed again. */
export async function retrySetup(): Promise<void> {
  const { workspaceId, rows } = useSetup.getState();
  if (!workspaceId || runningFor) return;
  const failed = rows.filter((r) => r.state === "error").map((r) => r.appId);
  if (!failed.length) return;
  runningFor = workspaceId;
  useSetup.setState({ running: true, rows: rows.map((r) => (r.state === "error" ? { ...r, state: "pending", progress: 0, error: undefined } : r)) });
  const built = new Set((await kvGet<string[]>("built")) ?? []);
  try {
    for (const appId of failed) await buildOne(workspaceId, appId, built);
  } finally {
    runningFor = null;
    useSetup.setState({ running: false });
  }
}
