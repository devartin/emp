/**
 * First-run setup (1.0 brief §2.5) against the mock backend: the plan is saved at vault creation, the picked apps
 * build with progress, a resumed build skips what exists (an app installed meanwhile is success, not an error), and
 * the workspace is named after the person.
 */
import { describe, expect, test, vi } from "vitest";

vi.mock("@/backend", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/backend")>();
  const { mockApi } = await import("@/test/helpers");
  const { api } = await mockApi({ seed: "empty" });
  return { ...real, api, default: api };
});

describe("first-run setup", () => {
  test("plan, region and name are saved; apps build once and resume cleanly", { timeout: 30_000 }, async () => {
    const { api } = (await import("@/backend")) as typeof import("@/backend");
    const { beginSetup, completeFirstRun, resumeSetup, useSetup, workspaceNameFor } = await import("./setup");
    const autoLock = { idleMinutes: 15, onSleep: true, onScreenLock: true, onBlurMinutes: null, maxSessionHours: null };
    await api.vault.create({ profile: "standard", autoLock });
    const [ws] = await api.workspace.list();

    await beginSetup({ apps: ["life-os", "habits"], name: " Sam " });
    expect(await api.kv.get({ ns: "ui.onboarding", key: "plan" })).toMatchObject({ apps: ["life-os", "habits"], name: "Sam" });
    expect((await api.workspace.list())[0].name).toBe(workspaceNameFor("Sam"));
    const settings = await api.settings.get();
    expect(settings.vault?.profileName).toBe("Sam");
    expect([0, 1, 6]).toContain(settings.vault?.weekStart);
    expect(settings.vault?.timezone).toBeTruthy();

    // Habits gets installed before the build runs (another window, or a build that finished just before quitting).
    const job = await api.lifeapp.install({ appId: "habits", answers: {}, mode: "quick", disabledKeys: [], workspaceId: ws.id, sampleData: false });
    await job.result;

    await resumeSetup(ws.id);
    const rows = useSetup.getState().rows;
    expect(rows.map((r) => [r.appId, r.state])).toEqual([
      ["life-os", "done"],
      ["habits", "done"],
    ]);
    expect(rows.every((r) => r.progress === 1 && !!r.instanceId)).toBe(true);
    expect(await api.kv.get({ ns: "ui.onboarding", key: "built" })).toEqual(["life-os"]);
    // First run counts as finished from here on, even when it was cut short before "Start using Ultranote".
    expect(await api.kv.get({ ns: "ui.onboarding", key: "completedAt" })).toBeTruthy();

    // Nothing left to do: a second call changes nothing and installs nothing twice.
    const before = (await api.lifeapp.instances({ workspaceId: ws.id })).length;
    await resumeSetup(ws.id);
    expect((await api.lifeapp.instances({ workspaceId: ws.id })).length).toBe(before);
    expect(before).toBe(2);
    await completeFirstRun();
  });
});
