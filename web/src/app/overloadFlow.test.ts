// A module overloaded and cooled from the page, through the real flow over a faked BFF.
//
// The flow's own test of this verb (writeVerification.test.ts) reads its source for the snapshot check. What it
// sends was reached by no test.
//
// It sends the client's own calls (bridge/dogmaWrites.ts): godma's Overload and StopOverload (godma.py 2074 and
// 2119), each with the module and the ID of the module's own overload effect, which the client's button finds
// among the module's effects (shipmodulebutton.py 231: the one of the overload category). Tranquility has one
// recorded so: Overload(moduleID, 3001) on the dogma location's object. Until 2026-10-10 the page asked a route
// of the BFF for each, with no effect named.

import test from "node:test";
import assert from "node:assert/strict";
import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import { fittingBody, namesBody, spaceBody, SOLAR_SYSTEM_ID } from "./botFixtures.ts";

// Two of the fixture ship's fitted modules: a web, whose type has an overload effect, and a strip miner, whose
// type has none.
const WEB = { itemID: 9988400023312, typeID: 527 };
const MINER = { itemID: 9988400037240, typeID: 17482 };
const WEB_OVERLOAD_EFFECT = 3001;

/** A flow with the fixture ship's fitting read, over a BFF that knows the two types' overload effects. */
async function harness(options: { readonly effectsFail?: () => boolean; readonly webEffect?: () => unknown } = {}) {
  const store = createClientStore();
  store.apply({ type: "character/online", character: {
    characterID: 140000005, characterName: "Test", stationID: null,
    structureID: null, solarSystemID: SOLAR_SYSTEM_ID, corporationID: 98000000,
  }, station: null });
  /** The static reads of overload effects, each by the types it asked of. */
  const effectReads: string[] = [];
  /** What the page asked of the server for the overload, in order. */
  const calls: Record<string, unknown>[] = [];
  const routes: string[] = [];
  const overloaded = new Set<number>();
  const flow = createAppFlow(store, { livePush: false, fetch: async (input, init) => {
    const url = new URL(String(input), "http://bff.test");
    const path = url.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    let result: unknown = { ok: true };
    if (path === "/api/bridge/fitting") result = fittingBody();
    if (path === "/api/names") result = namesBody(body);
    if (path === "/api/types/cycle-times") result = { ok: true, source: "static-data", baseCycleMs: {}, capped: false, limit: 500 };
    if (path === "/api/types/overload-effects") {
      effectReads.push(url.searchParams.get("typeIDs") ?? "");
      if (options.effectsFail?.()) return Response.json({ ok: false, error: "STATIC_DATA_UNAVAILABLE", message: "The static data could not be read." }, { status: 503 });
      const asked = (url.searchParams.get("typeIDs") ?? "").split(",").map(Number);
      result = { ok: true, source: "static-data", capped: false, limit: 500,
        overloadEffectID: Object.fromEntries(asked.map(typeID => [String(typeID), typeID === WEB.typeID ? (options.webEffect ? options.webEffect() : WEB_OVERLOAD_EFFECT) : null])) };
    }
    if (path === "/api/bridge/space/snapshot") {
      const space = spaceBody() as { space: { ship: Record<string, unknown> } };
      space.space.ship.overloadedModuleIDs = [...overloaded];
      result = space;
    }
    if (path === "/api/bridge/dogma/module/overload" || path === "/api/bridge/dogma/module/stop-overload") routes.push(path);
    if (path === "/api/bridge/call" && body.service === "dogmaIM") {
      calls.push(body);
      const moduleID = Number((body.args as number[])[0]);
      if (body.method === "Overload") overloaded.add(moduleID);
      if (body.method === "StopOverload") overloaded.delete(moduleID);
      result = { ok: true, service: "dogmaIM", method: body.method, result: moduleID, notifications: [] };
    }
    return Response.json(result);
  } });
  await flow.loadFitting();
  return { store, flow, effectReads, calls, routes };
}

