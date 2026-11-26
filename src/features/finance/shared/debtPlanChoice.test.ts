/**
 * Owner decision (Phase 2): the Debt planner saves its strategy and extra payment only after a real edit. Opening or
 * computing never writes the default (Avalanche + $200/mo). Until an edit the Money HQ Overview says "Debt-free at
 * minimum payments"; after one it says "Debt-free with your plan".
 *
 * Both states run against two kv backends: the mock's `kv_get` / `kv_set`, and an in-memory store with the desktop
 * contract (`crates/emp-store/src/repo/kv.rs`: `ui.*` namespaces only, a missing key reads as null).
 */
import { describe, expect, it } from "vitest";
import { mockApi } from "@/test/helpers";
import { figureLabel } from "./definitions";
import { choiceToSave, debtFreeKind, DEFAULT_DEBT_PLAN, parseChoice, type DebtPlanChoice } from "./debtPlanChoice";
import { createVaultKv, type KvIo } from "./vaultKv";

const NS = "ui.finance.debtPlan";
const INST = "money-hq-1";

type Io = KvIo & { writes: number };

async function mockIo(): Promise<Io> {
  const { api } = await mockApi();
  const io: Io = {
    writes: 0,
    get: (ns, key) => api.kv.get({ ns, key }),
    set: (ns, key, value) => {
      io.writes++;
      return api.kv.set({ ns, key, value });
    },
  };
  return io;
}

function desktopIo(): Io {
  const rows = new Map<string, unknown>();
  const check = (ns: string) => (ns.startsWith("ui.") ? Promise.resolve() : Promise.reject(new Error("only ui.* namespaces are accessible")));
  const io: Io = {
    writes: 0,
    get: (ns, key) => check(ns).then(() => rows.get(`${ns}\u0000${key}`) ?? null),
    set: (ns, key, value) =>
      check(ns).then(() => {
        io.writes++;
        rows.set(`${ns}\u0000${key}`, value);
      }),
  };
  return io;
}

/** What the planner does on a user action: write only a real edit. */
async function act(store: ReturnType<typeof createVaultKv<DebtPlanChoice>>, next: { strategy: string; extra: number }, isLedger = true) {
  const c = choiceToSave(store.getState().values[INST], next, isLedger);
  if (c) await store.getState().put(INST, c);
}

/** The Overview's label once the saved choice has loaded in a fresh session. */
async function overviewLabel(io: Io): Promise<string> {
  const fresh = createVaultKv(NS, parseChoice, io);
  await fresh.getState().load(INST);
  return figureLabel(debtFreeKind(fresh.getState().values[INST]) === "plan" ? "debtFree.plan" : "debtFree.minimum");
}

describe.each([
  ["mock", mockIo],
  ["desktop kv contract", async () => desktopIo()],
] as const)("Debt planner persistence (%s)", (_name, make) => {
  it("opening and computing write nothing; the Overview stays at minimum payments", async () => {
    const io = await make();
    const store = createVaultKv(NS, parseChoice, io);
    await store.getState().load(INST);
    expect(store.getState().values[INST]).toBeNull();
    // The planner shows the default and computes plans with it: none of that is an edit.
    await act(store, DEFAULT_DEBT_PLAN); // releasing the slider where it started / re-picking Avalanche
    await act(store, { strategy: "custom", extra: 300 }); // a custom order is never saved
    await act(store, { strategy: "snowball", extra: 300 }, false); // an edited what-if (not the ledger's debts)
    expect(io.writes).toBe(0);
    expect(await io.get(NS, INST)).toBeNull();
    expect(await overviewLabel(io)).toBe("Debt-free at minimum payments");
  });

  it("a real edit is saved and the Overview switches to your plan", async () => {
    const io = await make();
    const store = createVaultKv(NS, parseChoice, io);
    await store.getState().load(INST);
    await act(store, { strategy: "avalanche", extra: 350 }); // moved the slider
    expect(io.writes).toBe(1);
    expect(await io.get(NS, INST)).toEqual({ strategy: "avalanche", extra: 350 });
    expect(await overviewLabel(io)).toBe("Debt-free with your plan");
    // Once saved, going back to the old default is itself an edit (it differs from the saved choice).
    await act(store, DEFAULT_DEBT_PLAN);
    expect(await io.get(NS, INST)).toEqual(DEFAULT_DEBT_PLAN);
    // Re-committing the saved choice writes nothing.
    await act(store, DEFAULT_DEBT_PLAN);
    expect(io.writes).toBe(2);
  });
});

describe("choiceToSave", () => {
  it("compares with the saved choice, or the default when there is none", () => {
    expect(choiceToSave(null, { strategy: "avalanche", extra: 200 }, true)).toBeNull();
    expect(choiceToSave(undefined, { strategy: "snowball", extra: 200 }, true)).toEqual({ strategy: "snowball", extra: 200 });
    expect(choiceToSave({ strategy: "hybrid", extra: 50 }, { strategy: "hybrid", extra: 50 }, true)).toBeNull();
    expect(choiceToSave({ strategy: "hybrid", extra: 50 }, { strategy: "hybrid", extra: 75 }, true)).toEqual({ strategy: "hybrid", extra: 75 });
    expect(debtFreeKind(null)).toBe("minimum");
    expect(debtFreeKind(undefined)).toBe("minimum");
    expect(debtFreeKind({ strategy: "avalanche", extra: 0 })).toBe("plan");
  });
});
