// What a run keeps and reads across a restart, what it says it risks, and what the Hangar's
// tick keeps. The flying itself is companionFlow.test.ts; the host's side is test/pluginRuns.test.js.

import test from "node:test";
import assert from "node:assert/strict";

import { STANDING_ORDERS_KEPT_MS, abandonmentToResume, flyRun, keptStandingOrders, readoutOf } from "../backend.ts";
import { INITIAL_FLEET_COMPANION } from "../lib/companionState.ts";
import { DEFAULT_COMPANION_SETUP } from "../lib/fleetCompanionLoop.ts";
import { prunedSetups, setupFor, squadRoster, withSetup } from "../lib/companionSettings.ts";
import { serverCompanionFacts } from "../lib/companionReadout.ts";
import { serverCompanions } from "../lib/companionRoster.ts";

const NOW = Date.now();
const ABANDONED = { abandonedAtMs: NOW - 60_000, supervisorCharacterIDs: [90000002] };
const ORDERS = { targetMode: "all", flightMode: "auto", followRangeM: 10_000, propsHeld: true };

test("a check reads a setup, and says what it risks: repairs cost money", async () => {
  const plain = await flyRun.check({ ...DEFAULT_COMPANION_SETUP, repairsAtStation: false });
  assert.equal(plain.ok, true);
  assert.ok(plain.ok && plain.policy.riskClasses.includes("combat"));
  assert.ok(plain.ok && !plain.policy.riskClasses.includes("financial"));
  assert.ok(plain.ok && plain.policy.restartSafe);
  const paying = await flyRun.check({ ...DEFAULT_COMPANION_SETUP, repairsAtStation: true });
  assert.ok(paying.ok && paying.policy.riskClasses.includes("financial"));
  assert.equal(plain.ok && plain.name, "Fleet companion");
});

test("a setup that cannot be read is refused, with words", async () => {
  const refused = await flyRun.check("not a setup");
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok && refused.refusal.length > 0);
});

test("the thirty-minute clock comes back from what the plugin kept, keeping its start", () => {
  assert.deepEqual(abandonmentToResume({ abandonment: ABANDONED }), ABANDONED);
});

test("the clock comes back from a row saved when core flew companions", () => {
  assert.deepEqual(abandonmentToResume({ formerRow: { kind: "companion", abandonment: ABANDONED } }), ABANDONED);
});

test("no clock, or one that cannot be read, is a run with no clock: still bounded, and still flying", () => {
  for (const data of [null, {}, "words", [], { abandonment: null }, { abandonment: { abandonedAtMs: "soon" } }, { formerRow: null }]) {
    assert.equal(abandonmentToResume(data as never), null, JSON.stringify(data));
  }
});

test("standing orders kept recently come back as they were", () => {
  assert.deepEqual(keptStandingOrders({ standingOrders: ORDERS, ordersKeptAtMs: NOW - 1_000 }, NOW), ORDERS);
});

test("standing orders kept too long ago do not: free fire nobody has said for a while is not a safe thing to find", () => {
  assert.equal(keptStandingOrders({ standingOrders: ORDERS, ordersKeptAtMs: NOW - STANDING_ORDERS_KEPT_MS - 1 }, NOW), null);
  assert.deepEqual(keptStandingOrders({ standingOrders: ORDERS, ordersKeptAtMs: NOW - STANDING_ORDERS_KEPT_MS }, NOW), ORDERS);
});

test("standing orders that cannot be read, or from before there were any, do not come back", () => {
  for (const data of [
    null,
    { formerRow: { kind: "companion" } },
    { standingOrders: ORDERS },
    { standingOrders: null, ordersKeptAtMs: NOW },
    { standingOrders: { ...ORDERS, targetMode: "everything" }, ordersKeptAtMs: NOW },
    { standingOrders: { ...ORDERS, flightMode: "sideways" }, ordersKeptAtMs: NOW },
    { standingOrders: { ...ORDERS, followRangeM: -5 }, ordersKeptAtMs: NOW },
    { standingOrders: { ...ORDERS, propsHeld: "yes" }, ordersKeptAtMs: NOW },
  ]) {
    assert.equal(keptStandingOrders(data as never, NOW), null, JSON.stringify(data));
  }
});

test("what a run reports is what the window reads back, for every fact", () => {
  const state = {
    ...INITIAL_FLEET_COMPANION,
    inFleet: true,
    followingOrderFrom: "broadcast",
    lastOrderHeard: "Target",
    targetMode: "all",
    canTag: false,
    fitWarnings: ["No ammunition loaded."],
  } as never;
  assert.deepEqual(serverCompanionFacts({ plugin: { readout: readoutOf(state) } }), readoutOf(state));
});

test("a readout that says nothing reads as not known, never as a confident no", () => {
  assert.equal(serverCompanionFacts({ plugin: null }), null);
  assert.equal(serverCompanionFacts({ plugin: { readout: "words" } }), null);
  const facts = serverCompanionFacts({ plugin: { readout: { inFleet: "yes", canTag: 1, targetMode: "some", fitWarnings: [1, "a"] } } });
  assert.deepEqual(facts, { inFleet: null, followingOrderFrom: null, lastOrderHeard: null, targetMode: null, canTag: null, fitWarnings: ["a"] });
});

test("the window lists this plugin's live runs, and no other plugin's or a bot's", () => {
  const row = (pluginID: string | null, endedAt: string | null = null) => ({ plugin: pluginID === null ? null : { pluginID }, endedAt });
  const live = row("fleet-companion");
  assert.deepEqual(serverCompanions([live, row("fleet-companion", "2026-11-06"), row("trader"), row(null)]), [live]);
});

test("the Hangar's tick: on writes the setup, off removes it, and an empty squad leaves nothing", () => {
  const on = withSetup({}, "wing", 90000001, DEFAULT_COMPANION_SETUP);
  assert.deepEqual(setupFor(on, "wing", 90000001), DEFAULT_COMPANION_SETUP);
  assert.equal(setupFor(on, "wing", 90000002), null);
  assert.deepEqual(withSetup(on, "wing", 90000001, null), {});
});

test("a squad's roster is its members set up to fly, in membership order, and nobody else", () => {
  let setups = withSetup({}, "wing", 90000002, DEFAULT_COMPANION_SETUP);
  setups = withSetup(setups, "wing", 90000001, DEFAULT_COMPANION_SETUP);
  setups = withSetup(setups, "wing", 90000009, DEFAULT_COMPANION_SETUP);
  assert.deepEqual(squadRoster(setups, "wing", [90000001, 90000002, 90000003]).map((row) => row.characterID), [90000001, 90000002]);
});

test("a pilot out of its squad loses its tick, so being put back does not silently give it back", () => {
  let setups = withSetup({}, "wing", 90000001, DEFAULT_COMPANION_SETUP);
  setups = withSetup(setups, "wing", 90000002, DEFAULT_COMPANION_SETUP);
  const pruned = prunedSetups(setups, { wing: [90000002] });
  assert.equal(setupFor(pruned, "wing", 90000001), null);
  assert.deepEqual(setupFor(pruned, "wing", 90000002), DEFAULT_COMPANION_SETUP);
  assert.deepEqual(prunedSetups(setups, {}), {}, "a deleted squad's go too");
  assert.equal(prunedSetups(setups, { wing: [90000001, 90000002] }), setups, "nothing to prune changes nothing");
});