const call = (method: string, moduleID: number, effectID: number) =>
  ({ service: "dogmaIM", method, args: [moduleID, effectID], kwargs: null, pilot: true, confirm: true });

test("a module is overloaded and cooled by the page's own calls, each naming the module's overload effect", async () => {
  const { store, flow, effectReads, calls, routes } = await harness();
  await flow.setModuleOverload(WEB.itemID, true);
  // godma.py 2075: GetDogmaLM().Overload(itemID, effectID), as a pilot's and as a write the page means.
  assert.deepEqual(calls, [call("Overload", WEB.itemID, WEB_OVERLOAD_EFFECT)]);
  assert.deepEqual(effectReads, [String(WEB.typeID)]);
  assert.deepEqual([store.targeting.get().lastAction, store.targeting.get().actionError, store.targeting.get().silentDecline], ["Overload", null, null]);

  await flow.setModuleOverload(WEB.itemID, false);
  // 2120: StopOverload, with the same effect. What a type's effect is was asked once and is kept.
  assert.deepEqual(calls.slice(1), [call("StopOverload", WEB.itemID, WEB_OVERLOAD_EFFECT)]);
  assert.deepEqual(effectReads, [String(WEB.typeID)]);
  assert.deepEqual([store.targeting.get().lastAction, store.targeting.get().actionError], ["Stop overloading", null]);
  assert.deepEqual(routes, [], "neither route is asked");
});

test("a module whose type has no overload effect is not asked of the server at all, as the client has no button for it", async () => {
  const { store, flow, effectReads, calls, routes } = await harness();
  await flow.setModuleOverload(MINER.itemID, true);
  assert.deepEqual([calls, routes], [[], []]);
  assert.deepEqual(effectReads, [String(MINER.typeID)]);
  assert.match(String(store.targeting.get().actionError), /^Overload refused: .*cannot be overloaded/);
  // And that it has none is kept too.
  await flow.setModuleOverload(MINER.itemID, true);
  assert.deepEqual(effectReads, [String(MINER.typeID)]);
});

test("a module that is not one of the ship's is not asked of the server either", async () => {
  const { store, flow, effectReads, calls, routes } = await harness();
  await flow.setModuleOverload(4242, true);
  assert.deepEqual([calls, routes, effectReads], [[], [], []]);
  assert.match(String(store.targeting.get().actionError), /^Overload refused: .*not fitted to this ship/);
});

test("an answer that is no effect's ID is no answer: nothing is sent, and nothing is kept of it", async () => {
  for (const said of ["3001", 0, -3, 1.5, true, {}]) {
    let answer: unknown = said;
    const { store, flow, effectReads, calls } = await harness({ webEffect: () => answer });
    await flow.setModuleOverload(WEB.itemID, true);
    assert.deepEqual(calls, [], JSON.stringify(said));
    assert.match(String(store.targeting.get().actionError), /^Overload refused: .*could not be read/, JSON.stringify(said));
    // Asked again, and answered properly, it goes.
    answer = WEB_OVERLOAD_EFFECT;
    await flow.setModuleOverload(WEB.itemID, true);
    assert.deepEqual([calls, effectReads.length], [[call("Overload", WEB.itemID, WEB_OVERLOAD_EFFECT)], 2], JSON.stringify(said));
  }
});

test("where a type's overload effect cannot be read nothing is sent, and it is asked for again the next time", async () => {
  let failing = true;
  const { store, flow, effectReads, calls } = await harness({ effectsFail: () => failing });
  await flow.setModuleOverload(WEB.itemID, true);
  assert.deepEqual(calls, []);
  assert.match(String(store.targeting.get().actionError), /^Overload refused: /);
  failing = false;
  await flow.setModuleOverload(WEB.itemID, true);
  assert.deepEqual(calls, [call("Overload", WEB.itemID, WEB_OVERLOAD_EFFECT)]);
  assert.equal(effectReads.length, 2);
  assert.equal(store.targeting.get().actionError, null);
});
