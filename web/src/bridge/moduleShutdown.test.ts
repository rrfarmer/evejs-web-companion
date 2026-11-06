import test from "node:test";
import assert from "node:assert/strict";
import { observeDeferredShutdown } from "./moduleShutdown.ts";
import { requireModuleOutcome } from "../nav/moduleOutcome.ts";
import { activateModule, deactivateModule } from "./dogmaWrites.ts";
import type { JsonValue } from "./wire.ts";

const initial = { itemID: 7, shipID: 9, stopped: false, remainingMs: 75680 };
const outcome = (r: Record<string, unknown>) => ({ itemID: Number(r.itemID), active: null,
  stopped: typeof r.stopped === "boolean" ? r.stopped : null });
test("accepted long-cycle OFF survives old 15s budget and confirms the exact module before derived deadline", async () => {
  let now = 15000, reads = 0;
  const result = await observeDeferredShutdown(initial, 7, { current() {}, now: () => now,
    sleep: async ms => { now += ms; }, read: async shipID => {
      assert.equal(shipID, 9); reads++; return { itemID: 7, shipID, stopped: now >= 85680 };
    } });
  assert.ok(now > 15000 && now < 90680 && reads > 1);
  requireModuleOutcome(outcome(result), 7, "deactivate");
});
test("module still active beyond cycle-derived deadline remains UNCERTAIN; remaining budget cannot renew", async () => {
  let now = 15000, reads = 0;
  const result = await observeDeferredShutdown(initial, 7, { current() {}, now: () => now,
    sleep: async ms => { now += ms; }, read: async () => { reads++; return { ...initial, remainingMs: 300000 }; } });
  assert.equal(now, 90680); assert.ok(reads < 80);
  assert.throws(() => requireModuleOutcome(outcome(result), 7, "deactivate"), { code: "MODULE_ACTION_UNCERTAIN" });
});
test("unknown authority, already OFF and invalid pending budgets do not invent extended observation", async () => {
  for (const row of [{ ...initial, stopped: null }, { ...initial, stopped: true },
    { ...initial, remainingMs: 0 }, { ...initial, remainingMs: 305001 }, { ...initial, shipID: null }]) {
    assert.equal(await observeDeferredShutdown(row, 7, { current() {}, read: async () => { throw Error("unexpected read"); } }), row);
  }
});
test("different requested module or ship is never OFF confirmation", async () => {
  for (const fresh of [{ itemID: 8, shipID: 9, stopped: true }, { itemID: 7, shipID: 10, stopped: true }]) {
    let now = 0;
    const result = await observeDeferredShutdown(initial, 7, { current() {}, now: () => now,
      sleep: async ms => { now += ms; }, read: async () => fresh });
    assert.throws(() => requireModuleOutcome(outcome(result), 7, "deactivate"), { code: "MODULE_ACTION_UNCERTAIN" });
  }
});
test("retired authority interrupts pending OFF without another read or mutation", async () => {
  let current = true;
  await assert.rejects(observeDeferredShutdown(initial, 7, {
    current: () => { if (!current) throw Object.assign(Error("retired"), { code: "SESSION_REQUEST_RETIRED" }); },
    sleep: async () => { current = false; }, read: async () => { throw Error("retired generation must not read"); },
  }), { code: "SESSION_REQUEST_RETIRED" });
});
// The page's own deactivate since 2026-10-14 (dogmaWrites.ts; its route went): godma.py 2101, Deactivate(itemID,
// effectName), the effect it is stopping named; then the module's own state read, its cycle with the first reading.
test("the page's deactivate makes exactly one Deactivate, its effect named, then only exact-module reads", async () => {
  const acts: unknown[] = [];
  const reads: string[] = [];
  let now = 0;
  const result = await deactivateModule(
    async (service, method, args) => { acts.push([service, method, args]); return null; },
    {
      flightNow: async () => ({ inSpace: true, shipID: 9, solarSystemID: 30000142 }),
      state: async (itemID, shipID, cycle): Promise<Record<string, JsonValue>> => {
        reads.push(`${itemID}@${shipID}${cycle ? " cycle" : ""}`);
        return reads.length === 1 ? { ok: true, itemID, shipID, stopped: false, cycleMs: 3000 } : { ok: true, itemID, shipID, stopped: true };
      },
      effects: { of: async () => "moduleBonusAfterburner" },
    },
    7, { typeID: 439 }, { now: () => now, sleep: async (ms) => { now += ms; } });
  requireModuleOutcome(result, 7, "deactivate");
  assert.deepEqual(acts, [["dogmaIM", "Deactivate", [7, "moduleBonusAfterburner"]]]);
  assert.deepEqual(reads, ["7@9 cycle", "7@9"]);
});
const fakeModule = (states: readonly (boolean | null)[], seen = { reads: 0, slept: 0 }) => ({
  counts: seen,
  deps: {
    flightNow: async () => ({ inSpace: true, shipID: 9 }) as never,
    effects: {} as never,
    state: async (): Promise<Record<string, JsonValue>> => {
      const stopped = states[Math.min(seen.reads, states.length - 1)] ?? null;
      seen.reads++;
      return { itemID: 7, stopped, notifications: [seen.reads] };
    },
  },
});
const clockOf = (counts: { slept: number }) => {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => { now += ms; counts.slept += ms; } };
};
const accepted = async () => null as never;
test("ON: a module that shows as running only after the call's answer is active, and nothing heard meanwhile is lost", async () => {
  const { deps, counts } = fakeModule([true, true, false]);
  const result = await activateModule(accepted, deps, 7, { effect: "salvaging" }, clockOf(counts));
  assert.equal(result.active, true);
  assert.deepEqual(result.notifications, [1, 2, 3]);
  requireModuleOutcome(result as never, 7, "activate");
});
test("ON: a module running at the first read is not waited for", async () => {
  const { deps, counts } = fakeModule([false]);
  assert.equal((await activateModule(accepted, deps, 7, { effect: "salvaging" }, clockOf(counts))).active, true);
  assert.equal(counts.slept, 0);
});
test("ON: a module that never shows as running is still refused, after the short wait and no longer", async () => {
  const { deps, counts } = fakeModule([true]);
  const result = await activateModule(accepted, deps, 7, { effect: "salvaging" }, clockOf(counts));
  assert.equal(result.active, false);
  assert.equal(counts.slept, 2000);
  assert.throws(() => requireModuleOutcome(result as never, 7, "activate"), { code: "CALL_REFUSED" });
});
test("ON: an unreadable state is not waited on: it is for the caller to call uncertain", async () => {
  const { deps, counts } = fakeModule([null]);
  assert.equal((await activateModule(accepted, deps, 7, { effect: "salvaging" }, clockOf(counts))).active, null);
  assert.equal(counts.slept, 0);
});
