import test from "node:test";
import assert from "node:assert/strict";
import { observeDeferredShutdown } from "./moduleShutdown.ts";
import { requireModuleOutcome } from "../nav/moduleOutcome.ts";
import { deactivateModule } from "./dogmaWrites.ts";
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

test("the last read is made at the deadline, so a stop that lands in the wait's last moment is seen", async () => {
  let now = 0;
  const result = await observeDeferredShutdown({ ...initial, remainingMs: 2500 }, 7, { current() {}, now: () => now,
    sleep: async ms => { now += ms; }, read: async shipID => ({ itemID: 7, shipID, stopped: now < 2500 ? false : true }) });
  assert.equal(now, 2500);
  requireModuleOutcome(outcome(result), 7, "deactivate");
});

/** A module of a 4 s cycle whose stop comes `stopsAt` ms after the Deactivate. */
async function stopOfFourSecondCycle(stopsAt: number) {
  const acts: unknown[] = [];
  let now = 0;
  const result = await deactivateModule(
    async (service, method, args) => { acts.push([service, method, args]); return null; },
    {
      flightNow: async () => ({ inSpace: true, shipID: 9, solarSystemID: 30000142 }),
      state: async (itemID, shipID): Promise<Record<string, JsonValue>> => ({ ok: true, itemID, shipID, stopped: now >= stopsAt, cycleMs: 4000 }),
      effects: { of: async () => "tractorBeamCan" },
    },
    7, { typeID: 24348 }, { now: () => now, sleep: async (ms) => { now += ms; } });
  return { result, acts, waited: now };
}

test("a stop held up by a frozen server is still confirmed: the wait outlasts the freeze", async () => {
  const { result, acts, waited } = await stopOfFourSecondCycle(15_000);
  requireModuleOutcome(result, 7, "deactivate");
  assert.equal(waited, 15_000);
  assert.equal(acts.length, 1);
});

test("a module that never stops is still reported unconfirmed, once the wait is over, and the stop is never asked again", async () => {
  const { result, acts, waited } = await stopOfFourSecondCycle(Number.POSITIVE_INFINITY);
  assert.throws(() => requireModuleOutcome(result, 7, "deactivate"), { code: "MODULE_ACTION_UNCERTAIN" });
  assert.equal(waited, 34_000);
  assert.equal(acts.length, 1);
});

test("the wait for a very long cycle stays within what the watch will take on", async () => {
  const acts: unknown[] = [];
  let now = 0, reads = 0;
  const result = await deactivateModule(
    async (service, method, args) => { acts.push([service, method, args]); return null; },
    {
      flightNow: async () => ({ inSpace: true, shipID: 9, solarSystemID: 30000142 }),
      state: async (itemID, shipID): Promise<Record<string, JsonValue>> => { reads++; return { ok: true, itemID, shipID, stopped: now >= 290_000, cycleMs: 290_000 }; },
      effects: { of: async () => "someEffect" },
    },
    7, { typeID: 1 }, { now: () => now, sleep: async (ms) => { now += ms; } });
  requireModuleOutcome(result, 7, "deactivate");
  assert.ok(reads > 1);
});

const gatewayTimeout = () => Object.assign(new Error("The gateway timed out."), { code: "EVE_GATEWAY_TIMEOUT" });

/** A stop whose state reads answer as `answer` says, at the clock's time, counting from zero. */
async function stopWith(answer: (now: number, read: number) => Record<string, JsonValue> | Error) {
  let now = 0, reads = 0;
  const result = await deactivateModule(
    async () => null,
    {
      flightNow: async () => ({ inSpace: true, shipID: 9, solarSystemID: 30000142 }),
      state: async () => { const said = answer(now, reads++); if (said instanceof Error) throw said; return said; },
      effects: { of: async () => "tractorBeamCan" },
    },
    7, { typeID: 24348 }, { now: () => now, sleep: async (ms) => { now += ms; } });
  return { result, waited: now };
}
const reading = (stopped: boolean): Record<string, JsonValue> => ({ itemID: 7, shipID: 9, stopped, cycleMs: 4000 });

test("a gateway timing out on a read in the wait is no verdict: the module's stop is still seen after it", async () => {
  const { result, waited } = await stopWith((now, read) => (read === 0 ? reading(false) : now < 12_000 ? gatewayTimeout() : reading(true)));
  requireModuleOutcome(result, 7, "deactivate");
  assert.equal(waited, 12_000);
});

test("a gateway timing out on the first read does not end the watch either, and the wait is for a cycle unread", async () => {
  const seen = await stopWith((now) => (now < 3000 ? gatewayTimeout() : reading(true)));
  requireModuleOutcome(seen.result, 7, "deactivate");
  const never = await stopWith(() => gatewayTimeout());
  assert.throws(() => requireModuleOutcome(never.result, 7, "deactivate"), { code: "MODULE_ACTION_UNCERTAIN" });
  assert.equal(never.waited, 40_000);
});

test("a read refused for any other reason still ends the wait as it fails", async () => {
  const lost = Object.assign(new Error("The session is gone."), { code: "SESSION_NOT_FOUND" });
  await assert.rejects(stopWith((_now, read) => (read === 0 ? reading(false) : lost)), { code: "SESSION_NOT_FOUND" });
  await assert.rejects(stopWith(() => lost), { code: "SESSION_NOT_FOUND" });
});

test("a first read as slow as the whole wait still gets a last read", async () => {
  let now = 0, reads = 0;
  const result = await deactivateModule(
    async () => null,
    {
      flightNow: async () => ({ inSpace: true, shipID: 9, solarSystemID: 30000142 }),
      state: async () => { reads++; if (reads === 1) { now += 60_000; return reading(false); } return reading(true); },
      effects: { of: async () => "tractorBeamCan" },
    },
    7, { typeID: 24348 }, { now: () => now, sleep: async (ms) => { now += ms; } });
  requireModuleOutcome(result, 7, "deactivate");
  assert.equal(reads, 2);
});
