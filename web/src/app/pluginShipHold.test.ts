// A plugin's loop holds the ship as core's own loops do: taking it stops them, and they stop it.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow, type HeldPilot } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";

function makeFlow(notifications: () => readonly unknown[] = () => []) {
  const store = createClientStore();
  const flow = createAppFlow(store, {
    livePush: false,
    browserPilotRecovery: false,
    perSessionToken: true,
    initialSessionToken: "pilot",
    fetch: async () => Response.json({ ok: true, released: true, flight: {}, notifications: notifications() }),
  });
  return { store, flow };
}

const holderOf = (store: ReturnType<typeof createClientStore>) => store.get().bots;

test("a plugin's hold says who holds the ship, in the plugin's own words", () => {
  const { store, flow } = makeFlow();
  flow.flying.holdShip("plugin:trader", "The trader", () => {});
  assert.deepEqual(holderOf(store), { runningBotID: "plugin:trader", runningPluginName: "The trader" });
});

test("letting go leaves nothing holding the ship, and does not call the plugin's stop", () => {
  const { store, flow } = makeFlow();
  let stopped = 0;
  flow.flying.holdShip("plugin:trader", "The trader", () => { stopped += 1; }).release();
  assert.deepEqual(holderOf(store), { runningBotID: null, runningPluginName: null });
  assert.equal(stopped, 0);
});

test("a second plugin taking the ship stops the first, whose late release changes nothing", () => {
  const { store, flow } = makeFlow();
  const stopped: string[] = [];
  const first = flow.flying.holdShip("plugin:trader", "The trader", () => stopped.push("trader"));
  flow.flying.holdShip("plugin:hauler", "The hauler", () => stopped.push("hauler"));
  assert.deepEqual(stopped, ["trader"]);
  first.release();
  assert.equal(holderOf(store).runningBotID, "plugin:hauler");
});

test("one of core's loops taking the ship stops a plugin's", () => {
  const { store, flow } = makeFlow();
  let stopped = 0;
  flow.flying.holdShip("plugin:trader", "The trader", () => { stopped += 1; });
  // A start takes the ship before anything it awaits, so this much has happened as it returns.
  void flow.startFleetCompanion({} as Parameters<typeof flow.startFleetCompanion>[0]).catch(() => {});
  assert.equal(stopped, 1);
  assert.notEqual(holderOf(store).runningBotID, "plugin:trader");
});

test("while one of core's loops is running, it is what holds the ship and no plugin's name shows", () => {
  const { store } = makeFlow();
  store.apply({ type: "ship/plugin-holder", holder: { owner: "plugin:trader", name: "The trader" } });
  store.apply({ type: "custom-bot/started", name: "Mine" });
  assert.deepEqual(holderOf(store), { runningBotID: "custom", runningPluginName: null });
});

test("a pilot going offline clears the holder", () => {
  const { store, flow } = makeFlow();
  flow.flying.holdShip("plugin:trader", "The trader", () => {});
  store.apply({ type: "character/offline" });
  assert.deepEqual(holderOf(store), { runningBotID: null, runningPluginName: null });
});

test("a pilot's session closing stops a plugin's loop, and no hold can be taken after", async () => {
  const { flow } = makeFlow();
  let stopped = 0;
  flow.flying.holdShip("plugin:trader", "The trader", () => { stopped += 1; });
  assert.equal(flow.flying.isSessionClosing(), false);
  const before = flow.flying.sessionGeneration();
  const closing = flow.releaseSession().catch(() => {});
  assert.equal(stopped, 1);
  assert.equal(flow.flying.sessionGeneration(), before + 1);
  assert.throws(() => flow.flying.holdShip("plugin:trader", "The trader", () => {}), /released/);
  await closing;
});

test("listeners hear a fleet broadcast as it arrives, until they stop listening", async () => {
  const broadcast = { method: "OnFleetBroadcast", args: ["Target", 3, 90000002, 30000142, 9001, null] };
  let pending: readonly unknown[] = [];
  const { flow } = makeFlow(() => { const taken = pending; pending = []; return taken; });
  await flow.attachToHeldPilot({
    characterID: 90000001,
    character: { characterID: 90000001, characterName: "Test", stationID: null, structureID: null, solarSystemID: 30000142, corporationID: 98000000 },
    station: null,
  } as unknown as HeldPilot);
  let heard = 0;
  const stop = flow.flying.onPush(() => { heard += 1; });
  pending = [broadcast];
  await flow.flying.readFlightNow();
  assert.equal(heard, 1);
  stop();
  pending = [broadcast];
  await flow.flying.readFlightNow();
  assert.equal(heard, 1);
});

test("the flying calls a loop is made of are all there", () => {
  const { flow } = makeFlow();
  const missing = Object.entries(flow.flying).filter(([, value]) => value === undefined).map(([name]) => name);
  assert.deepEqual(missing, []);
});
