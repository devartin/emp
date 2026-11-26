/**
 * Finance UI choices kept in the vault's kv (SPEC §9.11: never browser storage): the remembered statement and the
 * chosen debt plan. Runs against the mock backend's kv, the same `kv_get` / `kv_set` contract Rust serves.
 */
import { describe, expect, it, vi } from "vitest";
import { mockApi } from "@/test/helpers";
import { createVaultKv, type KvIo } from "./vaultKv";
import { parseChoice } from "./debtPlanChoice";
import { parseStatement } from "./statements";

async function vaultIo(): Promise<KvIo & { api: Awaited<ReturnType<typeof mockApi>>["api"] }> {
  const { api } = await mockApi();
  return { api, get: (ns, key) => api.kv.get({ ns, key }), set: (ns, key, value) => api.kv.set({ ns, key, value }) };
}

describe("vault kv store", () => {
  it("writes go to the vault's kv and come back in a fresh session; nothing touches browser storage", async () => {
    const io = await vaultIo();
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem, removeItem: vi.fn() });
    try {
      const a = createVaultKv("ui.finance.debtPlan", parseChoice, io);
      await a.getState().put("inst1", { strategy: "snowball", extra: 150 });
      expect(await io.api.kv.get({ ns: "ui.finance.debtPlan", key: "inst1" })).toEqual({ strategy: "snowball", extra: 150 });
      const b = createVaultKv("ui.finance.debtPlan", parseChoice, io);
      expect(b.getState().values.inst1).toBeUndefined(); // not loaded yet: callers wait, never guess
      await b.getState().load("inst1");
      expect(b.getState().values.inst1).toEqual({ strategy: "snowball", extra: 150 });
      expect(setItem).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("nothing stored reads as null; a malformed value is ignored; reset (lock) forgets the cache", async () => {
    const io = await vaultIo();
    const s = createVaultKv("ui.finance.statement", parseStatement, io);
    await s.getState().load("acct-none");
    expect(s.getState().values["acct-none"]).toBeNull();
    await io.api.kv.set({ ns: "ui.finance.statement", key: "acct-bad", value: { balance: "abc", source: "ofx", importedOn: "2026-11-01" } });
    await s.getState().load("acct-bad");
    expect(s.getState().values["acct-bad"]).toBeNull();
    await s.getState().put("acct1", { balance: "-2025.32", source: "ofx", asOf: "2026-11-20", importedOn: "2026-11-21", fileName: "card.ofx" });
    s.getState().reset();
    expect(s.getState().values).toEqual({});
    await s.getState().load("acct1");
    expect(s.getState().values.acct1).toMatchObject({ balance: "-2025.32", asOf: "2026-11-20" });
  });

  it("a failed read counts as nothing stored, and a lock during the read discards it", async () => {
    let release: (v: unknown) => void = () => undefined;
    const io: KvIo = { get: () => new Promise((r) => (release = r)), set: () => Promise.resolve() };
    const s = createVaultKv("ui.finance.debtPlan", parseChoice, io);
    const p = s.getState().load("i");
    s.getState().reset();
    release({ strategy: "avalanche", extra: 0 });
    await p;
    expect(s.getState().values.i).toBeUndefined();
    const failing = createVaultKv("ui.finance.debtPlan", parseChoice, { get: () => Promise.reject(new Error("locked")), set: () => Promise.reject(new Error("locked")) });
    await failing.getState().load("i");
    expect(failing.getState().values.i).toBeNull();
    await failing.getState().put("i", { strategy: "hybrid", extra: 25 }); // kept for the session
    expect(failing.getState().values.i).toEqual({ strategy: "hybrid", extra: 25 });
  });

  it("only a well-formed choice parses", () => {
    expect(parseChoice({ strategy: "avalanche", extra: 200 })).toEqual({ strategy: "avalanche", extra: 200 });
    expect(parseChoice({ strategy: "custom", extra: 200 })).toBeNull();
    expect(parseChoice({ strategy: "snowball", extra: -1 })).toBeNull();
    expect(parseChoice("x")).toBeNull();
  });
});
